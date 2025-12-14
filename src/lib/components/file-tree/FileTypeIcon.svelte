<script lang="ts">
  /**
   * FileTypeIcon - VS Code-style file/folder icons using Iconify
   * Uses vscode-icons collection for authentic look
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
    /** Icon size in pixels */
    size?: number;
  }

  let { name, isDir = false, expanded = false, size = 16 }: Props = $props();

  const iconName = $derived(getNodeIcon(name, isDir, expanded));
</script>

<span class="file-type-icon" aria-hidden="true">
  <Icon icon={iconName} width={size} height={size} />
</span>

<style>
  .file-type-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 18px;
    height: 18px;
  }

  .file-type-icon :global(svg) {
    display: block;
  }
</style>
