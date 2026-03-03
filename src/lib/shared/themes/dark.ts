/**
 * Volt Dark Theme (Anysphere-inspired)
 * Pure black high-contrast theme
 */

import type * as Monaco from 'monaco-editor';

/** CSS variable values for dark theme */
export const darkThemeVars = {
    // Background colors
    '--color-bg': '#000000',
    '--color-bg-sidebar': '#0a0a0a',
    '--color-bg-panel': '#000000',
    '--color-bg-header': '#0a0a0a',
    '--color-bg-input': '#1a1a1a',

    // Text colors
    '--color-text': '#e5e5e5',
    '--color-text-secondary': '#a3a3a3',
    '--color-text-disabled': '#525252',

    // Accent colors
    '--color-accent': '#3b82f6', // Cursor blue
    '--color-success': '#22c55e',
    '--color-warning': '#eab308',
    '--color-error': '#ef4444',

    // UI colors
    '--color-border': '#1a1a1a',
    '--color-hover': '#131313',
    '--color-active': '#1a1a1a',

    // Elevated surfaces
    '--color-bg-elevated': '#0c0c0c',
    '--shadow-elevated': '0 8px 30px rgba(0, 0, 0, 0.7)',

    // Surface colors (for scrollbars etc)
    '--color-surface0': '#121212',
    '--color-surface1': '#1c1c1c',
    '--color-surface2': '#2e2e2e',

    // Overlay colors
    '--color-overlay0': '#3f3f3f',
    '--color-overlay1': '#525252',
    '--color-overlay2': '#737373',

    // Syntax highlighting colors (Adjusted for high contrast on black)
    '--color-pink': '#ec4899',
    '--color-mauve': '#d946ef',
    '--color-red': '#ef4444',
    '--color-maroon': '#f43f5e',
    '--color-peach': '#f97316',
    '--color-yellow': '#eab308',
    '--color-green': '#22c55e',
    '--color-teal': '#14b8a6',
    '--color-sky': '#0ea5e9',
    '--color-sapphire': '#3b82f6',
    '--color-blue': '#3b82f6',
    '--color-lavender': '#8b5cf6'
} as const;

/** Monaco editor theme definition for dark mode */
export const voltDarkMonacoTheme: Monaco.editor.IStandaloneThemeData = {
    base: 'vs-dark',
    inherit: true,
    rules: [
        // Common tokens
        { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
        { token: 'comment.doc', foreground: '6b7280', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'd946ef', fontStyle: 'bold' }, // Mauve/Magenta
        { token: 'string', foreground: '22c55e' }, // Green
        { token: 'string.escape', foreground: 'ec4899' },
        { token: 'string.interpolation', foreground: 'f97316' },
        { token: 'string.invalid', foreground: 'ef4444' },
        { token: 'number', foreground: 'eab308' }, // Yellow
        { token: 'number.float', foreground: 'eab308' },
        { token: 'number.hex', foreground: 'eab308' },
        { token: 'number.octal', foreground: 'eab308' },
        { token: 'number.binary', foreground: 'eab308' },
        { token: 'type', foreground: '3b82f6' }, // Blue
        { token: 'type.identifier', foreground: '3b82f6' },
        { token: 'function', foreground: 'eab308' }, // Yellow/Gold for functions
        { token: 'variable', foreground: 'e5e5e5' },
        { token: 'constant', foreground: 'f97316' },
        { token: 'operator', foreground: 'a3a3a3' },
        { token: 'delimiter', foreground: '737373' },
        { token: 'identifier', foreground: 'e5e5e5' },
        { token: 'annotation', foreground: 'eab308' },

        // HTML/XML tokens
        { token: 'tag', foreground: '3b82f6' },
        { token: 'attribute.name', foreground: '0ea5e9' },
        { token: 'attribute.value', foreground: '22c55e' },

        // Default token for source code
        { token: 'source', foreground: 'e5e5e5' },
    ],
    colors: {
        'editor.background': '#000000',
        'editor.foreground': '#e5e5e5',
        'editor.lineHighlightBackground': '#111111',
        'editor.selectionBackground': '#262626',
        'editor.inactiveSelectionBackground': '#1a1a1a',
        'editorCursor.foreground': '#3b82f6', // Blue cursor
        'editorWhitespace.foreground': '#262626',
        'editorLineNumber.foreground': '#525252',
        'editorLineNumber.activeForeground': '#e5e5e5',
        'editorIndentGuide.background': '#171717',
        'editorIndentGuide.activeBackground': '#404040',
        'editor.findMatchBackground': '#eab30833',
        'editor.findMatchHighlightBackground': '#eab3081a',
        'editorBracketMatch.background': '#262626',
        'editorBracketMatch.border': '#3b82f6',
        'editorError.foreground': '#ef4444',
        'editorWarning.foreground': '#eab308',
        'editorInfo.foreground': '#3b82f6',
        'editorHint.foreground': '#737373',
        'editorOverviewRuler.errorForeground': '#ef4444',
        'editorOverviewRuler.warningForeground': '#eab308',
        'editorOverviewRuler.infoForeground': '#3b82f6'
    }
};
