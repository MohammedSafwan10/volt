/**
 * Svelte Monaco Providers
 * 
 * Registers Monaco language providers that use the Svelte LSP sidecar
 * for completions, hover, definition, and other features.
 * 
 * This provides VS Code-level Svelte intelligence by using the real
 * svelte-language-server.
 */

import type * as Monaco from 'monaco-editor';
import { getMonaco } from '$core/services/monaco-loader';
import { openFileInEditor } from '$features/editor/stores/editor-entry';
import {
  getSvelteCompletions,
  getSvelteHover,
  getSvelteDefinition,
  getSvelteReferences,
  getSvelteSignatureHelp,
  isSvelteLspInitialized,
  type CompletionItem as LspCompletionItem,
  type HoverResult,
  type Location,
  type SignatureHelp
} from './svelte-sidecar';

// Track registered providers for cleanup
const registeredDisposables: Monaco.IDisposable[] = [];

// Svelte language ID
const SVELTE_LANGUAGE = 'svelte';

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
  if (!lspKind) return monaco.languages.CompletionItemKind.Text;
  
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
  
  return kindMap[lspKind] ?? monaco.languages.CompletionItemKind.Text;
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

  return {
    label: item.label,
    kind: mapCompletionKind(monaco, item.kind),
    detail: item.detail,
    documentation,
    insertText: item.insertText || item.label,
    insertTextRules: item.insertTextFormat === 2 
      ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet 
      : undefined,
    range
  };
}

/**
 * Convert LSP hover to Monaco hover
 */
function convertHover(
  _monaco: typeof Monaco,
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
 * Convert LSP file:// URI to file path
 */
function lspUriToFilePath(uri: string): string {
  let path = uri.replace('file://', '');
  // Handle Windows paths (file:///C:/...)
  if (path.match(/^\/[a-zA-Z]:/)) {
    path = path.slice(1);
  }
  // Normalize to forward slashes for consistency
  return path.replace(/\\/g, '/');
}

/**
 * Convert file path to our inmemory:// URI scheme
 * This matches the URI scheme used in monaco-models.ts
 */
function filePathToMonacoUri(monaco: typeof Monaco, filepath: string): Monaco.Uri {
  // Normalize path separators
  const normalizedPath = filepath.replace(/\\/g, '/');
  return monaco.Uri.parse(`inmemory://model/${encodeURIComponent(normalizedPath)}`);
}

/**
 * Convert LSP location to Monaco location
 * Uses our inmemory:// URI scheme so Monaco can navigate to the location
 */
function convertLocation(
  monaco: typeof Monaco,
  location: Location
): Monaco.languages.Location {
  const filepath = lspUriToFilePath(location.uri);
  
  return {
    uri: filePathToMonacoUri(monaco, filepath),
    range: {
      startLineNumber: location.range.start.line + 1,
      startColumn: location.range.start.character + 1,
      endLineNumber: location.range.end.line + 1,
      endColumn: location.range.end.character + 1
    }
  };
}

/**
 * Create completion provider for Svelte sidecar
 */
function createCompletionProvider(monaco: typeof Monaco): Monaco.languages.CompletionItemProvider {
  return {
    triggerCharacters: ['.', '"', "'", '/', '<', ':', '@', '$', '{'],
    
    async provideCompletionItems(
      model: Monaco.editor.ITextModel,
      position: Monaco.Position,
      _context: Monaco.languages.CompletionContext,
      _token: Monaco.CancellationToken
    ): Promise<Monaco.languages.CompletionList | null> {
      if (!isSvelteLspInitialized()) {
        return null;
      }
      
      const filepath = getFilePathFromModel(model);
      const line = position.lineNumber - 1; // LSP is 0-based
      const character = position.column - 1;
      
      const items = await getSvelteCompletions(filepath, line, character);
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
        incomplete: false
      };
    }
  };
}

/**
 * Create hover provider for Svelte sidecar
 */
function createHoverProvider(monaco: typeof Monaco): Monaco.languages.HoverProvider {
  return {
    async provideHover(
      model: Monaco.editor.ITextModel,
      position: Monaco.Position,
      _token: Monaco.CancellationToken
    ): Promise<Monaco.languages.Hover | null> {
      if (!isSvelteLspInitialized()) {
        return null;
      }
      
      const filepath = getFilePathFromModel(model);
      const line = position.lineNumber - 1;
      const character = position.column - 1;
      
      const hover = await getSvelteHover(filepath, line, character);
      if (!hover) {
        return null;
      }
      
      return convertHover(monaco, hover);
    }
  };
}

/**
 * Create definition provider for Svelte sidecar
 */
function createDefinitionProvider(monaco: typeof Monaco): Monaco.languages.DefinitionProvider {
  return {
    async provideDefinition(
      model: Monaco.editor.ITextModel,
      position: Monaco.Position,
      _token: Monaco.CancellationToken
    ): Promise<Monaco.languages.Definition | null> {
      if (!isSvelteLspInitialized()) {
        return null;
      }
      
      const filepath = getFilePathFromModel(model);
      const line = position.lineNumber - 1;
      const character = position.column - 1;
      
      const locations = await getSvelteDefinition(filepath, line, character);
      if (!locations || locations.length === 0) {
        return null;
      }
      
      return locations.map(loc => convertLocation(monaco, loc));
    }
  };
}

/**
 * Create references provider for Svelte sidecar
 */
function createReferencesProvider(monaco: typeof Monaco): Monaco.languages.ReferenceProvider {
  return {
    async provideReferences(
      model: Monaco.editor.ITextModel,
      position: Monaco.Position,
      context: Monaco.languages.ReferenceContext,
      _token: Monaco.CancellationToken
    ): Promise<Monaco.languages.Location[] | null> {
      if (!isSvelteLspInitialized()) {
        return null;
      }
      
      const filepath = getFilePathFromModel(model);
      const line = position.lineNumber - 1;
      const character = position.column - 1;
      
      const locations = await getSvelteReferences(filepath, line, character, context.includeDeclaration);
      if (!locations || locations.length === 0) {
        return null;
      }
      
      return locations.map(loc => convertLocation(monaco, loc));
    }
  };
}

/**
 * Create signature help provider for Svelte sidecar
 */
function createSignatureHelpProvider(monaco: typeof Monaco): Monaco.languages.SignatureHelpProvider {
  return {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [','],
    
    async provideSignatureHelp(
      model: Monaco.editor.ITextModel,
      position: Monaco.Position,
      _token: Monaco.CancellationToken,
      _context: Monaco.languages.SignatureHelpContext
    ): Promise<Monaco.languages.SignatureHelpResult | null> {
      if (!isSvelteLspInitialized()) {
        return null;
      }
      
      const filepath = getFilePathFromModel(model);
      const line = position.lineNumber - 1;
      const character = position.column - 1;
      
      const help = await getSvelteSignatureHelp(filepath, line, character);
      if (!help || help.signatures.length === 0) {
        return null;
      }
      
      const signatures: Monaco.languages.SignatureInformation[] = help.signatures.map(sig => {
        let documentation: string | Monaco.IMarkdownString | undefined;
        if (sig.documentation) {
          if (typeof sig.documentation === 'string') {
            documentation = sig.documentation;
          } else {
            documentation = { value: sig.documentation.value };
          }
        }
        
        const parameters: Monaco.languages.ParameterInformation[] = (sig.parameters || []).map(param => {
          let paramDoc: string | Monaco.IMarkdownString | undefined;
          if (param.documentation) {
            if (typeof param.documentation === 'string') {
              paramDoc = param.documentation;
            } else {
              paramDoc = { value: param.documentation.value };
            }
          }
          
          return {
            label: Array.isArray(param.label) ? param.label : param.label,
            documentation: paramDoc
          };
        });
        
        return {
          label: sig.label,
          documentation,
          parameters
        };
      });
      
      return {
        value: {
          signatures,
          activeSignature: help.activeSignature ?? 0,
          activeParameter: help.activeParameter ?? 0
        },
        dispose: () => {}
      };
    }
  };
}

/**
 * Register an editor opener to handle go-to-definition navigation for Svelte files
 * This opens files in the editor when Monaco tries to navigate to a location
 */
function registerEditorOpener(monaco: typeof Monaco): void {
  const openerDisposable = monaco.editor.registerEditorOpener({
    async openCodeEditor(
      _source: Monaco.editor.ICodeEditor,
      resource: Monaco.Uri,
      selectionOrPosition?: Monaco.IRange | Monaco.IPosition
    ): Promise<boolean> {
      // Extract file path from our inmemory:// URI
      // Format: inmemory://model/{encodedPath}
      if (resource.scheme === 'inmemory' && resource.authority === 'model') {
        const filepath = decodeURIComponent(resource.path.slice(1)); // Remove leading /
        
        // Open the file in the editor
        const opened = await openFileInEditor(filepath);
        if (!opened) {
          console.warn('[Svelte Monaco Providers] Failed to open file:', filepath);
          return false;
        }
        
        // Navigate to the position after a short delay to let the editor load
        if (selectionOrPosition) {
          setTimeout(() => {
            const line = 'startLineNumber' in selectionOrPosition 
              ? selectionOrPosition.startLineNumber 
              : selectionOrPosition.lineNumber;
            const column = 'startColumn' in selectionOrPosition 
              ? selectionOrPosition.startColumn 
              : selectionOrPosition.column;
            
            // Dispatch navigation event for the editor to handle
            window.dispatchEvent(new CustomEvent('volt:navigate-to-position', {
              detail: { file: filepath, line, column }
            }));
          }, 100);
        }
        
        // Return true to indicate we handled the navigation
        return true;
      }
      
      // For other URI schemes, return false to let Monaco handle it
      return false;
    }
  });
  
  registeredDisposables.push(openerDisposable);
  console.log('[Svelte Monaco Providers] Registered editor opener for go-to-definition');
}

/**
 * Register all Svelte Monaco providers
 * Should be called after Monaco is loaded and Svelte LSP is initialized
 */
export function registerSvelteMonacoProviders(): void {
  const monaco = getMonaco();
  if (!monaco) {
    return;
  }
  
  // Register editor opener for go-to-definition navigation
  registerEditorOpener(monaco);
  
  // Completion provider
  const completionDisposable = monaco.languages.registerCompletionItemProvider(
    SVELTE_LANGUAGE,
    createCompletionProvider(monaco)
  );
  registeredDisposables.push(completionDisposable);
  
  // Hover provider
  const hoverDisposable = monaco.languages.registerHoverProvider(
    SVELTE_LANGUAGE,
    createHoverProvider(monaco)
  );
  registeredDisposables.push(hoverDisposable);
  
  // Definition provider
  const definitionDisposable = monaco.languages.registerDefinitionProvider(
    SVELTE_LANGUAGE,
    createDefinitionProvider(monaco)
  );
  registeredDisposables.push(definitionDisposable);
  
  // References provider
  const referencesDisposable = monaco.languages.registerReferenceProvider(
    SVELTE_LANGUAGE,
    createReferencesProvider(monaco)
  );
  registeredDisposables.push(referencesDisposable);
  
  // Signature help provider
  const signatureDisposable = monaco.languages.registerSignatureHelpProvider(
    SVELTE_LANGUAGE,
    createSignatureHelpProvider(monaco)
  );
  registeredDisposables.push(signatureDisposable);
  
  console.log('[Svelte Monaco Providers] Registered providers for:', SVELTE_LANGUAGE);
}

/**
 * Dispose all registered providers
 */
export function disposeSvelteMonacoProviders(): void {
  for (const disposable of registeredDisposables) {
    disposable.dispose();
  }
  registeredDisposables.length = 0;
  console.log('[Svelte Monaco Providers] Disposed all providers');
}
