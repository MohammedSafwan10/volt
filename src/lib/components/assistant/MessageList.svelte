<script lang="ts">
  import { UIIcon, Markdown } from '$lib/components/ui';
  import type { AssistantMessage, ImageAttachment, ToolCall, ContentPart } from '$lib/stores/assistant.svelte';
  import type { AIMode } from '$lib/stores/ai.svelte';
  import InlineToolCall from './InlineToolCall.svelte';

  interface Props {
    messages: AssistantMessage[];
    currentMode?: AIMode;
    onToolApprove?: (messageId: string, toolCall: ToolCall) => void;
    onToolDeny?: (messageId: string, toolCall: ToolCall) => void;
    onToolAcceptEdit?: (messageId: string, toolCall: ToolCall) => void;
    onToolRejectEdit?: (messageId: string, toolCall: ToolCall) => void;
  }

  let { messages, currentMode = 'ask', onToolApprove, onToolDeny, onToolAcceptEdit, onToolRejectEdit }: Props = $props();

  // Get content parts for a message, falling back to legacy content if no parts
  function getContentParts(message: AssistantMessage): ContentPart[] {
    if (message.contentParts && message.contentParts.length > 0) {
      return message.contentParts;
    }
    // Fallback: convert legacy content to a single text part
    if (message.content) {
      return [{ type: 'text', text: message.content }];
    }
    return [];
  }

  // Image preview modal state
  let previewImage = $state<{ src: string; alt: string } | null>(null);

  function openImagePreview(img: ImageAttachment): void {
    previewImage = {
      src: `data:${img.mimeType};base64,${img.data}`,
      alt: img.filename
    };
  }

  function closeImagePreview(): void {
    previewImage = null;
  }

  function handlePreviewKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      closeImagePreview();
    }
  }

  function handleBackdropClick(e: MouseEvent): void {
    if ((e.target as HTMLElement).classList.contains('image-preview-modal')) {
      closeImagePreview();
    }
  }

  // Get image attachments from a message
  function getImageAttachments(message: AssistantMessage): ImageAttachment[] {
    return (message.attachments ?? []).filter(a => a.type === 'image') as ImageAttachment[];
  }

  function isReviewableEdit(tc: ToolCall): boolean {
    if (tc.reviewStatus !== 'pending') return false;
    if (tc.status !== 'completed') return false;
    const metaAny = tc.meta as any;
    const before = metaAny?.fileEdit?.beforeContent;
    return typeof before === 'string' && before.length > 0;
  }

  function getPendingReviewEdits(message: AssistantMessage): ToolCall[] {
    return (message.inlineToolCalls ?? []).filter(isReviewableEdit);
  }

  async function acceptAllEdits(messageId: string, toolCalls: ToolCall[]): Promise<void> {
    if (!onToolAcceptEdit) return;
    for (const tc of toolCalls) {
      await onToolAcceptEdit(messageId, tc);
    }
  }

  async function rejectAllEdits(messageId: string, toolCalls: ToolCall[]): Promise<void> {
    if (!onToolRejectEdit) return;
    for (const tc of toolCalls) {
      await onToolRejectEdit(messageId, tc);
    }
  }

  let containerRef: HTMLDivElement | undefined = $state();
  let userNearBottom = $state(true);
  let showJumpButton = $state(false);

  // Track scroll position for jump button visibility and autoscroll decision
  function handleScroll(): void {
    if (!containerRef) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    
    // User is "near bottom" if within 80px
    userNearBottom = distanceFromBottom < 80;
    showJumpButton = distanceFromBottom > 150;
  }

  // Jump to bottom with smooth scroll
  function jumpToBottom(): void {
    containerRef?.scrollTo({ top: containerRef.scrollHeight, behavior: 'smooth' });
    showJumpButton = false;
    userNearBottom = true;
  }

  // Scroll to bottom helper (instant, no animation)
  function scrollToBottom(): void {
    if (!containerRef) return;
    containerRef.scrollTop = containerRef.scrollHeight;
  }

  // Auto-scroll effect - runs AFTER DOM updates
  $effect(() => {
    // Track these to re-run on changes
    const lastMsg = messages[messages.length - 1];
    const content = lastMsg?.content;
    const thinking = lastMsg?.thinking;
    const isStreaming = lastMsg?.isStreaming;
    const msgCount = messages.length;
    
    // Avoid unused variable warnings
    void content;
    void thinking;
    void isStreaming;
    void msgCount;

    if (!containerRef) return;

    // Determine if we should auto-scroll:
    // 1. User is near bottom (hasn't scrolled up)
    // 2. OR the last message is from user (they just sent something)
    // 3. OR streaming just started (isStreaming became true)
    const shouldScroll = userNearBottom || lastMsg?.role === 'user';

    if (shouldScroll) {
      // Use requestAnimationFrame to ensure DOM has updated
      requestAnimationFrame(() => {
        scrollToBottom();
      });
    }
  });

  const emptyStateContent = $derived.by(() => {
    switch (currentMode) {
      case 'agent':
        return {
          icon: 'robot' as const,
          title: 'Agent Mode',
          hint: 'I can execute tasks, run commands, edit files, and help you build features.',
          actions: [
            { icon: 'file-plus' as const, label: 'Create a component' },
            { icon: 'pencil' as const, label: 'Refactor this file' },
            { icon: 'terminal' as const, label: 'Run tests' }
          ]
        };
      case 'plan':
        return {
          icon: 'file' as const,
          title: 'Plan Mode',
          hint: 'Let me help you design and plan features with detailed specs.',
          actions: [
            { icon: 'file' as const, label: 'Design a feature' },
            { icon: 'code' as const, label: 'Plan architecture' },
            { icon: 'search' as const, label: 'Review requirements' }
          ]
        };
      default:
        return {
          icon: 'sparkle' as const,
          title: 'How can I help?',
          hint: 'Ask me anything about your code. I can explain or help debug.',
          actions: [
            { icon: 'code' as const, label: 'Explain this code' },
            { icon: 'warning' as const, label: 'Fix a bug' },
            { icon: 'info' as const, label: 'How does this work?' }
          ]
        };
    }
  });

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
</script>

<div class="message-list-wrapper">
  <div class="message-list" bind:this={containerRef} onscroll={handleScroll} role="log" aria-live="polite">
  {#if messages.length === 0}
    <div class="empty-state">
      <div class="empty-icon {currentMode}">
        <UIIcon name={emptyStateContent.icon} size={32} />
      </div>
      <h3 class="empty-title">{emptyStateContent.title}</h3>
      <p class="empty-hint">{emptyStateContent.hint}</p>
      <div class="quick-actions">
        {#each emptyStateContent.actions as action (action.label)}
          <button class="quick-action" type="button">
            <UIIcon name={action.icon} size={14} />
            <span>{action.label}</span>
          </button>
        {/each}
      </div>
    </div>
  {:else}
    {#each messages as message (message.id)}
      {#if message.role === 'user'}
        {@const images = getImageAttachments(message)}
        <div class="message-row user">
          <div class="user-bubble">
            {#if images.length > 0}
              <div class="message-images" class:single={images.length === 1} class:multiple={images.length > 1}>
                {#each images as img (img.id)}
                  <button
                    class="message-image-btn"
                    onclick={() => openImagePreview(img)}
                    title="Click to view full image"
                    type="button"
                  >
                    <img 
                      src="data:{img.mimeType};base64,{img.data}" 
                      alt={img.filename}
                      class="message-image-thumb"
                    />
                  </button>
                {/each}
              </div>
            {/if}
            {#if message.content.trim()}
              <div class="bubble-text">{message.content}</div>
            {/if}
            <span class="bubble-time">{formatTime(message.timestamp)}</span>
          </div>
        </div>
      {:else if message.role === 'tool'}
        <!-- Tool messages are internal - don't render them in the UI -->
        <!-- They're used for conversation context with the API -->
      {:else if message.role === 'assistant'}
        <article class="message-row assistant" class:streaming={message.isStreaming}>
          <div class="avatar assistant">
            <UIIcon name="bolt" size={14} />
          </div>
          <div class="msg-body">
            <!-- Thinking indicator (collapsible) -->
            {#if message.thinking}
              <details class="thinking-section">
                <summary class="thinking-header">
                  <span class="thinking-icon" class:active={message.isThinking}>
                    <UIIcon name="sparkle" size={12} />
                  </span>
                  <span class="thinking-label">
                    {message.isThinking ? 'Thinking...' : 'Reasoning (click to view)'}
                  </span>
                  <UIIcon name="chevron-down" size={12} />
                </summary>
                <div class="thinking-content">
                  {message.thinking}
                </div>
              </details>
            {/if}

            {#each getContentParts(message) as part, i (part.type === 'tool' ? part.toolCall.id : `text-${i}`)}
              {#if part.type === 'tool'}
                <div class="inline-tool-wrapper">
                  <InlineToolCall 
                    toolCall={part.toolCall}
                    streamingProgress={part.toolCall.streamingProgress}
                    onApprove={onToolApprove ? () => onToolApprove(message.id, part.toolCall) : undefined}
                    onDeny={onToolDeny ? () => onToolDeny(message.id, part.toolCall) : undefined}
                    onAcceptEdit={onToolAcceptEdit ? () => onToolAcceptEdit(message.id, part.toolCall) : undefined}
                    onRejectEdit={onToolRejectEdit ? () => onToolRejectEdit(message.id, part.toolCall) : undefined}
                  />
                </div>
              {:else if part.type === 'text' && part.text.trim()}
                {@const parts = getContentParts(message)}
                <div class="msg-content">
                  {#if message.isStreaming && i === parts.length - 1}
                    <Markdown content={part.text} /><span class="cursor"></span>
                  {:else}
                    <Markdown content={part.text} />
                  {/if}
                </div>
              {/if}
            {/each}
            
            <!-- Bulk review buttons at the bottom of the message -->
            {#if !message.isStreaming && onToolAcceptEdit && onToolRejectEdit && getPendingReviewEdits(message).length >= 1}
              {@const pendingReviewEdits = getPendingReviewEdits(message)}
              <div class="bulk-review">
                <span class="bulk-review-label">Review edits</span>
                <div class="bulk-review-actions">
                  <button
                    class="approve-btn"
                    onclick={() => void acceptAllEdits(message.id, pendingReviewEdits)}
                    type="button"
                  >
                    <UIIcon name="check" size={12} />
                    Accept all
                  </button>
                  <button
                    class="deny-btn"
                    onclick={() => void rejectAllEdits(message.id, pendingReviewEdits)}
                    type="button"
                  >
                    <UIIcon name="close" size={12} />
                    Reject all
                  </button>
                </div>
              </div>
            {/if}
            
            <!-- Fallback for empty streaming message -->
            {#if getContentParts(message).length === 0 && message.isStreaming}
              <div class="msg-content">
                <span class="cursor"></span>
              </div>
            {/if}
            {#if message.role === 'assistant' && !message.isStreaming && message.content}
              <div class="msg-actions">
                <button class="action-btn" title="Copy" type="button"><UIIcon name="copy" size={12} /></button>
                <button class="action-btn" title="Insert" type="button"><UIIcon name="code" size={12} /></button>
                <button class="action-btn" title="Regenerate" type="button"><UIIcon name="refresh" size={12} /></button>
              </div>
            {/if}
          </div>
        </article>
      {/if}
    {/each}
  {/if}
  </div>

  <!-- Jump to bottom button -->
  {#if showJumpButton && messages.length > 0}
    <button
      class="jump-to-bottom"
      onclick={jumpToBottom}
      title="Jump to bottom"
      aria-label="Jump to latest message"
      type="button"
    >
      <UIIcon name="chevron-down" size={14} />
    </button>
  {/if}

  <!-- Image Preview Modal -->
  {#if previewImage}
    <div 
      class="image-preview-modal" 
      onclick={handleBackdropClick}
      onkeydown={handlePreviewKeydown}
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      tabindex="-1"
    >
      <div class="preview-content">
        <button
          class="preview-close"
          onclick={closeImagePreview}
          title="Close (Esc)"
          aria-label="Close preview"
          type="button"
        >
          <UIIcon name="close" size={18} />
        </button>
        <img 
          src={previewImage.src} 
          alt={previewImage.alt}
          class="preview-image"
        />
        <div class="preview-filename">{previewImage.alt}</div>
      </div>
    </div>
  {/if}
</div>

<style>
  .message-list-wrapper {
    position: relative;
    height: 100%;
    overflow: hidden;
  }

  .message-list {
    display: flex;
    flex-direction: column;
    padding: 16px;
    overflow-y: auto;
    height: 100%;
    gap: 12px;
  }

  .jump-to-bottom {
    position: absolute;
    bottom: 12px;
    left: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: transparent;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: all 0.15s ease;
    animation: fadeIn 0.15s ease;
    z-index: 10;
  }

  .jump-to-bottom:hover {
    color: var(--color-accent);
    transform: scale(1.15);
  }

  .jump-to-bottom:active {
    transform: scale(0.9);
  }

  .bulk-review {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--color-border);
    border-radius: 10px;
    background: var(--color-hover);
    margin: 6px 0 10px 0;
  }

  .bulk-review-label {
    font-size: 12px;
    color: var(--color-text-secondary);
  }

  .bulk-review-actions {
    display: flex;
    gap: 8px;
  }

  .approve-btn,
  .deny-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 8px 10px;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s ease;
    background: var(--color-bg);
    color: var(--color-text);
  }

  .approve-btn {
    border-color: rgba(0, 255, 140, 0.25);
  }

  .approve-btn:hover {
    border-color: rgba(0, 255, 140, 0.45);
    transform: translateY(-1px);
  }

  .deny-btn {
    border-color: rgba(255, 80, 80, 0.25);
  }

  .deny-btn:hover {
    border-color: rgba(255, 80, 80, 0.45);
    transform: translateY(-1px);
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 40px 20px;
    gap: 12px;
    flex: 1;
  }

  .empty-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 56px;
    border-radius: 16px;
    color: var(--color-bg);
    margin-bottom: 4px;
  }

  .empty-icon.ask { background: linear-gradient(135deg, var(--color-accent), var(--color-sapphire)); }
  .empty-icon.agent { background: linear-gradient(135deg, var(--color-green), var(--color-teal)); }
  .empty-icon.plan { background: linear-gradient(135deg, var(--color-mauve), var(--color-pink)); }

  .empty-title { font-size: 15px; font-weight: 600; color: var(--color-text); margin: 0; }
  .empty-hint { font-size: 12px; color: var(--color-text-secondary); max-width: 240px; margin: 0; line-height: 1.5; }

  .quick-actions { display: flex; flex-direction: column; gap: 6px; margin-top: 16px; width: 100%; max-width: 200px; }

  .quick-action {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    font-size: 12px;
    color: var(--color-text);
    transition: all 0.15s ease;
    text-align: left;
  }

  .quick-action:hover {
    background: var(--color-hover);
    border-color: var(--color-accent);
    transform: translateY(-1px);
  }

  .message-row { display: flex; gap: 10px; animation: slideIn 0.2s ease; }
  .message-row.user { justify-content: flex-end; }

  @keyframes slideIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .user-bubble {
    max-width: 80%;
    padding: 10px 14px;
    background: var(--color-accent);
    color: var(--color-bg);
    border-radius: 16px 16px 4px 16px;
    font-size: 13px;
    line-height: 1.5;
  }

  .bubble-text { white-space: pre-wrap; word-break: break-word; }
  .bubble-time { display: block; font-size: 10px; opacity: 0.7; margin-top: 4px; text-align: right; }

  .avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 8px;
    flex-shrink: 0;
  }

  .avatar.assistant { background: linear-gradient(135deg, var(--color-accent), var(--color-mauve)); color: var(--color-bg); }
  .avatar.tool { background: var(--color-warning); color: var(--color-bg); }

  .msg-body { flex: 1; min-width: 0; max-width: calc(100% - 36px); padding-top: 2px; }

  .inline-tool-wrapper {
    margin: 6px 0;
  }

  .inline-tools {
    margin-bottom: 8px;
  }

  .msg-content {
    font-size: 13px;
    line-height: 1.6;
    color: var(--color-text);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .message-row.streaming .msg-content { border-left: 2px solid var(--color-accent); padding-left: 10px; }

  .cursor {
    display: inline-block;
    width: 2px;
    height: 14px;
    background: var(--color-accent);
    margin-left: 2px;
    vertical-align: text-bottom;
    animation: blink 1s step-end infinite;
  }

  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }

  .msg-actions { display: flex; gap: 2px; margin-top: 6px; opacity: 0; transition: opacity 0.15s ease; }
  .message-row:hover .msg-actions { opacity: 1; }

  .action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    color: var(--color-text-secondary);
    transition: all 0.15s ease;
  }

  .action-btn:hover { background: var(--color-hover); color: var(--color-text); }

  /* Thinking section */
  .thinking-section {
    margin-bottom: 8px;
    border-radius: 6px;
    background: var(--color-surface0);
    border: 1px solid var(--color-border);
    overflow: hidden;
    animation: fadeIn 0.2s ease;
  }

  .thinking-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    font-size: 11px;
    color: var(--color-text-secondary);
    cursor: pointer;
    user-select: none;
    transition: all 0.15s ease;
  }

  .thinking-header:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .thinking-header::-webkit-details-marker {
    display: none;
  }

  .thinking-icon {
    display: flex;
    color: var(--color-mauve);
    transition: transform 0.3s ease;
  }

  .thinking-icon.active {
    animation: pulse 1.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.6; transform: scale(0.95); }
  }

  .thinking-label {
    flex: 1;
    font-weight: 500;
  }

  .thinking-section[open] .thinking-header :global(svg:last-child) {
    transform: rotate(180deg);
  }

  .thinking-content {
    padding: 8px 10px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--color-text-secondary);
    border-top: 1px solid var(--color-border);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow-y: auto;
  }

  /* Message images */
  .message-images {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 8px;
  }

  .message-images.single {
    max-width: 200px;
  }

  .message-images.multiple {
    max-width: 100%;
  }

  .message-image-btn {
    display: block;
    padding: 0;
    border-radius: 8px;
    overflow: hidden;
    cursor: pointer;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
    background: transparent;
  }

  .message-image-btn:hover {
    transform: scale(1.02);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }

  .message-image-btn:focus-visible {
    outline: 2px solid var(--color-bg);
    outline-offset: 2px;
  }

  .message-image-thumb {
    display: block;
    max-width: 180px;
    max-height: 120px;
    width: auto;
    height: auto;
    object-fit: cover;
    border-radius: 6px;
  }

  .message-images.multiple .message-image-thumb {
    max-width: 80px;
    max-height: 80px;
  }

  /* Image Preview Modal */
  .image-preview-modal {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.85);
    z-index: 1000;
    animation: fadeIn 0.2s ease;
    backdrop-filter: blur(4px);
  }

  .preview-content {
    position: relative;
    max-width: 90vw;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    animation: scaleIn 0.2s ease;
  }

  @keyframes scaleIn {
    from { opacity: 0; transform: scale(0.95); }
    to { opacity: 1; transform: scale(1); }
  }

  .preview-close {
    position: absolute;
    top: -40px;
    right: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.1);
    color: white;
    transition: all 0.15s ease;
  }

  .preview-close:hover {
    background: rgba(255, 255, 255, 0.2);
    transform: scale(1.1);
  }

  .preview-image {
    max-width: 90vw;
    max-height: 80vh;
    object-fit: contain;
    border-radius: 8px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
  }

  .preview-filename {
    margin-top: 12px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.7);
    text-align: center;
  }
</style>
