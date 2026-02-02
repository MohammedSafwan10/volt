<script lang="ts">
  /**
   * FileEditCard - Clean file edit display card
   * Shows: Edited filename.ext [+10 -5] [Open diff]
   */
  import { UIIcon } from "$lib/components/ui";
  import { editorStore } from "$lib/stores/editor.svelte";
  import { projectStore } from "$lib/stores/project.svelte";
  import type { ToolCall } from "$lib/stores/assistant.svelte";

  interface Props {
    toolCall: ToolCall;
    groupedToolCalls?: ToolCall[];
    onViewDiff?: (tc: ToolCall, allToolCalls?: ToolCall[]) => void;
    onFullDiff?: (tc: ToolCall, allToolCalls?: ToolCall[]) => void;
    onRevert?: (tc: ToolCall) => void;
    onUndoRevert?: (tc: ToolCall) => void;
    isReverted?: boolean;
    revertedIds?: Set<string>;
  }

  let {
    toolCall,
    groupedToolCalls = [],
    onViewDiff,
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

  // Diff stats from meta or calculated from arguments
  const diffStats = $derived.by(() => {
    let added = 0;
    let removed = 0;
    let hasStats = false;

    for (const tc of allToolCalls) {
      const meta = tc.meta as Record<string, any> | undefined;
      const stats = meta?.fileEdit as Record<string, any> | undefined;

      if (
        stats &&
        (typeof stats.added === "number" || typeof stats.removed === "number")
      ) {
        // Use server-provided stats if available
        if (typeof stats.added === "number") added += stats.added;
        if (typeof stats.removed === "number") removed += stats.removed;
        hasStats = true;
      } else {
        // Fallback: Calculate from arguments
        const args = tc.arguments as Record<string, any>;
        const name = tc.name;

        if (name === "replace_file_content") {
          if (args.ReplacementContent) {
            added += (args.ReplacementContent.match(/\n/g) || []).length + 1;
            hasStats = true;
          }
          if (args.TargetContent) {
            removed += (args.TargetContent.match(/\n/g) || []).length + 1;
            hasStats = true;
          }
        } else if (
          name === "multi_replace_file_content" &&
          Array.isArray(args.ReplacementChunks)
        ) {
          for (const chunk of args.ReplacementChunks) {
            if (chunk.ReplacementContent) {
              added += (chunk.ReplacementContent.match(/\n/g) || []).length + 1;
              hasStats = true;
            }
            if (chunk.TargetContent) {
              removed += (chunk.TargetContent.match(/\n/g) || []).length + 1;
              hasStats = true;
            }
          }
        } else if (name === "write_to_file") {
          if (args.CodeContent) {
            added += (args.CodeContent.match(/\n/g) || []).length + 1;
            hasStats = true;
          }
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
    <!-- Combined Status & File Info Block -->
    <div class="main-info">
      <div class="status-indicator">
        <UIIcon name={isAllFailed ? "error" : "pencil"} size={13} />
        <span class="status-label">{statusText}</span>
      </div>

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
        title={toolCall.arguments.path as string}
      >
        {#if isAllRunning}
          <UIIcon name="spinner" size={13} class="spinner-icon" />
        {:else}
          <UIIcon name={fileIcon} size={13} />
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
          {#if canViewDiffAny && onViewDiff}
            <button
              class="action-btn-text diff"
              onclick={(e) => {
                e.stopPropagation();
                onViewDiff(toolCall, isGrouped ? allToolCalls : undefined);
              }}
              title="Highlight changes in editor"
            >
              Open diff
            </button>
          {/if}
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
              Full Diff
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
    border-radius: 6px;
    background: transparent;
  }

  .card-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 0;
    cursor: default;
    font-size: 13px;
  }

  .main-info {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
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
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid var(--color-border);
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
    border-color: var(--color-accent);
  }

  .file-pill.is-loading {
    border-color: var(--color-accent);
    background: rgba(var(--color-accent-rgb), 0.05);
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
    background: rgba(255, 255, 255, 0.05);
  }

  .pill-progress-fill {
    height: 100%;
    background: var(--color-accent);
    transition: width 0.1s ease-out;
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
</style>
