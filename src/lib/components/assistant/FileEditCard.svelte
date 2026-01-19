<script lang="ts">
  /**
   * FileEditCard - Clean file edit display card
   * Shows: Edited filename.ext [diff] [revert]
   */
  import { UIIcon } from "$lib/components/ui";
  import { editorStore } from "$lib/stores/editor.svelte";
  import { projectStore } from "$lib/stores/project.svelte";
  import type { ToolCall } from "$lib/stores/assistant.svelte";

  interface Props {
    toolCall: ToolCall;
    groupedToolCalls?: ToolCall[];
    onViewDiff?: (tc: ToolCall, allToolCalls?: ToolCall[]) => void;
    onRevert?: (tc: ToolCall) => void;
    onUndoRevert?: (tc: ToolCall) => void;
    isReverted?: boolean;
    revertedIds?: Set<string>;
  }

  let {
    toolCall,
    groupedToolCalls = [],
    onViewDiff,
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
  const totalCount = $derived(allToolCalls.length);

  const filename = $derived.by(() => {
    const path = toolCall.arguments.path as string | undefined;
    if (!path) return "file";
    // Standardize path separators and get last part
    const parts = path.split(/[/\\]/);
    return parts[parts.length - 1] || path;
  });

  const fileExt = $derived(filename.split(".").pop()?.toLowerCase() || "");

  function getFileIcon(ext: string): any {
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

  // Diff stats from meta
  const diffStats = $derived.by(() => {
    let added = 0;
    let removed = 0;
    let hasStats = false;

    for (const tc of allToolCalls) {
      const meta = tc.meta as Record<string, any> | undefined;
      const stats = meta?.fileEdit as Record<string, any> | undefined;
      if (stats) {
        if (typeof stats.added === "number") {
          added += stats.added;
          hasStats = true;
        }
        if (typeof stats.removed === "number") {
          removed += stats.removed;
          hasStats = true;
        }
      }
    }

    if (!hasStats) return null;
    return { added, removed };
  });

  function canRevertEdit(tc: ToolCall): boolean {
    if (tc.status !== "completed" || revertedIds.has(tc.id)) return false;
    const meta = tc.meta as Record<string, unknown> | undefined;
    const fileEdit = meta?.fileEdit as Record<string, unknown> | undefined;
    return typeof fileEdit?.beforeContent === "string";
  }

  function canViewDiffEdit(tc: ToolCall): boolean {
    if (tc.status !== "completed") return false;
    const meta = tc.meta as Record<string, unknown> | undefined;
    const fileEdit = meta?.fileEdit as Record<string, unknown> | undefined;
    return typeof fileEdit?.beforeContent === "string";
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
    if (isAllRunning) return "Editing";
    if (isAllFailed) return "Failed";

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
  const activeStreamingTC = $derived(
    allToolCalls.find((tc) => tc.status === "running" && tc.streamingProgress),
  );
  const progress = $derived(activeStreamingTC?.streamingProgress);
</script>

<div
  class="edit-card"
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
    <!-- Status indicator -->
    <div class="status-icon">
      <UIIcon name="file" size={14} />
    </div>

    <!-- Main content -->
    <div class="content">
      <span class="status-text">{statusText}</span>
      <div
        class="file-pill"
        class:is-loading={isAllRunning}
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
        aria-label="Open {filename}"
      >
        {#if isAllRunning}
          <UIIcon name="spinner" size={14} class="spinner-icon" />
        {:else}
          <UIIcon name={fileIcon} size={14} />
        {/if}
        <span class="filename">{filename}</span>

        {#if progress}
          <div class="pill-progress-bar">
            <div
              class="pill-progress-fill"
              style="width: {progress.percent}%"
            ></div>
          </div>
        {/if}
      </div>
      {#if diffStats && hasAnyComplete && !isReverted}
        <div class="diff-stats">
          {#if diffStats.added > 0}
            <span class="stat-added">+{diffStats.added}</span>
          {/if}
          {#if diffStats.removed > 0}
            <span class="stat-removed">-{diffStats.removed}</span>
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
          {#if canViewDiffAny && onViewDiff}
            <button
              class="action-btn-text diff"
              onclick={(e) => {
                e.stopPropagation();
                onViewDiff(toolCall, isGrouped ? allToolCalls : undefined);
              }}
            >
              Open diff
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
                {#if canViewDiffEdit(tc) && onViewDiff}
                  <button
                    class="sub-btn"
                    onclick={() => onViewDiff(tc)}
                    title="Diff"
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

  <!-- Error message -->
  {#if isAllFailed && firstError}
    <div class="error-row">{firstError.split("\n")[0]}</div>
  {/if}
</div>

<style>
  .edit-card {
    margin: 4px 0;
  }

  .card-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 0;
    cursor: default;
    font-size: 13.5px;
    transition: color 0.15s ease;
  }

  .edit-card:has(.edit-count) .card-row {
    cursor: pointer;
  }
  .edit-card:has(.edit-count) .card-row:hover .filename {
    text-decoration: underline;
  }

  .status-icon {
    display: flex;
    align-items: center;
    color: var(--color-text-secondary);
    opacity: 0.6;
    flex-shrink: 0;
  }

  .content {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .status-text {
    font-size: 13px;
    color: var(--color-text-secondary);
    flex-shrink: 0;
    font-weight: 400;
  }

  .file-pill {
    display: flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    padding: 2px 0;
    max-width: fit-content;
    min-width: 0;
    position: relative;
    overflow: hidden;
    cursor: pointer;
    transition: opacity 0.2s ease;
  }

  .file-pill:hover {
    opacity: 0.7;
  }

  .file-pill:hover .filename {
    text-decoration: underline;
  }

  .file-pill.is-loading {
    border-color: var(--color-accent-alpha);
  }

  :global(.spinner-icon) {
    animation: spin 1s linear infinite;
    color: var(--color-accent);
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  .pill-progress-bar {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 1.5px;
    background: transparent;
  }

  .pill-progress-fill {
    height: 100%;
    background: var(--color-accent);
    transition: width 0.1s ease-out;
    box-shadow: 0 0 4px var(--color-accent);
  }

  .filename {
    font-size: 13px;
    font-weight: 500;
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .diff-stats {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 600; /* Bolder for visibility */
  }

  .stat-added {
    color: #4ade80; /* Intense vibrant green */
  }

  .stat-removed {
    color: #f87171; /* Intense vibrant red */
  }

  .edit-count {
    font-size: 11px;
    color: var(--color-text-secondary);
    opacity: 0.6;
    font-weight: 400;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 0;
  }

  .action-btn-text {
    background: transparent;
    color: var(--color-text-secondary);
    font-size: 12px;
    padding: 4px 8px;
    border-radius: 4px;
    transition: all 0.12s ease;
    white-space: nowrap;
  }

  .action-btn-text:hover {
    color: var(--color-text);
    background: var(--color-hover);
  }

  .action-btn-text.diff:hover {
    color: var(--color-text);
  }

  .action-btn-text.restore:hover {
    color: var(--color-green);
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
    transition: all 0.12s ease;
  }

  .action-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .action-btn.revert-icon:hover {
    color: var(--color-warning);
  }

  .action-btn.expand {
    width: 20px;
    height: 20px;
    transition: transform 0.15s ease;
    padding: 0;
  }

  .action-btn.expand.expanded {
    transform: rotate(180deg);
  }

  /* Expanded list */
  .expanded-list {
    padding: 2px 0 6px 20px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .sub-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 4px;
    border-radius: 4px;
    font-size: 11px;
    color: var(--color-text-secondary);
  }

  .sub-item:hover {
    color: var(--color-text);
  }
  .sub-item.reverted {
    opacity: 0.6;
  }

  .sub-index {
    color: var(--color-text-secondary);
    font-family: var(--font-mono, monospace);
    min-width: 14px;
    font-size: 10px;
    opacity: 0.5;
  }

  .sub-status {
    flex: 1;
  }

  .sub-actions {
    display: flex;
    gap: 2px;
  }

  .sub-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 4px;
    color: var(--color-text-secondary);
    transition: all 0.12s ease;
  }

  .sub-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  /* Error row */
  .error-row {
    padding: 4px 0 8px 20px;
    font-size: 11px;
    font-family: var(--font-mono, monospace);
    color: #f87171;
  }
</style>
