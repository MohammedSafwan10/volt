<script lang="ts">
  import { uiStore } from '$shared/stores/ui.svelte';
  import { problemsStore } from '$shared/stores/problems.svelte';
  import { editorStore } from '$features/editor/stores/editor.svelte';
  import { projectStore } from '$shared/stores/project.svelte';
  import { gitStore } from '$features/git/stores/git.svelte';
  import { UIIcon } from '$shared/components/ui';

  const errors = $derived.by(() => problemsStore.errorCount);
  const warnings = $derived.by(() => problemsStore.warningCount);
  const language = $derived.by(() => editorStore.activeFile?.language ?? 'Plain Text');

  // Derive values from editor store
  const encoding = $derived.by(() => editorStore.activeFile?.encoding ?? 'UTF-8');
  const lineEnding = $derived.by(() => editorStore.activeFile?.lineEnding ?? 'LF');
  const line = $derived.by(() => editorStore.activeFile ? editorStore.cursorPosition.line : null);
  const column = $derived.by(() => editorStore.activeFile ? editorStore.cursorPosition.column : null);
  const selected = $derived.by(() => editorStore.cursorPosition.selected);
  const indentation = $derived.by(() => {
    const opts = editorStore.editorOptions;
    return opts.insertSpaces ? `Spaces: ${opts.tabSize}` : `Tab Size: ${opts.tabSize}`;
  });

  const branch = $derived.by(() => {
    if (!projectStore.rootPath || !gitStore.isRepo) return null;
    return gitStore.currentBranch;
  });
  const workspaceStatus = $derived.by(() => {
    if (!projectStore.rootPath || projectStore.backgroundReady) return null;
    switch (projectStore.startupPhase) {
      case 'paint':
        return 'Opening workspace';
      case 'light':
        return 'Starting watchers';
      case 'core-bg':
        return projectStore.coreReady ? 'Warming workspace' : 'Indexing workspace';
      case 'heavy-bg':
        return projectStore.largeRepoMode ? 'Warming essentials' : 'Finishing startup';
      case 'background-ready':
        return projectStore.largeRepoMode ? 'Large repo mode' : 'Workspace ready';
      default:
        return null;
    }
  });
  const workspaceStatusTitle = $derived.by(() => {
    if (!workspaceStatus) return null;
    if (projectStore.largeRepoMode) {
      return `Large workspace mode · ${projectStore.indexedFileCount.toLocaleString()} files indexed in ${projectStore.initialIndexDurationMs}ms`;
    }
    return workspaceStatus;
  });
</script>

<div class="status-bar no-select">
  <div class="status-left">
    <button class="status-item" title={branch ? `Git branch: ${branch}` : 'Not a git repository'}>
      <span class="icon"><UIIcon name="git-branch" size={14} /></span>
      <span>{branch ?? '—'}</span>
    </button>

    <button class="status-item" title="Warnings">
      <span class="icon warning"><UIIcon name="warning" size={14} /></span>
      <span>{warnings}</span>
    </button>

    <button class="status-item" title="Errors">
      <span class="icon error"><UIIcon name="error" size={14} /></span>
      <span>{errors}</span>
    </button>

    {#if workspaceStatus}
      <div class="status-item startup-status" title={workspaceStatusTitle ?? workspaceStatus}>
        <span class="icon startup"><UIIcon name="spinner" size={14} /></span>
        <span>{workspaceStatus}</span>
      </div>
    {/if}
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
      {indentation}
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
      Ln {line ?? '—'}, Col {column ?? '—'}{#if selected > 0} ({selected} selected){/if}
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

  .status-item:disabled {
    opacity: 0.65;
    cursor: default;
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
    width: 14px;
    height: 14px;
    display: grid;
    place-items: center;
  }

  .icon.warning {
    color: var(--color-warning);
  }

  .icon.error {
    color: var(--color-error);
  }

  .startup-status {
    color: var(--color-text-secondary);
  }

  .startup-status .icon.startup {
    color: var(--color-accent);
  }

  .startup-status .icon.startup :global(svg) {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
</style>
