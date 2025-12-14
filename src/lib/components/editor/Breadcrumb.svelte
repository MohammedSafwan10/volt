<script lang="ts">
  import { UIIcon } from '$lib/components/ui';
  import { FileIcon } from '$lib/components/file-tree';
  import { projectStore } from '$lib/stores/project.svelte';

  interface Props {
    filepath: string;
  }

  let { filepath }: Props = $props();

  // Get path segments relative to project root
  const segments = $derived.by(() => {
    if (!filepath || !projectStore.rootPath) return [];
    
    const rootPath = projectStore.rootPath.replace(/\\/g, '/');
    const fullPath = filepath.replace(/\\/g, '/');
    
    // Get relative path
    let relativePath = fullPath;
    if (fullPath.startsWith(rootPath)) {
      relativePath = fullPath.slice(rootPath.length);
      if (relativePath.startsWith('/')) {
        relativePath = relativePath.slice(1);
      }
    }
    
    return relativePath.split('/').filter(Boolean);
  });

  const fileName = $derived(segments.length > 0 ? segments[segments.length - 1] : '');
  const folderSegments = $derived(segments.slice(0, -1));
</script>

{#if segments.length > 0}
  <div class="breadcrumb no-select">
    {#each folderSegments as segment, i (i)}
      <button class="breadcrumb-item" title={segment}>
        <UIIcon name="folder" size={14} />
        <span>{segment}</span>
      </button>
      <span class="separator">
        <UIIcon name="chevron-right" size={12} />
      </span>
    {/each}
    
    <span class="breadcrumb-item file">
      <FileIcon name={fileName} />
      <span>{fileName}</span>
    </span>
  </div>
{/if}

<style>
  .breadcrumb {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 22px;
    padding: 0 8px;
    background: var(--color-bg);
    border-bottom: 1px solid var(--color-border);
    font-size: 12px;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }

  .breadcrumb::-webkit-scrollbar {
    display: none;
  }

  .breadcrumb-item {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 4px;
    border-radius: 3px;
    color: var(--color-text-secondary);
    white-space: nowrap;
    transition: background 0.1s ease, color 0.1s ease;
  }

  .breadcrumb-item:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .breadcrumb-item.file {
    color: var(--color-text);
  }

  .separator {
    display: flex;
    align-items: center;
    color: var(--color-text-disabled);
  }
</style>
