/**
 * LSP Services - Monaco Editor Language Intelligence
 * 
 * Provides language features through Monaco's built-in workers:
 * - TypeScript/JavaScript: Autocomplete, diagnostics, hover, go to definition
 * - HTML: Autocomplete, validation, formatting
 * - CSS/SCSS/LESS: Autocomplete, validation, color picker
 * - Svelte: Custom syntax highlighting (via Monarch tokenizer)
 * 
 * Features:
 * - Autocomplete
 * - Error diagnostics
 * - Hover information
 * - Go to definition
 * - Find references
 * - Quick fixes
 * - Low-RAM mode support (single LSP at a time when RAM < 4GB)
 */

export {
  initializeLspClient,
  disposeLspClient,
  isLspInitialized,
  isLspLanguage,
  notifyFileOpened,
  notifyFileClosed,
  getActiveLanguageServices,
  isInLowRamMode,
  setEstimatedRam
} from './client';

export {
  goToDefinition,
  peekDefinition,
  goToTypeDefinition,
  goToImplementation,
  findReferences,
  peekReferences,
  triggerAutocomplete,
  triggerParameterHints,
  showHover,
  formatDocument,
  formatSelection,
  triggerRename,
  showQuickFixes,
  organizeImports,
  addMissingImports,
  navigateToPosition,
  getWordAtPosition,
  getModelMarkers,
  isTypeScriptFile
} from './typescript';

export {
  configureHtmlDefaults,
  configureCssDefaults,
  isHtmlFile,
  isCssFile,
  formatHtmlDocument,
  formatCssDocument,
  triggerAutocomplete as triggerHtmlCssAutocomplete,
  showColorPicker
} from './html-css';

export {
  SVELTE_LANGUAGE_ID,
  registerSvelteLanguage,
  isSvelteFile,
  svelteLanguageConfiguration,
  svelteMonarchTokens
} from './svelte';

// Sidecar infrastructure for real language servers
export {
  // Types
  type LspServerConfig,
  type LspServerInfo,
  type LspServerType,
  type LspServerStatus,
  type JsonRpcMessage,
  type MessageHandler,
  type ErrorHandler,
  type ExitHandler,
  // Transport
  LspTransport,
  createTransport,
  listServers,
  getServerInfo,
  isServerRunning,
  stopAllServers,
  // Registry
  getLspRegistry,
  initLspRegistry,
  disposeLspRegistry,
} from './sidecar';

// TypeScript LSP Sidecar (real language server)
export {
  isTsJsFile,
  notifyDocumentOpened,
  notifyDocumentChanged,
  notifyDocumentSaved,
  notifyDocumentClosed,
  getCompletions,
  getHover,
  getDefinition,
  getReferences,
  getSignatureHelp,
  formatDocument as formatTsDocument,
  getCodeActions,
  prepareRename,
  executeRename,
  isTsLspInitialized,
  isTsLspConnected,
  stopTsLsp,
  restartTsLsp,
  type CompletionItem as TsCompletionItem,
  type HoverResult as TsHoverResult,
  type Location as TsLocation,
  type SignatureHelp as TsSignatureHelp,
  type TextEdit as TsTextEdit,
  type CodeAction as TsCodeAction,
  type WorkspaceEdit as TsWorkspaceEdit,
} from './typescript-sidecar';

// TypeScript Monaco Providers (connects Monaco to the sidecar)
export {
  registerTsMonacoProviders,
  disposeTsMonacoProviders
} from './typescript-monaco-providers';

// Tailwind CSS LSP Sidecar (real language server)
export {
  isTailwindFile,
  notifyTailwindDocumentOpened,
  notifyTailwindDocumentChanged,
  notifyTailwindDocumentSaved,
  notifyTailwindDocumentClosed,
  getTailwindCompletions,
  getTailwindHover,
  getTailwindDocumentColors,
  getTailwindColorPresentations,
  isTailwindLspInitialized,
  isTailwindLspConnected,
  stopTailwindLsp,
  restartTailwindLsp,
  type CompletionItem as TailwindCompletionItem,
  type HoverResult as TailwindHoverResult,
  type TextEdit as TailwindTextEdit,
  type ColorInformation as TailwindColorInformation,
  type ColorPresentation as TailwindColorPresentation,
} from './tailwind-sidecar';

// Tailwind Monaco Providers (connects Monaco to the sidecar)
export {
  registerTailwindMonacoProviders,
  disposeTailwindMonacoProviders
} from './tailwind-monaco-providers';

// ESLint LSP Sidecar (real language server for linting)
export {
  isEslintFile,
  notifyEslintDocumentOpened,
  notifyEslintDocumentChanged,
  notifyEslintDocumentSaved,
  notifyEslintDocumentClosed,
  getEslintCodeActions,
  executeEslintFixAll,
  isEslintLspInitialized,
  isEslintLspConnected,
  stopEslintLsp,
  restartEslintLsp,
  pushEslintConfig,
  type CodeAction as EslintCodeAction,
  type WorkspaceEdit as EslintWorkspaceEdit,
  type TextEdit as EslintTextEdit,
} from './eslint-sidecar';

// Svelte LSP Sidecar (real language server for Svelte files)
export {
  isSvelteFile as isSvelteLspFile,
  notifySvelteDocumentOpened,
  notifySvelteDocumentChanged,
  notifySvelteDocumentSaved,
  notifySvelteDocumentClosed,
  getSvelteCompletions,
  getSvelteHover,
  getSvelteDefinition,
  getSvelteReferences,
  getSvelteSignatureHelp,
  formatSvelteDocument,
  getSvelteCodeActions,
  isSvelteLspInitialized,
  isSvelteLspConnected,
  stopSvelteLsp,
  restartSvelteLsp,
  type CompletionItem as SvelteCompletionItem,
  type HoverResult as SvelteHoverResult,
  type Location as SvelteLocation,
  type SignatureHelp as SvelteSignatureHelp,
  type TextEdit as SvelteTextEdit,
  type CodeAction as SvelteCodeAction,
  type WorkspaceEdit as SvelteWorkspaceEdit,
} from './svelte-sidecar';

// Svelte Monaco Providers (connects Monaco to the Svelte sidecar)
export {
  registerSvelteMonacoProviders,
  disposeSvelteMonacoProviders
} from './svelte-monaco-providers';

// Dart LSP Sidecar (real language server for Dart/Flutter)
export {
  isDartFile,
  isDartLspRunning,
  notifyDocumentOpened as notifyDartDocumentOpened,
  notifyDocumentChanged as notifyDartDocumentChanged,
  notifyDocumentSaved as notifyDartDocumentSaved,
  notifyDocumentClosed as notifyDartDocumentClosed,
  getCompletions as getDartCompletions,
  getHover as getDartHover,
  goToDefinition as getDartDefinition,
  findReferences as getDartReferences,
  renameSymbol as renameDartSymbol,
  getCodeActions as getDartCodeActions,
  formatDocument as formatDartDocument,
  getWorkspaceSymbols as getDartWorkspaceSymbols,
  checkDartSdkAvailable,
  stopDartLsp,
  restartDartLsp,
} from './dart-sidecar';
