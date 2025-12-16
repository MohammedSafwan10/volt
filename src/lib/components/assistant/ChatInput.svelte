<script lang="ts">
  import { UIIcon } from '$lib/components/ui';

  interface Props {
    inputRef?: HTMLTextAreaElement;
    value: string;
    isStreaming: boolean;
    onInput: (value: string) => void;
    onSend: () => void;
    onStop: () => void;
    onAttachFile: () => void;
    onAttachSelection: () => void;
  }

  let { 
    inputRef = $bindable(),
    value, 
    isStreaming, 
    onInput, 
    onSend, 
    onStop,
    onAttachFile,
    onAttachSelection
  }: Props = $props();

  let showAttachMenu = $state(false);

  function handleKeydown(e: KeyboardEvent): void {
    // Enter to send, Shift+Enter for newline
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (value.trim()) {
        onSend();
      }
    }
    
    // Escape to close attach menu
    if (e.key === 'Escape') {
      if (showAttachMenu) {
        e.preventDefault();
        e.stopPropagation();
        showAttachMenu = false;
      }
    }
  }

  function handleInput(e: Event): void {
    const target = e.target as HTMLTextAreaElement;
    onInput(target.value);
    autoResize(target);
  }

  function autoResize(textarea: HTMLTextAreaElement): void {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
  }

  function toggleAttachMenu(): void {
    showAttachMenu = !showAttachMenu;
  }

  function handleAttachFile(): void {
    onAttachFile();
    showAttachMenu = false;
  }

  function handleAttachSelection(): void {
    onAttachSelection();
    showAttachMenu = false;
  }

  // Close menu when clicking outside
  function handleClickOutside(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (!target.closest('.attach-container')) {
      showAttachMenu = false;
    }
  }
</script>

<svelte:window onclick={handleClickOutside} />

<div class="chat-input-container">
  <div class="input-row">
    <!-- Attach button -->
    <div class="attach-container">
      <button
        class="attach-btn"
        onclick={toggleAttachMenu}
        title="Attach context"
        aria-label="Attach context"
        aria-expanded={showAttachMenu}
        aria-haspopup="menu"
        type="button"
      >
        <UIIcon name="plus" size={16} />
      </button>
      
      {#if showAttachMenu}
        <div class="attach-menu" role="menu">
          <button
            class="attach-option"
            onclick={handleAttachFile}
            role="menuitem"
            type="button"
          >
            <UIIcon name="file" size={14} />
            <span>Current file</span>
          </button>
          <button
            class="attach-option"
            onclick={handleAttachSelection}
            role="menuitem"
            type="button"
          >
            <UIIcon name="code" size={14} />
            <span>Selection</span>
          </button>
        </div>
      {/if}
    </div>

    <!-- Text input -->
    <textarea
      bind:this={inputRef}
      class="chat-textarea"
      placeholder="Ask a question..."
      rows="1"
      {value}
      oninput={handleInput}
      onkeydown={handleKeydown}
      aria-label="Message input"
    ></textarea>

    <!-- Send/Stop button -->
    {#if isStreaming}
      <button
        class="action-btn stop"
        onclick={onStop}
        title="Stop (Esc)"
        aria-label="Stop generation"
        type="button"
      >
        <UIIcon name="stop" size={16} />
      </button>
    {:else}
      <button
        class="action-btn send"
        onclick={onSend}
        disabled={!value.trim()}
        title="Send (Enter)"
        aria-label="Send message"
        type="button"
      >
        <UIIcon name="play" size={16} />
      </button>
    {/if}
  </div>
  
  <div class="input-hint">
    <span>Enter to send, Shift+Enter for newline</span>
  </div>
</div>

<style>
  .chat-input-container {
    padding: 12px;
  }

  .input-row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    background: var(--color-bg-input);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 8px;
    transition: border-color 0.15s ease;
  }

  .input-row:focus-within {
    border-color: var(--color-accent);
  }

  .attach-container {
    position: relative;
    flex-shrink: 0;
  }

  .attach-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 4px;
    color: var(--color-text-secondary);
    transition: all 0.15s ease;
  }

  .attach-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .attach-btn:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
  }

  .attach-menu {
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: 4px;
    background: var(--color-bg-elevated);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    box-shadow: var(--shadow-elevated);
    min-width: 140px;
    z-index: 100;
    overflow: hidden;
  }

  .attach-option {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    font-size: 12px;
    color: var(--color-text);
    text-align: left;
    transition: background 0.15s ease;
  }

  .attach-option:hover {
    background: var(--color-hover);
  }

  .attach-option:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
  }

  .chat-textarea {
    flex: 1;
    min-height: 28px;
    max-height: 150px;
    padding: 4px 0;
    background: transparent;
    border: none;
    color: var(--color-text);
    font-size: 13px;
    line-height: 1.4;
    resize: none;
    outline: none;
  }

  .chat-textarea::placeholder {
    color: var(--color-text-disabled);
  }

  .action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 4px;
    flex-shrink: 0;
    transition: all 0.15s ease;
  }

  .action-btn.send {
    background: var(--color-accent);
    color: var(--color-bg);
  }

  .action-btn.send:hover:not(:disabled) {
    filter: brightness(1.1);
  }

  .action-btn.send:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .action-btn.stop {
    background: var(--color-error);
    color: var(--color-bg);
  }

  .action-btn.stop:hover {
    filter: brightness(1.1);
  }

  .action-btn:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  .input-hint {
    display: flex;
    justify-content: flex-end;
    padding-top: 4px;
    font-size: 10px;
    color: var(--color-text-disabled);
  }
</style>
