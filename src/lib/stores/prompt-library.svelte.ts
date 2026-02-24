export type PromptSource = "builtin" | "user" | "server";

export interface PromptTemplate {
  id: string;
  title: string;
  category: string;
  description: string;
  template: string;
  tags: string[];
  author: string;
  source: PromptSource;
  updatedAt: number;
}

interface PromptLibraryPersisted {
  userPrompts: PromptTemplate[];
  favoriteIds: string[];
  recentUsage?: Array<{ id: string; usedAt: number }>;
}

export interface PromptVariable {
  key: string;
  value: string;
}

const STORAGE_KEY = "volt.promptLibrary.v1";

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function makeSearchIndexText(prompt: PromptTemplate): string {
  return normalizeToken(
    [
      prompt.title,
      prompt.description,
      prompt.category,
      prompt.author,
      ...prompt.tags,
    ].join(" "),
  );
}

function extractTemplateVariables(template: string): string[] {
  const regex = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  const found = new Set<string>();
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(template)) !== null) {
    const key = match[1]?.trim();
    if (key) found.add(key);
  }
  return [...found];
}

function renderTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_full, key) => {
    const v = variables[key];
    return typeof v === "string" ? v : "";
  });
}

class PromptLibraryStore {
  isOpen = $state(false);
  isLoading = $state(false);
  searchQuery = $state("");
  activeCategory = $state("All");
  showFavoritesOnly = $state(false);

  builtinPrompts = $state<PromptTemplate[]>([]);
  userPrompts = $state<PromptTemplate[]>([]);
  favoriteIds = $state<Set<string>>(new Set());
  recentUsage = $state<Map<string, number>>(new Map());

  private searchIndex = $state<Map<string, string>>(new Map());
  private loaded = false;

  get allPrompts(): PromptTemplate[] {
    return [...this.userPrompts, ...this.builtinPrompts];
  }

  get filteredPrompts(): PromptTemplate[] {
    let prompts = this.allPrompts;

    if (this.showFavoritesOnly) {
      prompts = prompts.filter((p) => this.favoriteIds.has(p.id));
    }

    if (this.activeCategory !== "All") {
      prompts = prompts.filter((p) => p.category === this.activeCategory);
    }

    const query = normalizeToken(this.searchQuery);
    if (query.length > 0) {
      prompts = prompts.filter((p) => {
        const indexed = this.searchIndex.get(p.id) ?? makeSearchIndexText(p);
        return indexed.includes(query);
      });
    }

    return prompts.sort((a, b) => {
      if (this.favoriteIds.has(a.id) && !this.favoriteIds.has(b.id)) return -1;
      if (!this.favoriteIds.has(a.id) && this.favoriteIds.has(b.id)) return 1;
      return b.updatedAt - a.updatedAt;
    });
  }

  get recentPrompts(): PromptTemplate[] {
    const allById = new Map(this.allPrompts.map((p) => [p.id, p] as const));
    return [...this.recentUsage.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => allById.get(id))
      .filter((p): p is PromptTemplate => Boolean(p))
      .slice(0, 6);
  }

  get categories(): string[] {
    const values = new Set<string>();
    for (const p of this.allPrompts) values.add(p.category);
    return ["All", ...[...values].sort()];
  }

  getCategoryCount(category: string): number {
    if (category === "All") return this.allPrompts.length;
    return this.allPrompts.filter((p) => p.category === category).length;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded || this.isLoading) return;
    this.isLoading = true;
    try {
      this.loadPersisted();
      await this.loadBuiltinPrompts();
      this.rebuildSearchIndex();
      this.loaded = true;
    } finally {
      this.isLoading = false;
    }
  }

  open(): void {
    this.isOpen = true;
    void this.ensureLoaded();
  }

  close(): void {
    this.isOpen = false;
  }

  toggleOpen(): void {
    this.isOpen ? this.close() : this.open();
  }

  setSearchQuery(query: string): void {
    this.searchQuery = query;
  }

  setCategory(category: string): void {
    this.activeCategory = category;
  }

  toggleFavoritesOnly(): void {
    this.showFavoritesOnly = !this.showFavoritesOnly;
  }

  isFavorite(id: string): boolean {
    return this.favoriteIds.has(id);
  }

  toggleFavorite(id: string): void {
    if (this.favoriteIds.has(id)) {
      this.favoriteIds.delete(id);
    } else {
      this.favoriteIds.add(id);
    }
    this.favoriteIds = new Set(this.favoriteIds);
    this.persist();
  }

  recordUsage(id: string): void {
    const next = new Map(this.recentUsage);
    next.set(id, Date.now());
    this.recentUsage = next;
    this.persist();
  }

  clearRecentUsage(): void {
    this.recentUsage = new Map();
    this.persist();
  }

  addUserPrompt(input: {
    title: string;
    category: string;
    description: string;
    template: string;
    tags?: string[];
  }): PromptTemplate {
    const prompt: PromptTemplate = {
      id: `user-${crypto.randomUUID()}`,
      title: input.title.trim(),
      category: input.category.trim() || "Custom",
      description: input.description.trim(),
      template: input.template,
      tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean),
      author: "You",
      source: "user",
      updatedAt: Date.now(),
    };
    this.userPrompts = [prompt, ...this.userPrompts];
    this.upsertSearchIndex(prompt);
    this.persist();
    return prompt;
  }

  deleteUserPrompt(id: string): void {
    const before = this.userPrompts.length;
    this.userPrompts = this.userPrompts.filter((p) => p.id !== id);
    if (this.userPrompts.length !== before) {
      this.favoriteIds.delete(id);
      this.favoriteIds = new Set(this.favoriteIds);
      this.recentUsage.delete(id);
      this.recentUsage = new Map(this.recentUsage);
      this.searchIndex.delete(id);
      this.searchIndex = new Map(this.searchIndex);
      this.persist();
    }
  }

  extractVariables(prompt: PromptTemplate): PromptVariable[] {
    return extractTemplateVariables(prompt.template).map((key) => ({
      key,
      value: "",
    }));
  }

  renderPrompt(prompt: PromptTemplate, values: Record<string, string>): string {
    return renderTemplate(prompt.template, values);
  }

  private async loadBuiltinPrompts(): Promise<void> {
    const loadFrom = async (url: string): Promise<PromptTemplate[] | null> => {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) return null;
      const raw = (await response.json()) as PromptTemplate[];
      return raw.map((p) => ({
        ...p,
        source: p.source ?? "builtin",
        tags: Array.isArray(p.tags) ? p.tags : [],
      }));
    };

    try {
      const fromIndex = await loadFrom("/prompts.index.json");
      if (fromIndex) {
        this.builtinPrompts = fromIndex;
        return;
      }

      // Backward compatibility (legacy single-file catalog)
      const fromLegacy = await loadFrom("/prompts.json");
      if (fromLegacy) {
        this.builtinPrompts = fromLegacy;
        return;
      }

      throw new Error("No prompt catalog found (prompts.index.json / prompts.json)");
    } catch (err) {
      console.error("[PromptLibrary] Failed to load builtin prompts:", err);
      this.builtinPrompts = [];
    }
  }

  private loadPersisted(): void {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as PromptLibraryPersisted;
      this.userPrompts = Array.isArray(parsed.userPrompts)
        ? parsed.userPrompts.filter((p) => p?.id && p?.template)
        : [];
      this.favoriteIds = new Set(
        Array.isArray(parsed.favoriteIds) ? parsed.favoriteIds : [],
      );
      this.recentUsage = new Map(
        Array.isArray(parsed.recentUsage)
          ? parsed.recentUsage
              .filter(
                (r): r is { id: string; usedAt: number } =>
                  Boolean(r && typeof r.id === "string" && Number.isFinite(r.usedAt)),
              )
              .map((r) => [r.id, r.usedAt] as const)
          : [],
      );
    } catch (err) {
      console.warn("[PromptLibrary] Failed to load persisted data:", err);
      this.userPrompts = [];
      this.favoriteIds = new Set();
      this.recentUsage = new Map();
    }
  }

  private persist(): void {
    if (typeof window === "undefined") return;
    try {
      const payload: PromptLibraryPersisted = {
        userPrompts: this.userPrompts,
        favoriteIds: [...this.favoriteIds],
        recentUsage: [...this.recentUsage.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 40)
          .map(([id, usedAt]) => ({ id, usedAt })),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (err) {
      console.warn("[PromptLibrary] Failed to persist data:", err);
    }
  }

  private rebuildSearchIndex(): void {
    const next = new Map<string, string>();
    for (const p of this.allPrompts) {
      next.set(p.id, makeSearchIndexText(p));
    }
    this.searchIndex = next;
  }

  private upsertSearchIndex(prompt: PromptTemplate): void {
    const next = new Map(this.searchIndex);
    next.set(prompt.id, makeSearchIndexText(prompt));
    this.searchIndex = next;
  }
}

export const promptLibraryStore = new PromptLibraryStore();
