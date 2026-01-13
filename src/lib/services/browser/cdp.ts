/**
 * CDP (Chrome DevTools Protocol) Client
 * 
 * TypeScript client for interacting with the Rust CDP backend.
 * Provides professional browser automation capabilities similar to Playwright/Puppeteer.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// =============================================================================
// Types
// =============================================================================

export interface CdpStatus {
  connected: boolean;
  ws_url: string | null;
  target_id: string | null;
  error: string | null;
  available: boolean;
}

export interface CdpConsoleLog {
  level: string;
  message: string;
  args: string[];
  source: string | null;
  line: number | null;
  column: number | null;
  stack: string | null;
  timestamp: number;
}

export interface CdpJsError {
  message: string;
  description: string | null;
  url: string | null;
  line: number | null;
  column: number | null;
  stack: string | null;
  error_type: string | null;
  timestamp: number;
}

export interface CdpNetworkRequest {
  id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  resource_type: string | null;
  initiator: string | null;
  timestamp: number;
}

export interface CdpNetworkResponse {
  id: string;
  status: number;
  status_text: string;
  headers: Record<string, string>;
  mime_type: string | null;
  body: string | null;
  size: number | null;
  duration: number | null;
  from_cache: boolean;
  timestamp: number;
}

export interface CdpElement {
  node_id: number;
  backend_node_id: number | null;
  tag_name: string;
  id: string | null;
  classes: string[];
  attributes: Record<string, string>;
  outer_html: string | null;
  inner_text: string | null;
  computed_styles: Record<string, string>;
  rect: CdpRect | null;
  selector: string;
  xpath: string;
}

export interface CdpRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CdpPerformanceMetrics {
  dom_content_loaded: number | null;
  load_complete: number | null;
  first_paint: number | null;
  first_contentful_paint: number | null;
  largest_contentful_paint: number | null;
  time_to_first_byte: number | null;
  dom_nodes: number | null;
  js_heap_size: number | null;
  js_heap_used: number | null;
  documents: number | null;
  frames: number | null;
  js_event_listeners: number | null;
  layout_count: number | null;
  style_recalc_count: number | null;
  timestamp: number;
}

export interface CdpScreenshot {
  data: string;
  format: string;
  width: number;
  height: number;
}

export interface CdpClickResult {
  success: boolean;
  element_found: boolean;
  selector: string;
  error: string | null;
}

export interface CdpTypeResult {
  success: boolean;
  text: string;
  error: string | null;
}

export interface CdpEvaluateResult {
  success: boolean;
  value: unknown;
  error: string | null;
}

// =============================================================================
// CDP Client
// =============================================================================

class CdpClient {
  private unlisteners: UnlistenFn[] = [];

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  /** Check if CDP is available on this platform */
  async isAvailable(): Promise<boolean> {
    return invoke<boolean>('cdp_is_available');
  }

  /** Get current CDP connection status */
  async getStatus(): Promise<CdpStatus> {
    return invoke<CdpStatus>('cdp_get_status');
  }

  /** Discover CDP WebSocket URL from the debug endpoint */
  async discoverUrl(): Promise<string> {
    return invoke<string>('cdp_discover_url');
  }

  /** Connect to CDP endpoint */
  async connect(wsUrl: string): Promise<void> {
    return invoke('cdp_connect', { wsUrl });
  }

  /** Auto-connect to CDP - discovers URL and connects */
  async autoConnect(targetUrl?: string): Promise<void> {
    const wsUrl = await this.discoverUrl();
    await this.connect(wsUrl);
    await this.attachToPage(targetUrl);
  }

  /** Disconnect from CDP */
  async disconnect(): Promise<void> {
    return invoke('cdp_disconnect');
  }

  /** Attach to a page/target */
  async attachToPage(targetId?: string): Promise<void> {
    return invoke('cdp_attach_to_page', { targetId });
  }

  // ---------------------------------------------------------------------------
  // Event Subscriptions
  // ---------------------------------------------------------------------------

  /** Enable console logging */
  async enableConsole(): Promise<void> {
    return invoke('cdp_enable_console');
  }

  /** Enable network monitoring */
  async enableNetwork(): Promise<void> {
    return invoke('cdp_enable_network');
  }

  /** Subscribe to console events */
  async onConsole(callback: (log: CdpConsoleLog) => void): Promise<UnlistenFn> {
    const unlisten = await listen<CdpConsoleLog>('cdp://console', (event) => {
      callback(event.payload);
    });
    this.unlisteners.push(unlisten);
    return unlisten;
  }

  /** Subscribe to error events */
  async onError(callback: (error: CdpJsError) => void): Promise<UnlistenFn> {
    const unlisten = await listen<CdpJsError>('cdp://error', (event) => {
      callback(event.payload);
    });
    this.unlisteners.push(unlisten);
    return unlisten;
  }

  /** Subscribe to network request events */
  async onNetworkRequest(callback: (request: CdpNetworkRequest) => void): Promise<UnlistenFn> {
    const unlisten = await listen<CdpNetworkRequest>('cdp://network-request', (event) => {
      callback(event.payload);
    });
    this.unlisteners.push(unlisten);
    return unlisten;
  }

  /** Subscribe to network response events */
  async onNetworkResponse(callback: (response: CdpNetworkResponse) => void): Promise<UnlistenFn> {
    const unlisten = await listen<CdpNetworkResponse>('cdp://network-response', (event) => {
      callback(event.payload);
    });
    this.unlisteners.push(unlisten);
    return unlisten;
  }

  // ---------------------------------------------------------------------------
  // Data Retrieval
  // ---------------------------------------------------------------------------

  /** Get buffered console logs */
  async getConsoleLogs(limit?: number): Promise<CdpConsoleLog[]> {
    return invoke<CdpConsoleLog[]>('cdp_get_console_logs', { limit });
  }

  /** Get buffered JS errors */
  async getJsErrors(limit?: number): Promise<CdpJsError[]> {
    return invoke<CdpJsError[]>('cdp_get_js_errors', { limit });
  }

  /** Get buffered network requests */
  async getNetworkRequests(limit?: number): Promise<CdpNetworkRequest[]> {
    return invoke<CdpNetworkRequest[]>('cdp_get_network_requests', { limit });
  }

  /** Clear console logs buffer */
  async clearConsole(): Promise<void> {
    return invoke('cdp_clear_console');
  }

  /** Clear JS errors buffer */
  async clearErrors(): Promise<void> {
    return invoke('cdp_clear_errors');
  }

  /** Clear network buffer */
  async clearNetwork(): Promise<void> {
    return invoke('cdp_clear_network');
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  /** Navigate to URL */
  async navigate(url: string): Promise<void> {
    return invoke('cdp_navigate', { url });
  }

  /** Get current URL */
  async getUrl(): Promise<string> {
    return invoke<string>('cdp_get_url');
  }

  /** Get page title */
  async getTitle(): Promise<string> {
    return invoke<string>('cdp_get_title');
  }

  /** Get page HTML content */
  async getContent(): Promise<string> {
    return invoke<string>('cdp_get_content');
  }

  // ---------------------------------------------------------------------------
  // Automation
  // ---------------------------------------------------------------------------

  /** Click an element by selector */
  async click(selector: string): Promise<CdpClickResult> {
    return invoke<CdpClickResult>('cdp_click', { selector });
  }

  /** Type text into an element */
  async type(text: string, selector?: string): Promise<CdpTypeResult> {
    return invoke<CdpTypeResult>('cdp_type', { text, selector });
  }

  /** Press a key */
  async pressKey(key: string): Promise<void> {
    return invoke('cdp_press_key', { key });
  }

  /** Evaluate JavaScript */
  async evaluate(expression: string): Promise<CdpEvaluateResult> {
    return invoke<CdpEvaluateResult>('cdp_evaluate', { expression });
  }

  // ---------------------------------------------------------------------------
  // Screenshots
  // ---------------------------------------------------------------------------

  /** Take a screenshot of the page */
  async screenshot(fullPage?: boolean): Promise<CdpScreenshot> {
    return invoke<CdpScreenshot>('cdp_screenshot', { fullPage });
  }

  /** Take a screenshot of an element */
  async screenshotElement(selector: string): Promise<CdpScreenshot> {
    return invoke<CdpScreenshot>('cdp_screenshot_element', { selector });
  }

  // ---------------------------------------------------------------------------
  // Elements
  // ---------------------------------------------------------------------------

  /** Get element information by selector */
  async getElement(selector: string): Promise<CdpElement | null> {
    return invoke<CdpElement | null>('cdp_get_element', { selector });
  }

  /** Get multiple elements by selector */
  async getElements(selector: string, limit?: number): Promise<CdpElement[]> {
    return invoke<CdpElement[]>('cdp_get_elements', { selector, limit });
  }

  /** Wait for an element to appear */
  async waitForSelector(selector: string, timeoutMs?: number): Promise<boolean> {
    return invoke<boolean>('cdp_wait_for_selector', { selector, timeoutMs });
  }

  /** Scroll to an element */
  async scrollToElement(selector: string): Promise<void> {
    return invoke('cdp_scroll_to_element', { selector });
  }

  /** Scroll the page */
  async scrollBy(x: number, y: number): Promise<void> {
    return invoke('cdp_scroll_by', { x, y });
  }

  // ---------------------------------------------------------------------------
  // Performance
  // ---------------------------------------------------------------------------

  /** Get performance metrics */
  async getPerformance(): Promise<CdpPerformanceMetrics> {
    return invoke<CdpPerformanceMetrics>('cdp_get_performance');
  }

  // ---------------------------------------------------------------------------
  // Viewport
  // ---------------------------------------------------------------------------

  /** Set viewport size */
  async setViewport(width: number, height: number): Promise<void> {
    return invoke('cdp_set_viewport', { width, height });
  }

  /** Emulate a mobile device */
  async emulateDevice(device: string): Promise<void> {
    return invoke('cdp_emulate_device', { device });
  }

  // ---------------------------------------------------------------------------
  // Element Picker
  // ---------------------------------------------------------------------------

  /** Enable element picker mode (highlight on hover, capture on click) */
  async enableElementPicker(): Promise<void> {
    return invoke('cdp_enable_element_picker');
  }

  /** Disable element picker mode */
  async disableElementPicker(): Promise<void> {
    return invoke('cdp_disable_element_picker');
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  /** Cleanup all event listeners */
  cleanup(): void {
    this.unlisteners.forEach(unlisten => unlisten());
    this.unlisteners = [];
  }
}

// Export singleton instance
export const cdp = new CdpClient();
