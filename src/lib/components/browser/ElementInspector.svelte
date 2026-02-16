<script lang="ts">
  /**
   * ElementInspector - Shows selected element details
   * Simplified: Just shows element info and "Attach to Chat" button
   */
  import { UIIcon } from '$lib/components/ui';
  import { browserStore, type SelectedElement } from '$lib/stores/browser.svelte';
  import { assistantStore } from '$lib/stores/assistant.svelte';

  interface Props {
    element: SelectedElement;
  }

  let { element }: Props = $props();

  let copied = $state<string | null>(null);

  async function copyToClipboard(text: string, type: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    copied = type;
    setTimeout(() => { copied = null; }, 1500);
  }

  function attachToChat(): void {
    // Attach element as hidden context (shows as chip in main chat input)
    assistantStore.attachElement({
      tagName: element.tagName,
      id: element.id || undefined,
      classes: element.classes,
      html: element.html,
      css: element.css,
      rect: element.rect,
      selector: element.selector,
    });
    
    // Open the assistant panel so user can type their instruction
    assistantStore.openPanel();
    
    // Clear selection
    browserStore.clearSelection();
  }

  function clearSelection(): void {
    browserStore.clearSelection();
  }

  // Format CSS value for display
  function formatCssValue(value: string): string {
    if (value.length > 30) {
      return value.slice(0, 27) + '...';
    }
    return value;
  }
</script>

<div class="element-inspector">
  <div class="inspector-header">
    <div class="element-tag">
      <span class="tag-bracket">&lt;</span>
      <span class="tag-name">{element.tagName}</span>
      {#if element.id}
        <span class="tag-attr">
          <span class="attr-name">id</span>=<span class="attr-value">"{element.id}"</span>
        </span>
      {/if}
      {#if element.classes.length > 0}
        <span class="tag-attr">
          <span class="attr-name">class</span>=<span class="attr-value">"{element.classes.slice(0, 3).join(' ')}{element.classes.length > 3 ? '...' : ''}"</span>
        </span>
      {/if}
      <span class="tag-bracket">&gt;</span>
    </div>
    
    <button class="close-btn" onclick={clearSelection} title="Clear selection">
      <UIIcon name="close" size={12} />
    </button>
  </div>

  <div class="inspector-content">
    <!-- Attach to Chat Button (Primary Action) -->
    <button class="attach-btn" onclick={attachToChat}>
      <UIIcon name="sparkle" size={14} />
      <span>Ask AI about this element</span>
    </button>

    <!-- Selectors -->
    <div class="section">
      <div class="section-header">
        <UIIcon name="code" size={12} />
        <span>Selectors</span>
      </div>
      <div class="selector-row">
        <span class="selector-label">CSS</span>
        <code class="selector-value">{element.selector}</code>
        <button 
          class="copy-btn" 
          class:copied={copied === 'css'}
          onclick={() => copyToClipboard(element.selector, 'css')}
        >
          <UIIcon name={copied === 'css' ? 'check' : 'copy'} size={10} />
        </button>
      </div>
      <div class="selector-row">
        <span class="selector-label">XPath</span>
        <code class="selector-value">{element.xpath}</code>
        <button 
          class="copy-btn"
          class:copied={copied === 'xpath'}
          onclick={() => copyToClipboard(element.xpath, 'xpath')}
        >
          <UIIcon name={copied === 'xpath' ? 'check' : 'copy'} size={10} />
        </button>
      </div>
    </div>

    <!-- CSS Properties -->
    {#if Object.keys(element.css).length > 0}
      <div class="section">
        <div class="section-header">
          <UIIcon name="pencil" size={12} />
          <span>Computed Styles</span>
        </div>
        <div class="css-grid">
          {#each Object.entries(element.css).slice(0, 8) as [prop, value]}
            <div class="css-row">
              <span class="css-prop">{prop}</span>
              <span class="css-value" title={value}>{formatCssValue(value)}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Dimensions -->
    <div class="section">
      <div class="section-header">
        <UIIcon name="expand-all" size={12} />
        <span>Dimensions</span>
      </div>
      <div class="dimensions">
        <span class="dim">{Math.round(element.rect.width)} × {Math.round(element.rect.height)}</span>
        <span class="pos">at ({Math.round(element.rect.x)}, {Math.round(element.rect.y)})</span>
      </div>
    </div>
  </div>
</div>

<style>
  .element-inspector {
    display: flex;
    flex-direction: column;
    width: 260px;
    background: var(--color-bg-panel);
    border-left: 1px solid var(--color-border);
    overflow: hidden;
  }

  .inspector-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    padding: 12px;
    background: var(--color-surface0);
    border-bottom: 1px solid var(--color-border);
  }

  .element-tag {
    font-family: var(--font-mono, monospace);
    font-size: 11px;
    line-height: 1.4;
    word-break: break-all;
  }

  .tag-bracket {
    color: var(--color-text-secondary);
  }

  .tag-name {
    color: #f38ba8;
  }

  .tag-attr {
    margin-left: 4px;
  }

  .attr-name {
    color: #fab387;
  }

  .attr-value {
    color: #a6e3a1;
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 4px;
    color: var(--color-text-secondary);
    flex-shrink: 0;
    transition: all 0.15s ease;
  }

  .close-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .inspector-content {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }

  .attach-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    padding: 10px 12px;
    margin-bottom: 12px;
    background: var(--color-accent);
    color: var(--color-bg);
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    transition: all 0.15s ease;
  }

  .attach-btn:hover {
    filter: brightness(1.1);
  }

  .section {
    margin-bottom: 12px;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 0;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--color-text-secondary);
  }

  .selector-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: var(--color-surface0);
    border-radius: 4px;
    margin-bottom: 4px;
  }

  .selector-label {
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--color-text-secondary);
    width: 36px;
    flex-shrink: 0;
  }

  .selector-value {
    flex: 1;
    font-size: 10px;
    color: var(--color-text);
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
    flex-shrink: 0;
    transition: all 0.15s ease;
  }

  .copy-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .copy-btn.copied {
    color: var(--color-success);
  }

  .css-grid {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .css-row {
    display: flex;
    justify-content: space-between;
    padding: 3px 8px;
    background: var(--color-surface0);
    border-radius: 3px;
    font-size: 10px;
  }

  .css-prop {
    color: #89b4fa;
  }

  .css-value {
    color: #f9e2af;
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dimensions {
    display: flex;
    gap: 12px;
    padding: 6px 8px;
    background: var(--color-surface0);
    border-radius: 4px;
    font-size: 11px;
  }

  .dim {
    color: var(--color-text);
    font-weight: 500;
  }

  .pos {
    color: var(--color-text-secondary);
  }
</style>
