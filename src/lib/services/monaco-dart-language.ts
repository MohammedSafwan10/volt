/**
 * Dart Language Support for Monaco Editor
 * Provides syntax highlighting using Monarch grammar
 */

import type * as Monaco from 'monaco-editor';

/**
 * Dart language configuration
 */
export const dartLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
    comments: {
        lineComment: '//',
        blockComment: ['/*', '*/'],
    },
    brackets: [
        ['{', '}'],
        ['[', ']'],
        ['(', ')'],
    ],
    autoClosingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: "'", close: "'", notIn: ['string', 'comment'] },
        { open: '"', close: '"', notIn: ['string'] },
        { open: '`', close: '`', notIn: ['string', 'comment'] },
        { open: '/**', close: ' */', notIn: ['string'] },
    ],
    surroundingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: "'", close: "'" },
        { open: '"', close: '"' },
        { open: '`', close: '`' },
    ],
    folding: {
        markers: {
            start: /^\s*\/\/\s*#?region\b/,
            end: /^\s*\/\/\s*#?endregion\b/,
        },
    },
    indentationRules: {
        increaseIndentPattern: /^.*\{[^}"']*$/,
        decreaseIndentPattern: /^\s*\}/,
    },
};

/**
 * Dart Monarch token definitions for syntax highlighting
 */
export const dartMonarchLanguage: Monaco.languages.IMonarchLanguage = {
    defaultToken: '',
    tokenPostfix: '', // Keep empty to use standard theme tokens

    keywords: [
        'abstract', 'as', 'assert', 'async', 'await', 'base', 'break', 'case',
        'catch', 'class', 'const', 'continue', 'covariant', 'default', 'deferred',
        'do', 'dynamic', 'else', 'enum', 'export', 'extends', 'extension',
        'external', 'factory', 'false', 'final', 'finally', 'for', 'Function',
        'get', 'hide', 'if', 'implements', 'import', 'in', 'interface', 'is',
        'late', 'library', 'mixin', 'new', 'null', 'on', 'operator', 'part',
        'required', 'rethrow', 'return', 'sealed', 'set', 'show', 'static',
        'super', 'switch', 'sync', 'this', 'throw', 'true', 'try', 'typedef',
        'var', 'void', 'when', 'while', 'with', 'yield',
    ],

    typeKeywords: [
        'bool', 'double', 'dynamic', 'int', 'num', 'Object', 'String',
        'void', 'Never', 'Null', 'Future', 'Stream', 'List', 'Map', 'Set',
        'Iterable', 'Iterator', 'Duration', 'DateTime', 'Uri', 'Type',
    ],

    operators: [
        '=', '>', '<', '!', '~', '?', ':', '==', '<=', '>=', '!=',
        '&&', '||', '++', '--', '+', '-', '*', '/', '&', '|', '^', '%',
        '<<', '>>', '>>>', '+=', '-=', '*=', '/=', '&=', '|=', '^=',
        '%=', '<<=', '>>=', '>>>=', '??', '?.', '...', '..', '=>',
    ],

    symbols: /[=><!~?:&|+\-*\/\^%]+/,
    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,
    digits: /\d+(_+\d+)*/,
    octaldigits: /[0-7]+(_+[0-7]+)*/,
    binarydigits: /[0-1]+(_+[0-1]+)*/,
    hexdigits: /[[0-9a-fA-F]+(_+[0-9a-fA-F]+)*/,

    tokenizer: {
        root: [
            // Identifiers and keywords
            [/[a-zA-Z_$][\w$]*/, {
                cases: {
                    '@typeKeywords': 'type',
                    '@keywords': 'keyword',
                    '@default': 'identifier',
                },
            }],

            // Whitespace
            { include: '@whitespace' },

            // Delimiters and operators
            [/[{}()\[\]]/, '@brackets'],
            [/[<>](?!@symbols)/, '@brackets'],
            [/@symbols/, {
                cases: {
                    '@operators': 'operator',
                    '@default': '',
                },
            }],

            // Annotations
            [/@[a-zA-Z_$][\w$]*/, 'annotation'],

            // Numbers
            [/(@digits)[eE]([\-+]?(@digits))?/, 'number'],
            [/(@digits)\.(@digits)([eE][\-+]?(@digits))?/, 'number'],
            [/0[xX](@hexdigits)/, 'number'],
            [/0[oO]?(@octaldigits)/, 'number'],
            [/0[bB](@binarydigits)/, 'number'],
            [/(@digits)/, 'number'],

            // Delimiter
            [/[;,.]/, 'delimiter'],

            // Strings
            [/"""/, 'string', '@multilinestring'],
            [/"/, 'string', '@string_double'],
            [/'/, 'string', '@string_single'],
            [/r"/, 'string', '@rawstring_double'],
            [/r'/, 'string', '@rawstring_single'],
        ],

        whitespace: [
            [/[ \t\r\n]+/, ''],
            [/\/\*\*(?!\/)/, 'comment', '@doccomment'],
            [/\/\*/, 'comment', '@comment'],
            [/\/\/.*$/, 'comment'],
        ],

        comment: [
            [/[^\/*]+/, 'comment'],
            [/\*\//, 'comment', '@pop'],
            [/[\/*]/, 'comment'],
        ],

        doccomment: [
            [/[^\/*]+/, 'comment'],
            [/\*\//, 'comment', '@pop'],
            [/[\/*]/, 'comment'],
        ],

        string_double: [
            [/[^\\"$]+/, 'string'],
            [/@escapes/, 'string'],
            [/\\./, 'string'],
            [/\$\{/, { token: 'variable', next: '@interpolation' }],
            [/\$[a-zA-Z_]\w*/, 'variable'],
            [/"/, 'string', '@pop'],
        ],

        string_single: [
            [/[^\\'$]+/, 'string'],
            [/@escapes/, 'string'],
            [/\\./, 'string'],
            [/\$\{/, { token: 'variable', next: '@interpolation' }],
            [/\$[a-zA-Z_]\w*/, 'variable'],
            [/'/, 'string', '@pop'],
        ],

        rawstring_double: [
            [/[^"]+/, 'string'],
            [/"/, 'string', '@pop'],
        ],

        rawstring_single: [
            [/[^']+/, 'string'],
            [/'/, 'string', '@pop'],
        ],

        multilinestring: [
            [/[^\\"$]+/, 'string'],
            [/@escapes/, 'string'],
            [/\$\{/, { token: 'variable', next: '@interpolation' }],
            [/\$[a-zA-Z_]\w*/, 'variable'],
            [/"""/, 'string', '@pop'],
            [/./, 'string'],
        ],

        interpolation: [
            [/\{/, { token: 'variable', next: '@push' }],
            [/\}/, { token: 'variable', next: '@pop' }],
            { include: 'root' },
        ],
    },
};

/**
 * Register Dart language with Monaco Editor
 */
export function registerDartLanguage(monaco: typeof Monaco): void {
    console.log('[Monaco] Registering Dart language...');
    try {
        const languages = monaco.languages.getLanguages();
        const existing = languages.find(lang => lang.id === 'dart');

        if (existing) {
            console.log('[Monaco] Dart language already registered, updating tokenizer...');
            monaco.languages.setMonarchTokensProvider('dart', dartMonarchLanguage);
            monaco.languages.setLanguageConfiguration('dart', dartLanguageConfiguration);
            return;
        }

        monaco.languages.register({
            id: 'dart',
            extensions: ['.dart'],
            aliases: ['Dart', 'dart'],
        });

        monaco.languages.setLanguageConfiguration('dart', dartLanguageConfiguration);
        monaco.languages.setMonarchTokensProvider('dart', dartMonarchLanguage);

        console.log('[Monaco] Dart language registered successfully');
    } catch (err) {
        console.error('[Monaco] Failed to register Dart language:', err);
    }
}
