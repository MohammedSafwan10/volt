import type * as Monaco from 'monaco-editor';

/**
 * VS Code "Dark Modern" inspired theme
 */
export const darkModernThemeVars: Record<string, string> = {
  /* Background colors */
  '--color-bg': '#1f1f1f',
  '--color-bg-rgb': '31, 31, 31',
  '--color-bg-sidebar': '#181818',
  '--color-bg-panel': '#1f1f1f',
  '--color-bg-header': '#181818',
  '--color-bg-input': '#2a2d2e',
  
  /* Text colors */
  '--color-text': '#cccccc',
  '--color-text-secondary': '#969696',
  '--color-text-disabled': '#616161',
  
  /* Accent colors */
  '--color-accent': '#007acc',
  '--color-accent-rgb': '0, 122, 204',
  '--color-accent-alpha': 'rgba(0, 122, 204, 0.15)',
  '--color-success': '#4ec9b0',
  '--color-warning:': '#cca700',
  '--color-error': '#f14c4c',
  
  /* UI colors */
  '--color-border': '#2b2b2b',
  '--color-hover': '#2a2d2e',
  '--color-active': '#37373d',

  /* Elevated surfaces */
  '--color-bg-elevated': '#252526',
  '--shadow-elevated': '0 4px 20px rgba(0, 0, 0, 0.5)',
  
  /* Surface colors */
  '--color-surface0': '#252526',
  '--color-surface1': '#333333',
  '--color-surface2': '#3c3c3c',

  /* Overlay colors */
  '--color-overlay0': '#3c3c3c',
  '--color-overlay1': '#454545',
  '--color-overlay2': '#5a5a5a',
  
  /* Syntax highlighting colors */
  '--color-pink': '#c586c0',
  '--color-mauve': '#c586c0',
  '--color-red': '#f44747',
  '--color-maroon': '#d16969',
  '--color-peach': '#ce9178',
  '--color-yellow': '#dcdcaa',
  '--color-green': '#6a9955',
  '--color-teal': '#4ec9b0',
  '--color-sky': '#9cdcfe',
  '--color-sapphire': '#4fc1ff',
  '--color-blue': '#569cd6',
  '--color-lavender': '#b5cea8',
};

export const voltDarkModernMonacoTheme: Monaco.editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6a9955' },
    { token: 'keyword', foreground: '569cd6' },
    { token: 'string', foreground: 'ce9178' },
    { token: 'number', foreground: 'b5cea8' },
    { token: 'type', foreground: '4ec9b0' },
    { token: 'class', foreground: '4ec9b0' },
    { token: 'function', foreground: 'dcdcaa' },
    { token: 'variable', foreground: '9cdcfe' },
    { token: 'variable.predefined', foreground: '9cdcfe' },
    { token: 'constant', foreground: '4fc1ff' },
    { token: 'tag', foreground: '569cd6' },
    { token: 'attribute.name', foreground: '9cdcfe' },
    { token: 'delimiter', foreground: 'cccccc' },
  ],
  colors: {
    'editor.background': '#1f1f1f',
    'editor.foreground': '#cccccc',
    'editorCursor.foreground': '#aeafad',
    'editor.lineHighlightBackground': '#2a2d2e',
    'editorLineNumber.foreground': '#6e7681',
    'editorLineNumber.activeForeground': '#cccccc',
    'editorIndentGuide.background': '#333333',
    'editorIndentGuide.activeBackground': '#454545',
    'editor.selectionBackground': '#264f78',
    'editor.inactiveSelectionBackground': '#3a3d41',
  }
};
