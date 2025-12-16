<script lang="ts">
  import { UIIcon } from '$lib/components/ui';
  import type { AIMode } from '$lib/stores/ai.svelte';

  interface Props {
    inputRef?: HTMLTextAreaElement;
    value: string;
    isStreaming: boolean;
    currentMode: AIMode;
    onInput: (value: string) => void;
    onSend: () => void;
    onStop: () => void;
    onModeChange: (mode: AIMode) => void;
    onAttachFile: () => void;
    onAttachSelection: () => void;
  }

  let { 
    inputRef = $bindable(),
    value, 
    isStreaming,
    currentMode,
    onInput, 
    onSend, 
    onStop,
    onModeChange,
    onAttachFile,
    onAttachSelection
  }: Props = $props();

  let showModeMenu = $state(false);
  let showAttachMenu = $state(false);

  const modes: { id: AIMode; label: string; shortcut?: string; description: string }[] = [
    { id: 'agent', label: 'Agent', description: 'Execute tasks with tools' },
    { id: 'ask', label: 'Ask', description: 'Quick questions and explanations' },
    { id: 'plan', label: 'Plan', description: 'Design and plan features' }
  ];

  const currentModeInfo = $derived(modes.find(m => m.id === currentMode) ?? modes[0]);

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (value.trim()) {
        onSend();
      }
    }
    
    if (e.key === 'Escape') {
      if (showModeMenu || showAttachMenu || isStreaming) {
        e.preventDefault();
        e.stopPropagation();
        showModeMenu = false;
        showAttachMenu = false;
        if (isStreaming) onStop();
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

  function selectMode(mode: AIMode): void {
    onModeChange(mode);
    showModeMenu = false;
  }

  function handleAttachFile(): void {
    onAttachFile();
    showAttachMenu = false;
  }

  function handleAttachSelection(): void {
    onAttachSelection();
    showAttachMenu = false;
  }

  function handleClickOutside(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (!target.closest('.mode-dropdown-container')) {
      showModeMenu = false;
    }
    if (!target.closest('.attach-dropdown-container')) {
      showAttachMenu = false;
    }
  }
</script>

<svelte:window onclick={handleClickOutside} />

<div class="chat-input-bar">
  <!-- Text Input Area -->
  <div class="input-wrapper">
    <textarea
      bind:this={inputRef}
      class="chat-textarea"
      placeholder="Ask anything or type / for commands..."
      rows="1"
      {value}
      oninput={handleInput}
      onkeydown={handleKeydown}
      aria-label="Message input"
    ></textarea>
  </div>

  <!-- Bottom Bar with Mode Selector and Actions -->
  <div class="bottom-bar">
    <div class="left-controls">
      <!-- Mode Selector Dropdown -->
      <div class="mode-dropdown-container">
        <button
          class="mode-selector-btn"
          onclick={() => showModeMenu = !showModeMenu}
          aria-expanded={showModeMenu}
          aria-haspopup="listbox"
          type="button"
        >
          {#if currentMode === 'agent'}
            <span class="mode-check">✓</span>
          {/if}
          <span class="mode-label">{currentModeInfo.label}</span>
          <UIIcon name="chevron-down" size={12} />
        </button>

        {#if showModeMenu}
          <div class="mode-menu" role="listbox">
            {#each modes as mode (mode.id)}
              <button
                class="mode-option"
                class:active={currentMode === mode.id}
                onclick={() => selectMode(mode.id)}
                role="option"
                aria-selected={currentMode === mode.id}
                type="button"
              >
                <span class="option-check">{currentMode === mode.id ? '✓' : ''}</span>
                <span class="option-label">{mode.label}</span>
                {#if mode.shortcut}
                  <span class="option-shortcut">{mode.shortcut}</span>
                {/if}
              </button>
            {/each}
            <div class="menu-divider"></div>
            <button class="mode-option configure" type="button">
              <span class="option-check"></span>
              <span class="option-label config-label">Configure Custom Agents...</span>
            </button>
          </div>
        {/if}
      </div>

      <!-- Model Selector (placeholder for now) -->
      <button class="model-selector-btn" type="button" title="Select model">
        <span class="model-label">Gemini 2.5</span>
        <UIIcon name="chevron-down" size={12} />
      </button>
    </div>

    <div class="right-controls">
      <!-- Attach Button -->
      <div class="attach-dropdown-container">
        <button
          class="action-icon-btn"
          onclick={() => showAttachMenu = !showAttachMenu}
          title="Attach context"
          aria-label="Attach context"
          aria-expanded={showAttachMenu}
          type="button"
        >
          <UIIcon name="link" size={16} />
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

      <!-- Voice Button (placeholder) -->
      <button
        class="action-icon-btn"
        title="Voice input"
        aria-label="Voice input"
        type="button"
      >
        <UIIcon name="record" size={16} />
      </button>

      <!-- Send/Stop Button -->
      {#if isStreaming}
        <button
          class="send-btn stop"
          onclick={onStop}
          title="Stop (Esc)"
          aria-label="Stop generation"
          type="button"
        >
          <UIIcon name="stop" size={16} />
        </button>
      {:else}
        <button
          class="send-btn"
          onclick={onSend}
          disabled={!value.trim()}
          title="Send (Enter)"
          aria-label="Send message"
          type="button"
        >
          <UIIcon name="send" size={16} />
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .chat-input-bar {
    display: flex;
    flex-direction: column;
    padding: 12px;
    gap: 8px;
  }

  .input-wrapper {
    background: var(--color-bg-input);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    padding: 10px 12px;
    transition: border-color 0.15s ease;
  }

  .input-wrapper:focus-within {
    border-color: var(--color-accent);
  }

  .chat-textarea {
    width: 100%;
    min-height: 24px;
    max-height: 150px;
    padding: 0;
    background: transparent;
    border: none;
    color: var(--color-text);
    font-size: 13px;
    line-height: 1.5;
    resize: none;
    outline: none;
  }

  .chat-textarea::placeholder {
    color: var(--color-text-disabled);
  }

  .bottom-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .left-controls {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .right-controls {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  /* Mode Selector */
  .mode-dropdown-container {
    position: relative;
  }

  .mode-selector-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    color: var(--color-text);
    font-size: 12px;
    transition: all 0.15s ease;
  }

  .mode-selector-btn:hover {
    background: var(--color-hover);
    border-color: var(--color-text-secondary);
  }

  .mode-check {
    color: var(--color-accent);
    font-size: 11px;
  }

  .mode-label {
    font-weight: 500;
  }

  .mode-menu {
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: 4px;
    min-width: 200px;
    background: var(--color-bg-elevated);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    box-shadow: var(--shadow-elevated);
    padding: 4px 0;
    z-index: 100;
  }

  .mode-option {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 12px;
    font-size: 12px;
    color: var(--color-text);
    text-align: left;
    transition: background 0.1s ease;
  }

  .mode-option:hover {
    background: var(--color-hover);
  }

  .mode-option.active {
    background: var(--color-accent);
    background: rgba(137, 180, 250, 0.15);
  }

  .option-check {
    width: 14px;
    color: var(--color-accent);
    font-size: 11px;
  }

  .option-label {
    flex: 1;
  }

  .option-shortcut {
    color: var(--color-text-secondary);
    font-size: 11px;
  }

  .menu-divider {
    height: 1px;
    background: var(--color-border);
    margin: 4px 8px;
  }

  .config-label {
    color: var(--color-accent);
  }

  /* Model Selector */
  .model-selector-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: transparent;
    color: var(--color-text-secondary);
    font-size: 11px;
    transition: all 0.15s ease;
  }

  .model-selector-btn:hover {
    color: var(--color-text);
  }

  .model-label {
    opacity: 0.8;
  }

  /* Action Buttons */
  .action-icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 4px;
    color: var(--color-text-secondary);
    transition: all 0.15s ease;
  }

  .action-icon-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  /* Attach Menu */
  .attach-dropdown-container {
    position: relative;
  }

  .attach-menu {
    position: absolute;
    bottom: 100%;
    right: 0;
    margin-bottom: 4px;
    min-width: 140px;
    background: var(--color-bg-elevated);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    box-shadow: var(--shadow-elevated);
    padding: 4px 0;
    z-index: 100;
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
    transition: background 0.1s ease;
  }

  .attach-option:hover {
    background: var(--color-hover);
  }

  /* Send Button */
  .send-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 4px;
    background: var(--color-accent);
    color: var(--color-bg);
    transition: all 0.15s ease;
  }

  .send-btn:hover:not(:disabled) {
    filter: brightness(1.1);
  }

  .send-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .send-btn.stop {
    background: var(--color-error);
  }

  .send-btn:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
</style>
