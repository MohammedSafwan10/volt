<script lang="ts">
  import { tick } from 'svelte';
  import { UIIcon } from '$lib/components/ui';
  import type { AssistantMessage } from '$lib/stores/assistant.svelte';
  import type { AIMode } from '$lib/stores/ai.svelte';

  interface Props {
    messages: AssistantMessage[];
    currentMode?: AIMode;
  }

  let { messages, currentMode = 'ask' }: Props = $props();

  let containerRef: HTMLDivElement | undefined = $state();
  let autoscroll = true;
  let showJumpButton = $state(false);

  // Track scroll position for jump button visibility
  function handleScroll(): void {
    if (!containerRef) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    showJumpButton = distanceFromBottom > 150;
  }

  // Jump to bottom with smooth scroll
  function jumpToBottom(): void {
    containerRef?.scrollTo({ top: containerRef.scrollHeight, behavior: 'smooth' });
    showJumpButton = false;
  }

  // Use $effect.pre to check scroll position BEFORE DOM updates (Svelte 5 recommended pattern)
  $effect.pre(() => {
    // Reference messages to trigger on changes
    const lastMsg = messages[messages.length - 1];
    void lastMsg?.content;
    void messages.length;

    if (!containerRef) return;

    // Check if user is near bottom BEFORE the DOM update
    const { scrollTop, scrollHeight, clientHeight } = containerRef;
    autoscroll = scrollHeight - scrollTop - clientHeight < 50;

    // If user just sent a message, always scroll
    if (lastMsg?.role === 'user') {
      autoscroll = true;
    }

    if (autoscroll) {
      // Use tick() to scroll AFTER DOM updates
      tick().then(() => {
        containerRef?.scrollTo(0, containerRef.scrollHeight);
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
        <div class="message-row user">
          <div class="user-bubble">
            <div class="bubble-text">{message.content}</div>
            <span class="bubble-time">{formatTime(message.timestamp)}</span>
          </div>
        </div>
      {:else}
        <article class="message-row {message.role}" class:streaming={message.isStreaming}>
          <div class="avatar {message.role}">
            <UIIcon name={message.role === 'assistant' ? 'bolt' : 'terminal'} size={14} />
          </div>
          <div class="msg-body">
            <div class="msg-content">
              {#if message.isStreaming}
                <span>{message.content}</span><span class="cursor"></span>
              {:else}
                <span>{message.content}</span>
              {/if}
            </div>
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

  .msg-body { flex: 1; min-width: 0; padding-top: 2px; }

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
</style>
