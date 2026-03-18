/**
 * Tailwind CSS Monaco Providers
 * 
 * Registers Monaco language providers that use the Tailwind CSS LSP sidecar
 * for completions, hover, and color information.
 * 
 * This provides VS Code-level Tailwind IntelliSense by using the real
 * @tailwindcss/language-server.
 */

import type * as Monaco from 'monaco-editor';
import { getMonaco } from '$core/services/monaco-loader';
import {
  getTailwindCompletions,
  getTailwindHover,
  getTailwindDocumentColors,
  getTailwindColorPresentations,
  isTailwindLspInitialized,
  type CompletionItem as LspCompletionItem,
  type HoverResult,
  type ColorInformation,
  type ColorPresentation
} from './tailwind-sidecar';

// Track registered providers for cleanup
const registeredDisposables: Monaco.IDisposable[] = [];

// Languages to register Tailwind providers for
const TAILWIND_LANGUAGES = [
  'typescript',
  'javascript',
  'typescriptreact',
  'javascriptreact',
  'html',
  'css',
  'scss',
  'less',
  'svelte',
  'vue'
];

/**
 * Convert file path from Monaco model URI
 */
function getFilePathFromModel(model: Monaco.editor.ITextModel): string {
  const uri = model.uri;
  // Our URIs are in format: inmemory://model/{encodedPath}
  const path = uri.path;
  if (path.startsWith('/')) {
    return decodeURIComponent(path.slice(1));
  }
  return decodeURIComponent(path);
}


/**
 * Map LSP completion kind to Monaco completion kind
 */
function mapCompletionKind(monaco: typeof Monaco, lspKind?: number): Monaco.languages.CompletionItemKind {
  if (!lspKind) return monaco.languages.CompletionItemKind.Value;
  
  // LSP CompletionItemKind values
  const kindMap: Record<number, Monaco.languages.CompletionItemKind> = {
    1: monaco.languages.CompletionItemKind.Text,
    2: monaco.languages.CompletionItemKind.Method,
    3: monaco.languages.CompletionItemKind.Function,
    4: monaco.languages.CompletionItemKind.Constructor,
    5: monaco.languages.CompletionItemKind.Field,
    6: monaco.languages.CompletionItemKind.Variable,
    7: monaco.languages.CompletionItemKind.Class,
    8: monaco.languages.CompletionItemKind.Interface,
    9: monaco.languages.CompletionItemKind.Module,
    10: monaco.languages.CompletionItemKind.Property,
    11: monaco.languages.CompletionItemKind.Unit,
    12: monaco.languages.CompletionItemKind.Value,
    13: monaco.languages.CompletionItemKind.Enum,
    14: monaco.languages.CompletionItemKind.Keyword,
    15: monaco.languages.CompletionItemKind.Snippet,
    16: monaco.languages.CompletionItemKind.Color,
    17: monaco.languages.CompletionItemKind.File,
    18: monaco.languages.CompletionItemKind.Reference,
    19: monaco.languages.CompletionItemKind.Folder,
    20: monaco.languages.CompletionItemKind.EnumMember,
    21: monaco.languages.CompletionItemKind.Constant,
    22: monaco.languages.CompletionItemKind.Struct,
    23: monaco.languages.CompletionItemKind.Event,
    24: monaco.languages.CompletionItemKind.Operator,
    25: monaco.languages.CompletionItemKind.TypeParameter
  };
  
  return kindMap[lspKind] ?? monaco.languages.CompletionItemKind.Value;
}

/**
 * Convert LSP completion item to Monaco completion item
 */
function convertCompletionItem(
  monaco: typeof Monaco,
  item: LspCompletionItem,
  range: Monaco.IRange
): Monaco.languages.CompletionItem {
  let documentation: Monaco.languages.CompletionItem['documentation'];
  if (item.documentation) {
    if (typeof item.documentation === 'string') {
      documentation = item.documentation;
    } else if (item.documentation.kind === 'markdown') {
      documentation = { value: item.documentation.value };
    } else {
      documentation = item.documentation.value;
    }
  }

  // Handle text edit if present
  let insertText = item.insertText || item.label;
  let itemRange = range;
  
  if (item.textEdit) {
    insertText = item.textEdit.newText;
    itemRange = {
      startLineNumber: item.textEdit.range.start.line + 1,
      startColumn: item.textEdit.range.start.character + 1,
      endLineNumber: item.textEdit.range.end.line + 1,
      endColumn: item.textEdit.range.end.character + 1
    };
  }

  return {
    label: item.label,
    kind: mapCompletionKind(monaco, item.kind),
    detail: item.detail,
    documentation,
    insertText,
    insertTextRules: item.insertTextFormat === 2 
      ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet 
      : undefined,
    range: itemRange,
    sortText: item.sortText,
    filterText: item.filterText
  };
}

/**
 * Convert LSP hover to Monaco hover
 */
function convertHover(
  hover: HoverResult
): Monaco.languages.Hover {
  const contents: Monaco.IMarkdownString[] = [];
  
  if (typeof hover.contents === 'string') {
    contents.push({ value: hover.contents });
  } else if (Array.isArray(hover.contents)) {
    for (const content of hover.contents) {
      if (typeof content === 'string') {
        contents.push({ value: content });
      } else {
        contents.push({ value: content.value });
      }
    }
  } else {
    contents.push({ value: hover.contents.value });
  }
  
  let range: Monaco.IRange | undefined;
  if (hover.range) {
    range = {
      startLineNumber: hover.range.start.line + 1,
      startColumn: hover.range.start.character + 1,
      endLineNumber: hover.range.end.line + 1,
      endColumn: hover.range.end.character + 1
    };
  }
  
  return { contents, range };
}


/**
 * Create completion provider for Tailwind sidecar
 */
function createCompletionProvider(monaco: typeof Monaco): Monaco.languages.CompletionItemProvider {
  return {
    // Trigger on common Tailwind class contexts
    triggerCharacters: ['"', "'", ' ', ':', '-', '[', '/'],
    
    async provideCompletionItems(
      model: Monaco.editor.ITextModel,
      position: Monaco.Position,
      _context: Monaco.languages.CompletionContext,
      _token: Monaco.CancellationToken
    ): Promise<Monaco.languages.CompletionList | null> {
      if (!isTailwindLspInitialized()) {
        return null;
      }
      
      const filepath = getFilePathFromModel(model);
      const line = position.lineNumber - 1; // LSP is 0-based
      const character = position.column - 1;
      
      const items = await getTailwindCompletions(filepath, line, character);
      if (!items || items.length === 0) {
        return null;
      }
      
      // Get word range for replacement
      const word = model.getWordUntilPosition(position);
      const range: Monaco.IRange = {
        startLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: word.endColumn
      };
      
      const suggestions = items.map(item => convertCompletionItem(monaco, item, range));
      
      return {
        suggestions,
        incomplete: true // Tailwind has many classes, mark as incomplete for better UX
      };
    }
  };
}

/**
 * Create hover provider for Tailwind sidecar
 */
function createHoverProvider(): Monaco.languages.HoverProvider {
  return {
    async provideHover(
      model: Monaco.editor.ITextModel,
      position: Monaco.Position,
      _token: Monaco.CancellationToken
    ): Promise<Monaco.languages.Hover | null> {
      if (!isTailwindLspInitialized()) {
        return null;
      }
      
      const filepath = getFilePathFromModel(model);
      const line = position.lineNumber - 1;
      const character = position.column - 1;
      
      const hover = await getTailwindHover(filepath, line, character);
      if (!hover) {
        return null;
      }
      
      return convertHover(hover);
    }
  };
}

/**
 * Create color provider for Tailwind sidecar
 */
function createColorProvider(monaco: typeof Monaco): Monaco.languages.DocumentColorProvider {
  return {
    async provideDocumentColors(
      model: Monaco.editor.ITextModel,
      _token: Monaco.CancellationToken
    ): Promise<Monaco.languages.IColorInformation[] | null> {
      if (!isTailwindLspInitialized()) {
        return null;
      }
      
      const filepath = getFilePathFromModel(model);
      const colors = await getTailwindDocumentColors(filepath);
      
      if (!colors || colors.length === 0) {
        return null;
      }
      
      return colors.map((colorInfo: ColorInformation) => ({
        color: {
          red: colorInfo.color.red,
          green: colorInfo.color.green,
          blue: colorInfo.color.blue,
          alpha: colorInfo.color.alpha
        },
        range: {
          startLineNumber: colorInfo.range.start.line + 1,
          startColumn: colorInfo.range.start.character + 1,
          endLineNumber: colorInfo.range.end.line + 1,
          endColumn: colorInfo.range.end.character + 1
        }
      }));
    },
    
    async provideColorPresentations(
      model: Monaco.editor.ITextModel,
      colorInfo: Monaco.languages.IColorInformation,
      _token: Monaco.CancellationToken
    ): Promise<Monaco.languages.IColorPresentation[] | null> {
      if (!isTailwindLspInitialized()) {
        return null;
      }
      
      const filepath = getFilePathFromModel(model);
      const presentations = await getTailwindColorPresentations(
        filepath,
        {
          red: colorInfo.color.red,
          green: colorInfo.color.green,
          blue: colorInfo.color.blue,
          alpha: colorInfo.color.alpha
        },
        {
          start: {
            line: colorInfo.range.startLineNumber - 1,
            character: colorInfo.range.startColumn - 1
          },
          end: {
            line: colorInfo.range.endLineNumber - 1,
            character: colorInfo.range.endColumn - 1
          }
        }
      );
      
      if (!presentations || presentations.length === 0) {
        return null;
      }
      
      return presentations.map((pres: ColorPresentation) => {
        const result: Monaco.languages.IColorPresentation = {
          label: pres.label
        };
        
        if (pres.textEdit) {
          result.textEdit = {
            range: {
              startLineNumber: pres.textEdit.range.start.line + 1,
              startColumn: pres.textEdit.range.start.character + 1,
              endLineNumber: pres.textEdit.range.end.line + 1,
              endColumn: pres.textEdit.range.end.character + 1
            },
            text: pres.textEdit.newText
          };
        }
        
        return result;
      });
    }
  };
}


/**
 * Register all Tailwind Monaco providers
 * Should be called after Monaco is loaded and Tailwind LSP is initialized
 */
export function registerTailwindMonacoProviders(): void {
  const monaco = getMonaco();
  if (!monaco) {
    return;
  }
  
  // Register providers for all Tailwind-relevant languages
  for (const language of TAILWIND_LANGUAGES) {
    // Completion provider
    const completionDisposable = monaco.languages.registerCompletionItemProvider(
      language,
      createCompletionProvider(monaco)
    );
    registeredDisposables.push(completionDisposable);
    
    // Hover provider
    const hoverDisposable = monaco.languages.registerHoverProvider(
      language,
      createHoverProvider()
    );
    registeredDisposables.push(hoverDisposable);
    
    // Color provider (for color swatches)
    const colorDisposable = monaco.languages.registerColorProvider(
      language,
      createColorProvider(monaco)
    );
    registeredDisposables.push(colorDisposable);
  }
  
}

/**
 * Dispose all registered providers
 */
export function disposeTailwindMonacoProviders(): void {
  for (const disposable of registeredDisposables) {
    disposable.dispose();
  }
  registeredDisposables.length = 0;
}
