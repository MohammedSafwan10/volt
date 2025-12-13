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
