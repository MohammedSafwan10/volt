<script lang="ts">
  /**
   * EditorPlaceholder - Loading state shown while Monaco loads
   */
  interface Props {
    filename?: string;
  }

  let { filename = '' }: Props = $props();
</script>

<div class="editor-placeholder">
  <div class="loading-content">
    <div class="spinner"></div>
    <p class="loading-text">
      {#if filename}
        Loading {filename}...
      {:else}
        Loading editor...
      {/if}
    </p>
  </div>
</div>

<style>
  .editor-placeholder {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-bg);
  }

  .loading-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
  }

  .spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--color-border);
    border-top-color: var(--color-accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .loading-text {
    color: var(--color-text-secondary);
    font-size: 14px;
    margin: 0;
  }
</style>
