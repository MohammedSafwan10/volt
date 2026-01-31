import type * as Monaco from 'monaco-editor';

/**
 * Solarized Dark Theme
 * Designed by Ethan Schoonover
 */
export const solarizedDarkThemeVars: Record<string, string> = {
    /* Background colors */
    '--color-bg': '#002b36',
    '--color-bg-rgb': '0, 43, 54',
    '--color-bg-sidebar': '#073642',
    '--color-bg-panel': '#002b36',
    '--color-bg-header': '#073642',
    '--color-bg-input': '#073642',

    /* Text colors */
    '--color-text': '#839496',
    '--color-text-secondary': '#586e75',
    '--color-text-disabled': '#073642',

    /* Accent colors */
    '--color-accent': '#268bd2', // blue
    '--color-accent-rgb': '38, 139, 210',
    '--color-accent-alpha': 'rgba(38, 139, 210, 0.15)',
    '--color-success': '#859900', // green
    '--color-warning': '#b58900', // yellow
    '--color-error': '#dc322f',   // red

    /* UI colors */
    '--color-border': '#073642',
    '--color-hover': '#073642',
    '--color-active': '#586e75',

    /* Elevated surfaces */
    '--color-bg-elevated': '#073642',
    '--shadow-elevated': '0 4px 20px rgba(0, 0, 0, 0.5)',

    /* Surface colors */
    '--color-surface0': '#073642',
    '--color-surface1': '#586e75',
    '--color-surface2': '#657b83',

    /* Overlay colors */
    '--color-overlay0': '#586e75',
    '--color-overlay1': '#657b83',
    '--color-overlay2': '#839496',

    /* Syntax highlighting colors */
    '--color-pink': '#d33682',    // magenta
    '--color-mauve': '#6c71c4',   // violet
    '--color-red': '#dc322f',
    '--color-maroon': '#cb4b16',  // orange
    '--color-peach': '#cb4b16',
    '--color-yellow': '#b58900',
    '--color-green': '#859900',
    '--color-teal': '#2aa198',    // cyan
    '--color-sky': '#268bd2',     // blue
    '--color-sapphire': '#268bd2',
    '--color-blue': '#268bd2',
    '--color-lavender': '#6c71c4',
};

export const voltSolarizedDarkMonacoTheme: Monaco.editor.IStandaloneThemeData = {
    base: 'vs-dark',
    inherit: true,
    rules: [
        { token: 'comment', foreground: '586e75', fontStyle: 'italic' },
        { token: 'keyword', foreground: '859900' }, // green
        { token: 'string', foreground: '2aa198' },  // cyan
        { token: 'number', foreground: 'd33682' },  // magenta
        { token: 'type', foreground: 'b58900' },    // yellow
        { token: 'class', foreground: 'b58900' },
        { token: 'function', foreground: '268bd2' }, // blue
        { token: 'variable', foreground: '839496' },
        { token: 'variable.predefined', foreground: 'b58900' },
        { token: 'constant', foreground: 'cb4b16' }, // orange
        { token: 'tag', foreground: '268bd2' },
        { token: 'attribute.name', foreground: '586e75' },
        { token: 'delimiter', foreground: '839496' },
    ],
    colors: {
        'editor.background': '#002b36',
        'editor.foreground': '#839496',
        'editorCursor.foreground': '#839496',
        'editor.lineHighlightBackground': '#073642',
        'editorLineNumber.foreground': '#586e75',
        'editorLineNumber.activeForeground': '#93a1a1',
        'editorIndentGuide.background': '#073642',
        'editorIndentGuide.activeBackground': '#586e75',
        'editor.selectionBackground': '#073642',
        'editor.inactiveSelectionBackground': '#002b36',
    }
};
