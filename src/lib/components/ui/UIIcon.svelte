<script lang="ts">
  /**
   * UIIcon - Modern UI icons using Iconify
   * Uses codicon (VS Code icons) and other high-quality icon sets
   */
  import Icon from '@iconify/svelte';

  /** Available UI icon names */
  export type UIIconName =
    // Sidebar / Activity Bar
    | 'files'
    | 'search'
    | 'git-branch'
    | 'settings'
    | 'extensions'
    | 'debug'
    | 'account'
    // File operations
    | 'folder'
    | 'folder-open'
    | 'folder-plus'
    | 'file'
    | 'file-plus'
    | 'new-file'
    | 'new-folder'
    // Actions
    | 'refresh'
    | 'plus'
    | 'minus'
    | 'close'
    | 'trash'
    | 'pencil'
    | 'save'
    | 'save-all'
    | 'copy'
    | 'paste'
    | 'cut'
    | 'undo'
    | 'redo'
    | 'replace'
    | 'replace-all'
    // Navigation
    | 'chevron-right'
    | 'chevron-down'
    | 'chevron-up'
    | 'chevron-left'
    | 'arrow-left'
    | 'arrow-right'
    | 'collapse-all'
    | 'expand-all'
    // Status
    | 'warning'
    | 'error'
    | 'info'
    | 'check'
    | 'spinner'
    | 'loading'
    // Terminal / Output
    | 'terminal'
    | 'output'
    | 'console'
    | 'clear'
    | 'split'
    | 'kill'
    // Editor
    | 'code'
    | 'symbol-class'
    | 'symbol-method'
    | 'symbol-property'
    | 'symbol-variable'
    | 'symbol-function'
    // Misc
    | 'bolt'
    | 'menu'
    | 'more'
    | 'filter'
    | 'pin'
    | 'unpin'
    | 'lock'
    | 'unlock'
    | 'eye'
    | 'eye-off'
    | 'link'
    | 'external-link'
    | 'download'
    | 'upload'
    | 'sync'
    | 'clock'
    | 'calendar'
    | 'star'
    | 'star-filled'
    | 'heart'
    | 'bookmark'
    | 'tag'
    | 'home'
    | 'play'
    | 'pause'
    | 'stop'
    | 'record'
    | 'cloud'
    | 'comment'
    | 'sparkle'
    | 'robot'
    | 'send'
    | 'image';

  /** Map icon names to Iconify icon identifiers */
  const ICON_MAP: Record<UIIconName, string> = {
    // Sidebar / Activity Bar - using codicon (VS Code icons)
    files: 'codicon:files',
    search: 'codicon:search',
    'git-branch': 'codicon:source-control',
    settings: 'codicon:settings-gear',
    extensions: 'codicon:extensions',
    debug: 'codicon:debug-alt',
    account: 'codicon:account',
    // File operations
    folder: 'codicon:folder',
    'folder-open': 'codicon:folder-opened',
    'folder-plus': 'codicon:new-folder',
    file: 'codicon:file',
    'file-plus': 'codicon:new-file',
    'new-file': 'codicon:new-file',
    'new-folder': 'codicon:new-folder',
    // Actions
    refresh: 'codicon:refresh',
    plus: 'codicon:add',
    minus: 'codicon:remove',
    close: 'codicon:close',
    trash: 'codicon:trash',
    pencil: 'codicon:edit',
    save: 'codicon:save',
    'save-all': 'codicon:save-all',
    copy: 'codicon:copy',
    paste: 'codicon:paste',
    cut: 'codicon:clippy',
    undo: 'codicon:discard',
    redo: 'codicon:redo',
    replace: 'codicon:replace',
    'replace-all': 'codicon:replace-all',
    // Navigation
    'chevron-right': 'codicon:chevron-right',
    'chevron-down': 'codicon:chevron-down',
    'chevron-up': 'codicon:chevron-up',
    'chevron-left': 'codicon:chevron-left',
    'arrow-left': 'codicon:arrow-left',
    'arrow-right': 'codicon:arrow-right',
    'collapse-all': 'codicon:collapse-all',
    'expand-all': 'codicon:expand-all',
    // Status
    warning: 'codicon:warning',
    error: 'codicon:error',
    info: 'codicon:info',
    check: 'codicon:check',
    spinner: 'codicon:loading',
    loading: 'codicon:loading',
    // Terminal / Output
    terminal: 'codicon:terminal',
    output: 'codicon:output',
    console: 'codicon:debug-console',
    clear: 'codicon:clear-all',
    split: 'codicon:split-horizontal',
    kill: 'codicon:debug-stop',
    // Editor
    code: 'codicon:code',
    'symbol-class': 'codicon:symbol-class',
    'symbol-method': 'codicon:symbol-method',
    'symbol-property': 'codicon:symbol-property',
    'symbol-variable': 'codicon:symbol-variable',
    'symbol-function': 'codicon:symbol-method',
    // Misc
    bolt: 'codicon:zap',
    menu: 'codicon:menu',
    more: 'codicon:ellipsis',
    filter: 'codicon:filter',
    pin: 'codicon:pin',
    unpin: 'codicon:pinned',
    lock: 'codicon:lock',
    unlock: 'codicon:unlock',
    eye: 'codicon:eye',
    'eye-off': 'codicon:eye-closed',
    link: 'codicon:link',
    'external-link': 'codicon:link-external',
    download: 'codicon:cloud-download',
    upload: 'codicon:cloud-upload',
    sync: 'codicon:sync',
    clock: 'codicon:clock',
    calendar: 'codicon:calendar',
    star: 'codicon:star-empty',
    'star-filled': 'codicon:star-full',
    heart: 'codicon:heart',
    bookmark: 'codicon:bookmark',
    tag: 'codicon:tag',
    home: 'codicon:home',
    play: 'codicon:play',
    pause: 'codicon:debug-pause',
    stop: 'codicon:debug-stop',
    record: 'codicon:record',
    cloud: 'codicon:cloud',
    comment: 'codicon:comment',
    sparkle: 'codicon:sparkle',
    robot: 'codicon:robot',
    send: 'codicon:send',
    image: 'codicon:file-media',
  };

  interface Props {
    name: UIIconName;
    size?: number;
    title?: string;
    class?: string;
  }

  let { name, size = 16, title, class: className }: Props = $props();

  const iconName = $derived(ICON_MAP[name] || 'codicon:question');
  const ariaHidden = $derived(!title);
</script>

<span
  class="ui-icon {className || ''}"
  aria-hidden={ariaHidden}
  aria-label={title}
  role={title ? 'img' : undefined}
>
  {#if title}
    <span class="sr-only">{title}</span>
  {/if}
  <Icon icon={iconName} width={size} height={size} />
</span>

<style>
  .ui-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }

  .ui-icon :global(svg) {
    display: block;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
