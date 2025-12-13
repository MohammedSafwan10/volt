<script lang="ts">
  import { uiStore } from '$lib/stores/ui.svelte';

  // Placeholder values - will be connected to actual state later
  let branch = $state('main');
  let warnings = $state(0);
  let errors = $state(0);
  let encoding = $state('UTF-8');
  let lineEnding = $state('LF');
  let language = $state('TypeScript');
  let line = $state(1);
  let column = $state(1);
</script>

<div class="status-bar no-select">
  <div class="status-left">
    <button class="status-item" title="Current branch">
      <span class="icon">🌿</span>
      <span>{branch}</span>
    </button>

    <button class="status-item" title="Warnings">
      <span class="icon warning">⚠</span>
      <span>{warnings}</span>
    </button>

    <button class="status-item" title="Errors">
      <span class="icon error">✕</span>
      <span>{errors}</span>
    </button>
  </div>

  <div class="status-center">
    <span class="app-name">Volt</span>
  </div>

  <div class="status-right">
    <div class="status-group zoom-group" role="group" aria-label="Zoom">
      <button
        class="zoom-step"
        title="Zoom out (Ctrl+Minus)"
        onclick={() => uiStore.zoomOut()}
        type="button"
        aria-label="Zoom out"
      >
        −
      </button>

      <button
        class="zoom-label"
        title="Zoom (Ctrl+Plus / Ctrl+Minus / Ctrl+0) — click to reset"
        onclick={() => uiStore.resetZoom()}
        type="button"
      >
        {uiStore.zoomPercent}%
      </button>

      <button
        class="zoom-step"
        title="Zoom in (Ctrl+Plus)"
        onclick={() => uiStore.zoomIn()}
        type="button"
        aria-label="Zoom in"
      >
        +
      </button>
    </div>

    <button class="status-item" title="Indentation">
      Spaces: 2
    </button>

    <button class="status-item" title="Encoding">
      {encoding}
    </button>

    <button class="status-item" title="Line ending">
      {lineEnding}
    </button>

    <button class="status-item" title="Language">
      {language}
    </button>

    <button class="status-item" title="Cursor position">
      Ln {line}, Col {column}
    </button>
  </div>
</div>

<style>
  .status-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 22px;
    background: var(--color-bg-header);
    border-top: 1px solid var(--color-border);
    padding: 0 8px;
    font-size: 12px;
    color: var(--color-text);
  }

  .status-left,
  .status-right {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .status-center {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
  }

  .app-name {
    font-weight: 500;
  }

  .status-item {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 6px;
    height: 22px;
    color: var(--color-text);
    font-size: 12px;
    transition: background-color 0.1s ease;
  }

  .status-item:hover {
    background: var(--color-hover);
  }

  .status-group {
    display: flex;
    align-items: center;
    height: 22px;
    border-radius: 4px;
    overflow: hidden;
  }

  .zoom-group:hover {
    background: var(--color-hover);
  }

  .zoom-label {
    height: 22px;
    padding: 0 6px;
    font-size: 12px;
    color: var(--color-text);
  }

  .zoom-step {
    width: 18px;
    height: 22px;
    color: var(--color-text-secondary);
    opacity: 0;
    transition: opacity 0.12s ease;
  }

  .zoom-group:hover .zoom-step,
  .zoom-group:focus-within .zoom-step {
    opacity: 1;
  }

  .zoom-step:hover {
    color: var(--color-text);
  }

  .zoom-label:hover {
    background: var(--color-hover);
  }

  .zoom-group :focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
  }

  .icon {
    font-size: 11px;
  }

  .icon.warning {
    color: var(--color-warning);
  }

  .icon.error {
    color: var(--color-error);
  }
</style>
