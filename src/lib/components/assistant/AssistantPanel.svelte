<script lang="ts">
  import { UIIcon } from '$lib/components/ui';
  import { assistantStore, type ToolCall } from '$lib/stores/assistant.svelte';
  import { editorStore } from '$lib/stores/editor.svelte';
  import type { AIMode } from '$lib/stores/ai.svelte';
  import MessageList from './MessageList.svelte';
  import ChatInputBar from './ChatInputBar.svelte';
  import ToolCallRow from './ToolCallRow.svelte';

  // Focus the input when panel opens
  let inputRef: HTMLTextAreaElement | undefined = $state();

  $effect(() => {
    if (assistantStore.panelOpen && inputRef) {
      setTimeout(() => inputRef?.focus(), 50);
    }
  });

  function handleSend(): void {
    const content = assistantStore.inputValue.trim();
    if (!content) return;

    // Cancel any existing stream (cancel-by-default policy)
    if (assistantStore.isStreaming) {
      assistantStore.stopStreaming();
    }

    // Add user message with attached context
    const context = [...assistantStore.attachedContext];
    assistantStore.addUserMessage(content, context);
    
    // Clear input and context
    assistantStore.setInputValue('');
    assistantStore.clearContext();

    // Simulate response (AI integration in Task 10.2)
    simulateResponse(content);
  }

  function simulateResponse(userMessage: string): void {
    const controller = assistantStore.startStreaming();
    const msgId = assistantStore.addAssistantMessage('', true);
    
    let response = `I received your message: "${userMessage.slice(0, 50)}${userMessage.length > 50 ? '...' : ''}"

This is a placeholder response. AI integration will be completed in Task 10.2.

Current mode: **${assistantStore.currentMode}**`;

    let index = 0;
    const interval = setInterval(() => {
      if (controller.signal.aborted) {
        clearInterval(interval);
        return;
      }
      
      if (index < response.length) {
        assistantStore.updateAssistantMessage(msgId, response.slice(0, index + 1), true);
        index++;
      } else {
        assistantStore.updateAssistantMessage(msgId, response, false);
        assistantStore.stopStreaming();
        clearInterval(interval);
      }
    }, 15);
  }

  function handleStop(): void {
    assistantStore.stopStreaming();
  }

  function handleModeChange(mode: AIMode): void {
    assistantStore.setMode(mode);
  }

  function handleAttachCurrentFile(): void {
    const activeFile = editorStore.activeFile;
    if (!activeFile) return;

    assistantStore.attachContext({
      type: 'file',
      path: activeFile.path,
      content: activeFile.content,
      label: activeFile.path.split('/').pop() ?? activeFile.path
    });
  }

  function handleAttachSelection(): void {
    import('$lib/services/monaco-models').then(({ getEditorSelection }) => {
      const selection = getEditorSelection();
      if (selection && selection.text) {
        assistantStore.attachContext({
          type: 'selection',
          path: selection.path ?? undefined,
          content: selection.text,
          label: `Selection from ${selection.path?.split('/').pop() ?? 'editor'}`
        });
      }
    }).catch(() => {});
  }

  function handleRemoveContext(index: number): void {
    assistantStore.removeContext(index);
  }

  function handleClearConversation(): void {
    assistantStore.clearConversation();
  }

  function handleToolApprove(toolCall: ToolCall): void {
    assistantStore.updateToolCall(toolCall.id, { 
      status: 'running',
      startTime: Date.now()
    });
  }

  function handleToolDeny(toolCall: ToolCall): void {
    assistantStore.updateToolCall(toolCall.id, { 
      status: 'cancelled',
      endTime: Date.now()
    });
  }
</script>

<aside class="assistant-panel" aria-label="AI Assistant">
  <!-- Header -->
  <header class="panel-header">
    <div class="header-left">
      <div class="header-icon">
        <UIIcon name="comment" size={14} />
      </div>
      <span class="header-title">CHAT</span>
    </div>
    <div class="header-actions">
      <button
        class="header-btn"
        onclick={handleClearConversation}
        title="New chat"
        aria-label="New chat"
        type="button"
      >
        <UIIcon name="plus" size={14} />
      </button>
      <button
        class="header-btn"
        title="Settings"
        aria-label="Settings"
        type="button"
      >
        <UIIcon name="settings" size={14} />
      </button>
      <button
        class="header-btn"
        title="More actions"
        aria-label="More actions"
        type="button"
      >
        <UIIcon name="more" size={14} />
      </button>
      <button
        class="header-btn"
        onclick={() => assistantStore.closePanel()}
        title="Close (Ctrl+L)"
        aria-label="Close assistant panel"
        type="button"
      >
        <UIIcon name="close" size={14} />
      </button>
    </div>
  </header>

  <!-- Messages Area -->
  <div class="messages-area">
    <MessageList messages={assistantStore.messages} currentMode={assistantStore.currentMode} />
    
    <!-- Active Tool Calls -->
    {#if assistantStore.activeToolCalls.length > 0}
      <div class="tool-calls-section" role="region" aria-label="Tool activity">
        {#each assistantStore.activeToolCalls as toolCall (toolCall.id)}
          <ToolCallRow 
            {toolCall}
            onApprove={() => handleToolApprove(toolCall)}
            onDeny={() => handleToolDeny(toolCall)}
          />
        {/each}
      </div>
    {/if}
  </div>

  <!-- Input Area (Bottom) -->
  <div class="input-area">
    <!-- Attached Context Chips -->
    {#if assistantStore.attachedContext.length > 0}
      <div class="attached-context" role="list" aria-label="Attached context">
        {#each assistantStore.attachedContext as ctx, i (i)}
          <div class="context-chip" role="listitem">
            <UIIcon name={ctx.type === 'file' ? 'file' : 'code'} size={12} />
            <span class="context-label">{ctx.label}</span>
            <button
              class="context-remove"
              onclick={() => handleRemoveContext(i)}
              title="Remove"
              aria-label="Remove {ctx.label}"
              type="button"
            >
              <UIIcon name="close" size={10} />
            </button>
          </div>
        {/each}
      </div>
    {/if}

    <ChatInputBar
      bind:inputRef
      value={assistantStore.inputValue}
      isStreaming={assistantStore.isStreaming}
      currentMode={assistantStore.currentMode}
      onInput={(v) => assistantStore.setInputValue(v)}
      onSend={handleSend}
      onStop={handleStop}
      onModeChange={handleModeChange}
      onAttachFile={handleAttachCurrentFile}
      onAttachSelection={handleAttachSelection}
    />
  </div>
</aside>

<style>
  .assistant-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-bg-panel);
    border-left: 1px solid var(--color-border);
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: var(--color-bg-header);
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
    min-height: 36px;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .header-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-secondary);
  }

  .header-title {
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--color-text);
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .header-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 4px;
    color: var(--color-text-secondary);
    transition: all 0.15s ease;
  }

  .header-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .header-btn:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
  }

  .messages-area {
    flex: 1;
    overflow: hidden;
    min-height: 0;
  }

  .tool-calls-section {
    padding: 8px 12px;
    border-top: 1px solid var(--color-border);
    background: var(--color-bg-sidebar);
  }

  .input-area {
    border-top: 1px solid var(--color-border);
    background: var(--color-bg-sidebar);
    flex-shrink: 0;
  }

  .attached-context {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 12px 0;
  }

  .context-chip {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 6px 3px 8px;
    background: var(--color-surface0);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: 11px;
    color: var(--color-text-secondary);
  }

  .context-label {
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .context-remove {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border-radius: 2px;
    color: var(--color-text-secondary);
    opacity: 0.7;
    transition: all 0.15s ease;
  }

  .context-remove:hover {
    opacity: 1;
    background: var(--color-hover);
    color: var(--color-text);
  }
</style>
