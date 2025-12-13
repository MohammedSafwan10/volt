/**
 * Monaco Editor Lazy Loader
 * Loads Monaco only when first file opens to improve startup performance
 */

import type * as Monaco from 'monaco-editor';
import { voltDarkMonacoTheme } from '$lib/themes/dark';
import { voltLightMonacoTheme } from '$lib/themes/light';

// Singleton instance - null until first load
let monacoInstance: typeof Monaco | null = null;
let loadPromise: Promise<typeof Monaco> | null = null;

/**
 * Configure Monaco environment for Vite
 * Sets up web workers for language features
 */
function configureMonacoEnvironment(): void {
  if (typeof self === 'undefined') return;

  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      let workerUrl: string;

      switch (label) {
        case 'json':
          workerUrl = new URL(
            'monaco-editor/esm/vs/language/json/json.worker.js',
            import.meta.url
          ).href;
          break;
        case 'css':
        case 'scss':
        case 'less':
          workerUrl = new URL(
            'monaco-editor/esm/vs/language/css/css.worker.js',
            import.meta.url
          ).href;
          break;
        case 'html':
        case 'handlebars':
        case 'razor':
          workerUrl = new URL(
            'monaco-editor/esm/vs/language/html/html.worker.js',
            import.meta.url
          ).href;
          break;
        case 'typescript':
        case 'javascript':
          workerUrl = new URL(
            'monaco-editor/esm/vs/language/typescript/ts.worker.js',
            import.meta.url
          ).href;
          break;
        default:
          workerUrl = new URL(
            'monaco-editor/esm/vs/editor/editor.worker.js',
            import.meta.url
          ).href;
      }

      return new Worker(workerUrl, { type: 'module' });
    }
  };
}

/**
 * Load Monaco Editor lazily
 * Returns cached instance if already loaded
 */
export async function loadMonaco(): Promise<typeof Monaco> {
  // Return cached instance
  if (monacoInstance) {
    return monacoInstance;
  }

  // Return existing promise if load in progress
  if (loadPromise) {
    return loadPromise;
  }

  // Start loading
  loadPromise = (async () => {
    // Configure workers before importing
    configureMonacoEnvironment();

    // Dynamic import - this is where the actual loading happens
    const monaco = await import('monaco-editor');

    // Define custom themes
    monaco.editor.defineTheme('volt-dark', voltDarkMonacoTheme);
    monaco.editor.defineTheme('volt-light', voltLightMonacoTheme);

    // Cache the instance
    monacoInstance = monaco;

    return monaco;
  })();

  return loadPromise;
}

/**
 * Check if Monaco is already loaded
 */
export function isMonacoLoaded(): boolean {
  return monacoInstance !== null;
}

/**
 * Get Monaco instance if loaded (returns null if not loaded)
 */
export function getMonaco(): typeof Monaco | null {
  return monacoInstance;
}

/**
 * Detect language from file extension
 */
export function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  
  const languageMap: Record<string, string> = {
    // JavaScript/TypeScript
    'js': 'javascript',
    'mjs': 'javascript',
    'cjs': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'mts': 'typescript',
    'cts': 'typescript',
    
    // Web
    'html': 'html',
    'htm': 'html',
    'css': 'css',
    'scss': 'scss',
    'sass': 'scss',
    'less': 'less',
    
    // Data formats
    'json': 'json',
    'jsonc': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
    'xml': 'xml',
    'svg': 'xml',
    
    // Markdown
    'md': 'markdown',
    'mdx': 'markdown',
    
    // Config files
    'toml': 'ini',
    'ini': 'ini',
    'env': 'ini',
    
    // Shell
    'sh': 'shell',
    'bash': 'shell',
    'zsh': 'shell',
    'ps1': 'powershell',
    'bat': 'bat',
    'cmd': 'bat',
    
    // Other languages
    'py': 'python',
    'rs': 'rust',
    'go': 'go',
    'java': 'java',
    'c': 'c',
    'cpp': 'cpp',
    'h': 'c',
    'hpp': 'cpp',
    'cs': 'csharp',
    'php': 'php',
    'rb': 'ruby',
    'sql': 'sql',
    'graphql': 'graphql',
    'gql': 'graphql',
    
    // Svelte/Vue
    'svelte': 'svelte',
    'vue': 'html'
  };

  return languageMap[ext] || 'plaintext';
}
