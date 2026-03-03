<script lang="ts">
  import { onMount } from "svelte";
  import { UIIcon, VirtualList } from "$shared/components/ui";
  import { showToast } from "$shared/stores/toast.svelte";
  import { assistantStore } from "$features/assistant/stores/assistant.svelte";
  import {
    promptLibraryStore,
    type PromptTemplate,
    type PromptVariable,
  } from "$features/assistant/stores/prompt-library.svelte";

  let searchValue = $state("");
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let selectedPrompt = $state<PromptTemplate | null>(null);

  let variableEditorOpen = $state(false);
  let variableMode = $state<"copy" | "add" | "run">("add");
  let variablePrompt = $state<PromptTemplate | null>(null);
  let variableInputs = $state<PromptVariable[]>([]);

  let createModalOpen = $state(false);
  let createTitle = $state("");
  let createCategory = $state("Custom");
  let createDescription = $state("");
  let createTemplate = $state("");
  let createTags = $state("");

  onMount(() => {
    void promptLibraryStore.ensureLoaded();
    searchValue = promptLibraryStore.searchQuery;
  });

  function truncate(value: string, max = 120): string {
    if (value.length <= max) return value;
    return `${value.slice(0, max - 1)}...`;
  }

  function handleSearchInput(e: Event): void {
    const next = (e.target as HTMLInputElement).value;
    searchValue = next;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      promptLibraryStore.setSearchQuery(next);
    }, 180);
  }

  function openDetails(prompt: PromptTemplate): void {
    selectedPrompt = prompt;
  }

  function closeDetails(): void {
    selectedPrompt = null;
  }

  function setAssistantInput(text: string): void {
    assistantStore.openPanel();
    assistantStore.setInputValue(text);
  }

  function runAssistantInput(text: string): void {
    setAssistantInput(text);
    window.dispatchEvent(new CustomEvent("volt:assistant-send"));
  }

  function createOrRunPrompt(prompt: PromptTemplate, mode: "copy" | "add" | "run"): void {
    const vars = promptLibraryStore.extractVariables(prompt);
    if (vars.length > 0) {
      variablePrompt = prompt;
      variableInputs = vars;
      variableMode = mode;
      variableEditorOpen = true;
      return;
    }
    executePromptAction(mode, prompt.template);
  }

  function executePromptAction(mode: "copy" | "add" | "run", text: string): void {
    if (mode === "copy") {
      void copyToClipboard(text);
      return;
    }
    if (mode === "add") {
      setAssistantInput(text);
      return;
    }
    runAssistantInput(text);
  }

  function handleUsePrompt(prompt: PromptTemplate, mode: "copy" | "add" | "run"): void {
    promptLibraryStore.recordUsage(prompt.id);
    createOrRunPrompt(prompt, mode);
  }

  async function copyToClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      showToast({ type: "success", message: "Prompt copied" });
    } catch (err) {
      showToast({ type: "error", message: "Copy failed" });
      console.error("[PromptLibrary] Copy failed:", err);
    }
  }

  function handleConfirmVariables(): void {
    if (!variablePrompt) return;
    const values: Record<string, string> = {};
    for (const v of variableInputs) values[v.key] = v.value;
    const rendered = promptLibraryStore.renderPrompt(variablePrompt, values);
    executePromptAction(variableMode, rendered);
    variableEditorOpen = false;
    variablePrompt = null;
    variableInputs = [];
  }

  function openCreateModal(): void {
    createModalOpen = true;
    createTitle = "";
    createCategory = "Custom";
    createDescription = "";
    createTemplate = "";
    createTags = "";
  }

  function submitCreatePrompt(): void {
    if (!createTitle.trim() || !createTemplate.trim()) {
      showToast({ type: "warning", message: "Title and template are required" });
      return;
    }
    promptLibraryStore.addUserPrompt({
      title: createTitle,
      category: createCategory,
      description: createDescription,
      template: createTemplate,
      tags: createTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    });
    createModalOpen = false;
    showToast({ type: "success", message: "Prompt saved" });
  }
</script>

<div class="prompt-panel">
  <div class="toolbar">
    <div class="search-row">
      <div class="search-box">
        <UIIcon name="search" size={14} />
        <input
          type="text"
          placeholder="Search prompts..."
          value={searchValue}
          oninput={handleSearchInput}
        />
      </div>
      <button class="new-btn" onclick={openCreateModal} title="New prompt">
        <UIIcon name="plus" size={14} />
      </button>
    </div>
  </div>

  <div class="library-layout">
    <aside class="filter-rail">
      <button
        class="rail-chip"
        class:active={promptLibraryStore.showFavoritesOnly}
        onclick={() => promptLibraryStore.toggleFavoritesOnly()}
        title="Favorites only"
      >
        <UIIcon name="star" size={12} />
        <span>Favorites</span>
      </button>

      <div class="rail-label">Categories</div>
      <div class="rail-cats">
        {#each promptLibraryStore.categories as category (category)}
          <button
            class="rail-chip"
            class:active={promptLibraryStore.activeCategory === category}
            onclick={() => promptLibraryStore.setCategory(category)}
            title={category}
          >
            <span class="cat-name">{category}</span>
            <span class="cat-count">{promptLibraryStore.getCategoryCount(category)}</span>
          </button>
        {/each}
      </div>
    </aside>

    <section class="prompt-main">
      {#if promptLibraryStore.recentPrompts.length > 0 && !searchValue.trim() && promptLibraryStore.activeCategory === "All" && !promptLibraryStore.showFavoritesOnly}
        <div class="recent-section">
          <div class="recent-head">
            <div class="recent-title">Recently Used</div>
            <button class="recent-clear" onclick={() => promptLibraryStore.clearRecentUsage()}>
              Clear
            </button>
          </div>
          <div class="recent-chips">
            {#each promptLibraryStore.recentPrompts as recent (recent.id)}
              <button
                class="recent-chip"
                onclick={() => openDetails(recent)}
                title={recent.title}
              >
                <span>{truncate(recent.title, 30)}</span>
              </button>
            {/each}
          </div>
        </div>
      {/if}

      <div class="prompt-list">
        {#if promptLibraryStore.isLoading}
          <div class="empty">Loading prompts...</div>
        {:else if promptLibraryStore.filteredPrompts.length === 0}
          <div class="empty">No prompts match your filters.</div>
        {:else}
          <VirtualList items={promptLibraryStore.filteredPrompts} rowHeight={156} overscan={6}>
            {#snippet children({ item, style })}
              <div class="prompt-row" {style}>
                <div
                  class="prompt-card"
                  role="button"
                  tabindex="0"
                  onclick={() => openDetails(item)}
                  onkeydown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openDetails(item);
                    }
                  }}
                >
                  <div class="card-header">
                    <div class="title">{item.title}</div>
                    <button
                      class="star-btn"
                      class:active={promptLibraryStore.isFavorite(item.id)}
                      onclick={(e) => {
                        e.stopPropagation();
                        promptLibraryStore.toggleFavorite(item.id);
                      }}
                      title="Toggle favorite"
                    >
                      <UIIcon name="star" size={12} />
                    </button>
                  </div>
                  <div class="meta">{item.category} · {item.source}</div>
                  <div class="desc">{truncate(item.description, 108)}</div>
                  <div class="card-actions">
                    <button
                      class="action-btn"
                      onclick={(e) => {
                        e.stopPropagation();
                        handleUsePrompt(item, "copy");
                      }}
                    >
                      Copy
                    </button>
                    <button
                      class="action-btn"
                      onclick={(e) => {
                        e.stopPropagation();
                        handleUsePrompt(item, "add");
                      }}
                    >
                      Add
                    </button>
                    <button
                      class="action-btn primary"
                      onclick={(e) => {
                        e.stopPropagation();
                        handleUsePrompt(item, "run");
                      }}
                    >
                      Run
                    </button>
                  </div>
                </div>
              </div>
            {/snippet}
          </VirtualList>
        {/if}
      </div>
    </section>
  </div>

</div>

{#if selectedPrompt}
  {@const prompt = selectedPrompt}
  <div class="details-sheet" role="dialog" aria-modal="false" aria-label={prompt.title}>
    <div class="details-sheet-header">
      <h3>{prompt.title}</h3>
      <button class="close-btn" onclick={closeDetails} title="Close details">
        <UIIcon name="close" size={12} />
      </button>
    </div>
    <div class="details-sheet-body">
      <p class="drawer-desc">{prompt.description}</p>
      <div class="drawer-template">{prompt.template}</div>
    </div>
    <div class="details-sheet-actions">
      <button class="action-btn" onclick={() => handleUsePrompt(prompt, "copy")}>
        Copy
      </button>
      <button class="action-btn" onclick={() => handleUsePrompt(prompt, "add")}>
        Add to Input
      </button>
      <button class="action-btn primary" onclick={() => handleUsePrompt(prompt, "run")}>
        Run
      </button>
      {#if prompt.source === "user"}
        <button
          class="action-btn danger"
          onclick={() => {
            promptLibraryStore.deleteUserPrompt(prompt.id);
            closeDetails();
          }}
        >
          Delete
        </button>
      {/if}
    </div>
  </div>
{/if}

{#if variableEditorOpen && variablePrompt}
  <div class="dialog-backdrop">
    <div class="dialog">
      <div class="dialog-head">
        <h3>Fill Variables</h3>
        <button class="close-btn" onclick={() => (variableEditorOpen = false)}>
          <UIIcon name="close" size={12} />
        </button>
      </div>
      <div class="dialog-body">
        {#each variableInputs as variable, i (variable.key)}
          <label class="field">
            <span>{variable.key}</span>
            <input
              type="text"
              value={variable.value}
              oninput={(e) => {
                variableInputs[i].value = (e.target as HTMLInputElement).value;
                variableInputs = [...variableInputs];
              }}
            />
          </label>
        {/each}
      </div>
      <div class="dialog-actions">
        <button class="action-btn" onclick={() => (variableEditorOpen = false)}>Cancel</button>
        <button class="action-btn primary" onclick={handleConfirmVariables}>Apply</button>
      </div>
    </div>
  </div>
{/if}

{#if createModalOpen}
  <div class="dialog-backdrop">
    <div class="dialog large">
      <div class="dialog-head">
        <h3>New Prompt</h3>
        <button class="close-btn" onclick={() => (createModalOpen = false)}>
          <UIIcon name="close" size={12} />
        </button>
      </div>
      <div class="dialog-body">
        <label class="field"><span>Title</span><input type="text" bind:value={createTitle} /></label>
        <label class="field"><span>Category</span><input type="text" bind:value={createCategory} /></label>
        <label class="field"><span>Description</span><input type="text" bind:value={createDescription} /></label>
        <label class="field"><span>Tags (comma separated)</span><input type="text" bind:value={createTags} /></label>
        <label class="field"><span>Template</span><textarea rows="8" bind:value={createTemplate}></textarea></label>
      </div>
      <div class="dialog-actions">
        <button class="action-btn" onclick={() => (createModalOpen = false)}>Cancel</button>
        <button class="action-btn primary" onclick={submitCreatePrompt}>Save Prompt</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .prompt-panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    min-height: 0;
    position: relative;
    overflow: hidden;
  }

  .toolbar {
    padding: 10px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg-panel);
  }

  .search-row {
    display: flex;
    gap: 8px;
  }

  .search-box {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--color-surface0);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 0 10px;
    height: 34px;
    color: var(--color-text-secondary);
  }

  .search-box input {
    width: 100%;
    background: transparent;
    border: none;
    outline: none;
    color: var(--color-text);
    font-size: 12px;
  }

  .new-btn {
    width: 34px;
    height: 34px;
    border-radius: 8px;
    border: 1px solid var(--color-border);
    color: var(--color-text-secondary);
    background: var(--color-surface0);
  }

  .library-layout {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 130px 1fr;
  }

  .filter-rail {
    border-right: 1px solid color-mix(in srgb, var(--color-border) 80%, transparent);
    background: color-mix(in srgb, var(--color-bg-sidebar) 80%, var(--color-bg-panel));
    padding: 10px 8px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow: auto;
  }

  .rail-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-secondary);
    padding: 0 6px;
  }

  .rail-cats {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .rail-chip {
    min-height: 28px;
    border-radius: 8px;
    border: 1px solid var(--color-border);
    background: var(--color-surface0);
    color: var(--color-text-secondary);
    font-size: 11px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 0 8px;
    text-align: left;
  }

  .rail-chip.active {
    color: var(--color-text);
    border-color: color-mix(in srgb, var(--color-accent) 45%, var(--color-border));
    background: color-mix(in srgb, var(--color-accent) 14%, var(--color-surface0));
  }

  .cat-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cat-count {
    font-size: 10px;
    color: var(--color-text-disabled);
  }

  .prompt-main {
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .prompt-list {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    position: relative;
  }

  .recent-section {
    padding: 8px 10px 6px;
    border-bottom: 1px solid color-mix(in srgb, var(--color-border) 70%, transparent);
    background: color-mix(in srgb, var(--color-surface0) 60%, transparent);
  }

  .recent-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .recent-title {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-secondary);
    margin-bottom: 6px;
  }

  .recent-clear {
    font-size: 10px;
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    padding: 2px 8px;
    background: var(--color-surface0);
  }

  .recent-chips {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    padding-bottom: 4px;
  }

  .recent-chip {
    height: 24px;
    padding: 0 10px;
    border-radius: 999px;
    border: 1px solid var(--color-border);
    background: var(--color-surface0);
    color: var(--color-text-secondary);
    font-size: 11px;
    white-space: nowrap;
    flex: 0 0 auto;
  }

  .recent-chip:hover {
    color: var(--color-text);
    border-color: color-mix(in srgb, var(--color-accent) 40%, var(--color-border));
    background: color-mix(in srgb, var(--color-accent) 10%, var(--color-surface0));
  }

  .empty {
    height: 100%;
    display: grid;
    place-items: center;
    color: var(--color-text-secondary);
    font-size: 12px;
  }

  .prompt-row {
    padding: 10px 10px;
  }

  .prompt-card {
    width: 100%;
    min-height: 132px;
    border-radius: 12px;
    border: 1px solid var(--color-border);
    background: var(--color-bg-elevated, var(--color-surface0));
    text-align: left;
    padding: 10px 12px 12px;
    display: grid;
    grid-template-rows: auto auto minmax(32px, 1fr) auto;
    row-gap: 6px;
    cursor: pointer;
    overflow: hidden;
  }

  .prompt-card:hover {
    border-color: color-mix(in srgb, var(--color-accent) 40%, var(--color-border));
    background: color-mix(in srgb, var(--color-accent) 8%, var(--color-bg-elevated, var(--color-surface0)));
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .title {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .star-btn {
    width: 20px;
    height: 20px;
    border-radius: 5px;
    color: var(--color-text-secondary);
  }

  .star-btn.active {
    color: var(--color-warning);
  }

  .meta {
    font-size: 10px;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .desc {
    font-size: 12px;
    color: var(--color-text-secondary);
    overflow: hidden;
    display: -webkit-box;
    line-clamp: 2;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    min-height: 34px;
  }

  .card-actions {
    display: flex;
    gap: 8px;
    margin-top: 2px;
    justify-content: flex-end;
    align-items: center;
    padding-top: 4px;
  }

  .action-btn {
    min-height: 30px;
    min-width: 58px;
    padding: 0 12px;
    border-radius: 8px;
    border: 1px solid var(--color-border);
    background: var(--color-surface0);
    color: var(--color-text-secondary);
    font-size: 12px;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    letter-spacing: 0.01em;
  }

  .action-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
    border-color: color-mix(in srgb, var(--color-accent) 25%, var(--color-border));
  }

  .action-btn.primary {
    color: var(--color-text);
    border-color: color-mix(in srgb, var(--color-accent) 45%, var(--color-border));
    background: color-mix(in srgb, var(--color-accent) 18%, var(--color-surface0));
  }

  .action-btn.danger {
    color: var(--color-error);
    border-color: color-mix(in srgb, var(--color-error) 50%, var(--color-border));
  }

  .close-btn {
    width: 22px;
    height: 22px;
    border-radius: 6px;
    color: var(--color-text-secondary);
  }

  .close-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .drawer-desc {
    margin: 0;
    font-size: 12px;
    color: var(--color-text-secondary);
  }

  .drawer-template {
    font-size: 12px;
    line-height: 1.45;
    white-space: pre-wrap;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 8px;
    overflow: auto;
  }

  .dialog-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1200;
    background: color-mix(in srgb, var(--color-bg) 45%, transparent);
    backdrop-filter: blur(4px);
    display: grid;
    place-items: center;
  }

  .dialog {
    width: min(520px, calc(100vw - 24px));
    border-radius: 10px;
    border: 1px solid var(--color-border);
    background: var(--color-bg-panel);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .dialog.large {
    width: min(680px, calc(100vw - 24px));
  }

  .dialog-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .dialog-head h3 {
    margin: 0;
    font-size: 14px;
  }

  .dialog-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 56vh;
    overflow: auto;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--color-text-secondary);
  }

  .field input,
  .field textarea {
    width: 100%;
    border-radius: 8px;
    border: 1px solid var(--color-border);
    background: var(--color-surface0);
    color: var(--color-text);
    padding: 8px 10px;
    font-size: 12px;
    font-family: inherit;
    resize: vertical;
  }

  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .details-sheet {
    position: absolute;
    inset: 0;
    z-index: 20;
    background: color-mix(in srgb, var(--color-bg-panel) 96%, var(--color-bg-sidebar));
    border-left: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    animation: sheetIn 0.16s ease-out;
  }

  @keyframes sheetIn {
    from {
      transform: translateX(14px);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  .details-sheet-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px;
    border-bottom: 1px solid var(--color-border);
  }

  .details-sheet-header h3 {
    margin: 0;
    font-size: 14px;
    line-height: 1.3;
  }

  .details-sheet-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px;
    overflow: auto;
  }

  .details-sheet-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px;
    border-top: 1px solid var(--color-border);
  }

  @media (max-width: 420px) {
    .library-layout {
      grid-template-columns: 1fr;
    }

    .filter-rail {
      border-right: none;
      border-bottom: 1px solid color-mix(in srgb, var(--color-border) 80%, transparent);
      max-height: 150px;
    }

    .rail-cats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
    }
  }
</style>
