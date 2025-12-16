<script lang="ts">
  import { UIIcon } from '$lib/components/ui';
  import { assistantStore, type ToolCall, type ImageAttachment, IMAGE_LIMITS } from '$lib/stores/assistant.svelte';
  import { editorStore } from '$lib/stores/editor.svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import type { AIMode } from '$lib/stores/ai.svelte';
  import { streamChat, type ChatMessage, type ContentPart } from '$lib/services/ai';
  import MessageList from './MessageList.svelte';
  import ChatInputBar from './ChatInputBar.svelte';
  import ToolCallRow from './ToolCallRow.svelte';
  import { open } from '@tauri-apps/plugin-dialog';

  // Focus the input when panel opens
  let inputRef: HTMLTextAreaElement | undefined = $state();

  $effect(() => {
    if (assistantStore.panelOpen && inputRef) {
      setTimeout(() => inputRef?.focus(), 50);
    }
  });

  function toProviderMessages(messages: typeof assistantStore.messages): ChatMessage[] {
    const out: ChatMessage[] = [];

    for (const msg of messages) {
      if (msg.role !== 'user' && msg.role !== 'assistant') continue;

      if (msg.role === 'assistant') {
        out.push({ role: 'assistant', content: msg.content });
        continue;
      }

      const attachments = msg.attachments ?? [];
      const imageAttachments = attachments.filter(a => a.type === 'image') as ImageAttachment[];

      if (imageAttachments.length === 0) {
        out.push({ role: 'user', content: msg.content });
        continue;
      }

      const parts: ContentPart[] = [];
      if (msg.content.trim().length > 0) {
        parts.push({ type: 'text', text: msg.content });
      }
      for (const img of imageAttachments) {
        parts.push({ type: 'image', mimeType: img.mimeType, data: img.data });
      }

      out.push({ role: 'user', content: msg.content, parts });
    }

    return out;
  }

  async function handleSend(): Promise<void> {
    const content = assistantStore.inputValue.trim();
    if (!content && assistantStore.pendingAttachments.length === 0) return;

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

    const providerMessages = toProviderMessages(assistantStore.messages);
    const controller = assistantStore.startStreaming();
    const msgId = assistantStore.addAssistantMessage('', true);

    const caps = assistantStore.modeCapabilities;
    const systemPrompt = `You are the AI assistant inside Volt (a code editor).

Current mode: ${assistantStore.currentMode}.
- canMutateFiles: ${caps.canMutateFiles}
- canExecuteCommands: ${caps.canExecuteCommands}
- canUseTools: ${caps.canUseTools}

If canMutateFiles is false, do not instruct the app to modify files. Provide analysis, explanations, or plans only.`;

    let acc = '';

    try {
      for await (const chunk of streamChat({
        messages: providerMessages,
        systemPrompt,
        stream: true
      }, assistantStore.currentMode, controller.signal)) {
        if (controller.signal.aborted) return;

        if (chunk.type === 'content' && chunk.content) {
          acc += chunk.content;
          assistantStore.updateAssistantMessage(msgId, acc, true);
        }

        if (chunk.type === 'error') {
          const error = chunk.error ?? 'Unknown error';
          assistantStore.updateAssistantMessage(msgId, `Error: ${error}`, false);
          showToast({ message: error, type: 'error' });
          return;
        }
      }

      assistantStore.updateAssistantMessage(msgId, acc, false);
    } catch (err) {
      if (controller.signal.aborted) return;

      const msg = err instanceof Error ? err.message : 'Unknown error';
      assistantStore.updateAssistantMessage(msgId, `Error: ${msg}`, false);
      showToast({ message: msg, type: 'error' });
    } finally {
      // Finish streaming without re-aborting (stopStreaming is for user-cancel)
      if (assistantStore.abortController === controller) {
        assistantStore.abortController = null;
      }
      assistantStore.isStreaming = false;
      assistantStore.updateAssistantMessage(msgId, acc, false);
    }
  }

  function handleStop(): void {
    assistantStore.stopStreaming();
  }

  function handleModeChange(mode: AIMode): void {
    assistantStore.setMode(mode);
  }

  function handleAttachCurrentFile(): void {
    const activeFile = editorStore.activeFile;
    if (!activeFile) {
      showToast({ message: 'No file is currently open', type: 'warning' });
      return;
    }

    // Use new attachment model
    const result = assistantStore.attachFile(activeFile.path, activeFile.content);
    if (!result.success) {
      showToast({ message: result.error ?? 'Failed to attach file', type: 'warning' });
    }

    // Also add to legacy context for backward compatibility
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
        // Use new attachment model with range
        const result = assistantStore.attachSelection(
          selection.text,
          selection.path ?? undefined,
          selection.range ? {
            startLine: selection.range.startLineNumber,
            startCol: selection.range.startColumn,
            endLine: selection.range.endLineNumber,
            endCol: selection.range.endColumn
          } : undefined
        );
        
        if (!result.success) {
          showToast({ message: result.error ?? 'Failed to attach selection', type: 'warning' });
          return;
        }

        // Also add to legacy context
        assistantStore.attachContext({
          type: 'selection',
          path: selection.path ?? undefined,
          content: selection.text,
          label: `Selection from ${selection.path?.split('/').pop() ?? 'editor'}`
        });
      } else {
        showToast({ message: 'No text selected in editor', type: 'warning' });
      }
    }).catch(() => {
      showToast({ message: 'Failed to get selection', type: 'error' });
    });
  }

  /**
   * Handle image attachment from file (drag & drop or paste)
   */
  async function handleAttachImage(file: File): Promise<void> {
    // Validate mime type
    const mimeType = file.type as typeof IMAGE_LIMITS.allowedMimeTypes[number];
    if (!IMAGE_LIMITS.allowedMimeTypes.includes(mimeType)) {
      showToast({ 
        message: `Unsupported image type: ${file.type}. Use PNG, JPEG, or WebP.`, 
        type: 'warning' 
      });
      return;
    }

    // Check file size
    if (file.size > IMAGE_LIMITS.maxImageBytes) {
      const maxMB = IMAGE_LIMITS.maxImageBytes / (1024 * 1024);
      showToast({ 
        message: `Image too large (${(file.size / (1024 * 1024)).toFixed(1)}MB). Maximum: ${maxMB}MB`, 
        type: 'warning' 
      });
      return;
    }

    try {
      // Read file as base64
      const base64Data = await readFileAsBase64(file);
      
      // Get image dimensions
      const dimensions = await getImageDimensions(base64Data, mimeType);
      
      // Add to attachments
      const result = assistantStore.attachImage(
        file.name,
        mimeType,
        base64Data,
        dimensions
      );

      if (!result.success) {
        showToast({ message: result.error ?? 'Failed to attach image', type: 'warning' });
      }
    } catch (err) {
      showToast({ message: 'Failed to read image file', type: 'error' });
    }
  }

  /**
   * Open file picker for images
   */
  async function handleAttachImageFromPicker(): Promise<void> {
    try {
      const selected = await open({
        multiple: true,
        filters: [{
          name: 'Images',
          extensions: ['png', 'jpg', 'jpeg', 'webp']
        }]
      });

      if (!selected) return;

      const paths = Array.isArray(selected) ? selected : [selected];
      
      for (const path of paths) {
        // Read file using Tauri fs
        const { readFile } = await import('@tauri-apps/plugin-fs');
        const bytes = await readFile(path);
        
        // Convert to base64
        const base64Data = btoa(
          bytes.reduce((data: string, byte: number) => data + String.fromCharCode(byte), '')
        );
        
        // Determine mime type from extension
        const ext = path.split('.').pop()?.toLowerCase();
        let mimeType: 'image/png' | 'image/jpeg' | 'image/webp' = 'image/png';
        if (ext === 'jpg' || ext === 'jpeg') mimeType = 'image/jpeg';
        else if (ext === 'webp') mimeType = 'image/webp';
        
        // Get filename
        const filename = path.split(/[/\\]/).pop() ?? 'image';
        
        // Get dimensions
        const dimensions = await getImageDimensions(base64Data, mimeType);
        
        // Add to attachments
        const result = assistantStore.attachImage(filename, mimeType, base64Data, dimensions);
        if (!result.success) {
          showToast({ message: result.error ?? 'Failed to attach image', type: 'warning' });
        }
      }
    } catch (err) {
      showToast({ message: 'Failed to open image picker', type: 'error' });
    }
  }

  /**
   * Read a File as base64 string
   */
  function readFileAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Remove data URL prefix (e.g., "data:image/png;base64,")
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /**
   * Get image dimensions from base64 data
   */
  function getImageDimensions(base64: string, mimeType: string): Promise<{ width: number; height: number } | undefined> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        resolve({ width: img.width, height: img.height });
      };
      img.onerror = () => {
        resolve(undefined);
      };
      img.src = `data:${mimeType};base64,${base64}`;
    });
  }

  function handleRemoveContext(index: number): void {
    assistantStore.removeContext(index);
  }

  function handleRemoveAttachment(id: string): void {
    assistantStore.removeAttachment(id);
  }

  function handleClearConversation(): void {
    assistantStore.clearConversation();
  }

  function handleToolApprove(toolCall: ToolCall): void {
    // Validate tool call against current mode
    const error = assistantStore.validateToolCall(toolCall.name);
    if (error) {
      showToast({ message: error, type: 'warning' });
      assistantStore.updateToolCall(toolCall.id, { 
        status: 'cancelled',
        error,
        endTime: Date.now()
      });
      return;
    }

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

  // Get attachment previews for display
  const attachmentPreviews = $derived(assistantStore.getAttachmentPreviews());
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
    <!-- Attachment Previews (new model) -->
    {#if attachmentPreviews.length > 0}
      <div class="attachment-previews" role="list" aria-label="Attachments to send">
        {#each attachmentPreviews as preview (preview.id)}
          <div class="attachment-preview" class:is-image={preview.isImage} role="listitem">
            {#if preview.isImage && preview.thumbnailData}
              <img 
                src="data:image/png;base64,{preview.thumbnailData}" 
                alt={preview.label}
                class="attachment-thumbnail"
              />
            {:else}
              <UIIcon 
                name={preview.type === 'file' ? 'file' : preview.type === 'selection' ? 'code' : preview.type === 'folder' ? 'folder' : 'image'} 
                size={14} 
              />
            {/if}
            <div class="attachment-info">
              <span class="attachment-label">{preview.label}</span>
              {#if preview.size || preview.dimensions}
                <span class="attachment-meta">
                  {preview.dimensions ?? ''}{preview.dimensions && preview.size ? ' · ' : ''}{preview.size ?? ''}
                </span>
              {/if}
            </div>
            <button
              class="attachment-remove"
              onclick={() => handleRemoveAttachment(preview.id)}
              title="Remove"
              aria-label="Remove {preview.label}"
              type="button"
            >
              <UIIcon name="close" size={10} />
            </button>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Legacy Attached Context Chips (for backward compatibility) -->
    {#if assistantStore.attachedContext.length > 0 && attachmentPreviews.length === 0}
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
      onAttachImage={handleAttachImage}
      onAttachImageFromPicker={handleAttachImageFromPicker}
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

  /* Attachment previews (new model) */
  .attachment-previews {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 12px 0;
  }

  .attachment-preview {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px 4px 8px;
    background: var(--color-surface0);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-size: 11px;
    color: var(--color-text-secondary);
    max-width: 200px;
  }

  .attachment-preview.is-image {
    padding: 4px;
  }

  .attachment-thumbnail {
    width: 32px;
    height: 32px;
    object-fit: cover;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .attachment-info {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }

  .attachment-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text);
  }

  .attachment-meta {
    font-size: 10px;
    color: var(--color-text-disabled);
  }

  .attachment-remove {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 3px;
    color: var(--color-text-secondary);
    opacity: 0.7;
    transition: all 0.15s ease;
    flex-shrink: 0;
  }

  .attachment-remove:hover {
    opacity: 1;
    background: var(--color-hover);
    color: var(--color-text);
  }
</style>
