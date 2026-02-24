<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { onDestroy, onMount } from "svelte";
  import { UIIcon, Markdown } from "$lib/components/ui";
  import type {
    AssistantMessage,
    ToolCall,
    ContentPart,
  } from "$lib/stores/assistant.svelte";
  import InlineToolCall from "./InlineToolCall.svelte";
  import FileEditCard from "./FileEditCard.svelte";
  import { openFullDiffView } from "$lib/services/diff-view";
  import { writeFile } from "$lib/services/file-system";
  import { showToast } from "$lib/stores/toast.svelte";
  import { editorStore } from "$lib/stores/editor.svelte";
  import StreamingStatus from "./StreamingStatus.svelte";
  import { isFileMutatingTool, isTerminalTool as isTerminalToolName } from "$lib/services/ai/tools";

  interface Props {
    message: AssistantMessage;
    msgIdx: number;
    showStreamingFallback?: boolean;
    onToolApprove?: (messageId: string, toolCall: ToolCall) => void;
    onToolDeny?: (messageId: string, toolCall: ToolCall) => void;
    elapsedTime?: string | null;
  }

  let {
    message,
    msgIdx,
    showStreamingFallback = false,
    onToolApprove,
    onToolDeny,
    elapsedTime,
  }: Props =
    $props();

  const showStreaming = $derived(
    Boolean(message.isStreaming || showStreamingFallback),
  );

  // Track reverted tool calls
  let revertedIds = $state<Set<string>>(new Set());
  let copyStatus = $state<"idle" | "copied">("idle");
  let copyTimeout: ReturnType<typeof setTimeout> | null = null;

  // Live timer for active thinking - updates every second
  let now = $state(Date.now());
  let timerInterval: ReturnType<typeof setInterval> | null = null;

  // Check if any thinking part is active
  const hasActiveThinking = $derived(() => {
    const parts = message.contentParts ?? [];
    return parts.some((p) => p.type === "thinking" && p.isActive);
  });

  // Start/stop timer based on active thinking
  $effect(() => {
    if (hasActiveThinking()) {
      if (!timerInterval) {
        timerInterval = setInterval(() => {
          now = Date.now();
        }, 1000);
      }
    } else {
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
    }
  });

  onDestroy(() => {
    if (timerInterval) {
      clearInterval(timerInterval);
    }
    if (copyTimeout) {
      clearTimeout(copyTimeout);
    }
  });

  function isFileEditTool(toolCall: ToolCall): boolean {
    return isFileMutatingTool(toolCall.name);
  }

  function isTerminalTool(toolCall: ToolCall): boolean {
    return isTerminalToolName(toolCall.name);
  }

  // Get the first pending terminal tool ID (for Kiro-style sequential approval)
  function getFirstPendingTerminalId(): string | null {
    const parts = getContentParts(message);
    for (const part of parts) {
      if (part.type === "tool" && isTerminalTool(part.toolCall)) {
        if (
          part.toolCall.status === "pending" &&
          part.toolCall.requiresApproval
        ) {
          return part.toolCall.id;
        }
      }
    }
    return null;
  }

  function getToolCallPath(tc: ToolCall): string | null {
    const path = tc.arguments.path as string | undefined;
    return path ? path.replace(/\\/g, "/") : null;
  }

  function getToolTextOffset(tc: ToolCall): number | null {
    const offset = (tc.meta as any)?.textOffset;
    return typeof offset === "number" && offset >= 0 ? offset : null;
  }

  function buildContentPartsFromOffsets(
    msg: AssistantMessage,
  ): ContentPart[] | null {
    if (!msg.inlineToolCalls?.length) return null;

    // Tool-only assistant turns are valid (no narrative text).
    // Render tool cards directly so they are visible live, not only after reload reconstruction.
    if (!msg.content) {
      return msg.inlineToolCalls.map((tc) => ({ type: "tool", toolCall: tc }));
    }

    const toolCallsWithOffsets = msg.inlineToolCalls
      .map((tc) => ({ tc, offset: getToolTextOffset(tc) }))
      .filter((item): item is { tc: ToolCall; offset: number } =>
        typeof item.offset === "number",
      )
      .sort((a, b) => a.offset - b.offset);

    if (toolCallsWithOffsets.length === 0) return null;

    const parts: ContentPart[] = [];
    let cursor = 0;

    for (const { tc, offset } of toolCallsWithOffsets) {
      const safeOffset = Math.min(Math.max(offset, 0), msg.content.length);
      const textChunk = msg.content.slice(cursor, safeOffset).trimEnd();
      if (textChunk.trim()) {
        parts.push({ type: "text", text: textChunk });
      }
      parts.push({ type: "tool", toolCall: tc });
      cursor = safeOffset;
    }

    const tail = msg.content.slice(cursor).trim();
    if (tail) parts.push({ type: "text", text: tail });

    return parts.length > 0 ? parts : null;
  }

  function getContentParts(msg: AssistantMessage): ContentPart[] {
    // PRIORITY: Use saved contentParts (has correct order from streaming/history)
    // Only rebuild from offsets as a fallback for legacy messages without contentParts
    if (msg.contentParts?.length) return msg.contentParts;
    
    // Fallback: try to rebuild from offsets (for old messages without contentParts)
    const rebuilt = buildContentPartsFromOffsets(msg);
    if (rebuilt) return rebuilt;

    // Last-chance fallback for live turns where contentParts was not yet materialized.
    if (msg.inlineToolCalls?.length) {
      return msg.inlineToolCalls.map((tc) => ({ type: "tool", toolCall: tc }));
    }
    
    // Last resort: just the text content
    if (msg.content) return [{ type: "text", text: msg.content }];
    return [];
  }

  // Format thinking duration for display (Cursor-style)
  // Uses the live 'now' timer for active thinking to show realtime elapsed time
  function formatThinkingDuration(
    startTime: number,
    endTime?: number,
    isActive?: boolean,
  ): string {
    const end = isActive ? now : (endTime ?? now);
    const durationMs = end - startTime;
    const seconds = Math.floor(durationMs / 1000);
    if (seconds < 1) return "<1s";
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function groupFileEdits(
    parts: ContentPart[],
  ): Map<string, { primary: ToolCall; grouped: ToolCall[] }> {
    const groups = new Map<
      string,
      { primary: ToolCall; grouped: ToolCall[] }
    >();
    const processedIds = new Set<string>();

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (
        part.type !== "tool" ||
        !isFileEditTool(part.toolCall) ||
        processedIds.has(part.toolCall.id)
      )
        continue;

      const path = getToolCallPath(part.toolCall);
      if (!path) continue;

      const group: ToolCall[] = [];
      processedIds.add(part.toolCall.id);

      for (let j = i + 1; j < parts.length; j++) {
        const nextPart = parts[j];
        if (nextPart.type !== "tool" || !isFileEditTool(nextPart.toolCall))
          break;
        if (getToolCallPath(nextPart.toolCall) !== path) break;
        group.push(nextPart.toolCall);
        processedIds.add(nextPart.toolCall.id);
      }

      groups.set(part.toolCall.id, { primary: part.toolCall, grouped: group });
    }
    return groups;
  }

  function shouldSkipToolCall(
    tcId: string,
    groups: Map<string, { primary: ToolCall; grouped: ToolCall[] }>,
  ): boolean {
    for (const [_, group] of groups) {
      if (group.grouped.some((tc) => tc.id === tcId)) return true;
    }
    return false;
  }

  async function handleViewDiff(
    toolCall: ToolCall,
    allToolCalls?: ToolCall[],
  ): Promise<void> {
    // Always prefer full diff (red/green). If content is missing, show a clear error.
    if (allToolCalls && allToolCalls.length > 1) {
      const firstMeta = allToolCalls[0].meta as
        | Record<string, unknown>
        | undefined;
      const firstFileEdit = firstMeta?.fileEdit as
        | Record<string, unknown>
        | undefined;
      const originalContent = firstFileEdit?.beforeContent as
        | string
        | undefined;

      const lastMeta = allToolCalls[allToolCalls.length - 1].meta as
        | Record<string, unknown>
        | undefined;
      const lastFileEdit = lastMeta?.fileEdit as
        | Record<string, unknown>
        | undefined;
      const modifiedContent = lastFileEdit?.afterContent as
        | string
        | undefined;

      const path =
        (toolCall.arguments.path as string) ||
        (firstFileEdit?.relativePath as string) ||
        "";
      const absolutePath = firstFileEdit?.absolutePath as string | undefined;

      if (
        typeof originalContent !== "string" ||
        typeof modifiedContent !== "string"
      ) {
        showToast({
          message: "Cannot show diff: content not available",
          type: "error",
        });
        return;
      }

      openFullDiffView({
        filePath: absolutePath || path,
        originalContent,
        modifiedContent,
        toolCallId: `grouped-${allToolCalls.map((tc) => tc.id).join("-")}`,
      });
      return;
    }

    const meta = toolCall.meta as Record<string, unknown> | undefined;
    const fileEdit = meta?.fileEdit as Record<string, unknown> | undefined;
    const path =
      (toolCall.arguments.path as string) ||
      (fileEdit?.relativePath as string) ||
      "";
    const absolutePath = fileEdit?.absolutePath as string | undefined;
    const originalContent = fileEdit?.beforeContent as string | undefined;
    const modifiedContent = fileEdit?.afterContent as string | undefined;

    if (
      typeof originalContent !== "string" ||
      typeof modifiedContent !== "string"
    ) {
      showToast({ message: "Cannot show diff: content not available", type: "error" });
      return;
    }

    openFullDiffView({
      filePath: absolutePath || path,
      originalContent,
      modifiedContent,
      toolCallId: toolCall.id,
    });
  }

  /**
   * Open full Monaco DiffEditor with proper red/green inline diff
   * This shows deleted lines in RED and added lines in GREEN
   */
  function handleFullDiff(toolCall: ToolCall, allToolCalls?: ToolCall[]): void {
    // Get content for diff
    let originalContent: string | undefined;
    let modifiedContent: string | undefined;
    let filePath: string = '';

    if (allToolCalls && allToolCalls.length > 1) {
      // Grouped edits - use first beforeContent and last afterContent
      const firstMeta = allToolCalls[0].meta as Record<string, unknown> | undefined;
      const firstFileEdit = firstMeta?.fileEdit as Record<string, unknown> | undefined;
      originalContent = firstFileEdit?.beforeContent as string | undefined;
      
      const lastMeta = allToolCalls[allToolCalls.length - 1].meta as Record<string, unknown> | undefined;
      const lastFileEdit = lastMeta?.fileEdit as Record<string, unknown> | undefined;
      modifiedContent = lastFileEdit?.afterContent as string | undefined;
      
      filePath = (firstFileEdit?.absolutePath as string) || 
                 (toolCall.arguments.path as string) || 
                 (firstFileEdit?.relativePath as string) || '';
    } else {
      // Single edit
      const meta = toolCall.meta as Record<string, unknown> | undefined;
      const fileEdit = meta?.fileEdit as Record<string, unknown> | undefined;
      originalContent = fileEdit?.beforeContent as string | undefined;
      modifiedContent = fileEdit?.afterContent as string | undefined;
      filePath = (fileEdit?.absolutePath as string) || 
                 (toolCall.arguments.path as string) || 
                 (fileEdit?.relativePath as string) || '';
    }

    if (typeof originalContent !== 'string' || typeof modifiedContent !== 'string') {
      showToast({ message: 'Cannot show diff: content not available', type: 'error' });
      return;
    }

    openFullDiffView({
      filePath,
      originalContent,
      modifiedContent,
      toolCallId: toolCall.id,
    });
  }

  async function handleRevert(toolCall: ToolCall): Promise<void> {
    const meta = toolCall.meta as Record<string, unknown> | undefined;
    const fileEdit = meta?.fileEdit as Record<string, unknown> | undefined;
    const beforeContent = fileEdit?.beforeContent as string | undefined;
    const absolutePath = fileEdit?.absolutePath as string | undefined;
    const isNewFile = fileEdit?.isNewFile === true;

    // For new files, we want to delete on revert
    if (isNewFile && absolutePath) {
      try {
        await invoke("delete_path", { path: absolutePath });
        revertedIds = new Set([...revertedIds, toolCall.id]);
        showToast({ message: "File deleted (reverted)", type: "success" });

        // Close tab if open
        editorStore.closeFile(absolutePath, true);
        return;
      } catch (e) {
        console.error("[Revert] Delete failed:", e);
        showToast({
          message: "Failed to delete file on revert",
          type: "error",
        });
        return;
      }
    }

    if (typeof beforeContent !== "string" || !absolutePath) {
      showToast({
        message: "Cannot revert: original content not available",
        type: "error",
      });
      return;
    }

    // Store current content for undo
    const afterContent = fileEdit?.afterContent as string | undefined;
    if (afterContent !== undefined) {
      // Store in meta for undo
      (fileEdit as Record<string, unknown>).revertedContent = afterContent;
    }

    // Write the original content back
    const success = await writeFile(absolutePath, beforeContent);
    if (success) {
      revertedIds = new Set([...revertedIds, toolCall.id]);
      showToast({ message: "Changes reverted", type: "success" });

      // Reload file in editor if open
      await editorStore.reloadFile(absolutePath);
    } else {
      showToast({ message: "Failed to revert changes", type: "error" });
    }
  }

  async function handleUndoRevert(toolCall: ToolCall): Promise<void> {
    const meta = toolCall.meta as Record<string, unknown> | undefined;
    const fileEdit = meta?.fileEdit as Record<string, unknown> | undefined;
    const afterContent = fileEdit?.afterContent as string | undefined;
    const revertedContent = fileEdit?.revertedContent as string | undefined;
    const absolutePath = fileEdit?.absolutePath as string | undefined;

    const contentToRestore = revertedContent ?? afterContent;

    if (typeof contentToRestore !== "string" || !absolutePath) {
      showToast({
        message: "Cannot restore: content not available",
        type: "error",
      });
      return;
    }

    // Write the AI content back
    const success = await writeFile(absolutePath, contentToRestore);
    if (success) {
      revertedIds.delete(toolCall.id);
      revertedIds = new Set(revertedIds);
      showToast({ message: "Changes restored", type: "success" });

      // Reload file in editor if open
      await editorStore.reloadFile(absolutePath);
    } else {
      showToast({ message: "Failed to restore changes", type: "error" });
    }
  }

  const contentParts = $derived(getContentParts(message));
  function isTextPart(part: ContentPart): part is Extract<ContentPart, { type: "text" }> {
    return part.type === "text";
  }

  const copyableText = $derived.by(() => {
    const textChunks = contentParts
      .filter(isTextPart)
      .map((p) => p.text.trim())
      .filter(Boolean);
    if (textChunks.length > 0) return textChunks.join("\n\n");
    return message.content?.trim() || "";
  });
  const fileEditGroups = $derived(groupFileEdits(contentParts));
  const firstPendingTerminalId = $derived(getFirstPendingTerminalId());

  // Track manual toggle state for thinking blocks to avoid auto-reopening during streaming
  let manualThinkingStates = $state<Record<string, boolean>>({});
  let autoExpandThinking = $state(true);

  onMount(() => {
    try {
      const stored = localStorage.getItem("assistant.thinking.autoExpand");
      if (stored === "false") autoExpandThinking = false;
    } catch {
      // ignore
    }
  });

  function getThinkingKey(part: ContentPart, idx: number): string {
    if (part.type !== "thinking") return `text-${idx}`;
    const title = part.title ?? "";
    const end = typeof part.endTime === "number" ? part.endTime : "active";
    return `thinking:${part.startTime}:${end}:${title}`;
  }

  function handleThinkingToggle(key: string, event: Event) {
    const details = event.currentTarget as HTMLDetailsElement;
    manualThinkingStates[key] = details.open;
    autoExpandThinking = details.open;
    try {
      localStorage.setItem(
        "assistant.thinking.autoExpand",
        autoExpandThinking ? "true" : "false",
      );
    } catch {
      // ignore
    }
  }

  $effect(() => {
    // Auto-close finished thinking blocks
    const parts = getContentParts(message);
    parts.forEach((part, i) => {
      if (part.type === "thinking" && !part.isActive) {
        const key = getThinkingKey(part, i);
        if (manualThinkingStates[key] === undefined) {
          manualThinkingStates[key] = false;
        }
      }
    });
  });

  async function handleCopyMessage(): Promise<void> {
    if (!copyableText) {
      showToast({ message: "Nothing to copy", type: "warning" });
      return;
    }
    try {
      await navigator.clipboard.writeText(copyableText);
      copyStatus = "copied";
      if (copyTimeout) clearTimeout(copyTimeout);
      copyTimeout = setTimeout(() => {
        copyStatus = "idle";
      }, 1500);
    } catch (err) {
      showToast({
        message: err instanceof Error ? err.message : "Failed to copy",
        type: "error",
      });
    }
  }
</script>

<article class="message-row assistant" class:streaming={showStreaming}>
  <div class="msg-body">
    <div class="activity-thread">
      <div class="activity-spine"></div>
      <div class="activity-content">
        {#each contentParts as part, i (part.type === "tool" ? part.toolCall.id : part.type === "thinking" ? getThinkingKey(part, i) : `text-${i}`)}
          <div class="activity-item">
            {#if part.type === "thinking"}
              {@const thinkingKey = getThinkingKey(part, i)}
              <!-- Inline thinking block (Cursor-style - minimal) -->
              <details
                class="inline-thinking"
                open={manualThinkingStates[thinkingKey] ??
                  (autoExpandThinking ? part.isActive : false)}
                ontoggle={(e) => handleThinkingToggle(thinkingKey, e)}
              >
                <summary class="thinking-header">
                  <div class="thinking-header-content" class:active={part.isActive}>
                    <span class="thinking-icon" class:active={part.isActive}>
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path
                          d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2 2.5 2.5 0 0 1 .5 0Z"
                        />
                        <path
                          d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2 2.5 2.5 0 0 0-.5 0Z"
                        />
                      </svg>
                    </span>
                    {#if part.isActive}
                      <span class="thinking-label">
                        {part.title || "Thinking"}
                        <span class="thinking-dots"></span>
                        <span class="thinking-duration"
                          >({formatThinkingDuration(
                            part.startTime,
                            undefined,
                            true,
                          )})</span
                        >
                      </span>
                    {:else}
                      <span class="thinking-duration">
                        {part.title || "Thought"} for {formatThinkingDuration(
                          part.startTime,
                          part.endTime,
                          false,
                        )}
                      </span>
                    {/if}
                  </div>
                </summary>
                <div class="thinking-body">
                  {#if part.title && !part.isActive}
                    <div class="thinking-title">{part.title}</div>
                  {/if}
                  <div class="thinking-content">{part.thinking}</div>
                </div>
              </details>
            {:else if part.type === "tool"}
              {@const isGroupedChild = shouldSkipToolCall(
                part.toolCall.id,
                fileEditGroups,
              )}
              {#if !isGroupedChild}
                <div class="inline-tool-wrapper">
                  {#if isFileEditTool(part.toolCall)}
                    {@const group = fileEditGroups.get(part.toolCall.id)}
                    <FileEditCard
                      toolCall={part.toolCall}
                      groupedToolCalls={group?.grouped ?? []}
                      onFullDiff={handleFullDiff}
                      onRevert={handleRevert}
                      onUndoRevert={handleUndoRevert}
                      isReverted={revertedIds.has(part.toolCall.id)}
                      {revertedIds}
                    />
                  {:else}
                    <InlineToolCall
                      toolCall={part.toolCall}
                      streamingProgress={part.toolCall.streamingProgress}
                      onApprove={onToolApprove
                        ? () => onToolApprove(message.id, part.toolCall)
                        : undefined}
                      onDeny={onToolDeny
                        ? () => onToolDeny(message.id, part.toolCall)
                        : undefined}
                      isFirstPendingTerminal={!isTerminalTool(part.toolCall) ||
                        part.toolCall.id === firstPendingTerminalId}
                    />
                  {/if}
                </div>
              {/if}
            {:else if part.type === "text" && part.text.trim()}
              <div class="msg-content">
                {#if showStreaming && i === contentParts.length - 1}
                  <Markdown content={part.text} /><span class="cursor"></span>
                {:else}
                  <Markdown content={part.text} />
                {/if}
              </div>
            {/if}
          </div>
        {/each}

        {#if contentParts.length === 0 && showStreaming}
          <div class="msg-content"><span class="cursor"></span></div>
        {/if}
      </div>
    </div>

    {#if showStreaming}
      <StreamingStatus
        isStreaming={showStreaming}
        isThinking={message.isThinking || false}
        activeToolNames={message.inlineToolCalls
          ?.filter((tc) => tc.status === "running" || tc.status === "pending")
          .map((tc) => tc.name) || []}
      />
    {/if}

    {#if !showStreaming}
      <div class="message-meta">
        <div class="meta-left">
          <span class="meta-time">{formatTime(message.timestamp)}</span>
          {#if message.streamState === "interrupted"}
            <span class="meta-pill warning" title={message.streamIssue || "Stream interrupted"}>
              <UIIcon name="warning" size={12} />
              <span>Interrupted</span>
            </span>
          {:else if message.streamState === "failed"}
            <span class="meta-pill error" title={message.streamIssue || "Generation failed"}>
              <UIIcon name="error" size={12} />
              <span>Failed</span>
            </span>
          {:else if message.streamState === "cancelled"}
            <span class="meta-pill" title={message.streamIssue || "Generation cancelled"}>
              <UIIcon name="close" size={12} />
              <span>Cancelled</span>
            </span>
          {/if}
          {#if elapsedTime}
            <span class="meta-pill" title="Generation time">
              <UIIcon name="clock" size={12} />
              <span>{elapsedTime}</span>
            </span>
          {/if}
        </div>
        {#if copyableText}
          <div class="meta-actions">
            <button
              class="copy-btn"
              onclick={handleCopyMessage}
              title="Copy assistant text (excludes tool cards)"
              type="button"
              aria-label="Copy assistant text"
            >
              <UIIcon
                name={copyStatus === "copied" ? "check" : "copy"}
                size={12}
              />
              <span class="copy-label"
                >{copyStatus === "copied" ? "Copied" : "Copy"}</span
              >
            </button>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</article>

<style>
  .message-row {
    display: flex;
    gap: 10px;
    animation: slideIn 0.2s ease;
  }
  @keyframes slideIn {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .msg-body {
    flex: 1;
    min-width: 0;
    max-width: 100%;
    padding-top: 0;
  }

  .activity-thread {
    position: relative;
    padding-left: 18px;
  }

  .activity-spine {
    position: absolute;
    left: 4px;
    top: 6px;
    bottom: 6px;
    width: 1px;
    background: linear-gradient(
      to bottom,
      var(--color-border) 0%,
      var(--color-border) 70%,
      transparent 100%
    );
    opacity: 0.5;
  }

  .activity-item {
    position: relative;
    margin-bottom: 8px;
  }

  .activity-item:last-child {
    margin-bottom: 0;
  }

  .activity-item::before {
    content: "";
    position: absolute;
    left: -14px;
    top: 8px;
    width: 13px;
    height: 1px;
    background: var(--color-border);
    opacity: 0.3;
  }

  .inline-tool-wrapper {
    margin: 2px 0;
  }

  .msg-content {
    font-size: 13px;
    line-height: 1.6;
    color: var(--color-text);
    word-break: break-word;
  }

  .cursor {
    display: none;
  }
  @keyframes blink {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0;
    }
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  .message-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 10px;
    gap: 12px;
  }

  .meta-left {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    min-height: 22px;
  }

  .meta-time {
    font-size: 10px;
    color: var(--color-text-secondary);
    opacity: 0.7;
  }

  .meta-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    font-size: 11px;
    color: var(--color-text-secondary);
    opacity: 0.8;
    transition: all 0.2s ease;
    user-select: none;
  }

  .meta-pill:hover {
    opacity: 1;
    background: rgba(255, 255, 255, 0.06);
    border-color: var(--color-accent);
    color: var(--color-text);
  }

  .meta-pill.warning {
    border-color: color-mix(in srgb, #f59e0b 45%, var(--color-border));
    color: #fbbf24;
  }

  .meta-pill.error {
    border-color: color-mix(in srgb, #ef4444 45%, var(--color-border));
    color: #f87171;
  }

  .meta-actions {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  .message-row.assistant:hover .meta-actions {
    opacity: 1;
  }

  .copy-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--color-border);
    color: var(--color-text-secondary);
    padding: 3px 8px;
    border-radius: 6px;
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .copy-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    color: var(--color-text);
    border-color: var(--color-accent);
  }

  .copy-label {
    line-height: 1;
  }


  /* Inline thinking block (Cursor-style - transparent/minimal) */
  .inline-thinking {
    margin: 2px 0;
  }
  .thinking-header {
    padding: 4px 0;
    font-size: 13px;
    color: var(--color-text-secondary);
    cursor: pointer;
    user-select: none;
    list-style: none;
    transition: color 0.15s ease;
    outline: none;
  }
  .thinking-header::-webkit-details-marker {
    display: none;
  }
  .thinking-header-content {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .thinking-header-content.active .thinking-label {
    background: linear-gradient(
      90deg,
      rgba(255, 255, 255, 0.35) 0%,
      rgba(255, 255, 255, 0.9) 45%,
      rgba(255, 255, 255, 0.35) 100%
    );
    background-size: 200% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: thinking-shimmer 1.6s linear infinite;
  }
  .thinking-icon {
    display: flex;
    color: var(--color-text-secondary);
    opacity: 0.7;
    flex-shrink: 0;
  }
  .thinking-icon.active {
    animation: pulse 2s ease-in-out infinite;
    color: var(--color-accent);
    opacity: 1;
  }
  .inline-thinking[open] .thinking-icon {
    opacity: 1;
  }

  /* Smooth Dot Animation */
  .thinking-dots {
    display: inline-block;
    width: 16px;
    margin-right: 8px;
  }
  .thinking-dots::after {
    content: "";
    display: inline-block;
    animation: thinking-dots 2s steps(4, end) infinite;
    text-align: left;
  }

  @keyframes thinking-dots {
    0%,
    20% {
      content: "";
    }
    40% {
      content: ".";
    }
    60% {
      content: "..";
    }
    80%,
    100% {
      content: "...";
    }
  }
  @keyframes thinking-shimmer {
    0% {
      background-position: 200% 0;
    }
    100% {
      background-position: -200% 0;
    }
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }
  .thinking-label {
    font-weight: 400;
  }
  .thinking-duration {
    color: var(--color-text-secondary);
    font-size: 11px;
    opacity: 0.6;
    font-weight: 400;
  }

  @media (prefers-reduced-motion: reduce) {
    .thinking-header-content.active .thinking-label {
      animation: none;
      color: var(--color-text);
      background: none;
    }
  }
  .thinking-body {
    padding-left: 14px;
    margin-left: 4px;
    border-left: 1px solid var(--color-border);
    margin-top: 4px;
    padding-bottom: 8px;
  }
  .thinking-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-text);
    margin-bottom: 6px;
  }
  .thinking-content {
    font-size: 12px;
    line-height: 1.5;
    color: var(--color-text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow-y: auto;
  }
</style>
