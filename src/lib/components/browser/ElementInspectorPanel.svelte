<script lang="ts">
  /**
   * ElementInspectorPanel - Horizontal element inspector for DevTools panel
   * Shows selected element info with quick AI action buttons
   */
  import { UIIcon } from '$lib/components/ui';
  import { browserStore, type SelectedElement } from '$lib/stores/browser.svelte';
  import { assistantStore } from '$lib/stores/assistant.svelte';

  interface Props {
    element: SelectedElement;
  }

  let { element }: Props = $props();

  let copied = $state<string | null>(null);

  function copyToClipboard(text: string, type: string): void {
    navigator.clipboard.writeText(text);
    copied = type;
    setTimeout(() => { copied = null; }, 1500);
  }

  function askAI(prompt: string): void {
    // Attach element as hidden context (shown as chip, details sent to AI)
    assistantStore.attachElement({
      tagName: element.tagName,
      id: element.id || undefined,
      classes: element.classes,
      html: element.html,
      css: element.css,
      rect: element.rect,
      selector: element.selector,
    });
    // Set only the prompt text (element context is hidden in attachment)
    assistantStore.setInputValue(prompt);
    assistantStore.openPanel();
  }

  function attachToChat(): void {
    // Just attach element as context chip, let user type their own question
    assistantStore.attachElement({
      tagName: element.tagName,
      id: element.id || undefined,
      classes: element.classes,
      html: element.html,
      css: element.css,
      rect: element.rect,
      selector: element.selector,
    });
    assistantStore.openPanel();
  }

  function formatCssValue(value: string): string {
    return value.length > 25 ? value.slice(0, 22) + '...' : value;
  }
</script>

<div class="element-panel">
  <!-- Left: Element Info -->
  <div class="element-info">
    <div class="element-tag">
      <span class="bracket">&lt;</span><span class="tag">{element.tagName}</span>{#if element.id}<span class="attr"> id="<span class="val">{element.id}</span>"</span>{/if}{#if element.classes.length}<span class="attr"> class="<span class="val">{element.classes.slice(0,2).join(' ')}{element.classes.length > 2 ? '...' : ''}</span>"</span>{/if}<span class="bracket">&gt;</span>
    </div>
    
    <div class="selectors">
      <div class="selector-item">
        <span class="label">CSS</span>
        <code>{element.selector}</code>
        <button class="copy-btn" class:copied={copied === 'css'} onclick={() => copyToClipboard(element.selector, 'css')}>
          <UIIcon name={copied === 'css' ? 'check' : 'copy'} size={10} />
        </button>
      </div>
      <div class="selector-item">
        <span class="label">Size</span>
        <code>{Math.round(element.rect.width)} × {Math.round(element.rect.height)}</code>
      </div>
    </div>

    <div class="css-props">
      {#each Object.entries(element.css).slice(0, 6) as [prop, value]}
        <div class="css-item">
          <span class="prop">{prop}:</span>
          <span class="value" title={value}>{formatCssValue(value)}</span>
        </div>
      {/each}
    </div>
  </div>

  <!-- Right: Quick AI Actions -->
  <div class="ai-section">
    <div class="ai-header">
      <UIIcon name="sparkle" size={14} />
      <span>Ask AI</span>
    </div>
    
    <div class="quick-actions">
      <button class="attach-btn" onclick={attachToChat}>
        <UIIcon name="link" size={12} />
        Attach to Chat
      </button>
      <button class="quick-btn" onclick={() => askAI('Improve the UI/UX of this element. Suggest better colors, spacing, typography.')}>
        <UIIcon name="sparkle" size={12} />
        UI/UX
      </button>
      <button class="quick-btn" onclick={() => askAI('Check accessibility issues with this element. Check WCAG compliance.')}>
        <UIIcon name="eye" size={12} />
        A11y
      </button>
      <button class="quick-btn" onclick={() => askAI('Make this element responsive for mobile, tablet, and desktop.')}>
        <UIIcon name="split" size={12} />
        Responsive
      </button>
      <button class="quick-btn" onclick={() => askAI('Modernize the CSS. Use flexbox, grid, CSS variables, modern properties.')}>
        <UIIcon name="code" size={12} />
        CSS
      </button>
    </div>
    
    <button class="clear-btn" onclick={() => browserStore.clearSelection()}>
      <UIIcon name="close" size={12} />
      Clear Selection
    </button>
  </div>
</div>

<style>
  .element-panel {
    display: flex;
    gap: 16px;
    height: 100%;
    padding: 12px;
    overflow: hidden;
  }

  .element-info {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 280px;
    max-width: 400px;
    overflow-y: auto;
  }

  .element-tag {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    padding: 6px 10px;
    background: var(--color-surface0);
    border-radius: 6px;
    word-break: break-all;
  }

  .bracket { color: var(--color-text-secondary); }
  .tag { color: #f38ba8; }
  .attr { color: #fab387; }
  .val { color: #a6e3a1; }

  .selectors {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .selector-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: var(--color-surface0);
    border-radius: 4px;
    font-size: 11px;
  }

  .selector-item .label {
    color: var(--color-text-secondary);
    font-size: 9px;
    text-transform: uppercase;
    font-weight: 600;
  }

  .selector-item code {
    color: var(--color-text);
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .copy-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 3px;
    color: var(--color-text-secondary);
    transition: all 0.15s ease;
  }

  .copy-btn:hover { background: var(--color-hover); color: var(--color-text); }
  .copy-btn.copied { color: var(--color-success); }

  .css-props {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .css-item {
    display: flex;
    gap: 4px;
    padding: 2px 6px;
    background: var(--color-surface0);
    border-radius: 3px;
    font-size: 10px;
    font-family: 'JetBrains Mono', monospace;
  }

  .css-item .prop { color: #89b4fa; }
  .css-item .value { color: #f9e2af; }

  .ai-section {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
    justify-content: center;
  }

  .ai-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 600;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .ai-header :global(.ui-icon) {
    color: var(--color-accent);
  }

  .quick-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .attach-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    background: var(--color-accent);
    border: none;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 500;
    color: var(--color-bg);
    transition: all 0.15s ease;
  }

  .attach-btn:hover {
    filter: brightness(1.1);
  }

  .quick-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px 12px;
    background: var(--color-surface0);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-size: 11px;
    color: var(--color-text);
    transition: all 0.15s ease;
  }

  .quick-btn:hover {
    background: var(--color-hover);
    border-color: var(--color-accent);
  }

  .quick-btn :global(.ui-icon) {
    color: var(--color-accent);
  }

  .clear-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 6px 12px;
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-size: 11px;
    color: var(--color-text-secondary);
    align-self: flex-start;
    transition: all 0.15s ease;
  }

  .clear-btn:hover {
    background: var(--color-error);
    border-color: var(--color-error);
    color: white;
  }
</style>
