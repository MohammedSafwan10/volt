<script lang="ts">
  import { terminalStore } from '$features/terminal/stores/terminal.svelte';
  import { assistantStore } from '$features/assistant/stores/assistant.svelte';
  import Icon from '@iconify/svelte';
  import { fade, slide } from 'svelte/transition';

  interface Props {
    terminalId: string;
  }

  let { terminalId }: Props = $props();
  
  const lastError = $derived(terminalStore.lastError);
  const isVisible = $derived(
    lastError && 
    lastError.terminalId === terminalId && 
    terminalStore.activeTerminalId === terminalId
  );

  async function handleFix() {
    if (!lastError) return;
    
    // Switch to assistant and start debug
    assistantStore.openPanel();
    assistantStore.setInputValue(`I got this error in the terminal while running "${lastError.command}":\n\n${lastError.output}\n\nCan you help me fix it?`);
    
    // Clear the error state
    terminalStore.lastError = null;
  }

  function handleDismiss() {
    terminalStore.lastError = null;
  }
</script>

{#if isVisible}
  <div 
    class="terminal-actions-overlay"
    transition:fade={{ duration: 200 }}
  >
    <div 
      class="actions-card"
      transition:slide={{ axis: 'y', duration: 300 }}
    >
      <div class="card-header">
        <div class="header-title">
          <span class="sparkle-icon">
            <Icon icon="codicon:sparkle" width="14" height="14" />
          </span>
          <span>Smart Terminal Fix</span>
        </div>
        <button class="close-btn" onclick={handleDismiss}>
          <Icon icon="codicon:close" width="14" height="14" />
        </button>
      </div>
      
      <div class="card-content">
        <div class="error-summary">
          <Icon icon="codicon:terminal" width="12" height="12" />
          <code class="cmd">{lastError?.command ?? 'unknown'}</code>
          <span class="status">failed</span>
        </div>
        <p class="description">
          The command failed with errors. AI can analyze the output and suggest a fix.
        </p>
      </div>

      <div class="card-footer">
        <button class="primary-btn" onclick={handleFix}>
          <span>Fix with AI</span>
          <Icon icon="codicon:chevron-right" width="14" height="14" />
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .terminal-actions-overlay {
    position: absolute;
    bottom: 20px;
    right: 20px;
    z-index: 100;
    pointer-events: none;
  }

  .actions-card {
    width: 280px;
    background: var(--color-bg-sidebar);
    border: 1px solid var(--color-accent);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
    pointer-events: auto;
    overflow: hidden;
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: color-mix(in srgb, var(--color-accent) 10%, transparent);
    border-bottom: 1px solid color-mix(in srgb, var(--color-accent) 20%, transparent);
  }

  .header-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--color-accent);
  }

  .sparkle-icon {
    display: inline-flex;
    animation: pulse 2s infinite;
  }

  @keyframes pulse {
    0% { transform: scale(1); opacity: 1; }
    50% { transform: scale(1.1); opacity: 0.8; }
    100% { transform: scale(1); opacity: 1; }
  }

  .close-btn {
    color: var(--color-text-dim);
    border: none;
    background: none;
    cursor: pointer;
    padding: 2px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
  }

  .close-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    color: var(--color-text);
  }

  .card-content {
    padding: 12px;
  }

  .error-summary {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--color-text-dim);
    margin-bottom: 8px;
  }

  .cmd {
    background: rgba(0, 0, 0, 0.2);
    padding: 2px 4px;
    border-radius: 3px;
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
  }

  .status {
    color: #ef4444;
    font-weight: 600;
  }

  .description {
    font-size: 12px;
    line-height: 1.4;
    color: var(--color-text);
    margin: 0;
  }

  .card-footer {
    padding: 8px 12px 12px;
  }

  .primary-btn {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    background: var(--color-accent);
    color: white;
    border: none;
    padding: 8px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .primary-btn:hover {
    filter: brightness(1.1);
    transform: translateY(-1px);
  }

  .primary-btn:active {
    transform: translateY(0);
  }
</style>