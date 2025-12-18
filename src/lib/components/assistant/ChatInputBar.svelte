<script lang="ts">
  import { UIIcon } from '$lib/components/ui';
  import type { AIMode } from '$lib/stores/ai.svelte';
  import { aiSettingsStore, PROVIDERS } from '$lib/stores/ai.svelte';
  import { IMAGE_LIMITS, assistantStore } from '$lib/stores/assistant.svelte';

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
    onAttachImage?: (file: File) => void;
    onAttachImageFromPicker?: () => void;
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
    onAttachSelection,
    onAttachImage,
    onAttachImageFromPicker
  }: Props = $props();

  // Get current model from settings store (synced with settings panel)
  const currentModel = $derived(aiSettingsStore.modelPerMode[currentMode]);
  
  // Context usage tracking (reactive) - use current model
  const contextUsage = $derived(assistantStore.getContextUsage(currentModel));

  // SVG circle parameters for progress ring
  const RING_SIZE = 24;
  const RING_STROKE = 2.5;
  const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
  
  // Calculate stroke dash offset for progress
  const strokeDashoffset = $derived(
    RING_CIRCUMFERENCE - (contextUsage.percentage / 100) * RING_CIRCUMFERENCE
  );

  // Determine ring color based on usage
  const ringColor = $derived(
    contextUsage.isOverLimit ? 'var(--color-error)' :
    contextUsage.isNearLimit ? 'var(--color-warning)' :
    'var(--color-green)'
  );

  let isDraggingOver = $state(false);

  let showModeMenu = $state(false);
  let showAttachMenu = $state(false);
  let showModelMenu = $state(false);

  // Available models from provider config
  const availableModels = $derived(PROVIDERS[aiSettingsStore.selectedProvider].models);
  
  // Display-friendly model name
  function getModelDisplayName(model: string): string {
    const thinking = model.endsWith('|thinking');
    const base = thinking ? model.slice(0, -'|thinking'.length) : model;

    if (base === 'gemini-2.5-flash') return thinking ? 'Gemini 2.5 Flash (thinking)' : 'Gemini 2.5 Flash';
    if (base === 'gemini-3-flash-preview') return thinking ? 'Gemini 3.0 Flash Preview (thinking)' : 'Gemini 3.0 Flash Preview';
    // Fallback: capitalize and clean up
    return (thinking ? base : model).replace('gemini-', 'Gemini ').replace(/-/g, ' ') + (thinking ? ' (thinking)' : '');
  }

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

  function handleAttachImagePicker(): void {
    onAttachImageFromPicker?.();
    showAttachMenu = false;
  }

  // Handle paste for images
  function handlePaste(e: ClipboardEvent): void {
    if (!onAttachImage) return;
    
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          onAttachImage(file);
        }
        return;
      }
    }
  }

  // Handle drag over
  function handleDragOver(e: DragEvent): void {
    e.preventDefault();
    if (e.dataTransfer?.types.includes('Files')) {
      isDraggingOver = true;
    }
  }

  // Handle drag leave
  function handleDragLeave(e: DragEvent): void {
    e.preventDefault();
    isDraggingOver = false;
  }

  // Handle drop for images
  function handleDrop(e: DragEvent): void {
    e.preventDefault();
    isDraggingOver = false;
    
    if (!onAttachImage) return;
    
    const files = e.dataTransfer?.files;
    if (!files) return;

    for (const file of files) {
      const mimeType = file.type as typeof IMAGE_LIMITS.allowedMimeTypes[number];
      if (IMAGE_LIMITS.allowedMimeTypes.includes(mimeType)) {
        onAttachImage(file);
      }
    }
  }

  function handleClickOutside(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (!target.closest('.mode-dropdown-container')) {
      showModeMenu = false;
    }
    if (!target.closest('.attach-dropdown-container')) {
      showAttachMenu = false;
    }
    if (!target.closest('.model-dropdown-container')) {
      showModelMenu = false;
    }
  }

  function selectModel(model: string): void {
    aiSettingsStore.setModelForMode(currentMode, model);
    showModelMenu = false;
  }
</script>

<svelte:window onclick={handleClickOutside} />

<div 
  class="chat-input-bar"
  class:dragging={isDraggingOver}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
  role="region"
  aria-label="Chat input area"
>
  {#if isDraggingOver}
    <div class="drop-overlay">
      <UIIcon name="image" size={24} />
      <span>Drop image to attach</span>
    </div>
  {/if}

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
      onpaste={handlePaste}
      aria-label="Message input"
    ></textarea>
  </div>

  <!-- Bottom Bar with Mode Selector and Actions -->
  <div class="bottom-bar">
    <div class="left-controls">
      <!-- Context Usage Ring -->
      {#if assistantStore.messages.length > 0 || contextUsage.usedTokens > 100}
        <div 
          class="context-ring-container"
          class:near-limit={contextUsage.isNearLimit}
          class:over-limit={contextUsage.isOverLimit}
          title="{contextUsage.percentage.toFixed(0)}% context usage ({assistantStore.formatTokenCount(contextUsage.usedTokens)} / {assistantStore.formatTokenCount(contextUsage.maxTokens)} tokens)"
        >
          <svg 
            class="context-ring" 
            width={RING_SIZE} 
            height={RING_SIZE}
            viewBox="0 0 {RING_SIZE} {RING_SIZE}"
          >
            <!-- Background circle -->
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              stroke="var(--color-border)"
              stroke-width={RING_STROKE}
            />
            <!-- Progress circle -->
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              stroke={ringColor}
              stroke-width={RING_STROKE}
              stroke-linecap="round"
              stroke-dasharray={RING_CIRCUMFERENCE}
              stroke-dashoffset={strokeDashoffset}
              transform="rotate(-90 {RING_SIZE / 2} {RING_SIZE / 2})"
              class="progress-circle"
            />
          </svg>
        </div>
      {/if}

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

      <!-- Model Selector Dropdown -->
      <div class="model-dropdown-container">
        <button 
          class="model-selector-btn" 
          type="button" 
          title="Select model"
          onclick={() => showModelMenu = !showModelMenu}
          aria-expanded={showModelMenu}
          aria-haspopup="listbox"
        >
          <span class="model-label">{getModelDisplayName(currentModel)}</span>
          <UIIcon name="chevron-down" size={12} />
        </button>

        {#if showModelMenu}
          <div class="model-menu" role="listbox">
            {#each availableModels as model (model)}
              <button
                class="model-option"
                class:active={currentModel === model}
                onclick={() => selectModel(model)}
                role="option"
                aria-selected={currentModel === model}
                type="button"
              >
                {getModelDisplayName(model)}
              </button>
            {/each}
          </div>
        {/if}
      </div>
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
            {#if onAttachImageFromPicker}
              <button
                class="attach-option"
                onclick={handleAttachImagePicker}
                role="menuitem"
                type="button"
              >
                <UIIcon name="image" size={14} />
                <span>Image</span>
              </button>
            {/if}
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
    position: relative;
  }

  .chat-input-bar.dragging {
    background: var(--color-accent-alpha);
  }

  .drop-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: var(--color-accent-alpha);
    border: 2px dashed var(--color-accent);
    border-radius: 8px;
    color: var(--color-accent);
    font-size: 13px;
    font-weight: 500;
    z-index: 10;
    pointer-events: none;
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
    gap: 6px;
  }

  /* Context Usage Ring */
  .context-ring-container {
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: help;
    transition: transform 0.15s ease;
  }

  .context-ring-container:hover {
    transform: scale(1.1);
  }

  .context-ring {
    display: block;
  }

  .progress-circle {
    transition: stroke-dashoffset 0.3s ease, stroke 0.2s ease;
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
    animation: dropdownIn 0.15s ease;
    transform-origin: bottom left;
  }

  @keyframes dropdownIn {
    from {
      opacity: 0;
      transform: scale(0.95) translateY(4px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
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
  .model-dropdown-container {
    position: relative;
  }

  .model-selector-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: transparent;
    color: var(--color-text-secondary);
    font-size: 11px;
    transition: all 0.15s ease;
    border-radius: 4px;
  }

  .model-selector-btn:hover {
    color: var(--color-text);
    background: var(--color-hover);
  }

  .model-label {
    opacity: 0.8;
  }

  .model-menu {
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: 4px;
    min-width: 160px;
    background: var(--color-bg-elevated);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    box-shadow: var(--shadow-elevated);
    padding: 4px 0;
    z-index: 100;
    animation: dropdownIn 0.15s ease;
    transform-origin: bottom left;
  }

  .model-option {
    width: 100%;
    padding: 8px 14px;
    font-size: 12px;
    color: var(--color-text);
    text-align: left;
    transition: background 0.1s ease;
  }

  .model-option:hover {
    background: var(--color-hover);
  }

  .model-option.active {
    background: rgba(137, 180, 250, 0.15);
    color: var(--color-accent);
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
    animation: dropdownIn 0.15s ease;
    transform-origin: bottom right;
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
