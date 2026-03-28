<script lang="ts">
  /**
   * FileEditCard - Clean file edit display card
   * Shows: Edited filename.ext [+10 -5] [Open diff]
   */
  import { UIIcon } from "$shared/components/ui";
  import { editorStore } from "$features/editor/stores/editor.svelte";
  import { projectStore } from "$shared/stores/project.svelte";
  import { uiStore } from "$shared/stores/ui.svelte";
  import { problemsStore } from "$shared/stores/problems.svelte";
  import type { ToolCall } from "$features/assistant/stores/assistant.svelte";
  import { getFileEditDiffStats } from "./file-edit-stats";

  interface Props {
    toolCall: ToolCall;
    groupedToolCalls?: ToolCall[];
    compact?: boolean;
    onFullDiff?: (tc: ToolCall, allToolCalls?: ToolCall[]) => void;
    onRevert?: (tc: ToolCall) => void;
    onUndoRevert?: (tc: ToolCall) => void;
    isReverted?: boolean;
    revertedIds?: Set<string>;
  }

  let {
    toolCall,
    groupedToolCalls = [],
    compact = false,
    onFullDiff,
    onRevert,
    onUndoRevert,
    isReverted = false,
    revertedIds = new Set(),
  }: Props = $props();

  const allToolCalls = $derived([toolCall, ...groupedToolCalls]);
  const isGrouped = $derived(groupedToolCalls.length > 0);
  let isExpanded = $state(false);

  const successCount = $derived(
    allToolCalls.filter((tc) => tc.status === "completed").length,
  );
  const failedCount = $derived(
    allToolCalls.filter((tc) => tc.status === "failed").length,
  );
  const runningCount = $derived(
    allToolCalls.filter((tc) => tc.status === "running").length,
  );
  const queuedCount = $derived(
    allToolCalls.filter((tc) => (tc.meta as any)?.editPhase === "queued")
      .length,
  );
  const writingCount = $derived(
    allToolCalls.filter((tc) => (tc.meta as any)?.editPhase === "writing")
      .length,
  );
  const totalCount = $derived(allToolCalls.length);

  const filename = $derived.by(() => {
    const path = toolCall.arguments.path as string | undefined;
    if (!path) return "file";
    // Standardize path separators and get last part
    const parts = path.split(/[/\\]/);
    return parts[parts.length - 1] || path;
  });

  const fileExt = $derived(filename.split(".").pop()?.toLowerCase() || "");
  const isDeleteTool = $derived.by(
    () => toolCall.name === "delete_file" || toolCall.name === "delete_path",
  );
  const isCreateDirTool = $derived.by(() => toolCall.name === "create_dir");

  function getFileIcon(ext: string): any {
    if (isCreateDirTool) return "folder";
    switch (ext) {
      case "svelte":
        return "svelte";
      case "ts":
      case "tsx":
        return "typescript";
      case "js":
      case "jsx":
        return "javascript";
      case "rs":
        return "rust";
      case "py":
        return "python";
      case "json":
        return "json";
      case "dart":
        return "dart";
      case "xml":
        // Special case for AndroidManifest.xml
        if (filename.toLowerCase().includes("androidmanifest"))
          return "android";
        return "xml";
      case "yaml":
      case "yml":
        return "yaml";
      case "md":
        return "markdown";
      case "css":
        return "css";
      case "html":
        return "html";
      default:
        return "file";
    }
  }

  const fileIcon = $derived(getFileIcon(fileExt));
  const statusIcon = $derived.by(() => {
    if (isAllFailed) return "error";
    if (isDeleteTool) return "trash";
    if (isCreateDirTool) return "folder";
    return "pencil";
  });
  function isNoopEdit(tc: ToolCall): boolean {
    const output = typeof tc.output === "string" ? tc.output.trim() : "";
    if (output.startsWith("No changes:")) return true;

    const meta = tc.meta as Record<string, unknown> | undefined;
    const fileEdit = meta?.fileEdit as Record<string, unknown> | undefined;
    const beforeContent = fileEdit?.beforeContent;
    const afterContent = fileEdit?.afterContent;
    return (
      typeof beforeContent === "string" &&
      typeof afterContent === "string" &&
      beforeContent === afterContent
    );
  }

  const isNoopCard = $derived.by(
    () =>
      allToolCalls.length > 0 &&
      allToolCalls.every(
        (tc) => tc.status === "completed" && !tc.meta?.fileDeleted && isNoopEdit(tc),
      ),
  );
  const diffStats = $derived(getFileEditDiffStats(allToolCalls));

  function canRevertEdit(tc: ToolCall): boolean {
    if (tc.status !== "completed" || revertedIds.has(tc.id)) return false;
    if (isNoopEdit(tc)) return false;
    const meta = tc.meta as Record<string, unknown> | undefined;
    const fileEdit = meta?.fileEdit as Record<string, unknown> | undefined;
    return typeof fileEdit?.beforeContent === "string" || fileEdit?.isNewFile === true;
  }

  function canViewDiffEdit(tc: ToolCall): boolean {
    if (tc.status !== "completed") return false;
    if (isNoopEdit(tc)) return false;
    const meta = tc.meta as Record<string, unknown> | undefined;
    const fileEdit = meta?.fileEdit as Record<string, unknown> | undefined;
    if (fileEdit?.isDirectory === true) return false;
    // We can view diff if we have beforeContent OR if it's a new file (beforeContent might be empty)
    return (
      typeof fileEdit?.beforeContent === "string" ||
      fileEdit?.isNewFile === true
    );
  }

  const canRevert = $derived(allToolCalls.some((tc) => canRevertEdit(tc)));
  const canViewDiffAny = $derived(
    allToolCalls.some((tc) => canViewDiffEdit(tc)),
  );
  const hasAnyComplete = $derived(successCount > 0);
  const isAllRunning = $derived(
    runningCount > 0 && successCount === 0 && failedCount === 0,
  );
  const isAllFailed = $derived(failedCount > 0 && successCount === 0);
  const currentLiveStatus = $derived.by(() => {
    const active = allToolCalls.find(
      (tc) =>
        tc.status === "running" &&
        typeof (tc.meta as any)?.liveStatus === "string" &&
        String((tc.meta as any).liveStatus).trim().length > 0,
    );
    if (!active) return "";
    return String((active.meta as any).liveStatus).trim();
  });

  async function handleFileClick(path: string | undefined) {
    if (!path) return;

    let fullPath = path;
    if (projectStore.rootPath && !path.startsWith("/") && !path.includes(":")) {
      const sep = projectStore.rootPath.includes("\\") ? "\\" : "/";
      fullPath = `${projectStore.rootPath}${sep}${path}`;
    }

    await editorStore.openFile(fullPath);
  }

  function getStatusText(): string {
    if (isReverted) return "Reverted";
    if (isNoopCard) return "Unchanged";
    if (queuedCount > 0 && writingCount === 0 && runningCount === 0)
      return "Queued";
    if (currentLiveStatus) return currentLiveStatus;
    if (writingCount > 0 || isAllRunning) {
      if (isDeleteTool) return "Deleting...";
      if (isCreateDirTool) return "Creating...";
      return "Editing...";
    }
    if (isAllFailed) return "Failed";

    if (isDeleteTool) return "Deleted";
    if (isCreateDirTool) return "Created folder";

    const meta = toolCall.meta as Record<string, unknown> | undefined;
    const fileEdit = meta?.fileEdit as Record<string, unknown> | undefined;
    if (fileEdit?.isNewFile) return "Created";
    return "Edited";
  }

  const statusText = $derived(getStatusText());
  const firstError = $derived(
    allToolCalls.find((tc) => tc.status === "failed" && tc.error)?.error,
  );

  // Real-time progress tracking
  const diagnosticsSummary = $derived.by(() => {
    let errorCount = 0;
    let warningCount = 0;
    let hasDiagnostics = false;
    const problems: Array<{
      file?: string;
      relativePath?: string;
      fileName?: string;
      line?: number;
      column?: number;
      message?: string;
      severity?: string;
    }> = [];

    for (const tc of allToolCalls) {
      const meta = tc.meta as Record<string, any> | undefined;
      const diagnostics = meta?.diagnostics as Record<string, any> | undefined;
      const fileEdit = meta?.fileEdit as Record<string, any> | undefined;

      if (
        diagnostics &&
        (typeof diagnostics.errorCount === "number" ||
          typeof diagnostics.warningCount === "number")
      ) {
        errorCount += diagnostics.errorCount || 0;
        warningCount += diagnostics.warningCount || 0;
        hasDiagnostics = true;
        if (Array.isArray(diagnostics.problems)) {
          problems.push(...diagnostics.problems);
        }
      } else if (
        fileEdit &&
        (typeof fileEdit.errorCount === "number" ||
          typeof fileEdit.warningCount === "number")
      ) {
        errorCount += fileEdit.errorCount || 0;
        warningCount += fileEdit.warningCount || 0;
        hasDiagnostics = true;
      }
    }

    if (!hasDiagnostics) return null;
    return { errorCount, warningCount, problems };
  });

  let hideDiagnostics = $state(false);
  let diagnosticsExpanded = $state(false);

  // Live diagnostic auto-refresh: watch the global problemsStore for the edited file
  // When errors drop to 0, auto-hide the diagnostics row
  const editedFilePath = $derived(() => {
    const rawPath = toolCall.arguments.path as string;
    if (!rawPath) return null;
    if (rawPath.includes(":") || rawPath.startsWith("/")) return rawPath;
    if (projectStore.rootPath) {
      const sep = projectStore.rootPath.includes("\\") ? "\\" : "/";
      return `${projectStore.rootPath}${sep}${rawPath}`;
    }
    return rawPath;
  });

  const liveErrorCount = $derived(() => {
    const filePath = editedFilePath();
    if (!filePath) return -1; // unknown
    const problems = problemsStore.getProblemsForFile(filePath);
    return problems.filter((p) => p.severity === "error").length;
  });

  // Auto-hide diagnostics when live LSP errors reach 0 for the edited file
  $effect(() => {
    const liveErrors = liveErrorCount();
    const snapshot = diagnosticsSummary;
    // Only auto-hide if: we had errors at edit time, and live errors are now 0
    if (
      snapshot &&
      snapshot.errorCount > 0 &&
      liveErrors === 0 &&
      hasAnyComplete
    ) {
      hideDiagnostics = true;
    }
  });

  function openProblems(): void {
    uiStore.openBottomPanelTab("problems");
  }

  async function openProblem(problem: {
    file?: string;
    relativePath?: string;
    line?: number;
    column?: number;
  }): Promise<void> {
    const candidate =
      problem.file ||
      problem.relativePath ||
      (problem as any).path ||
      (problem as any).absolutePath;

    if (!candidate) return;

    let fullPath = candidate;
    if (
      projectStore.rootPath &&
      !candidate.startsWith("/") &&
      !candidate.includes(":")
    ) {
      const sep = projectStore.rootPath.includes("\\") ? "\\" : "/";
      fullPath = `${projectStore.rootPath}${sep}${candidate}`;
    }

    await editorStore.openFile(fullPath);
    window.dispatchEvent(
      new CustomEvent("volt:navigate-to-position", {
        detail: {
          file: fullPath,
          line: problem.line ?? 1,
          column: problem.column ?? 1,
        },
      }),
    );
  }
</script>

<div
  class="edit-card"
  class:compact
  class:success={hasAnyComplete && !isAllFailed && !isReverted}
  class:failed={isAllFailed}
  class:running={isAllRunning}
  class:reverted={isReverted}
>
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions a11y_no_noninteractive_element_interactions -->
  <div
    class="card-row"
    role={isGrouped ? "button" : undefined}
    onclick={isGrouped ? () => (isExpanded = !isExpanded) : undefined}
  >
    <!-- Combined Status & File Info Block -->
    <div class="main-info">
      {#if !isAllRunning}
        <div class="status-indicator" title={statusText}>
          {#if statusIcon === 'pencil'}
            <!-- Custom Sleek Edit Pen -->
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 20h9"/>
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
            </svg>
          {:else}
            <UIIcon name={statusIcon} size={13} />
          {/if}
        </div>
      {/if}

      <div
        class="file-pill"
        role="button"
        tabindex="0"
        onclick={(e) => {
          e.stopPropagation();
          handleFileClick(toolCall.arguments.path as string);
        }}
        onkeydown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            handleFileClick(toolCall.arguments.path as string);
          }
        }}
        title={toolCall.arguments.path as string}
      >
        {#if isAllRunning}
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="shimmer-icon"
          >
            <path
              d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2 2.5 2.5 0 0 1 .5 0Z"
            />
            <path
              d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2 2.5 2.5 0 0 0-.5 0Z"
            />
          </svg>
        {:else}
          <UIIcon name={fileIcon} size={13} />
          <span class="filename">{filename}</span>
        {/if}
      </div>

      <!-- Stats - Always show if available -->
      {#if diffStats}
        <div class="diff-stats">
          {#if diffStats.added > 0}
            <span class="stat-added" title="Lines added"
              >+{diffStats.added}</span
            >
          {/if}
          {#if diffStats.removed > 0}
            <span class="stat-removed" title="Lines removed"
              >-{diffStats.removed}</span
            >
          {/if}
        </div>
      {:else if isGrouped}
        <span class="edit-count">({allToolCalls.length} edits)</span>
      {/if}
    </div>

    <!-- Actions -->
    <div class="actions">
      {#if hasAnyComplete && !isAllFailed}
        {#if isReverted}
          {#if onUndoRevert}
            <button
              class="action-btn-text restore"
              onclick={(e) => {
                e.stopPropagation();
                onUndoRevert(toolCall);
              }}
            >
              Undo revert
            </button>
          {/if}
        {:else}
          {#if canViewDiffAny && onFullDiff}
            <button
              class="action-btn-text full-diff"
              onclick={(e) => {
                e.stopPropagation();
                onFullDiff(toolCall, isGrouped ? allToolCalls : undefined);
              }}
              title="Show full diff with red/green (VS Code style)"
            >
              <UIIcon name="diff" size={12} />
              Diff
            </button>
          {/if}
          {#if canRevert && onRevert}
            <button
              class="action-btn revert-icon"
              onclick={(e) => {
                e.stopPropagation();
                onRevert(toolCall);
              }}
              title="Revert all"
            >
              <UIIcon name="undo" size={14} />
            </button>
          {/if}
        {/if}
      {/if}
      {#if isGrouped}
        <button class="action-btn expand" class:expanded={isExpanded}>
          <UIIcon name="chevron-down" size={12} />
        </button>
      {/if}
    </div>
  </div>

  <!-- Expanded list for grouped edits -->
  {#if isGrouped && isExpanded}
    <div class="expanded-list">
      {#each allToolCalls as tc, i (tc.id)}
        {@const tcReverted = revertedIds.has(tc.id)}
        <div class="sub-item" class:reverted={tcReverted}>
          <span class="sub-index">{i + 1}.</span>
          <span class="sub-status"
            >{tcReverted
              ? "Reverted"
              : isNoopEdit(tc)
                ? "Unchanged"
              : tc.name === "delete_file" || tc.name === "delete_path"
                ? tc.status === "failed"
                  ? "Failed"
                  : (tc.meta as any)?.editPhase === "queued"
                    ? "Queued"
                    : (tc.meta as any)?.editPhase === "writing"
                      ? "Deleting"
                      : "Deleted"
              : tc.name === "create_dir"
                ? tc.status === "failed"
                  ? "Failed"
                  : (tc.meta as any)?.editPhase === "queued"
                    ? "Queued"
                    : (tc.meta as any)?.editPhase === "writing"
                      ? "Creating"
                      : "Created"
              : (tc.meta as any)?.editPhase === "queued"
                ? "Queued"
                : (tc.meta as any)?.editPhase === "writing"
                  ? "Editing"
                  : tc.status === "failed"
                    ? "Failed"
                    : "Edited"}</span
          >
          <div class="sub-actions">
            {#if tc.status === "completed"}
              {#if tcReverted}
                {#if onUndoRevert}
                  <button
                    class="sub-btn"
                    onclick={() => onUndoRevert(tc)}
                    title="Restore"
                  >
                    <UIIcon name="redo" size={12} />
                  </button>
                {/if}
              {:else}
                {#if canViewDiffEdit(tc) && onFullDiff}
                  <button
                    class="sub-btn"
                    onclick={() => onFullDiff(tc)}
                    title="Full diff"
                  >
                    <UIIcon name="replace" size={12} />
                  </button>
                {/if}
                {#if canRevertEdit(tc) && onRevert}
                  <button
                    class="sub-btn"
                    onclick={() => onRevert(tc)}
                    title="Revert"
                  >
                    <UIIcon name="undo" size={12} />
                  </button>
                {/if}
              {/if}
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if diagnosticsSummary && !hideDiagnostics && hasAnyComplete && (diagnosticsSummary.errorCount > 0 || diagnosticsSummary.warningCount > 0)}
    <div class="diagnostics-row">
      <button
        class="diag-toggle"
        onclick={() => (diagnosticsExpanded = !diagnosticsExpanded)}
        title={diagnosticsExpanded ? "Collapse" : "Expand"}
      >
        <UIIcon
          name={diagnosticsExpanded ? "chevron-down" : "chevron-right"}
          size={12}
        />
      </button>
      <div class="diagnostics-text">
        <span class="diag-warn"
          >⚠ {diagnosticsSummary.errorCount} error{diagnosticsSummary.errorCount ===
          1
            ? ""
            : "s"}{diagnosticsSummary.warningCount > 0
            ? ` · ${diagnosticsSummary.warningCount} warn`
            : ""}</span
        >
      </div>
      <div class="diagnostics-actions">
        <button class="diag-view" onclick={openProblems}>View</button>
        <button
          class="diag-close"
          onclick={() => {
            hideDiagnostics = true;
          }}
          title="Hide"
        >
          <UIIcon name="close" size={12} />
        </button>
      </div>
    </div>
    {#if diagnosticsExpanded && diagnosticsSummary.problems?.length}
      <div class="diagnostics-details">
        {#each diagnosticsSummary.problems.slice(0, 8) as p}
          <button class="diag-item" onclick={() => openProblem(p)}>
            <span class="diag-file"
              >{p.fileName || p.relativePath || p.file || "file"}</span
            >
            <span class="diag-loc">L{p.line ?? "?"}:{p.column ?? "?"}</span>
            <span class="diag-msg">{p.message || "Problem detected"}</span>
          </button>
        {/each}
        {#if diagnosticsSummary.problems.length > 8}
          <div class="diag-more">
            +{diagnosticsSummary.problems.length - 8} more
          </div>
        {/if}
      </div>
    {/if}
  {/if}

  <!-- Error message -->
  {#if isAllFailed && firstError}
    <div class="error-row">{firstError.split("\n")[0]}</div>
  {/if}
</div>

<style>
  .edit-card {
    margin: 4px 0;
    border-radius: 6px;
    background: transparent;
  }

  .edit-card.compact {
    margin: 2px 0;
  }

  .card-row {
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 12px;
    cursor: default;
    font-size: 13px;
    background: rgba(255, 255, 255, 0.02);
    border-radius: 999px;
    transition: all 0.2s ease;
  }
  .card-row:hover { background: rgba(255, 255, 255, 0.06); }

  .edit-card.compact .card-row {
    gap: 8px;
    padding: 4px 0;
    font-size: 12px;
  }

  .main-info {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
  }

  .edit-card.compact .main-info {
    gap: 8px;
  }

  .status-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--color-text-secondary);
    font-size: 12px;
    font-weight: 500;
  }

  .file-pill {
    display: flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: none;
    padding: 2px 8px;
    border-radius: 4px;
    max-width: fit-content;
    min-width: 0;
    position: relative;
    overflow: hidden;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .file-pill:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .edit-card.compact :global(.file-pill) {
    padding: 1px 6px;
  }

  .filename {
    font-size: 13px;
    font-weight: 500;
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: "JetBrains Mono", "Fira Code", monospace;
  }

  .edit-card.compact .filename {
    font-size: 12px;
  }

  .diff-stats {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    font-weight: 600;
    font-family: "JetBrains Mono", monospace;
    margin-left: 2px;
  }

  .stat-added {
    color: #4ade80; /* Explicit Bright Green */
  }

  .stat-removed {
    color: #f87171; /* Explicit Soft Red */
  }

  .edit-count {
    font-size: 11px;
    color: var(--color-text-secondary);
    opacity: 0.6;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .edit-card.compact .actions {
    gap: 6px;
  }

  .action-btn-text {
    background: transparent;
    border: 1px solid var(--color-border);
    color: var(--color-text-secondary);
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
    transition: all 0.15s ease;
    white-space: nowrap;
    font-weight: 500;
  }

  .edit-card.compact .action-btn-text {
    padding: 2px 6px;
    font-size: 10px;
  }

  .action-btn-text:hover {
    color: var(--color-text);
    background: var(--color-hover);
    border-color: var(--color-text);
  }

  .action-btn-text.full-diff {
    display: flex;
    align-items: center;
    gap: 4px;
    color: #4ec9b0;
    border-color: #4ec9b0;
    background: rgba(78, 201, 176, 0.08);
  }

  .action-btn-text.full-diff:hover {
    background: rgba(78, 201, 176, 0.18);
    color: #6dd5c0;
    border-color: #6dd5c0;
  }

  .action-btn-text.restore {
    color: var(--color-success);
    border-color: var(--color-success);
    background: rgba(var(--color-success-rgb, 78, 201, 176), 0.1);
  }

  .action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 4px;
    color: var(--color-text-secondary);
    background: transparent;
    transition: all 0.15s ease;
    opacity: 0.7;
  }

  .action-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
    opacity: 1;
  }

  .action-btn.revert-icon:hover {
    color: var(--color-warning);
    background: rgba(var(--color-warning-rgb, 255, 177, 85), 0.1);
  }

  .action-btn.expand {
    transition: transform 0.2s ease;
  }

  .action-btn.expand.expanded {
    transform: rotate(180deg);
  }

  /* Expanded list */
  .expanded-list {
    padding: 0 0 8px 32px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    border-left: 1px solid var(--color-border);
    margin-left: 10px;
  }

  .sub-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 12px;
    color: var(--color-text-secondary);
    background: rgba(255, 255, 255, 0.02);
  }

  .sub-item:hover {
    color: var(--color-text);
    background: rgba(255, 255, 255, 0.04);
  }

  .sub-item.reverted {
    opacity: 0.5;
    text-decoration: line-through;
  }

  .sub-index {
    color: var(--color-text-disabled);
    font-family: "JetBrains Mono", monospace;
    min-width: 14px;
    font-size: 11px;
  }

  .sub-status {
    flex: 1;
  }

  .sub-actions {
    display: flex;
    gap: 4px;
  }

  .sub-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    color: var(--color-text-secondary);
    transition: all 0.15s ease;
  }

  .sub-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  /* Error row */
  .error-row {
    padding: 6px 12px;
    margin: 4px 0 8px 32px;
    font-size: 12px;
    font-family: "JetBrains Mono", monospace;
    color: var(--color-error);
    background: rgba(var(--color-error-rgb, 241, 76, 76), 0.05);
    border-radius: 4px;
    border-left: 2px solid var(--color-error);
  }

  .diagnostics-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin: 4px 0 8px 32px;
    padding: 6px 10px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--color-border);
    font-size: 12px;
  }

  .diagnostics-text {
    color: var(--color-text-secondary);
    font-family: "JetBrains Mono", monospace;
  }

  .diag-warn {
    color: #facc15;
  }

  .diagnostics-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .diag-view {
    background: rgba(78, 201, 176, 0.12);
    border: 1px solid #4ec9b0;
    color: #4ec9b0;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
  }

  .diag-view:hover {
    background: rgba(78, 201, 176, 0.2);
    color: #6dd5c0;
  }

  .diag-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    color: var(--color-text-secondary);
  }

  .diag-toggle:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .diag-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 4px;
    color: var(--color-text-secondary);
  }

  .diag-close:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .diagnostics-details {
    margin: 0 0 8px 32px;
    padding: 6px;
    border-radius: 6px;
    border: 1px solid var(--color-border);
    background: rgba(255, 255, 255, 0.02);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .diag-item {
    display: grid;
    grid-template-columns: auto auto 1fr;
    gap: 8px;
    align-items: center;
    padding: 4px 6px;
    border-radius: 4px;
    font-size: 12px;
    color: var(--color-text-secondary);
    text-align: left;
    cursor: pointer;
  }

  .diag-item:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .diag-file {
    font-family: "JetBrains Mono", monospace;
    color: var(--color-text);
  }

  .diag-loc {
    font-family: "JetBrains Mono", monospace;
    color: #facc15;
  }

  .diag-msg {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .diag-more {
    font-size: 11px;
    color: var(--color-text-secondary);
    padding: 2px 6px;
  }
</style>
