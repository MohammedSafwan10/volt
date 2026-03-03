<script lang="ts">
  import { UIIcon } from '$shared/components/ui';

  interface Props {
    hasProject?: boolean;
  }

  let { hasProject = true }: Props = $props();
</script>

<div class="empty-state fade-in">
  <div class="empty-icon">
    <UIIcon name="code" size={48} />
  </div>
  
  {#if hasProject}
    <h2>No file selected</h2>
    <p>Select a file from the explorer to start editing</p>
    
    <div class="shortcuts">
      <div class="shortcut">
        <kbd>Ctrl</kbd><span>+</span><kbd>K</kbd> <kbd>Ctrl</kbd><span>+</span><kbd>O</kbd>
        <span class="shortcut-label">Open Folder</span>
      </div>
      <div class="shortcut">
        <kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>P</kbd>
        <span class="shortcut-label">Command Palette</span>
      </div>
      <div class="shortcut">
        <kbd>Ctrl</kbd><span>+</span><kbd>`</kbd>
        <span class="shortcut-label">Toggle Terminal</span>
      </div>
    </div>
  {:else}
    <h2>Welcome to Volt</h2>
    <p>Open a folder to get started</p>
  {/if}
</div>

<style>
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 32px;
    text-align: center;
    color: var(--color-text-secondary);
  }

  .empty-icon {
    opacity: 0.3;
    margin-bottom: 8px;
  }

  h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 500;
    color: var(--color-text);
  }

  p {
    margin: 0;
    font-size: 13px;
  }

  .shortcuts {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 16px;
    padding: 16px;
    background: var(--color-bg-panel);
    border: 1px solid var(--color-border);
    border-radius: 8px;
  }

  .shortcut {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--color-text-secondary);
  }

  .shortcut-label {
    margin-left: 8px;
    color: var(--color-text);
  }

  kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    background: var(--color-bg-input);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-family: inherit;
    font-size: 11px;
    color: var(--color-text);
  }
</style>
