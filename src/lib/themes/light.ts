/**
 * Volt Light Theme (Catppuccin Latte-inspired)
 * Light theme for Volt IDE
 */

import type * as Monaco from 'monaco-editor';

/** CSS variable values for light theme */
export const lightThemeVars = {
  // Background colors
  '--color-bg': '#eff1f5',
  '--color-bg-sidebar': '#e6e9ef',
  '--color-bg-panel': '#eff1f5',
  '--color-bg-header': '#e6e9ef',
  '--color-bg-input': '#ccd0da',
  
  // Text colors
  '--color-text': '#4c4f69',
  '--color-text-secondary': '#6c6f85',
  '--color-text-disabled': '#9ca0b0',
  
  // Accent colors
  '--color-accent': '#1e66f5',
  '--color-success': '#40a02b',
  '--color-warning': '#df8e1d',
  '--color-error': '#d20f39',
  
  // UI colors
  '--color-border': '#ccd0da',
  '--color-hover': '#d7dbe3',
  '--color-active': '#bcc0cc',

  // Elevated surfaces
  '--color-bg-elevated': '#ffffff',
  '--shadow-elevated': '0 12px 34px rgba(0, 0, 0, 0.14)',
  
  // Surface colors
  '--color-surface0': '#ccd0da',
  '--color-surface1': '#bcc0cc',
  '--color-surface2': '#acb0be',
  
  // Overlay colors
  '--color-overlay0': '#9ca0b0',
  '--color-overlay1': '#8c8fa1',
  '--color-overlay2': '#7c7f93',
  
  // Syntax highlighting colors
  '--color-pink': '#ea76cb',
  '--color-mauve': '#8839ef',
  '--color-red': '#d20f39',
  '--color-maroon': '#e64553',
  '--color-peach': '#fe640b',
  '--color-yellow': '#df8e1d',
  '--color-green': '#40a02b',
  '--color-teal': '#179299',
  '--color-sky': '#04a5e5',
  '--color-sapphire': '#209fb5',
  '--color-blue': '#1e66f5',
  '--color-lavender': '#7287fd'
} as const;

/** Monaco editor theme definition for light mode */
export const voltLightMonacoTheme: Monaco.editor.IStandaloneThemeData = {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '9ca0b0', fontStyle: 'italic' },
    { token: 'keyword', foreground: '8839ef', fontStyle: 'bold' },
    { token: 'string', foreground: '40a02b' },
    { token: 'number', foreground: 'fe640b' },
    { token: 'type', foreground: 'df8e1d' },
    { token: 'function', foreground: '1e66f5' },
    { token: 'variable', foreground: '4c4f69' },
    { token: 'constant', foreground: 'fe640b' },
    { token: 'operator', foreground: '04a5e5' },
    { token: 'delimiter', foreground: '7c7f93' },
    { token: 'tag', foreground: 'd20f39' },
    { token: 'attribute.name', foreground: 'df8e1d' },
    { token: 'attribute.value', foreground: '40a02b' }
  ],
  colors: {
    'editor.background': '#eff1f5',
    'editor.foreground': '#4c4f69',
    'editor.lineHighlightBackground': '#e6e9ef',
    'editor.selectionBackground': '#bcc0cc',
    'editor.inactiveSelectionBackground': '#ccd0da',
    'editorCursor.foreground': '#dc8a78',
    'editorWhitespace.foreground': '#bcc0cc',
    'editorLineNumber.foreground': '#9ca0b0',
    'editorLineNumber.activeForeground': '#4c4f69',
    'editorIndentGuide.background': '#ccd0da',
    'editorIndentGuide.activeBackground': '#bcc0cc',
    'editor.findMatchBackground': '#df8e1d40',
    'editor.findMatchHighlightBackground': '#df8e1d20',
    'editorBracketMatch.background': '#bcc0cc',
    'editorBracketMatch.border': '#1e66f5'
  }
};
