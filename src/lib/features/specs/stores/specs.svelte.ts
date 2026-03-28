import { invoke } from '@tauri-apps/api/core';
import { streamChat } from '$core/ai';
import { buildSpecPrompt } from '$core/ai/prompts/prompt-spec';
import { readFileQuiet, writeFile, writeFileQuiet, getFileInfoQuiet } from '$core/services/file-system';
import { aiSettingsStore } from '$features/assistant/stores/ai.svelte';
import { assistantStore, type AttachedContext, type SyntheticPromptMeta } from '$features/assistant/stores/assistant.svelte';
import { chatHistoryStore } from '$features/assistant/stores/chat-history.svelte';
import { editorStore } from '$features/editor/stores/editor.svelte';
import { projectStore } from '$shared/stores/project.svelte';
import { showToast } from '$shared/stores/toast.svelte';
import type {
  PendingSpecDraft,
  RunAllQueue,
  SpecVerificationPayload,
  SpecOperation,
  SpecResponsePayload,
  SpecTaskRunEvent,
  TaskRunSyncInput,
  VoltSpecContext,
  VoltSpecManifest,
  VoltSpecTask,
  VoltSpecTaskRun,
  VoltSpecTaskVerification,
} from '$features/specs/types';
import {
  buildSpecContext,
  ensureTrailingNewline,
  isRuntimeActive,
  normalizePath,
  parseTaggedJson,
  parseVerificationTaggedJson,
  parseTaskCheckboxStates,
  phaseFromPath,
  findTaskLineNumber,
  renderTasksMarkdown,
  sanitizeTask,
  slugify,
  summarizeAssistantExcerpt,
} from '$features/specs/utils';

function buildCreatePrompt(userPrompt: string): string {
  return [
    'You are handling a user message inside Volt Spec Mode.',
    'Return a short summary followed by <volt-spec-json>...</volt-spec-json>.',
    'Inside the JSON include: action and assistantMessage.',
    'Allowed actions: answer, ask_clarification, draft_requirements.',
    'If the user message is casual, conversational, or not a concrete feature request, use action="answer" or action="ask_clarification".',
    'Use action="ask_clarification" when the user seems to want a spec but has not provided enough concrete product detail yet.',
    'Only use action="draft_requirements" when there is enough detail to draft the first confirmed artifact.',
    'When action="draft_requirements", also include title, slug, and requirementsMarkdown.',
    'When action is not draft_requirements, do not include requirementsMarkdown, designMarkdown, or tasks.',
    'Requirements markdown must use stable ids like REQ-1, REQ-2 and stay concrete and implementation-aware.',
    '',
    'User request:',
    userPrompt.trim(),
  ].join('\n');
}

function buildDesignPrompt(spec: VoltSpecManifest): string {
  return [
    'Regenerate the design document for this spec.',
    'Return a short summary followed by <volt-spec-json>...</volt-spec-json>.',
    'Inside the JSON include: action, assistantMessage, and designMarkdown.',
    'Use action="design".',
    'The design must map back to the listed requirements and be implementation-aware.',
    '',
    `Spec title: ${spec.title}`,
    '',
    'Requirements markdown:',
    spec.requirementsMarkdown,
  ].join('\n');
}

function buildTasksPrompt(spec: VoltSpecManifest): string {
  return [
    'Generate the implementation task list for this spec.',
    'Return a short summary followed by <volt-spec-json>...</volt-spec-json>.',
    'Inside the JSON include: action, assistantMessage, and tasks.',
    'Use action="tasks".',
    'Tasks must be dependency-aware, small enough for one focused agent run, and reference requirement ids.',
    '',
    `Spec title: ${spec.title}`,
    '',
    'Requirements markdown:',
    spec.requirementsMarkdown,
    '',
    'Design markdown:',
    spec.designMarkdown,
  ].join('\n');
}

function buildTaskVerificationPrompt(spec: VoltSpecManifest, task: VoltSpecTask, latestRun?: VoltSpecTaskRun): string {
  return [
    `Verify spec task ${task.id}: ${task.title}`,
    '',
    'You are Volt Task Verifier.',
    'Be sharp, candid, and a little funny when something is weak, but stay professional and useful.',
    'One light roast is fine. Do not turn the review into stand-up comedy.',
    '',
    `Spec: ${spec.title}`,
    `Task summary: ${task.summary || 'No summary provided.'}`,
    task.requirementIds.length > 0 ? `Requirements: ${task.requirementIds.join(', ')}` : '',
    task.dependencyIds.length > 0 ? `Dependencies: ${task.dependencyIds.join(', ')}` : '',
    task.scopeHints.length > 0 ? `Scope hints: ${task.scopeHints.join(', ')}` : '',
    `Expected verification: ${task.verification}`,
    latestRun ? `Latest execution status: ${latestRun.status}` : 'Latest execution status: unavailable',
    latestRun?.lastStatusMessage ? `Latest run note: ${latestRun.lastStatusMessage}` : '',
    '',
    'Rules:',
    '1. Read the attached spec files and latest run context first.',
    '2. Inspect the actual workspace/diff/files before you judge. Do not trust the executor summary blindly.',
    '3. First response is review-only. Do not edit code or spec files yet.',
    '4. If research or extra inspection is needed, do that first and then deliver the review.',
    '5. Only start fixing code if the user explicitly approves after your review.',
    '6. Never edit requirements.md, design.md, or tasks.md directly. Volt owns spec state.',
    '',
    'Your first response must include:',
    '- verdict: pass | needs-fix | incomplete',
    '- completeness score: x/10',
    '- quality score: x/10',
    '- spec adherence score: x/10',
    '- what is solid',
    '- what is missing or risky',
    '- any lazy shortcuts or weak choices you found',
    '- concrete next steps',
    '',
    'After the visible review, append this exact machine-readable block format with real values:',
    '<volt-spec-verify-json>{"verdict":"pass|needs-fix|incomplete","completenessScore":0,"qualityScore":0,"specAdherenceScore":0,"summary":"...","findings":["..."],"recommendations":["..."]}</volt-spec-verify-json>',
    'Do not wrap that JSON block in markdown fences.',
  ].filter(Boolean).join('\n');
}

function buildSpecSyntheticPrompt(
  kind: SyntheticPromptMeta['kind'],
  title: string,
  subtitle?: string,
): SyntheticPromptMeta {
  return {
    kind,
    title,
    subtitle: subtitle?.trim() || undefined,
  };
}

function clampScore(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.min(10, Math.round(parsed)));
}

function normalizeVerificationPayload(payload: SpecVerificationPayload | null): SpecVerificationPayload | null {
  if (!payload?.verdict) return null;
  if (payload.verdict !== 'pass' && payload.verdict !== 'needs-fix' && payload.verdict !== 'incomplete') {
    return null;
  }

  return {
    verdict: payload.verdict,
    completenessScore: clampScore(payload.completenessScore),
    qualityScore: clampScore(payload.qualityScore),
    specAdherenceScore: clampScore(payload.specAdherenceScore),
    summary: typeof payload.summary === 'string' ? payload.summary.trim() : undefined,
    findings: Array.isArray(payload.findings)
      ? payload.findings.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : [],
    recommendations: Array.isArray(payload.recommendations)
      ? payload.recommendations.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : [],
  };
}

class SpecStore {
  activeFilePath = $state<string | null>(null);
  activeSpec = $state<VoltSpecManifest | null>(null);
  activeContext = $state<VoltSpecContext | null>(null);
  isBusy = $state(false);
  busyLabel = $state('');
  lastError = $state<string | null>(null);
  runAllQueue = $state<RunAllQueue | null>(null);
  pendingDraft = $state<PendingSpecDraft | null>(null);

  private cache = new Map<string, VoltSpecManifest>();
  private trackedRunSignature = new Map<string, string>();
  private trackedConversationToSpec = new Map<string, { specId: string; taskId: string; runId: string }>();
  private trackedVerificationSignature = new Map<string, string>();
  private trackedConversationToVerification = new Map<string, { specId: string; taskId: string; verificationId: string }>();
  private activeLoadToken = 0;
  private runtimeSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeSyncInFlight = false;
  private runtimeSyncRequested = false;

  isSpecPath(path: string | null | undefined): boolean {
    if (!path) return false;
    return normalizePath(path).includes('/.volt/specs/');
  }

  isEditableSpecMarkdown(path: string | null | undefined): boolean {
    if (!path || !this.isSpecPath(path)) return false;
    const normalized = normalizePath(path).toLowerCase();
    return normalized.endsWith('/requirements.md') || normalized.endsWith('/design.md') || normalized.endsWith('/tasks.md');
  }

  setActiveFile(path: string | null): void {
    this.activeFilePath = path ? normalizePath(path) : null;
    const token = ++this.activeLoadToken;
    if (!path || !this.isSpecPath(path) || !projectStore.rootPath) {
      this.activeSpec = null;
      this.activeContext = null;
      return;
    }

    void this.loadSpecForPath(path).then(({ spec, context }) => {
      if (token !== this.activeLoadToken) return;
      this.activeSpec = spec;
      this.activeContext = context;
    }).catch((error) => {
      if (token !== this.activeLoadToken) return;
      console.error('[SpecStore] Failed to load active spec:', error);
      this.activeSpec = null;
      this.activeContext = null;
    });
  }

  handleActiveFileDraftChanged(path: string, content: string): void {
    if (!this.isSpecPath(path) || !this.activeSpec || !this.activeContext) return;

    const normalizedPath = normalizePath(path);
    if (
      this.activeContext.requirementsPath !== normalizedPath &&
      this.activeContext.designPath !== normalizedPath &&
      this.activeContext.tasksPath !== normalizedPath
    ) {
      return;
    }

    const phase = phaseFromPath(path);
    if (!phase) return;

    const normalizedContent = ensureTrailingNewline(content);
    const spec = this.activeSpec;
    let changed = false;

    if (phase === 'requirements' && spec.requirementsMarkdown !== normalizedContent) {
      spec.requirementsMarkdown = normalizedContent;
      spec.phaseStates.requirements = 'ready';
      spec.phaseStates.design = spec.designMarkdown ? 'stale' : 'pending';
      spec.phaseStates.tasks = spec.tasks.length > 0 ? 'stale' : 'pending';
      spec.staleFlags.design = true;
      spec.staleFlags.tasks = true;
      changed = true;
    } else if (phase === 'design' && spec.designMarkdown !== normalizedContent) {
      spec.designMarkdown = normalizedContent;
      spec.phaseStates.design = 'ready';
      spec.phaseStates.tasks = spec.tasks.length > 0 ? 'stale' : 'pending';
      spec.staleFlags.tasks = true;
      changed = true;
    } else if (phase === 'tasks') {
      changed = this.applyTaskCheckboxOverrides(spec, normalizedContent);
    }

    if (!changed) return;

    spec.updatedAt = Date.now();
    this.cache.set(this.activeContext.manifestPath, spec);
    this.activeSpec = spec;
  }

  async handleActiveFileSaved(path: string, content: string): Promise<void> {
    if (!this.isSpecPath(path) || !projectStore.rootPath) return;

    const { spec, context } = await this.loadSpecForPath(path);
    const phase = phaseFromPath(path);
    if (!phase) return;

    const normalizedContent = ensureTrailingNewline(content);
    let changed = false;
    const shouldPersistTaskState = phase === 'tasks';

    if (phase === 'requirements' && spec.requirementsMarkdown !== normalizedContent) {
      spec.requirementsMarkdown = normalizedContent;
      spec.phaseStates.requirements = 'ready';
      spec.phaseStates.design = spec.designMarkdown ? 'stale' : 'pending';
      spec.phaseStates.tasks = spec.tasks.length > 0 ? 'stale' : 'pending';
      spec.staleFlags.design = true;
      spec.staleFlags.tasks = true;
      changed = true;
    } else if (phase === 'design' && spec.designMarkdown !== normalizedContent) {
      spec.designMarkdown = normalizedContent;
      spec.phaseStates.design = 'ready';
      spec.phaseStates.tasks = spec.tasks.length > 0 ? 'stale' : 'pending';
      spec.staleFlags.tasks = true;
      changed = true;
    } else if (phase === 'tasks') {
      changed = this.applyTaskCheckboxOverrides(spec, normalizedContent);
    }

    if (!changed && !shouldPersistTaskState) return;

    if (changed) {
      spec.updatedAt = Date.now();
    }
    await this.persistSpec(spec, context, {
      writeRequirements: phase !== 'requirements',
      writeDesign: phase !== 'design',
      writeTasks: phase !== 'tasks',
    });
    this.activeSpec = spec;
    this.activeContext = context;
  }

  async openTaskConversation(conversationId: string): Promise<void> {
    if (!conversationId) return;
    const summary = chatHistoryStore.conversations.find((conversation) => conversation.id === conversationId);
    if (assistantStore.switchToConversation(conversationId, summary)) {
      chatHistoryStore.activeConversationId = conversationId;
      assistantStore.openPanel();
      return;
    }

    if (!summary) return;
    const fullConversation = await chatHistoryStore.getConversation(conversationId);
    assistantStore.loadConversation(fullConversation);
    chatHistoryStore.activeConversationId = conversationId;
    assistantStore.openPanel();
  }

  async openLatestRun(taskId: string): Promise<void> {
    if (!this.activeSpec || !this.activeContext) return;
    const task = this.activeSpec.tasks.find((entry) => entry.id === taskId);
    if (!task?.latestRunId) return;
    await editorStore.openFile(`${this.activeContext.specDir}/runs/${taskId}/${task.latestRunId}.json`);
  }

  async openTaskInEditor(taskId: string): Promise<void> {
    if (!this.activeSpec || !this.activeContext) return;
    const line = findTaskLineNumber(this.activeSpec, taskId);
    await editorStore.openFile(this.activeContext.tasksPath);
    if (line) {
      await editorStore.setSelection(this.activeContext.tasksPath, {
        startLine: line,
        startColumn: 1,
        endLine: line,
        endColumn: 1,
      });
    }
    await this.revealSpecInTree(this.activeContext.tasksPath);
  }

  async createSpecFromPrompt(prompt: string, context: AttachedContext[] = []): Promise<void> {
    const workspaceRoot = projectStore.rootPath;
    if (!workspaceRoot) {
      showToast({ message: 'Open a workspace before creating a spec.', type: 'warning' });
      return;
    }

    const conversationId = assistantStore.currentConversation?.id;
    if (!conversationId) {
      showToast({ message: 'Open a spec conversation before drafting a spec.', type: 'warning' });
      return;
    }

    this.pendingDraft = null;

    await this.runSpecPlanner({
      operation: 'create',
      prompt: buildCreatePrompt(prompt),
      conversationSummary: prompt,
      contextMentions: context,
      applyResult: async (payload) => {
        if (!payload.requirementsMarkdown?.trim()) {
          throw new Error('Spec response did not include requirementsMarkdown.');
        }
        const title = typeof payload.title === 'string' && payload.title.trim().length > 0
          ? payload.title.trim()
          : prompt.trim().slice(0, 80) || 'Untitled Spec';
        const uniqueSlug = await this.ensureUniqueSlug(payload.slug || slugify(title), workspaceRoot);
        this.pendingDraft = {
          conversationId,
          title,
          slug: uniqueSlug,
          prompt: prompt.trim(),
          createdAt: Date.now(),
          requirementsMarkdown: ensureTrailingNewline(payload.requirementsMarkdown || ''),
          contextMentions: [...context],
        };
        return `Drafted requirements for "${title}". Review the proposal, then choose Create Requirements to write .volt/specs/${uniqueSlug}/requirements.md into this workspace.`;
      },
    });
  }

  async confirmPendingDraft(): Promise<void> {
    const workspaceRoot = projectStore.rootPath;
    const draft = this.pendingDraft;
    if (!workspaceRoot || !draft) return;

    const confirmedSlug = await this.ensureUniqueSlug(draft.slug, workspaceRoot);
    const spec: VoltSpecManifest = {
      version: 1,
      id: crypto.randomUUID(),
      slug: confirmedSlug,
      title: draft.title,
      prompt: draft.prompt,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'active',
      phaseStates: {
        requirements: 'ready',
        design: 'pending',
        tasks: 'pending',
      },
      staleFlags: {
        design: false,
        tasks: false,
      },
      requirementsMarkdown: ensureTrailingNewline(draft.requirementsMarkdown),
      designMarkdown: '',
      tasks: [],
    };

    const specContext = buildSpecContext(workspaceRoot, confirmedSlug);
    await this.persistSpec(spec, specContext, {
      writeDesign: false,
      writeTasks: false,
    });
    this.activeSpec = spec;
    this.activeContext = specContext;
    this.pendingDraft = null;
    await editorStore.openFile(specContext.requirementsPath);
    await this.revealSpecInTree(specContext.requirementsPath);
    showToast({ message: `Created spec "${spec.title}"`, type: 'success' });
  }

  discardPendingDraft(): void {
    if (!this.pendingDraft) return;
    this.pendingDraft = null;
    showToast({ message: 'Discarded the pending spec draft.', type: 'info' });
  }

  private dispatchAssistantPrompt(
    prompt: string,
    options: {
      syntheticPrompt?: SyntheticPromptMeta;
      suppressAutoTitle?: boolean;
    } = {},
  ): void {
    if (typeof window === 'undefined') {
      assistantStore.setInputValue(prompt);
      return;
    }

    window.dispatchEvent(
      new CustomEvent('volt:assistant-send-prompt', {
        detail: {
          prompt,
          syntheticPrompt: options.syntheticPrompt,
          suppressAutoTitle: options.suppressAutoTitle,
        },
      }),
    );
  }

  getVerificationConversationActionState(conversationId: string | null | undefined): {
    taskId: string;
    taskTitle: string;
    status: VoltSpecTaskVerification['status'];
    verdict?: VoltSpecTaskVerification['verdict'];
    isStale: boolean;
    hasReviewPayload: boolean;
    canApplyFixes: boolean;
    canReverify: boolean;
  } | null {
    if (!conversationId) return null;
    const match = this.findVerificationConversationMatch(conversationId);
    if (!match) return null;

    const { task, verification } = match;
    const isStale = Boolean(verification.isStale);
    const inferredVerdict =
      verification.verdict ??
      (verification.status === 'needs-fix'
        ? 'needs-fix'
        : verification.status === 'incomplete'
          ? 'incomplete'
          : verification.status === 'passed'
            ? 'pass'
            : undefined);
    const hasReviewPayload =
      Boolean(verification.summary?.trim()) ||
      verification.findings.length > 0 ||
      verification.recommendations.length > 0;
    const canApplyFixes =
      !isStale &&
      (verification.status === 'running'
        ? false
        : inferredVerdict === 'needs-fix' ||
        inferredVerdict === 'incomplete' ||
        (!inferredVerdict && hasReviewPayload));
    const canReverify = true;

    return {
      taskId: task.id,
      taskTitle: task.title,
      status: verification.status,
      verdict: inferredVerdict,
      isStale,
      hasReviewPayload,
      canApplyFixes,
      canReverify,
    };
  }

  async applyReviewFixesForConversation(conversationId: string | null | undefined): Promise<void> {
    if (!conversationId) return;
    if (assistantStore.isStreaming) {
      showToast({ message: 'Wait for the current assistant run to finish before applying review fixes.', type: 'warning' });
      return;
    }

    const match = this.findVerificationConversationMatch(conversationId);
    if (!match) {
      showToast({ message: 'Could not resolve the current verification context.', type: 'warning' });
      return;
    }

    const { spec, context, task, verification } = match;
    const inferredVerdict =
      verification.verdict ??
      (verification.status === 'needs-fix'
        ? 'needs-fix'
        : verification.status === 'incomplete'
          ? 'incomplete'
          : verification.status === 'passed'
            ? 'pass'
            : undefined);
    const hasReviewPayload =
      Boolean(verification.summary?.trim()) ||
      verification.findings.length > 0 ||
      verification.recommendations.length > 0;
    if (
      verification.status === 'running' ||
      (inferredVerdict === 'pass' && !verification.isStale) ||
      (!hasReviewPayload && inferredVerdict !== 'needs-fix' && inferredVerdict !== 'incomplete')
    ) {
      showToast({ message: 'This verification does not currently require follow-up fixes.', type: 'info' });
      return;
    }

    verification.isStale = true;
    spec.updatedAt = Date.now();
    await this.persistSpec(spec, context);
    if (this.activeSpec?.id === spec.id) {
      this.activeSpec = spec;
      this.activeContext = context;
    }

    const attachments = [
      { path: context.requirementsPath, content: spec.requirementsMarkdown, label: 'requirements.md' },
      { path: context.designPath, content: spec.designMarkdown, label: 'design.md' },
      { path: context.tasksPath, content: renderTasksMarkdown(spec), label: 'tasks.md' },
    ];

    for (const attachment of attachments) {
      if (!attachment.content.trim()) continue;
      assistantStore.attachFile(attachment.path, attachment.content, attachment.label);
    }

    const findings = verification.findings.length > 0
      ? verification.findings.map((finding, index) => `${index + 1}. ${finding}`).join('\n')
      : 'No explicit findings were captured.';
    const recommendations = verification.recommendations.length > 0
      ? verification.recommendations.map((entry, index) => `${index + 1}. ${entry}`).join('\n')
      : 'No extra recommendations were captured.';

    const prompt = [
      `Apply the verifier findings for spec task ${task.id}: ${task.title}.`,
      '',
      'Stay inside the original task scope. Fix what the review called out, but do not smuggle in unrelated scope.',
      'Treat the verifier findings below as the punch list.',
      'Do not edit requirements.md, design.md, or tasks.md directly.',
      'After the fixes, summarize what changed and what should be re-verified.',
      '',
      `Verifier status: ${verification.status}`,
      typeof verification.completenessScore === 'number' ? `Completeness score: ${verification.completenessScore}/10` : '',
      typeof verification.qualityScore === 'number' ? `Quality score: ${verification.qualityScore}/10` : '',
      typeof verification.specAdherenceScore === 'number' ? `Spec adherence score: ${verification.specAdherenceScore}/10` : '',
      verification.summary ? `Verifier summary: ${verification.summary}` : '',
      '',
      'Findings:',
      findings,
      '',
      'Recommendations:',
      recommendations,
    ].filter(Boolean).join('\n');

    assistantStore.setMode('agent');
    assistantStore.openPanel();
    assistantStore.setConversationTitle(`${task.id} · Fix Review`, conversationId);
    this.dispatchAssistantPrompt(prompt, {
      syntheticPrompt: buildSpecSyntheticPrompt(
        'spec-review-fix',
        `${task.id} · Fix Review`,
        task.title,
      ),
      suppressAutoTitle: true,
    });

    showToast({ message: `Queued review fixes for ${task.id} in this verifier chat.`, type: 'success' });
  }

  async reverifyConversationTask(conversationId: string | null | undefined): Promise<void> {
    if (!conversationId) return;
    const match = this.findVerificationConversationMatch(conversationId);
    if (!match) {
      showToast({ message: 'Could not resolve the current verification context.', type: 'warning' });
      return;
    }

    await this.startVerificationForTask(match.spec.id, match.task.id);
  }

  hasPendingDraftForConversation(conversationId: string | null | undefined): boolean {
    return Boolean(conversationId && this.pendingDraft?.conversationId === conversationId);
  }

  getSpecStateSummary(): Record<string, unknown> {
    return {
      activeFilePath: this.activeFilePath,
      hasPendingDraft: Boolean(this.pendingDraft),
      pendingDraft: this.pendingDraft
        ? {
            title: this.pendingDraft.title,
            slug: this.pendingDraft.slug,
            createdAt: this.pendingDraft.createdAt,
          }
        : null,
      activeSpec: this.activeSpec
        ? {
            id: this.activeSpec.id,
            slug: this.activeSpec.slug,
            title: this.activeSpec.title,
            status: this.activeSpec.status,
            phaseStates: this.activeSpec.phaseStates,
            staleFlags: this.activeSpec.staleFlags,
            taskCount: this.activeSpec.tasks.length,
            tasks: this.activeSpec.tasks.map((task) => ({
              id: task.id,
              title: task.title,
              status: task.status,
              dependencyIds: task.dependencyIds,
            })),
          }
        : null,
    };
  }

  stageRequirementsDraftFromTool(args: {
    title: string;
    slug: string;
    requirementsMarkdown: string;
  }): { message: string; slug: string } {
    const conversationId = assistantStore.currentConversation?.id;
    if (!conversationId) {
      throw new Error('A spec conversation is required before staging a requirements draft.');
    }

    this.pendingDraft = {
      conversationId,
      title: args.title.trim(),
      slug: slugify(args.slug.trim()),
      prompt: args.title.trim(),
      createdAt: Date.now(),
      requirementsMarkdown: ensureTrailingNewline(args.requirementsMarkdown),
      contextMentions: [],
    };

    return {
      slug: this.pendingDraft.slug,
      message: `Staged requirements for "${this.pendingDraft.title}". Ask the user to confirm with Create Requirements before writing .volt/specs/${this.pendingDraft.slug}/requirements.md.`,
    };
  }

  async writePhaseFromTool(args: {
    phase: 'requirements' | 'design' | 'tasks';
    title?: string;
    slug?: string;
    requirementsMarkdown?: string;
    designMarkdown?: string;
    tasks?: Array<Record<string, unknown>>;
  }): Promise<{ message: string; path: string }> {
    const workspaceRoot = projectStore.rootPath;
    if (!workspaceRoot) {
      throw new Error('Open a workspace before writing spec files.');
    }

    if (args.phase === 'requirements') {
      const content = ensureTrailingNewline(args.requirementsMarkdown ?? '');
      if (!content.trim()) {
        throw new Error('requirementsMarkdown is required for the requirements phase.');
      }

      const activeSpec = await this.reloadActiveSpec();
      if (activeSpec && this.activeContext) {
        activeSpec.requirementsMarkdown = content;
        activeSpec.phaseStates.requirements = 'ready';
        activeSpec.phaseStates.design = activeSpec.designMarkdown ? 'stale' : 'pending';
        activeSpec.phaseStates.tasks = activeSpec.tasks.length > 0 ? 'stale' : 'pending';
        activeSpec.staleFlags.design = true;
        activeSpec.staleFlags.tasks = true;
        activeSpec.updatedAt = Date.now();
        await this.persistSpec(activeSpec, this.activeContext);
        this.activeSpec = activeSpec;
        await editorStore.openFile(this.activeContext.requirementsPath);
        await this.revealSpecInTree(this.activeContext.requirementsPath);
        return {
          message: `Updated requirements.md for "${activeSpec.title}" and marked downstream artifacts stale.`,
          path: this.activeContext.requirementsPath,
        };
      }

      const title = args.title?.trim();
      if (!title) {
        throw new Error('title is required when creating a new spec from requirements.');
      }

      const confirmedSlug = await this.ensureUniqueSlug(args.slug || slugify(title), workspaceRoot);
      const spec: VoltSpecManifest = {
        version: 1,
        id: crypto.randomUUID(),
        slug: confirmedSlug,
        title,
        prompt: title,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: 'active',
        phaseStates: {
          requirements: 'ready',
          design: 'pending',
          tasks: 'pending',
        },
        staleFlags: {
          design: false,
          tasks: false,
        },
        requirementsMarkdown: content,
        designMarkdown: '',
        tasks: [],
      };
      const context = buildSpecContext(workspaceRoot, confirmedSlug);
      await this.persistSpec(spec, context, { writeDesign: false, writeTasks: false });
      this.activeSpec = spec;
      this.activeContext = context;
      this.pendingDraft = null;
      await editorStore.openFile(context.requirementsPath);
      await this.revealSpecInTree(context.requirementsPath);
      return {
        message: `Created "${title}" and wrote requirements.md in .volt/specs/${confirmedSlug}/.`,
        path: context.requirementsPath,
      };
    }

    const activeSpec = await this.reloadActiveSpec();
    if (!activeSpec || !this.activeContext) {
      throw new Error(`Open an existing spec before writing the ${args.phase} phase.`);
    }

    if (args.phase === 'design') {
      const content = ensureTrailingNewline(args.designMarkdown ?? '');
      if (!content.trim()) {
        throw new Error('designMarkdown is required for the design phase.');
      }

      activeSpec.designMarkdown = content;
      activeSpec.phaseStates.design = 'ready';
      activeSpec.phaseStates.tasks = activeSpec.tasks.length > 0 ? 'stale' : 'pending';
      activeSpec.staleFlags.design = false;
      activeSpec.staleFlags.tasks = true;
      activeSpec.updatedAt = Date.now();
      await this.persistSpec(activeSpec, this.activeContext);
      this.activeSpec = activeSpec;
      await editorStore.openFile(this.activeContext.designPath);
      await this.revealSpecInTree(this.activeContext.designPath);
      return {
        message: `Updated design.md for "${activeSpec.title}" and marked tasks.md as stale.`,
        path: this.activeContext.designPath,
      };
    }

    if (!Array.isArray(args.tasks) || args.tasks.length === 0) {
      throw new Error('tasks is required for the tasks phase.');
    }

    activeSpec.tasks = args.tasks.map((task, index) => sanitizeTask(task, index));
    activeSpec.phaseStates.tasks = 'ready';
    activeSpec.staleFlags.tasks = false;
    activeSpec.updatedAt = Date.now();
    await this.persistSpec(activeSpec, this.activeContext);
    this.activeSpec = activeSpec;
    await editorStore.openFile(this.activeContext.tasksPath);
    await this.revealSpecInTree(this.activeContext.tasksPath);
    return {
      message: `Updated tasks.md for "${activeSpec.title}" with ${activeSpec.tasks.length} task${activeSpec.tasks.length === 1 ? '' : 's'}.`,
      path: this.activeContext.tasksPath,
    };
  }

  async startTaskFromTool(taskId: string, retry = false): Promise<string> {
    if (retry) {
      await this.executeTask(taskId, true, true);
      return `Retried spec task ${taskId}. A fresh Agent chat was created for the retry run.`;
    }

    await this.executeTask(taskId, false, true);
    return `Started spec task ${taskId}. A fresh Agent chat was created for this run.`;
  }

  async openActiveSpecPhase(phase: 'requirements' | 'design' | 'tasks'): Promise<void> {
    if (!this.activeContext) return;
    const path =
      phase === 'requirements'
        ? this.activeContext.requirementsPath
        : phase === 'design'
          ? this.activeContext.designPath
          : this.activeContext.tasksPath;
    await editorStore.openFile(path);
    await this.revealSpecInTree(path);
  }

  async continueActiveSpec(): Promise<void> {
    if (!this.activeSpec || !this.activeContext) return;
    const spec = await this.reloadActiveSpec();
    if (!spec) return;
    const phase = this.activeFilePath ? phaseFromPath(this.activeFilePath) : null;

    if (phase === 'requirements') {
      if (!spec.designMarkdown || spec.staleFlags.design || spec.phaseStates.design !== 'ready') {
        await this.generateDesign(spec, 'design');
        return;
      }

      await this.openActiveSpecPhase('design');
      showToast({ message: 'Opened design.md.', type: 'info' });
      return;
    }

    if (phase === 'design') {
      if (spec.tasks.length === 0 || spec.staleFlags.tasks || spec.phaseStates.tasks !== 'ready') {
        await this.generateTasks(spec, 'tasks');
        return;
      }

      await this.openActiveSpecPhase('tasks');
      showToast({ message: 'Opened tasks.md.', type: 'info' });
      return;
    }

    await this.openActiveSpecPhase('tasks');
    showToast({ message: 'Opened tasks.md.', type: 'info' });
  }

  async syncActiveSpec(): Promise<void> {
    if (!this.activeSpec || !this.activeContext) return;
    const spec = await this.reloadActiveSpec();
    if (!spec) return;

    const phase = this.activeFilePath ? phaseFromPath(this.activeFilePath) : null;
    if (phase === 'requirements') {
      const designUpdated =
        !spec.designMarkdown || spec.staleFlags.design || spec.phaseStates.design !== 'ready'
          ? await this.generateDesign(spec, 'sync-design')
          : true;
      if (!designUpdated) return;
      const refreshed = await this.reloadActiveSpec();
      if (
        refreshed &&
        (refreshed.tasks.length === 0 ||
          refreshed.staleFlags.tasks ||
          refreshed.phaseStates.tasks !== 'ready')
      ) {
        await this.generateTasks(refreshed, 'sync-tasks');
      }
      return;
    }

    if (phase === 'design' && (spec.tasks.length === 0 || spec.staleFlags.tasks || spec.phaseStates.tasks !== 'ready')) {
      await this.generateTasks(spec, 'sync-tasks');
      return;
    }

    showToast({ message: 'No stale downstream spec files need syncing.', type: 'info' });
  }

  async startTask(taskId: string): Promise<void> {
    await this.executeTask(taskId, false, false);
  }

  async retryTask(taskId: string): Promise<void> {
    await this.executeTask(taskId, true, false);
  }

  async verifyTask(taskId: string): Promise<void> {
    if (!this.activeSpec) return;
    await this.startVerificationForTask(this.activeSpec.id, taskId);
  }

  async runAllReadyTasks(): Promise<void> {
    if (!this.activeSpec) return;
    const spec = await this.reloadActiveSpec();
    if (!spec) return;

    const pending = spec.tasks
      .filter((task) => task.status === 'todo')
      .filter((task) => task.dependencyIds.every((dependencyId) => spec.tasks.find((candidate) => candidate.id === dependencyId)?.status === 'done'))
      .map((task) => task.id);

    if (pending.length === 0) {
      showToast({ message: 'No dependency-ready tasks are available to run.', type: 'info' });
      return;
    }

    this.runAllQueue = {
      specId: spec.id,
      pendingTaskIds: pending,
    };

    showToast({ message: `Queued ${pending.length} task${pending.length === 1 ? '' : 's'} for execution.`, type: 'success' });
    await this.kickRunAllQueue();
  }

  scheduleAssistantRuntimeSync(): void {
    this.runtimeSyncRequested = true;
    if (this.runtimeSyncTimer || this.runtimeSyncInFlight) return;

    this.runtimeSyncTimer = setTimeout(() => {
      this.runtimeSyncTimer = null;
      void this.flushAssistantRuntimeSync();
    }, 40);
  }

  private async flushAssistantRuntimeSync(): Promise<void> {
    if (this.runtimeSyncInFlight) return;
    this.runtimeSyncInFlight = true;

    try {
      while (this.runtimeSyncRequested) {
        this.runtimeSyncRequested = false;
        await this.syncAssistantRuntimeNow();
      }
    } finally {
      this.runtimeSyncInFlight = false;
      if (this.runtimeSyncRequested && !this.runtimeSyncTimer) {
        this.scheduleAssistantRuntimeSync();
      }
    }
  }

  async syncAssistantRuntime(): Promise<void> {
    this.runtimeSyncRequested = true;
    await this.flushAssistantRuntimeSync();
  }

  private async syncAssistantRuntimeNow(): Promise<void> {
    const updates = Array.from(this.trackedConversationToSpec.entries());
    for (const [conversationId, tracked] of updates) {
      const runState = assistantStore.getConversationRunState(conversationId);
      if (!runState) {
        if (!assistantStore.hasOpenConversationTab(conversationId)) {
          this.trackedConversationToSpec.delete(conversationId);
          this.trackedRunSignature.delete(`${tracked.specId}:${tracked.taskId}:${tracked.runId}`);
        }
        continue;
      }

      const messages = assistantStore.getConversationMessages(conversationId);
      const latestAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
      await this.applyTaskRunSync(tracked.specId, tracked.taskId, tracked.runId, {
        conversationId,
        isStreaming: runState.isStreaming,
        agentLoopState: runState.agentLoopState,
        updatedAt: runState.updatedAt,
        lastError: runState.lastError,
        assistantExcerpt: summarizeAssistantExcerpt(latestAssistant?.content),
      });
    }

    const verificationUpdates = Array.from(this.trackedConversationToVerification.entries());
    for (const [conversationId, tracked] of verificationUpdates) {
      const runState = assistantStore.getConversationRunState(conversationId);
      if (!runState) {
        if (!assistantStore.hasOpenConversationTab(conversationId)) {
          this.trackedConversationToVerification.delete(conversationId);
          this.trackedVerificationSignature.delete(`${tracked.specId}:${tracked.taskId}:verify:${tracked.verificationId}`);
        }
        continue;
      }

      const messages = assistantStore.getConversationMessages(conversationId);
      const latestAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
      await this.applyTaskVerificationSync(
        tracked.specId,
        tracked.taskId,
        tracked.verificationId,
        {
          conversationId,
          isStreaming: runState.isStreaming,
          agentLoopState: runState.agentLoopState,
          updatedAt: runState.updatedAt,
          lastError: runState.lastError,
          assistantExcerpt: summarizeAssistantExcerpt(latestAssistant?.content),
        },
        latestAssistant?.content,
      );
    }

    await this.kickRunAllQueue();
  }

  private async loadSpecForPath(path: string): Promise<{ spec: VoltSpecManifest; context: VoltSpecContext }> {
    const rootPath = projectStore.rootPath;
    if (!rootPath) {
      throw new Error('Workspace root is not available.');
    }

    const normalized = normalizePath(path);
    const match = normalized.match(/\/\.volt\/specs\/([^/]+)/);
    if (!match?.[1]) {
      throw new Error(`Path is not inside .volt/specs: ${path}`);
    }

    const slug = match[1];
    const context = buildSpecContext(rootPath, slug);
    const cached = this.cache.get(context.manifestPath);
    if (cached) {
      await this.reconcileTaskStatusesFromSource(cached, context);
      return { spec: cached, context };
    }

    const raw = await readFileQuiet(context.manifestPath);
    if (!raw) {
      throw new Error(`Spec manifest not found: ${context.manifestPath}`);
    }

    const spec = JSON.parse(raw) as VoltSpecManifest;
    this.hydrateSpecManifest(spec);
    await this.reconcileTaskStatusesFromSource(spec, context);
    this.cache.set(context.manifestPath, spec);
    this.trackSpecRuns(spec);
    return { spec, context };
  }

  private async reloadActiveSpec(): Promise<VoltSpecManifest | null> {
    if (!this.activeContext) return null;
    const raw = await readFileQuiet(this.activeContext.manifestPath);
    if (!raw) return null;
    const spec = JSON.parse(raw) as VoltSpecManifest;
    this.hydrateSpecManifest(spec);
    await this.reconcileTaskStatusesFromSource(spec, this.activeContext);
    this.cache.set(this.activeContext.manifestPath, spec);
    this.trackSpecRuns(spec);
    this.activeSpec = spec;
    return spec;
  }

  private async persistSpec(
    spec: VoltSpecManifest,
    context: VoltSpecContext,
    options?: {
      writeRequirements?: boolean;
      writeDesign?: boolean;
      writeTasks?: boolean;
    },
  ): Promise<void> {
    await this.ensureDirQuiet(`${context.rootPath}/.volt`);
    await this.ensureDirQuiet(`${context.rootPath}/.volt/specs`);
    await this.ensureDirQuiet(context.specDir);
    await writeFileQuiet(context.manifestPath, `${JSON.stringify(spec, null, 2)}\n`);
    this.cache.set(context.manifestPath, spec);

    if (options?.writeRequirements !== false) {
      await writeFileQuiet(context.requirementsPath, ensureTrailingNewline(spec.requirementsMarkdown));
    }
    if (options?.writeDesign !== false) {
      await writeFileQuiet(context.designPath, ensureTrailingNewline(spec.designMarkdown));
    }
    const activeTasksPath = editorStore.activeFile?.path ? normalizePath(editorStore.activeFile.path) : null;
    const shouldProtectActiveTaskDraft =
      activeTasksPath === context.tasksPath &&
      editorStore.isDirty(context.tasksPath);
    if (options?.writeTasks !== false && !shouldProtectActiveTaskDraft) {
      await writeFileQuiet(context.tasksPath, renderTasksMarkdown(spec));
    }
  }

  private async ensureUniqueSlug(baseSlug: string, rootPath: string): Promise<string> {
    const normalizedRoot = normalizePath(rootPath);
    let candidate = slugify(baseSlug);
    let attempt = 2;

    while (await getFileInfoQuiet(`${normalizedRoot}/.volt/specs/${candidate}/spec.json`)) {
      candidate = `${slugify(baseSlug)}-${attempt}`;
      attempt += 1;
    }

    return candidate;
  }

  private async ensureDirQuiet(path: string): Promise<void> {
    try {
      await invoke('create_dir', { path });
    } catch {
      // Directory may already exist.
    }
  }

  private hydrateSpecManifest(spec: VoltSpecManifest): void {
    spec.tasks = (spec.tasks ?? []).map((task) => ({
      ...task,
      runs: Array.isArray(task.runs) ? task.runs : [],
      verifications: Array.isArray(task.verifications) ? task.verifications : [],
      latestVerificationId:
        typeof task.latestVerificationId === 'string' && task.latestVerificationId.trim().length > 0
          ? task.latestVerificationId
          : undefined,
    }));
  }

  private applyTaskCheckboxOverrides(spec: VoltSpecManifest, markdown: string): boolean {
    if (spec.tasks.length === 0) return false;

    const overrides = parseTaskCheckboxStates(markdown, spec.tasks.map((task) => task.id));
    let changed = false;

    for (const task of spec.tasks) {
      const override = overrides.get(task.id);
      if (!override) continue;

      const latestRun = task.latestRunId
        ? task.runs.find((entry) => entry.runId === task.latestRunId)
        : undefined;

      if (latestRun?.status === 'running') {
        continue;
      }

      if (override === 'done' && task.status !== 'done') {
        task.status = 'done';
        if (latestRun) {
          latestRun.lastStatusMessage = 'Marked complete manually';
          latestRun.error = undefined;
        }
        changed = true;
      } else if (override === 'todo' && task.status !== 'todo') {
        task.status = 'todo';
        this.markTaskVerificationsStale(task);
        if (latestRun) {
          latestRun.lastStatusMessage = 'Marked todo manually';
        }
        changed = true;
      }
    }

    return changed;
  }

  private async reconcileTaskStatusesFromSource(spec: VoltSpecManifest, context: VoltSpecContext): Promise<void> {
    if (spec.tasks.length === 0) return;
    const activeFile = editorStore.activeFile;
    const activeFilePath = activeFile?.path ? normalizePath(activeFile.path) : null;
    const liveEditorTasksContent = activeFilePath === context.tasksPath ? activeFile?.content ?? null : null;
    const tasksMarkdown = liveEditorTasksContent ?? await readFileQuiet(context.tasksPath);
    if (!tasksMarkdown) return;

    const changed = this.applyTaskCheckboxOverrides(spec, tasksMarkdown);
    if (!changed) return;

    spec.updatedAt = Date.now();
    await this.persistSpec(spec, context, { writeTasks: false });
  }

  private async runSpecPlanner(options: {
    operation: SpecOperation;
    prompt: string;
    conversationSummary: string;
    contextMentions: AttachedContext[];
    applyResult: (payload: SpecResponsePayload) => Promise<string>;
  }): Promise<boolean> {
    if (this.isBusy) {
      showToast({ message: 'A spec operation is already running.', type: 'warning' });
      return false;
    }

    if (!assistantStore.currentConversation || assistantStore.currentMode !== 'spec') {
      assistantStore.newConversation();
    }

    assistantStore.openPanel();
    assistantStore.setMode('spec');
    this.isBusy = true;
    this.busyLabel =
      options.operation === 'create'
        ? 'Drafting requirements'
        : options.operation === 'design'
          ? 'Generating design'
          : 'Generating tasks';
    this.lastError = null;

    const syntheticPrompt =
      options.operation === 'create'
        ? buildSpecSyntheticPrompt('spec-phase', 'Spec · Requirements Draft', options.conversationSummary)
        : options.operation === 'design' || options.operation === 'sync-design'
          ? buildSpecSyntheticPrompt('spec-phase', 'Spec · Design', options.conversationSummary)
          : buildSpecSyntheticPrompt('spec-phase', 'Spec · Tasks', options.conversationSummary);

    assistantStore.addUserMessage(
      options.conversationSummary,
      options.contextMentions,
      undefined,
      {
        syntheticPrompt,
        suppressAutoTitle: true,
      },
    );

    const controller = assistantStore.startStreaming();
    const assistantMessageId = assistantStore.addAssistantMessage(`${this.busyLabel}...`, true);
    let finalText = '';
    let errorMessage: string | null = null;

    try {
      const request = {
        messages: [{ role: 'user' as const, content: options.prompt }],
        systemPrompt: buildSpecPrompt({
          provider: aiSettingsStore.selectedProvider,
          workspaceRoot: projectStore.rootPath ?? undefined,
        }),
        temperature: 0.2,
        maxTokens: 12_000,
      };

      for await (const chunk of streamChat(request, 'spec', controller.signal)) {
        if (chunk.type === 'content' && chunk.content) {
          finalText += chunk.content;
        } else if (chunk.type === 'thinking' && chunk.thinking) {
          assistantStore.appendThinkingToMessage(assistantMessageId, chunk.thinking);
        } else if (chunk.type === 'error') {
          errorMessage = chunk.error ?? 'Spec generation failed.';
          break;
        }
      }

      if (errorMessage) {
        throw new Error(errorMessage);
      }

      const payload = parseTaggedJson<SpecResponsePayload>(finalText);
      if (!payload) {
        throw new Error('Spec response did not include a valid <volt-spec-json> payload.');
      }

      const summary = await options.applyResult(payload);
      assistantStore.finalizeThinking(assistantMessageId);
      assistantStore.updateAssistantMessage(assistantMessageId, summary, false);
      assistantStore.markAssistantMessageStreamState(assistantMessageId, 'completed');
      if (assistantStore.currentConversation?.id) {
        assistantStore.completeStreamingForConversation(assistantStore.currentConversation.id, 'completed');
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Spec generation failed.';
      this.lastError = message;
      assistantStore.finalizeThinking(assistantMessageId);
      assistantStore.markAssistantMessageStreamState(assistantMessageId, 'failed', message);
      if (assistantStore.currentConversation?.id) {
        assistantStore.completeStreamingForConversation(assistantStore.currentConversation.id, 'failed', message);
      }
      showToast({ message, type: 'error' });
      return false;
    } finally {
      this.isBusy = false;
      this.busyLabel = '';
    }
  }

  private async generateDesign(spec: VoltSpecManifest, operation: SpecOperation): Promise<boolean> {
    return await this.runSpecPlanner({
      operation,
      prompt: buildDesignPrompt(spec),
      conversationSummary: `Generate design for spec "${spec.title}"`,
      contextMentions: [],
      applyResult: async (payload) => {
        const nextSpec = await this.reloadActiveSpec();
        if (!nextSpec || !this.activeContext) {
          throw new Error('Unable to reload the current spec before saving design output.');
        }
        if (!payload.designMarkdown?.trim()) {
          throw new Error('Spec response did not include designMarkdown.');
        }

        nextSpec.designMarkdown = ensureTrailingNewline(payload.designMarkdown || '');
        nextSpec.phaseStates.design = 'ready';
        nextSpec.phaseStates.tasks = nextSpec.tasks.length > 0 ? 'stale' : 'pending';
        nextSpec.staleFlags.design = false;
        nextSpec.staleFlags.tasks = true;
        nextSpec.updatedAt = Date.now();

        await this.persistSpec(nextSpec, this.activeContext);
        this.activeSpec = nextSpec;
        await editorStore.openFile(this.activeContext.designPath);
        return `Updated design.md for "${nextSpec.title}" and marked tasks.md as stale.`;
      },
    });
  }

  private async generateTasks(spec: VoltSpecManifest, operation: SpecOperation): Promise<boolean> {
    return await this.runSpecPlanner({
      operation,
      prompt: buildTasksPrompt(spec),
      conversationSummary: `Generate tasks for spec "${spec.title}"`,
      contextMentions: [],
      applyResult: async (payload) => {
        const nextSpec = await this.reloadActiveSpec();
        if (!nextSpec || !this.activeContext) {
          throw new Error('Unable to reload the current spec before saving task output.');
        }
        if (!Array.isArray(payload.tasks) || payload.tasks.length === 0) {
          throw new Error('Spec response did not include any tasks.');
        }

        nextSpec.tasks = (payload.tasks ?? []).map((task, index) => sanitizeTask(task, index));
        nextSpec.phaseStates.tasks = 'ready';
        nextSpec.staleFlags.tasks = false;
        nextSpec.updatedAt = Date.now();

        await this.persistSpec(nextSpec, this.activeContext);
        this.activeSpec = nextSpec;
        await editorStore.openFile(this.activeContext.tasksPath);
        return `Updated tasks.md for "${nextSpec.title}" with ${nextSpec.tasks.length} executable task${nextSpec.tasks.length === 1 ? '' : 's'}.`;
      },
    });
  }

  private async revealSpecInTree(path: string): Promise<void> {
    if (!projectStore.rootPath) return;
    await projectStore.refreshTree();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('reveal-file', { detail: { path } }));
    }
  }

  private async executeTask(taskId: string, isRetry: boolean, allowDuringStreaming: boolean): Promise<void> {
    if (!this.activeSpec || !this.activeContext) return;

    if (assistantStore.isStreaming && !allowDuringStreaming) {
      showToast({ message: 'Wait for the current assistant run to finish before starting another task.', type: 'warning' });
      return;
    }

    const spec = await this.reloadActiveSpec();
    if (!spec || !this.activeContext) return;

    const task = spec.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      showToast({ message: `Task ${taskId} was not found.`, type: 'error' });
      return;
    }

    const unmetDependency = task.dependencyIds.find((dependencyId) => spec.tasks.find((candidate) => candidate.id === dependencyId)?.status !== 'done');
    if (unmetDependency) {
      showToast({ message: `Task ${task.id} is blocked by dependency ${unmetDependency}.`, type: 'warning' });
      return;
    }

    const runId = crypto.randomUUID();
    const run: VoltSpecTaskRun = {
      runId,
      taskId: task.id,
      conversationId: '',
      status: 'running',
      startedAt: Date.now(),
      lastStatusMessage: isRetry ? 'Retry queued' : 'Queued',
    };

    this.markTaskVerificationsStale(task);
    task.status = 'running';
    task.latestRunId = runId;
    task.runs = [...task.runs, run];
    spec.updatedAt = Date.now();
    await this.persistSpec(spec, this.activeContext);
    this.activeSpec = spec;

    assistantStore.newConversation();
    assistantStore.setMode('agent');
    assistantStore.openPanel();

    const conversationId = assistantStore.currentConversation?.id;
    if (!conversationId) {
      showToast({ message: 'Failed to create a task conversation.', type: 'error' });
      return;
    }
    assistantStore.setConversationTitle(`${task.id} · ${isRetry ? 'Retry' : 'Build'}`, conversationId);

    const latestSpec = await this.reloadActiveSpec();
    if (!latestSpec || !this.activeContext) return;
    const latestTask = latestSpec.tasks.find((entry) => entry.id === task.id);
    if (!latestTask) return;
    const latestRun = latestTask.runs.find((entry) => entry.runId === runId);
    if (!latestRun) return;

    latestRun.conversationId = conversationId;
    this.trackedConversationToSpec.set(conversationId, {
      specId: latestSpec.id,
      taskId: latestTask.id,
      runId,
    });

    await this.persistSpec(latestSpec, this.activeContext);
    await this.writeRunSnapshot(this.activeContext, latestTask, latestRun);
    await this.appendRunEvent(this.activeContext, latestTask, latestRun, {
      at: Date.now(),
      type: isRetry ? 'queued' : 'created',
      message: isRetry ? 'Retry queued' : 'Task run created',
    });

    const attachments = [
      { path: this.activeContext.requirementsPath, content: latestSpec.requirementsMarkdown, label: 'requirements.md' },
      { path: this.activeContext.designPath, content: latestSpec.designMarkdown, label: 'design.md' },
      { path: this.activeContext.tasksPath, content: renderTasksMarkdown(latestSpec), label: 'tasks.md' },
    ];

    for (const attachment of attachments) {
      if (!attachment.content.trim()) continue;
      assistantStore.attachFile(attachment.path, attachment.content, attachment.label);
    }

    const prompt = [
      `${isRetry ? 'Retry' : 'Execute'} spec task ${latestTask.id}: ${latestTask.title}`,
      '',
      `Spec: ${latestSpec.title}`,
      `Summary: ${latestTask.summary || 'No summary provided.'}`,
      latestTask.requirementIds.length > 0 ? `Requirements: ${latestTask.requirementIds.join(', ')}` : '',
      latestTask.dependencyIds.length > 0 ? `Dependencies: ${latestTask.dependencyIds.join(', ')}` : '',
      latestTask.scopeHints.length > 0 ? `Scope hints: ${latestTask.scopeHints.join(', ')}` : '',
      `Verification: ${latestTask.verification}`,
      '',
      'Rules:',
      '1. Read the attached requirements, design, and tasks files first.',
      '2. Stay inside this task scope.',
      '3. Do not edit requirements.md, design.md, or tasks.md. Volt manages spec artifacts and task state.',
      '4. Verify before declaring completion.',
      '5. If blocked, stop and report the blocker clearly.',
    ].filter(Boolean).join('\n');

    this.dispatchAssistantPrompt(prompt, {
      syntheticPrompt: buildSpecSyntheticPrompt(
        'spec-task',
        `${latestTask.id} · ${isRetry ? 'Retry' : 'Build'}`,
        latestTask.title,
      ),
      suppressAutoTitle: true,
    });
    await editorStore.openFile(this.activeContext.tasksPath);
  }

  private async applyTaskRunSync(
    specId: string,
    taskId: string,
    runId: string,
    input: TaskRunSyncInput,
  ): Promise<void> {
    const spec = Array.from(this.cache.values()).find((entry) => entry.id === specId);
    const context = spec && projectStore.rootPath ? buildSpecContext(projectStore.rootPath, spec.slug) : null;
    if (!spec || !context) return;

    const task = spec.tasks.find((entry) => entry.id === taskId);
    const run = task?.runs.find((entry) => entry.runId === runId);
    if (!task || !run) return;
    const trackedKey = `${specId}:${taskId}:${runId}`;

    // A spec task run is a single execution. Once it reaches a terminal state,
    // later chat turns in the same conversation must not mutate that run.
    if (run.status !== 'running' && run.endedAt) {
      this.trackedConversationToSpec.delete(input.conversationId);
      this.trackedRunSignature.delete(trackedKey);
      return;
    }

    const nextStatus =
      input.agentLoopState === 'failed'
        ? 'failed'
        : input.agentLoopState === 'cancelled'
          ? 'cancelled'
          : isRuntimeActive(input.agentLoopState, input.isStreaming)
            ? 'running'
            : 'completed';

    const nextMessage =
      input.agentLoopState === 'waiting_tool'
        ? 'Waiting for tool'
        : input.agentLoopState === 'waiting_approval'
          ? 'Waiting for approval'
          : input.agentLoopState === 'completing'
            ? 'Verifying completion'
            : input.agentLoopState === 'failed'
              ? (input.lastError || 'Task failed')
              : input.agentLoopState === 'cancelled'
                ? 'Task cancelled'
                : nextStatus === 'completed'
                  ? 'Task completed'
                  : 'Running';

    const signature = `${nextStatus}:${nextMessage}:${input.assistantExcerpt ?? ''}`;
    if (this.trackedRunSignature.get(trackedKey) === signature) return;
    this.trackedRunSignature.set(trackedKey, signature);

    run.status = nextStatus;
    run.lastStatusMessage = nextMessage;
    run.lastAssistantExcerpt = input.assistantExcerpt;
    run.error = nextStatus === 'failed' ? (input.lastError ?? run.error) : undefined;
    if (nextStatus !== 'running') {
      run.endedAt = input.updatedAt;
    }

    if (task.latestRunId === runId) {
      task.status =
        nextStatus === 'completed'
          ? 'done'
          : nextStatus === 'failed' || nextStatus === 'cancelled'
            ? 'failed'
            : 'running';
    }

    spec.updatedAt = Date.now();
    await this.persistSpec(spec, context);
    await this.writeRunSnapshot(context, task, run);
    await this.appendRunEvent(context, task, run, {
      at: Date.now(),
      type:
        nextStatus === 'completed'
          ? 'completed'
          : nextStatus === 'failed'
            ? 'failed'
            : nextStatus === 'cancelled'
              ? 'cancelled'
              : input.agentLoopState === 'waiting_tool'
                ? 'waiting_tool'
                : input.agentLoopState === 'waiting_approval'
                  ? 'waiting_approval'
                  : input.agentLoopState === 'completing'
                    ? 'completing'
                    : 'running',
      message: nextMessage,
      assistantExcerpt: input.assistantExcerpt,
    });

    if (this.activeSpec?.id === spec.id) {
      this.activeSpec = spec;
    }

    if (nextStatus !== 'running') {
      this.trackedConversationToSpec.delete(input.conversationId);
      this.trackedRunSignature.delete(trackedKey);
    }
  }

  private async applyTaskVerificationSync(
    specId: string,
    taskId: string,
    verificationId: string,
    input: TaskRunSyncInput,
    assistantContent?: string,
  ): Promise<void> {
    const spec = Array.from(this.cache.values()).find((entry) => entry.id === specId);
    const context = spec && projectStore.rootPath ? buildSpecContext(projectStore.rootPath, spec.slug) : null;
    if (!spec || !context) return;

    const task = spec.tasks.find((entry) => entry.id === taskId);
    const verification = task?.verifications.find((entry) => entry.verificationId === verificationId);
    if (!task || !verification) return;
    const trackedKey = `${specId}:${taskId}:verify:${verificationId}`;

    if (verification.status !== 'running' && verification.completedAt) {
      if (input.updatedAt > verification.completedAt && !verification.isStale) {
        verification.isStale = true;
        spec.updatedAt = Date.now();
        await this.persistSpec(spec, context);

        if (this.activeSpec?.id === spec.id) {
          this.activeSpec = spec;
        }
      }
      this.trackedConversationToVerification.delete(input.conversationId);
      this.trackedVerificationSignature.delete(trackedKey);
      return;
    }

    const parsedPayload = normalizeVerificationPayload(
      assistantContent ? parseVerificationTaggedJson(assistantContent) : null,
    );

    const nextStatus: VoltSpecTaskVerification['status'] =
      input.agentLoopState === 'failed'
        ? 'failed'
        : input.agentLoopState === 'cancelled'
          ? 'cancelled'
          : isRuntimeActive(input.agentLoopState, input.isStreaming)
            ? 'running'
            : parsedPayload?.verdict === 'pass'
              ? 'passed'
              : parsedPayload?.verdict === 'needs-fix'
                ? 'needs-fix'
                : parsedPayload?.verdict === 'incomplete'
                  ? 'incomplete'
                  : 'failed';

    const nextMessage =
      nextStatus === 'running'
        ? (input.agentLoopState === 'waiting_tool'
            ? 'Verifier is inspecting tools'
            : input.agentLoopState === 'waiting_approval'
              ? 'Verifier is waiting for approval'
              : input.agentLoopState === 'completing'
                ? 'Verifier is wrapping up'
                : 'Verification running')
        : nextStatus === 'passed'
          ? 'Verification passed'
          : nextStatus === 'needs-fix'
            ? 'Verification found fixes'
            : nextStatus === 'incomplete'
              ? 'Verification marked task incomplete'
              : nextStatus === 'cancelled'
                ? 'Verification cancelled'
                : (input.lastError || 'Verification failed');

    const signature = `${nextStatus}:${nextMessage}:${assistantContent ?? ''}`;
    if (this.trackedVerificationSignature.get(trackedKey) === signature) return;
    this.trackedVerificationSignature.set(trackedKey, signature);

    verification.status = nextStatus;
    verification.lastAssistantExcerpt = input.assistantExcerpt;
    verification.error = nextStatus === 'failed' ? (input.lastError ?? 'Verification failed') : undefined;

    if (parsedPayload) {
      verification.verdict = parsedPayload.verdict;
      verification.summary = parsedPayload.summary;
      verification.completenessScore = parsedPayload.completenessScore;
      verification.qualityScore = parsedPayload.qualityScore;
      verification.specAdherenceScore = parsedPayload.specAdherenceScore;
      verification.findings = parsedPayload.findings ?? [];
      verification.recommendations = parsedPayload.recommendations ?? [];
      verification.isStale = false;
    }

    if (nextStatus !== 'running') {
      verification.completedAt = input.updatedAt;
    }

    spec.updatedAt = Date.now();
    await this.persistSpec(spec, context);

    if (this.activeSpec?.id === spec.id) {
      this.activeSpec = spec;
    }

    if (nextStatus !== 'running') {
      this.trackedConversationToVerification.delete(input.conversationId);
      this.trackedVerificationSignature.delete(trackedKey);
    }
  }

  private async appendRunEvent(
    context: VoltSpecContext,
    task: VoltSpecTask,
    run: VoltSpecTaskRun,
    event: SpecTaskRunEvent,
  ): Promise<void> {
    const runDir = `${context.specDir}/runs/${task.id}`;
    await this.ensureDirQuiet(`${context.specDir}/runs`);
    await this.ensureDirQuiet(runDir);
    const ndjsonPath = `${runDir}/${run.runId}.ndjson`;
    const existing = (await readFileQuiet(ndjsonPath)) ?? '';
    await writeFileQuiet(ndjsonPath, `${existing}${JSON.stringify(event)}\n`);
  }

  private async writeRunSnapshot(
    context: VoltSpecContext,
    task: VoltSpecTask,
    run: VoltSpecTaskRun,
  ): Promise<void> {
    const runDir = `${context.specDir}/runs/${task.id}`;
    await this.ensureDirQuiet(`${context.specDir}/runs`);
    await this.ensureDirQuiet(runDir);
    await writeFileQuiet(`${runDir}/${run.runId}.json`, `${JSON.stringify(run, null, 2)}\n`);
  }

  private async kickRunAllQueue(): Promise<void> {
    if (!this.runAllQueue || !this.activeSpec) return;
    if (assistantStore.isStreaming) return;
    if (this.runAllQueue.specId !== this.activeSpec.id) return;
    const refreshed = await this.reloadActiveSpec();
    if (!refreshed) return;

    const readyFromLatest = refreshed.tasks
      .filter((task) => task.status === 'todo')
      .filter((task) =>
        task.dependencyIds.every(
          (dependencyId) => refreshed.tasks.find((candidate) => candidate.id === dependencyId)?.status === 'done',
        ),
      )
      .map((task) => task.id);

    const pendingTaskIds = Array.from(new Set([...this.runAllQueue.pendingTaskIds, ...readyFromLatest]));
    if (pendingTaskIds.length === 0) {
      this.runAllQueue = null;
      showToast({ message: 'Run all tasks queue completed.', type: 'success' });
      return;
    }

    const [nextTaskId, ...rest] = pendingTaskIds;
    this.runAllQueue = { ...this.runAllQueue, pendingTaskIds: rest };
    await this.executeTask(nextTaskId, false, false);
  }

  private trackSpecRuns(spec: VoltSpecManifest): void {
    for (const task of spec.tasks) {
      for (const run of task.runs) {
        if (!run.conversationId || run.status !== 'running' || Boolean(run.endedAt)) continue;
        this.trackedConversationToSpec.set(run.conversationId, {
          specId: spec.id,
          taskId: task.id,
          runId: run.runId,
        });
      }
      for (const verification of task.verifications) {
        if (!verification.conversationId || verification.status !== 'running' || Boolean(verification.completedAt)) continue;
        this.trackedConversationToVerification.set(verification.conversationId, {
          specId: spec.id,
          taskId: task.id,
          verificationId: verification.verificationId,
        });
      }
    }
  }

  private markTaskVerificationsStale(task: VoltSpecTask): void {
    for (const verification of task.verifications) {
      if (verification.status === 'running') continue;
      verification.isStale = true;
    }
  }

  private findVerificationConversationMatch(conversationId: string): {
    spec: VoltSpecManifest;
    context: VoltSpecContext;
    task: VoltSpecTask;
    verification: VoltSpecTaskVerification;
  } | null {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId || !projectStore.rootPath) return null;

    for (const spec of this.cache.values()) {
      const task = spec.tasks.find((entry) =>
        entry.verifications.some((verification) => verification.conversationId === normalizedConversationId),
      );
      if (!task) continue;
      const verification = task.verifications.find((entry) => entry.conversationId === normalizedConversationId);
      if (!verification) continue;
      return {
        spec,
        context: buildSpecContext(projectStore.rootPath, spec.slug),
        task,
        verification,
      };
    }

    return null;
  }

  private async startVerificationForTask(specId: string, taskId: string): Promise<void> {
    if (assistantStore.isStreaming) {
      showToast({ message: 'Wait for the current assistant run to finish before starting verification.', type: 'warning' });
      return;
    }

    const activeSpecMatch =
      this.activeSpec?.id === specId && this.activeContext
        ? { spec: this.activeSpec, context: this.activeContext }
        : null;
    const cachedSpec = activeSpecMatch?.spec ?? Array.from(this.cache.values()).find((entry) => entry.id === specId);
    const context = activeSpecMatch?.context ?? (cachedSpec && projectStore.rootPath
      ? buildSpecContext(projectStore.rootPath, cachedSpec.slug)
      : null);
    if (!cachedSpec || !context) return;

    const raw = await readFileQuiet(context.manifestPath);
    const spec = raw ? (JSON.parse(raw) as VoltSpecManifest) : cachedSpec;
    this.hydrateSpecManifest(spec);
    await this.reconcileTaskStatusesFromSource(spec, context);
    this.cache.set(context.manifestPath, spec);
    this.trackSpecRuns(spec);

    const task = spec.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      showToast({ message: `Task ${taskId} was not found.`, type: 'error' });
      return;
    }

    if (task.status !== 'done') {
      showToast({ message: `Task ${task.id} must be completed before it can be verified.`, type: 'warning' });
      return;
    }

    const latestRun = task.latestRunId
      ? task.runs.find((entry) => entry.runId === task.latestRunId)
      : undefined;

    const verificationId = crypto.randomUUID();
    const verification: VoltSpecTaskVerification = {
      verificationId,
      conversationId: '',
      status: 'running',
      createdAt: Date.now(),
      findings: [],
      recommendations: [],
      lastAssistantExcerpt: latestRun?.lastAssistantExcerpt,
      isStale: false,
    };

    this.markTaskVerificationsStale(task);
    task.latestVerificationId = verificationId;
    task.verifications = [...task.verifications, verification];
    spec.updatedAt = Date.now();
    await this.persistSpec(spec, context);
    if (this.activeSpec?.id === spec.id) {
      this.activeSpec = spec;
      this.activeContext = context;
    }

    assistantStore.newConversation();
    assistantStore.setMode('agent');
    assistantStore.openPanel();

    const conversationId = assistantStore.currentConversation?.id;
    if (!conversationId) {
      showToast({ message: 'Failed to create a verification conversation.', type: 'error' });
      return;
    }
    assistantStore.setConversationTitle(`${task.id} · Verify`, conversationId);

    const refreshedRaw = await readFileQuiet(context.manifestPath);
    const refreshedSpec = refreshedRaw ? (JSON.parse(refreshedRaw) as VoltSpecManifest) : spec;
    this.hydrateSpecManifest(refreshedSpec);
    await this.reconcileTaskStatusesFromSource(refreshedSpec, context);
    const refreshedTask = refreshedSpec.tasks.find((entry) => entry.id === taskId);
    const refreshedVerification = refreshedTask?.verifications.find((entry) => entry.verificationId === verificationId);
    if (!refreshedTask || !refreshedVerification) return;

    refreshedVerification.conversationId = conversationId;
    this.trackedConversationToVerification.set(conversationId, {
      specId: refreshedSpec.id,
      taskId: refreshedTask.id,
      verificationId,
    });
    await this.persistSpec(refreshedSpec, context);
    this.cache.set(context.manifestPath, refreshedSpec);
    if (this.activeSpec?.id === refreshedSpec.id) {
      this.activeSpec = refreshedSpec;
      this.activeContext = context;
    }

    const attachments = [
      { path: context.requirementsPath, content: refreshedSpec.requirementsMarkdown, label: 'requirements.md' },
      { path: context.designPath, content: refreshedSpec.designMarkdown, label: 'design.md' },
      { path: context.tasksPath, content: renderTasksMarkdown(refreshedSpec), label: 'tasks.md' },
    ];

    for (const attachment of attachments) {
      if (!attachment.content.trim()) continue;
      assistantStore.attachFile(attachment.path, attachment.content, attachment.label);
    }

    if (latestRun) {
      const latestRunPath = `${context.specDir}/runs/${task.id}/${latestRun.runId}.json`;
      assistantStore.attachFile(latestRunPath, `${JSON.stringify(latestRun, null, 2)}\n`, `${task.id}-latest-run.json`);
    }

    const prompt = buildTaskVerificationPrompt(refreshedSpec, refreshedTask, latestRun);
    this.dispatchAssistantPrompt(prompt, {
      syntheticPrompt: buildSpecSyntheticPrompt(
        'spec-verify',
        `${task.id} · Verify`,
        task.title,
      ),
      suppressAutoTitle: true,
    });

    await editorStore.openFile(context.tasksPath);
    showToast({ message: `Started verification for ${task.id}. The verifier will review before making any edits.`, type: 'success' });
  }
}

export const specStore = new SpecStore();
