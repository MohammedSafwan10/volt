<script lang="ts">
  import { UIIcon } from '$lib/components/ui';
  import { FileIcon } from '$lib/components/file-tree';
  import { projectStore } from '$lib/stores/project.svelte';
  import { uiStore } from '$lib/stores/ui.svelte';

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

  /**
   * Build absolute path for a folder segment
   * @param segmentIndex - Index of the folder segment (0-based)
   */
  function getAbsolutePath(segmentIndex: number): string {
    if (!projectStore.rootPath) return '';
    
    const rootPath = projectStore.rootPath.replace(/\\/g, '/');
    const pathParts = segments.slice(0, segmentIndex + 1);
    return `${rootPath}/${pathParts.join('/')}`;
  }

  /**
   * Handle click on a folder segment - expand it in the file tree
   */
  async function handleFolderClick(segmentIndex: number): Promise<void> {
    const absolutePath = getAbsolutePath(segmentIndex);
    if (!absolutePath) return;

    // Ensure sidebar is open and showing explorer
    uiStore.setActiveSidebarPanel('explorer');

    // Find and expand the folder in the tree
    const node = projectStore.findNode(absolutePath);
    if (node && node.isDir) {
      // Expand all parent folders first
      await expandPathToNode(absolutePath);
      
      // Select the folder
      projectStore.selectItem(absolutePath);
    }
  }

  /**
   * Expand all folders in the path to make the target visible
   */
  async function expandPathToNode(targetPath: string): Promise<void> {
    if (!projectStore.rootPath) return;

    const rootPath = projectStore.rootPath.replace(/\\/g, '/');
    const normalizedTarget = targetPath.replace(/\\/g, '/');
    
    // Get relative path parts
    let relativePath = normalizedTarget;
    if (normalizedTarget.startsWith(rootPath)) {
      relativePath = normalizedTarget.slice(rootPath.length);
      if (relativePath.startsWith('/')) {
        relativePath = relativePath.slice(1);
      }
    }

    const parts = relativePath.split('/').filter(Boolean);
    let currentPath = rootPath;

    // Expand each folder in the path
    for (let i = 0; i < parts.length; i++) {
      currentPath = `${currentPath}/${parts[i]}`;
      const node = projectStore.findNode(currentPath);
      if (node && node.isDir && !node.expanded) {
        await projectStore.toggleFolder(node);
      }
    }
  }
</script>

{#if segments.length > 0}
  <nav class="breadcrumb no-select" aria-label="File path">
    {#each folderSegments as segment, i (i)}
      <button 
        class="breadcrumb-item clickable" 
        title="Go to {segment}"
        onclick={() => handleFolderClick(i)}
        aria-label="Navigate to folder {segment}"
      >
        <UIIcon name="folder" size={14} />
        <span>{segment}</span>
      </button>
      <span class="separator" aria-hidden="true">
        <UIIcon name="chevron-right" size={12} />
      </span>
    {/each}
    
    <span class="breadcrumb-item file" aria-current="page">
      <FileIcon name={fileName} />
      <span>{fileName}</span>
    </span>
  </nav>
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
    background: transparent;
    border: none;
    font: inherit;
  }

  .breadcrumb-item.clickable {
    cursor: pointer;
  }

  .breadcrumb-item.clickable:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .breadcrumb-item.clickable:focus-visible {
    outline: 1px solid var(--color-accent);
    outline-offset: -1px;
  }

  .breadcrumb-item.file {
    color: var(--color-text);
    cursor: default;
  }

  .separator {
    display: flex;
    align-items: center;
    color: var(--color-text-disabled);
  }
</style>
