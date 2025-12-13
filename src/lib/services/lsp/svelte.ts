/**
 * Svelte Language Support
 * 
 * Provides Svelte-specific language features for Monaco Editor:
 * - Custom Svelte language definition with syntax highlighting
 * - Svelte-specific tokens for runes, directives, and blocks
 * 
 * Note: Full LSP support would require svelte-language-server,
 * which is complex to integrate in a browser environment.
 * This module provides enhanced syntax highlighting as a foundation.
 */

import type * as Monaco from 'monaco-editor';

// Svelte language ID
export const SVELTE_LANGUAGE_ID = 'svelte';

/**
 * Svelte language configuration
 */
export const svelteLanguageConfiguration: Monaco.languages.LanguageConfiguration = {
  comments: {
    lineComment: '//',
    blockComment: ['/*', '*/']
  },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
    ['<', '>']
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '<', close: '>' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: '`', close: '`' }
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '<', close: '>' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
    { open: '`', close: '`' }
  ],
  folding: {
    markers: {
      start: /^\s*<!--\s*#region\b.*-->/,
      end: /^\s*<!--\s*#endregion\b.*-->/
    }
  },
  wordPattern: /(-?\d*\.\d\w*)|([^\`\~\!\@\#\%\^\&\*\(\)\-\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)/g,
  indentationRules: {
    increaseIndentPattern: /<(?!\?|(?:area|base|br|col|frame|hr|html|img|input|keygen|link|menuitem|meta|param|source|track|wbr)\b|[^>]*\/>)([-_\.A-Za-z0-9]+)(?=\s|>)\b[^>]*>(?!.*<\/\1>)|<!--(?!.*-->)|\{[^}"']*$/,
    decreaseIndentPattern: /^\s*(<\/[-_\.A-Za-z0-9]+\b[^>]*>|-->|\})/
  }
};

/**
 * Svelte Monarch tokenizer definition
 * Provides syntax highlighting for Svelte files
 */
export const svelteMonarchTokens: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.svelte',

  // Svelte-specific keywords
  svelteKeywords: [
    'if', 'else', 'each', 'await', 'then', 'catch', 'key', 'snippet', 'render',
    'html', 'debug', 'const', 'attach'
  ],

  // Svelte 5 runes
  svelteRunes: [
    '$state', '$derived', '$effect', '$props', '$bindable', '$inspect', '$host'
  ],

  // Svelte directives
  svelteDirectives: [
    'bind', 'on', 'use', 'transition', 'in', 'out', 'animate', 'class', 'style'
  ],

  // Svelte special elements
  svelteElements: [
    'svelte:head', 'svelte:body', 'svelte:window', 'svelte:document',
    'svelte:element', 'svelte:component', 'svelte:self', 'svelte:fragment',
    'svelte:options', 'svelte:boundary'
  ],

  // JavaScript keywords
  jsKeywords: [
    'break', 'case', 'catch', 'continue', 'debugger', 'default', 'delete',
    'do', 'else', 'finally', 'for', 'function', 'if', 'in', 'instanceof',
    'new', 'return', 'switch', 'this', 'throw', 'try', 'typeof', 'var',
    'void', 'while', 'with', 'class', 'const', 'enum', 'export', 'extends',
    'import', 'super', 'implements', 'interface', 'let', 'package', 'private',
    'protected', 'public', 'static', 'yield', 'async', 'await', 'of'
  ],

  // TypeScript keywords
  tsKeywords: [
    'type', 'interface', 'namespace', 'module', 'declare', 'abstract',
    'as', 'asserts', 'any', 'boolean', 'bigint', 'never', 'number',
    'object', 'string', 'symbol', 'undefined', 'unknown', 'void',
    'keyof', 'typeof', 'readonly', 'infer', 'is', 'satisfies'
  ],

  // Operators
  operators: [
    '=', '>', '<', '!', '~', '?', ':', '==', '<=', '>=', '!=',
    '&&', '||', '++', '--', '+', '-', '*', '/', '&', '|', '^', '%',
    '<<', '>>', '>>>', '+=', '-=', '*=', '/=', '&=', '|=', '^=',
    '%=', '<<=', '>>=', '>>>=', '=>', '??', '?.', '...'
  ],

  // Symbols
  symbols: /[=><!~?:&|+\-*\/\^%]+/,

  // Escape sequences
  escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,

  // Tokenizer rules
  tokenizer: {
    root: [
      // Svelte script tag
      [/<script(\s+[^>]*)?>/, { token: 'tag', next: '@script' }],
      
      // Svelte style tag
      [/<style(\s+[^>]*)?>/, { token: 'tag', next: '@style' }],
      
      // Svelte blocks
      [/\{#(if|each|await|key|snippet)/, { token: 'keyword.svelte', next: '@svelteBlock' }],
      [/\{:(else|then|catch)/, { token: 'keyword.svelte', next: '@svelteBlock' }],
      [/\{\/(if|each|await|key|snippet)\}/, 'keyword.svelte'],
      
      // Svelte special tags
      [/@(html|debug|const|render|attach)/, 'keyword.svelte'],
      
      // Svelte expressions
      [/\{/, { token: 'delimiter.curly', next: '@svelteExpression' }],
      
      // HTML comments
      [/<!--/, 'comment', '@htmlComment'],
      
      // HTML tags
      [/<\/?[\w:-]+/, { token: 'tag', next: '@htmlTag' }],
      
      // Text content
      [/[^<{]+/, 'text']
    ],

    // Script block (JavaScript/TypeScript)
    script: [
      [/<\/script\s*>/, { token: 'tag', next: '@pop' }],
      { include: '@javascript' }
    ],

    // Style block (CSS)
    style: [
      [/<\/style\s*>/, { token: 'tag', next: '@pop' }],
      { include: '@css' }
    ],

    // Svelte block content
    svelteBlock: [
      [/\}/, { token: 'keyword.svelte', next: '@pop' }],
      { include: '@javascript' }
    ],

    // Svelte expression
    svelteExpression: [
      [/\}/, { token: 'delimiter.curly', next: '@pop' }],
      { include: '@javascript' }
    ],

    // HTML tag
    htmlTag: [
      [/\s+/, ''],
      [/[\w:-]+(?==)/, 'attribute.name'],
      [/=/, 'delimiter'],
      [/"[^"]*"/, 'attribute.value'],
      [/'[^']*'/, 'attribute.value'],
      [/\{/, { token: 'delimiter.curly', next: '@svelteExpression' }],
      [/\/?>/, { token: 'tag', next: '@pop' }]
    ],

    // HTML comment
    htmlComment: [
      [/-->/, 'comment', '@pop'],
      [/./, 'comment']
    ],

    // JavaScript tokenizer
    javascript: [
      // Svelte runes
      [/\$(?:state|derived|effect|props|bindable|inspect|host)\b/, 'keyword.rune'],
      
      // Comments
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@jsComment'],
      
      // Strings
      [/"([^"\\]|\\.)*$/, 'string.invalid'],
      [/'([^'\\]|\\.)*$/, 'string.invalid'],
      [/"/, 'string', '@jsDoubleString'],
      [/'/, 'string', '@jsSingleString'],
      [/`/, 'string', '@jsTemplateString'],
      
      // Numbers
      [/\d*\.\d+([eE][\-+]?\d+)?/, 'number.float'],
      [/0[xX][0-9a-fA-F]+/, 'number.hex'],
      [/\d+/, 'number'],
      
      // Keywords
      [/[a-zA-Z_$][\w$]*/, {
        cases: {
          '@jsKeywords': 'keyword',
          '@tsKeywords': 'keyword.type',
          '@default': 'identifier'
        }
      }],
      
      // Operators
      [/@symbols/, {
        cases: {
          '@operators': 'operator',
          '@default': ''
        }
      }],
      
      // Delimiters
      [/[{}()\[\]]/, 'delimiter.bracket'],
      [/[;,.]/, 'delimiter']
    ],

    jsComment: [
      [/\*\//, 'comment', '@pop'],
      [/./, 'comment']
    ],

    jsDoubleString: [
      [/[^\\"]+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape.invalid'],
      [/"/, 'string', '@pop']
    ],

    jsSingleString: [
      [/[^\\']+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape.invalid'],
      [/'/, 'string', '@pop']
    ],

    jsTemplateString: [
      [/\$\{/, { token: 'delimiter.bracket', next: '@jsTemplateExpression' }],
      [/[^`$]+/, 'string'],
      [/`/, 'string', '@pop']
    ],

    jsTemplateExpression: [
      [/\}/, { token: 'delimiter.bracket', next: '@pop' }],
      { include: '@javascript' }
    ],

    // CSS tokenizer
    css: [
      // Comments
      [/\/\*/, 'comment', '@cssComment'],
      
      // Selectors
      [/[.#][\w-]+/, 'tag'],
      [/[\w-]+(?=\s*\{)/, 'tag'],
      [/:[\w-]+/, 'tag.pseudo'],
      
      // Properties
      [/[\w-]+(?=\s*:)/, 'attribute.name'],
      
      // Values
      [/#[0-9a-fA-F]{3,8}/, 'number.hex'],
      [/\d+(\.\d+)?(px|em|rem|%|vh|vw|deg|s|ms)?/, 'number'],
      [/"[^"]*"/, 'string'],
      [/'[^']*'/, 'string'],
      
      // Functions
      [/[\w-]+(?=\()/, 'function'],
      
      // Delimiters
      [/[{}();:,]/, 'delimiter']
    ],

    cssComment: [
      [/\*\//, 'comment', '@pop'],
      [/./, 'comment']
    ]
  }
};

/**
 * Register Svelte language with Monaco
 */
export function registerSvelteLanguage(monaco: typeof Monaco): void {
  // Check if already registered
  const languages = monaco.languages.getLanguages();
  if (languages.some(lang => lang.id === SVELTE_LANGUAGE_ID)) {
    return;
  }

  // Register the language
  monaco.languages.register({
    id: SVELTE_LANGUAGE_ID,
    extensions: ['.svelte'],
    aliases: ['Svelte', 'svelte'],
    mimetypes: ['text/x-svelte']
  });

  // Set language configuration
  monaco.languages.setLanguageConfiguration(SVELTE_LANGUAGE_ID, svelteLanguageConfiguration);

  // Set Monarch tokenizer
  monaco.languages.setMonarchTokensProvider(SVELTE_LANGUAGE_ID, svelteMonarchTokens);
}

/**
 * Check if a file is a Svelte file
 */
export function isSvelteFile(filepath: string): boolean {
  return filepath.toLowerCase().endsWith('.svelte');
}

