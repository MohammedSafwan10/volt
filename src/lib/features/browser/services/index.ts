/**
 * Browser Services - DevTools injection and utilities
 */

export * from './devtools-inject';
export * from './cdp';

import { invoke } from '@tauri-apps/api/core';
import { getDevToolsScript } from './devtools-inject';
import { browserStore } from '$features/browser/stores/browser.svelte';
import { browserDevToolsStore } from '$features/browser/stores/browser-devtools.svelte';
import { cdp, type CdpStatus } from './cdp';

/**
 * Inject devtools capture scripts into the browser webview
 * Should be called after the browser navigates to a new page
 */
export async function injectDevToolsScripts(): Promise<void> {
  if (!browserStore.isOpen) {
    console.warn('[Browser] Cannot inject devtools - browser not open');
    return;
  }

  try {
    const script = getDevToolsScript();
    await browserStore.executeJs(script);
    console.log('[Browser] DevTools scripts injected');
  } catch (err) {
    console.error('[Browser] Failed to inject devtools scripts:', err);
  }
}

/**
 * Initialize browser devtools - sets up event listeners and injects scripts
 * Uses CDP on Windows, falls back to JS injection on other platforms
 */
export async function initializeBrowserDevTools(): Promise<void> {
  // Check if CDP is available (Windows only for now)
  const cdpAvailable = await cdp.isAvailable();
  
  if (cdpAvailable) {
    console.log('[Browser] CDP available - using professional browser automation');
    
    // Try to auto-connect to CDP
    // This will fail if the browser isn't open yet, which is fine
    try {
      await cdp.autoConnect();
      await cdp.enableConsole();
      await cdp.enableNetwork();
      console.log('[Browser] CDP connected and monitoring enabled');
    } catch (err) {
      console.log('[Browser] CDP not ready yet - will connect when browser opens');
    }
  } else {
    console.log('[Browser] CDP not available - using JS injection fallback');
  }
  
  // Initialize the store (sets up event listeners)
  await browserDevToolsStore.initialize();
  
  console.log('[Browser] DevTools initialized');
}

/**
 * Connect CDP after browser is created
 * Should be called after browser_create succeeds
 * @param browserUrl - The URL loaded in the browser (e.g., http://localhost:3000)
 */
export async function connectCdpToBrowser(browserUrl?: string): Promise<boolean> {
  const cdpAvailable = await cdp.isAvailable();
  if (!cdpAvailable) return false;

  // Retry because WebView2/CDP endpoint can lag behind webview creation/navigation.
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      const delay = 300 * attempt;
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    try {
      const status = await cdp.getStatus();
      if (!status.connected) {
        await cdp.autoConnect(browserUrl);
      } else {
        // Already connected, but target may have changed after navigation.
        await cdp.attachToPage(browserUrl);
      }

      await cdp.enableConsole();
      await cdp.enableNetwork();
      return true;
    } catch (err) {
      // Do NOT attach without URL filter; that can bind to Volt host page
      // and leak IDE logs into browser diagnostics.
      if (attempt === maxAttempts) {
        const msg = String(err ?? '');
        if (/No page found with URL containing/i.test(msg)) {
          console.debug('[Browser] CDP target not ready for URL yet:', browserUrl);
        } else {
          console.warn('[Browser] CDP connection failed:', err);
        }
        return false;
      }
    }
  }

  return false;
}

/**
 * Cleanup browser devtools
 */
export async function cleanupBrowserDevTools(): Promise<void> {
  await browserDevToolsStore.cleanup();
}

/**
 * Clear all devtools data
 */
export function clearDevToolsData(): void {
  browserDevToolsStore.clearAll();
}

/**
 * Get a summary of browser state for AI context
 */
export function getBrowserContextForAI(): string {
  const summary = browserDevToolsStore.getSummaryForAI();
  
  let context = `Browser State:\n`;
  context += `- URL: ${browserStore.url}\n`;
  context += `- Console logs: ${summary.consoleLogCount}\n`;
  context += `- Errors: ${summary.errorCount}\n`;
  context += `- Warnings: ${summary.warningCount}\n`;
  context += `- Network requests: ${summary.networkRequestCount}\n`;
  context += `- Failed requests: ${summary.failedRequestCount}\n`;
  
  if (summary.recentErrors.length > 0) {
    context += `\nRecent Errors:\n`;
    summary.recentErrors.forEach(e => {
      context += `- ${e.message}\n`;
    });
  }
  
  if (summary.recentFailedRequests.length > 0) {
    context += `\nFailed Requests:\n`;
    summary.recentFailedRequests.forEach(r => {
      context += `- ${r.method} ${r.url} → ${r.status || 'Error'}\n`;
    });
  }
  
  if (browserStore.selectedElement) {
    const el = browserStore.selectedElement;
    context += `\nSelected Element:\n`;
    context += `- Tag: <${el.tagName}>\n`;
    context += `- Selector: ${el.selector}\n`;
    if (el.id) context += `- ID: ${el.id}\n`;
    if (el.classes.length) context += `- Classes: ${el.classes.join(', ')}\n`;
  }
  
  return context;
}
