<script lang="ts">
  import { UIIcon, Markdown } from "$lib/components/ui";
  import type { AssistantMessage, ToolCall, ContentPart } from "$lib/stores/assistant.svelte";
  import InlineToolCall from "./InlineToolCall.svelte";
  import FileEditCard from "./FileEditCard.svelte";
  import { openDiffView } from "$lib/services/diff-view";
  import { writeFile } from "$lib/services/file-system";
  import { showToast } from "$lib/stores/toast.svelte";
  import { editorStore } from "$lib/stores/editor.svelte";

  interface Props {
    message: AssistantMessage;
    msgIdx: number;
    onToolApprove?: (messageId: string, toolCall: ToolCall) => void;
    onToolDeny?: (messageId: string, toolCall: ToolCall) => void;
    elapsedTime?: string | null;
  }

  let { message, msgIdx, onToolApprove, onToolDeny, elapsedTime }: Props = $props();

  // Track reverted tool calls
  let revertedIds = $state<Set<string>>(new Set());

  const FILE_EDIT_TOOLS = ['write_file', 'str_replace', 'apply_edit', 'append_file', 'create_file', 'replace_lines', 'multi_replace_file_content'];
  const TERMINAL_TOOLS = ['run_command', 'start_process', 'terminal_write'];

  function isFileEditTool(toolCall: ToolCall): boolean {
    return FILE_EDIT_TOOLS.includes(toolCall.name);
  }

  function isTerminalTool(toolCall: ToolCall): boolean {
    return TERMINAL_TOOLS.includes(toolCall.name);
  }

  // Get the first pending terminal tool ID (for Kiro-style sequential approval)
  function getFirstPendingTerminalId(): string | null {
    const parts = getContentParts(message);
    for (const part of parts) {
      if (part.type === 'tool' && isTerminalTool(part.toolCall)) {
        if (part.toolCall.status === 'pending' && part.toolCall.requiresApproval) {
          return part.toolCall.id;
        }
      }
    }
    return null;
  }

  function getToolCallPath(tc: ToolCall): string | null {
    const path = tc.arguments.path as string | undefined;
    return path ? path.replace(/\\/g, '/') : null;
  }

  function getContentParts(msg: AssistantMessage): ContentPart[] {
    if (msg.contentParts?.length) return msg.contentParts;
    if (msg.content) return [{ type: "text", text: msg.content }];
    return [];
  }

  function groupFileEdits(parts: ContentPart[]): Map<string, { primary: ToolCall; grouped: ToolCall[] }> {
    const groups = new Map<string, { primary: ToolCall; grouped: ToolCall[] }>();
    const processedIds = new Set<string>();
    
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.type !== 'tool' || !isFileEditTool(part.toolCall) || processedIds.has(part.toolCall.id)) continue;
      
      const path = getToolCallPath(part.toolCall);
      if (!path) continue;
      
      const group: ToolCall[] = [];
      processedIds.add(part.toolCall.id);
      
      for (let j = i + 1; j < parts.length; j++) {
        const nextPart = parts[j];
        if (nextPart.type !== 'tool' || !isFileEditTool(nextPart.toolCall)) break;
        if (getToolCallPath(nextPart.toolCall) !== path) break;
        group.push(nextPart.toolCall);
        processedIds.add(nextPart.toolCall.id);
      }
      
      groups.set(part.toolCall.id, { primary: part.toolCall, grouped: group });
    }
    return groups;
  }

  function shouldSkipToolCall(tcId: string, groups: Map<string, { primary: ToolCall; grouped: ToolCall[] }>): boolean {
    for (const [_, group] of groups) {
      if (group.grouped.some(tc => tc.id === tcId)) return true;
    }
    return false;
  }

  async function handleViewDiff(toolCall: ToolCall, allToolCalls?: ToolCall[]): Promise<void> {
    // If multiple tool calls provided (grouped edits), show combined diff
    if (allToolCalls && allToolCalls.length > 1) {
      // Get the first tool call's beforeContent as the original
      const firstMeta = allToolCalls[0].meta as Record<string, unknown> | undefined;
      const firstFileEdit = firstMeta?.fileEdit as Record<string, unknown> | undefined;
      const originalContent = firstFileEdit?.beforeContent as string | undefined;
      
      // Get the last tool call's afterContent as the final result
      const lastMeta = allToolCalls[allToolCalls.length - 1].meta as Record<string, unknown> | undefined;
      const lastFileEdit = lastMeta?.fileEdit as Record<string, unknown> | undefined;
      
      const path = toolCall.arguments.path as string || firstFileEdit?.relativePath as string || '';
      const absolutePath = firstFileEdit?.absolutePath as string | undefined;
      
      if (!path && !absolutePath) return;
      
      // Pass combined info - the diff view will show original vs final
      await openDiffView({ 
        path, 
        absolutePath,
        originalContent,
        // Use a combined ID for the grouped diff
        toolCallIds: allToolCalls.map(tc => tc.id)
      }, `grouped-${allToolCalls.map(tc => tc.id).join('-')}`);
      return;
    }
    
    // Single tool call - show individual diff
    const meta = toolCall.meta as Record<string, unknown> | undefined;
    const fileEdit = meta?.fileEdit as Record<string, unknown> | undefined;
    const path = toolCall.arguments.path as string || fileEdit?.relativePath as string || '';
    const absolutePath = fileEdit?.absolutePath as string | undefined;
    const firstChangedLine = fileEdit?.firstChangedLine as number | undefined;
    const lastChangedLine = fileEdit?.lastChangedLine as number | undefined;
    if (!path && !absolutePath) return;
    await openDiffView({ path, absolutePath, firstChangedLine, lastChangedLine }, toolCall.id);
  }

  async function handleRevert(toolCall: ToolCall): Promise<void> {
    const meta = toolCall.meta as Record<string, unknown> | undefined;
    const fileEdit = meta?.fileEdit as Record<string, unknown> | undefined;
    const beforeContent = fileEdit?.beforeContent as string | undefined;
    const absolutePath = fileEdit?.absolutePath as string | undefined;
    
    if (typeof beforeContent !== 'string' || !absolutePath) {
      showToast({ message: 'Cannot revert: original content not available', type: 'error' });
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
      showToast({ message: 'Changes reverted', type: 'success' });
      
      // Reload file in editor if open
      await editorStore.reloadFile(absolutePath);
    } else {
      showToast({ message: 'Failed to revert changes', type: 'error' });
    }
  }

  async function handleUndoRevert(toolCall: ToolCall): Promise<void> {
    const meta = toolCall.meta as Record<string, unknown> | undefined;
    const fileEdit = meta?.fileEdit as Record<string, unknown> | undefined;
    const afterContent = fileEdit?.afterContent as string | undefined;
    const revertedContent = fileEdit?.revertedContent as string | undefined;
    const absolutePath = fileEdit?.absolutePath as string | undefined;
    
    const contentToRestore = revertedContent ?? afterContent;
    
    if (typeof contentToRestore !== 'string' || !absolutePath) {
      showToast({ message: 'Cannot restore: content not available', type: 'error' });
      return;
    }

    // Write the AI content back
    const success = await writeFile(absolutePath, contentToRestore);
    if (success) {
      const newSet = new Set(revertedIds);
      newSet.delete(toolCall.id);
      revertedIds = newSet;
      showToast({ message: 'Changes restored', type: 'success' });
      
      // Reload file in editor if open
      await editorStore.reloadFile(absolutePath);
    } else {
      showToast({ message: 'Failed to restore changes', type: 'error' });
    }
  }

  const contentParts = $derived(getContentParts(message));
  const fileEditGroups = $derived(groupFileEdits(contentParts));
  const firstPendingTerminalId = $derived(getFirstPendingTerminalId());
</script>

<article class="message-row assistant" class:streaming={message.isStreaming}>
  <div class="avatar"><UIIcon name="bolt" size={14} /></div>
  <div class="msg-body">
    {#if message.thinking}
      <details class="thinking-section">
        <summary class="thinking-header">
          <span class="thinking-icon" class:active={message.isThinking}><UIIcon name="sparkle" size={12} /></span>
          <span class="thinking-label">{message.isThinking ? "Thinking..." : "Reasoning (click to view)"}</span>
          <UIIcon name="chevron-down" size={12} />
        </summary>
        <div class="thinking-content">{message.thinking}</div>
      </details>
    {/if}

    {#each contentParts as part, i (part.type === "tool" ? part.toolCall.id : `text-${i}`)}
      {#if part.type === "tool"}
        {@const isGroupedChild = shouldSkipToolCall(part.toolCall.id, fileEditGroups)}
        {#if !isGroupedChild}
          <div class="inline-tool-wrapper">
            {#if isFileEditTool(part.toolCall)}
              {@const group = fileEditGroups.get(part.toolCall.id)}
              <FileEditCard 
                toolCall={part.toolCall} 
                groupedToolCalls={group?.grouped ?? []} 
                onViewDiff={handleViewDiff}
                onRevert={handleRevert}
                onUndoRevert={handleUndoRevert}
                isReverted={revertedIds.has(part.toolCall.id)}
                {revertedIds}
              />
            {:else}
              <InlineToolCall
                toolCall={part.toolCall}
                streamingProgress={part.toolCall.streamingProgress}
                onApprove={onToolApprove ? () => onToolApprove(message.id, part.toolCall) : undefined}
                onDeny={onToolDeny ? () => onToolDeny(message.id, part.toolCall) : undefined}
                isFirstPendingTerminal={!isTerminalTool(part.toolCall) || part.toolCall.id === firstPendingTerminalId}
              />
            {/if}
          </div>
        {/if}
      {:else if part.type === "text" && part.text.trim()}
        <div class="msg-content">
          {#if message.isStreaming && i === contentParts.length - 1}
            <Markdown content={part.text} /><span class="cursor"></span>
          {:else}
            <Markdown content={part.text} />
          {/if}
        </div>
      {/if}
    {/each}

    {#if contentParts.length === 0 && message.isStreaming}
      <div class="msg-content"><span class="cursor"></span></div>
    {/if}
    
    {#if message.isStreaming && message.inlineToolCalls?.some(tc => tc.status === 'running')}
      <div class="processing-indicator"><UIIcon name="spinner" size={12} /><span>Processing tools...</span></div>
    {/if}
    
    {#if !message.isStreaming && message.content}
      <div class="msg-actions">
        <button class="action-btn" title="Copy" type="button"><UIIcon name="copy" size={12} /></button>
        <button class="action-btn" title="Insert" type="button"><UIIcon name="code" size={12} /></button>
        <button class="action-btn" title="Regenerate" type="button"><UIIcon name="refresh" size={12} /></button>
      </div>
      {#if elapsedTime}
        <div class="elapsed-time"><UIIcon name="clock" size={10} /><span>Elapsed time: {elapsedTime}</span></div>
      {/if}
    {/if}
  </div>
</article>

<style>
  .message-row { display: flex; gap: 10px; animation: slideIn 0.2s ease; }
  @keyframes slideIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

  .avatar {
    display: flex; align-items: center; justify-content: center;
    width: 26px; height: 26px; border-radius: 8px; flex-shrink: 0;
    background: linear-gradient(135deg, var(--color-accent), var(--color-mauve));
    color: var(--color-bg);
  }

  .msg-body { flex: 1; min-width: 0; max-width: calc(100% - 36px); padding-top: 2px; }
  .inline-tool-wrapper { margin: 6px 0; }

  .msg-content {
    font-size: 13px; line-height: 1.6; color: var(--color-text);
    white-space: pre-wrap; word-break: break-word;
  }

  .message-row.streaming .msg-content { border-left: 2px solid var(--color-accent); padding-left: 10px; }

  .cursor {
    display: inline-block; width: 2px; height: 14px;
    background: var(--color-accent); margin-left: 2px;
    vertical-align: text-bottom; animation: blink 1s step-end infinite;
  }
  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }

  .processing-indicator {
    display: flex; align-items: center; gap: 6px;
    padding: 8px 12px; margin-top: 8px; font-size: 12px;
    color: var(--color-text-secondary); background: var(--color-surface0);
    border-radius: 6px; border: 1px solid var(--color-border);
  }
  .processing-indicator :global(svg) { animation: spin 1s linear infinite; color: var(--color-accent); }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

  .msg-actions { display: flex; gap: 2px; margin-top: 6px; opacity: 0; transition: opacity 0.15s ease; }
  .message-row:hover .msg-actions { opacity: 1; }

  .action-btn {
    display: flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; border-radius: 4px;
    color: var(--color-text-secondary); transition: all 0.15s ease;
  }
  .action-btn:hover { background: var(--color-hover); color: var(--color-text); }

  .elapsed-time {
    display: flex; align-items: center; gap: 4px;
    margin-top: 6px; font-size: 10px; color: var(--color-text-secondary); opacity: 0.7;
  }

  .thinking-section {
    margin-bottom: 8px; border-radius: 6px;
    background: var(--color-surface0); border: 1px solid var(--color-border); overflow: hidden;
  }
  .thinking-header {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 10px; font-size: 11px; color: var(--color-text-secondary);
    cursor: pointer; user-select: none;
  }
  .thinking-header:hover { background: var(--color-hover); color: var(--color-text); }
  .thinking-header::-webkit-details-marker { display: none; }
  .thinking-icon { display: flex; color: var(--color-mauve); }
  .thinking-icon.active { animation: pulse 1.5s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.6; transform: scale(0.95); } }
  .thinking-label { flex: 1; font-weight: 500; }
  .thinking-section[open] .thinking-header :global(svg:last-child) { transform: rotate(180deg); }
  .thinking-content {
    padding: 8px 10px; font-size: 12px; line-height: 1.5;
    color: var(--color-text-secondary); border-top: 1px solid var(--color-border);
    white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto;
  }
</style>
