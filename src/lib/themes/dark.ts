/**
 * Volt Dark Theme (Catppuccin Mocha-inspired)
 * Default theme for Volt IDE
 */

import type * as Monaco from 'monaco-editor';

/** CSS variable values for dark theme */
export const darkThemeVars = {
  // Background colors
  '--color-bg': '#1e1e2e',
  '--color-bg-sidebar': '#181825',
  '--color-bg-panel': '#1e1e2e',
  '--color-bg-header': '#181825',
  '--color-bg-input': '#313244',

  // Text colors
  '--color-text': '#cdd6f4',
  '--color-text-secondary': '#a6adc8',
  '--color-text-disabled': '#585b70',

  // Accent colors
  '--color-accent': '#89b4fa',
  '--color-success': '#a6e3a1',
  '--color-warning': '#f9e2af',
  '--color-error': '#f38ba8',

  // UI colors
  '--color-border': '#313244',
  '--color-hover': '#2b2d3f',
  '--color-active': '#45475a',

  // Elevated surfaces
  '--color-bg-elevated': '#11111b',
  '--shadow-elevated': '0 12px 40px rgba(0, 0, 0, 0.45)',

  // Surface colors
  '--color-surface0': '#313244',
  '--color-surface1': '#45475a',
  '--color-surface2': '#585b70',

  // Overlay colors
  '--color-overlay0': '#6c7086',
  '--color-overlay1': '#7f849c',
  '--color-overlay2': '#9399b2',

  // Syntax highlighting colors
  '--color-pink': '#f5c2e7',
  '--color-mauve': '#cba6f7',
  '--color-red': '#f38ba8',
  '--color-maroon': '#eba0ac',
  '--color-peach': '#fab387',
  '--color-yellow': '#f9e2af',
  '--color-green': '#a6e3a1',
  '--color-teal': '#94e2d5',
  '--color-sky': '#89dceb',
  '--color-sapphire': '#74c7ec',
  '--color-blue': '#89b4fa',
  '--color-lavender': '#b4befe'
} as const;

/** Monaco editor theme definition for dark mode */
export const voltDarkMonacoTheme: Monaco.editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    // Common tokens
    { token: 'comment', foreground: '6c7086', fontStyle: 'italic' },
    { token: 'comment.doc', foreground: '7f849c', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'cba6f7', fontStyle: 'bold' },
    { token: 'string', foreground: 'a6e3a1' },
    { token: 'string.escape', foreground: 'f5c2e7' },
    { token: 'string.interpolation', foreground: 'fab387' },
    { token: 'string.invalid', foreground: 'f38ba8' },
    { token: 'number', foreground: 'fab387' },
    { token: 'number.float', foreground: 'fab387' },
    { token: 'number.hex', foreground: 'fab387' },
    { token: 'number.octal', foreground: 'fab387' },
    { token: 'number.binary', foreground: 'fab387' },
    { token: 'type', foreground: 'f9e2af' },
    { token: 'type.identifier', foreground: 'f9e2af' },
    { token: 'function', foreground: '89b4fa' },
    { token: 'variable', foreground: 'cdd6f4' },
    { token: 'constant', foreground: 'fab387' },
    { token: 'operator', foreground: '89dceb' },
    { token: 'delimiter', foreground: '9399b2' },
    { token: 'identifier', foreground: 'cdd6f4' },
    { token: 'annotation', foreground: 'f9e2af' },

    // HTML/XML tokens
    { token: 'tag', foreground: 'f38ba8' },
    { token: 'attribute.name', foreground: 'f9e2af' },
    { token: 'attribute.value', foreground: 'a6e3a1' },

    // Default token for source code
    { token: 'source', foreground: 'cdd6f4' },
  ],
  colors: {
    'editor.background': '#1e1e2e',
    'editor.foreground': '#cdd6f4',
    'editor.lineHighlightBackground': '#313244',
    'editor.selectionBackground': '#45475a',
    'editor.inactiveSelectionBackground': '#313244',
    'editorCursor.foreground': '#f5e0dc',
    'editorWhitespace.foreground': '#45475a',
    'editorLineNumber.foreground': '#6c7086',
    'editorLineNumber.activeForeground': '#cdd6f4',
    'editorIndentGuide.background': '#313244',
    'editorIndentGuide.activeBackground': '#45475a',
    'editor.findMatchBackground': '#f9e2af40',
    'editor.findMatchHighlightBackground': '#f9e2af20',
    'editorBracketMatch.background': '#45475a',
    'editorBracketMatch.border': '#89b4fa'
  }
};
