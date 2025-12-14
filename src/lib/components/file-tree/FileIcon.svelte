<script lang="ts">
  /**
   * FileIcon - VS Code-style file/folder icons
   * Wrapper around FileTypeIcon for backward compatibility
   */
  import Icon from '@iconify/svelte';
  import { getNodeIcon } from './file-type-icons';

  interface Props {
    /** File or folder name */
    name: string;
    /** Whether this is a directory */
    isDir?: boolean;
    /** Whether the folder is expanded (only applies to directories) */
    expanded?: boolean;
  }

  let { name, isDir = false, expanded = false }: Props = $props();

  const iconName = $derived(getNodeIcon(name, isDir, expanded));
</script>

<span class="icon" aria-hidden="true">
  <Icon icon={iconName} width={16} height={16} />
</span>

<style>
  .icon {
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .icon :global(svg) {
    display: block;
  }
</style>
