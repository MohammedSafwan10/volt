/**
 * Browser AI Tool Handlers
 * These tools allow the AI to access browser devtools data for debugging assistance
 */

import { browserDevToolsStore } from '$lib/stores/browser-devtools.svelte';
import { browserStore } from '$lib/stores/browser.svelte';
import { invoke } from '@tauri-apps/api/core';

// ============================================================================
// Tool: browser_get_console_logs
// ============================================================================

export interface GetConsoleLogsParams {
  limit?: number;
  level?: 'log' | 'info' | 'warn' | 'error' | 'debug';
  since_minutes?: number;
}

export interface GetConsoleLogsResult {
  logs: Array<{
    level: string;
    message: string;
    source?: string;
    line?: number;
    timestamp: number;
  }>;
  total_count: number;
  error_count: number;
  warning_count: number;
}

export async function browser_get_console_logs(params: GetConsoleLogsParams): Promise<GetConsoleLogsResult> {
  const since = params.since_minutes 
    ? Date.now() - (params.since_minutes * 60 * 1000)
    : undefined;

  const logs = browserDevToolsStore.getLogsForAI({
    limit: params.limit || 50,
    level: params.level,
    since,
  });

  return {
    logs: logs.map(l => ({
      level: l.level,
      message: l.message,
      source: l.source,
      line: l.line,
      timestamp: l.timestamp,
    })),
    total_count: browserDevToolsStore.consoleLogs.length,
    error_count: browserDevToolsStore.errorCount,
    warning_count: browserDevToolsStore.warningCount,
  };
}

// ============================================================================
// Tool: browser_get_errors
// ============================================================================

export interface GetErrorsParams {
  limit?: number;
  include_console_errors?: boolean;
}

export interface GetErrorsResult {
  errors: Array<{
    message: string;
    filename?: string;
    line?: number;
    column?: number;
    stack?: string;
    type: string;
    timestamp: number;
  }>;
  total_count: number;
}

export async function browser_get_errors(params: GetErrorsParams): Promise<GetErrorsResult> {
  const jsErrors = browserDevToolsStore.getErrorsForAI({ limit: params.limit || 20 });
  
  let allErrors: GetErrorsResult['errors'] = jsErrors.map(e => ({
    message: e.message,
    filename: e.filename,
    line: e.lineno,
    column: e.colno,
    stack: e.stack,
    type: e.type as string,
    timestamp: e.timestamp,
  }));

  // Optionally include console.error logs
  if (params.include_console_errors !== false) {
    const consoleErrors = browserDevToolsStore.consoleLogs
      .filter(l => l.level === 'error')
      .slice(-(params.limit || 20))
      .map(l => ({
        message: l.message,
        filename: l.source,
        line: l.line,
        column: l.column,
        stack: l.stack,
        type: 'console.error' as string,
        timestamp: l.timestamp,
      }));
    
    allErrors = [...allErrors, ...consoleErrors]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, params.limit || 20);
  }

  return {
    errors: allErrors,
    total_count: browserDevToolsStore.errors.length + browserDevToolsStore.errorCount,
  };
}

// ============================================================================
// Tool: browser_get_network_requests
// ============================================================================

export interface GetNetworkRequestsParams {
  limit?: number;
  method?: string;
  status?: number;
  failed_only?: boolean;
  url_contains?: string;
}

export interface GetNetworkRequestsResult {
  requests: Array<{
    method: string;
    url: string;
    status?: number;
    status_text?: string;
    duration?: number;
    size?: number;
    error?: string;
    timestamp: number;
  }>;
  total_count: number;
  failed_count: number;
}

export async function browser_get_network_requests(params: GetNetworkRequestsParams): Promise<GetNetworkRequestsResult> {
  let requests = browserDevToolsStore.getNetworkForAI({
    limit: params.limit || 50,
    method: params.method,
    status: params.status,
    failed: params.failed_only,
  });

  // Filter by URL if specified
  if (params.url_contains) {
    const pattern = params.url_contains.toLowerCase();
    requests = requests.filter(r => r.url.toLowerCase().includes(pattern));
  }

  return {
    requests: requests.map(r => ({
      method: r.method,
      url: r.url,
      status: r.status,
      status_text: r.statusText,
      duration: r.duration,
      size: r.size,
      error: r.error,
      timestamp: r.timestamp,
    })),
    total_count: browserDevToolsStore.networkRequests.length,
    failed_count: browserDevToolsStore.failedRequestCount,
  };
}

// ============================================================================
// Tool: browser_get_network_request_details
// ============================================================================

export interface GetNetworkRequestDetailsParams {
  request_id: string;
}

export interface GetNetworkRequestDetailsResult {
  found: boolean;
  request?: {
    id: string;
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
    status?: number;
    status_text?: string;
    response_headers?: Record<string, string>;
    response_body?: string;
    duration?: number;
    size?: number;
    error?: string;
    timestamp: number;
  };
}

export async function browser_get_network_request_details(params: GetNetworkRequestDetailsParams): Promise<GetNetworkRequestDetailsResult> {
  const request = browserDevToolsStore.networkRequests.find(r => r.id === params.request_id);
  
  if (!request) {
    return { found: false };
  }

  return {
    found: true,
    request: {
      id: request.id,
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body,
      status: request.status,
      status_text: request.statusText,
      response_headers: request.responseHeaders,
      response_body: request.responseBody,
      duration: request.duration,
      size: request.size,
      error: request.error,
      timestamp: request.timestamp,
    },
  };
}

// ============================================================================
// Tool: browser_get_performance
// ============================================================================

export interface GetPerformanceResult {
  metrics: {
    dom_content_loaded?: number;
    load_complete?: number;
    first_paint?: number;
    first_contentful_paint?: number;
    largest_contentful_paint?: number;
    total_resources?: number;
    total_size?: number;
    js_heap_size?: number;
  } | null;
  has_data: boolean;
}

export async function browser_get_performance(): Promise<GetPerformanceResult> {
  const perf = browserDevToolsStore.performance;
  
  if (!perf) {
    return { metrics: null, has_data: false };
  }

  return {
    metrics: {
      dom_content_loaded: perf.domContentLoaded,
      load_complete: perf.loadComplete,
      first_paint: perf.firstPaint,
      first_contentful_paint: perf.firstContentfulPaint,
      largest_contentful_paint: perf.largestContentfulPaint,
      total_resources: perf.totalResources,
      total_size: perf.totalSize,
      js_heap_size: perf.jsHeapSize,
    },
    has_data: true,
  };
}

// ============================================================================
// Tool: browser_get_selected_element
// ============================================================================

export interface GetSelectedElementResult {
  has_selection: boolean;
  element?: {
    tag_name: string;
    id: string;
    classes: string[];
    html: string;
    css: Record<string, string>;
    selector: string;
    xpath: string;
    rect: { x: number; y: number; width: number; height: number };
  };
}

export async function browser_get_selected_element(): Promise<GetSelectedElementResult> {
  const element = browserStore.selectedElement;
  
  if (!element) {
    return { has_selection: false };
  }

  return {
    has_selection: true,
    element: {
      tag_name: element.tagName,
      id: element.id,
      classes: element.classes,
      html: element.html,
      css: element.css,
      selector: element.selector,
      xpath: element.xpath,
      rect: element.rect,
    },
  };
}

// ============================================================================
// Tool: browser_get_summary
// ============================================================================

export interface GetBrowserSummaryResult {
  is_open: boolean;
  url: string;
  console: {
    total_logs: number;
    errors: number;
    warnings: number;
  };
  network: {
    total_requests: number;
    failed_requests: number;
  };
  has_selected_element: boolean;
  recent_errors: Array<{
    message: string;
    source?: string;
  }>;
}

export async function browser_get_summary(): Promise<GetBrowserSummaryResult> {
  const summary = browserDevToolsStore.getSummaryForAI();
  
  return {
    is_open: browserStore.isOpen,
    url: browserStore.url,
    console: {
      total_logs: summary.consoleLogCount,
      errors: summary.errorCount,
      warnings: summary.warningCount,
    },
    network: {
      total_requests: summary.networkRequestCount,
      failed_requests: summary.failedRequestCount,
    },
    has_selected_element: !!browserStore.selectedElement,
    recent_errors: summary.recentErrors.map(e => ({
      message: e.message,
      source: e.filename,
    })),
  };
}

// ============================================================================
// Tool: browser_screenshot
// ============================================================================

export interface ScreenshotParams {
  selector?: string;  // Optional: screenshot specific element
  full_page?: boolean;
}

export interface ScreenshotResult {
  success: boolean;
  image_base64?: string;
  error?: string;
}

export async function browser_screenshot(params: ScreenshotParams): Promise<ScreenshotResult> {
  try {
    // Use CDP for screenshots (more reliable)
    if (params.selector) {
      const result = await invoke<{ data: string; format: string }>('cdp_screenshot_element', {
        selector: params.selector,
      });
      return {
        success: true,
        image_base64: result.data,
      };
    } else {
      const result = await invoke<{ data: string; format: string }>('cdp_screenshot', {
        fullPage: params.full_page || false,
      });
      return {
        success: true,
        image_base64: result.data,
      };
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================================
// Tool: browser_navigate
// ============================================================================

export interface NavigateParams {
  url: string;
}

export interface NavigateResult {
  success: boolean;
  url: string;
  error?: string;
}

export async function browser_navigate(params: NavigateParams): Promise<NavigateResult> {
  try {
    await browserStore.navigate(params.url);
    return {
      success: true,
      url: browserStore.url,
    };
  } catch (err) {
    return {
      success: false,
      url: params.url,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================================
// Tool: browser_click (CDP)
// ============================================================================

export interface ClickParams {
  selector: string;
}

export interface ClickResult {
  success: boolean;
  element_found: boolean;
  error?: string;
}

export async function browser_click(params: ClickParams): Promise<ClickResult> {
  try {
    // Use CDP for clicking (more reliable than JS injection)
    const result = await invoke<{ success: boolean; element_found: boolean; error?: string }>('cdp_click', {
      selector: params.selector,
    });
    return result;
  } catch (err) {
    return {
      success: false,
      element_found: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================================
// Tool: browser_type (CDP)
// ============================================================================

export interface TypeParams {
  selector?: string;  // Optional: focus element first
  text: string;
}

export interface TypeResult {
  success: boolean;
  error?: string;
}

export async function browser_type(params: TypeParams): Promise<TypeResult> {
  try {
    // Use CDP for typing (more reliable than JS injection)
    const result = await invoke<{ success: boolean; error?: string }>('cdp_type', {
      text: params.text,
      selector: params.selector,
    });
    return result;
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================================
// Tool: browser_get_element (CDP)
// ============================================================================

export interface GetElementParams {
  selector: string;
}

export interface GetElementResult {
  found: boolean;
  element?: {
    tag_name: string;
    id?: string;
    classes: string[];
    outer_html?: string;
    inner_text?: string;
    rect?: { x: number; y: number; width: number; height: number };
    selector: string;
  };
  error?: string;
}

export async function browser_get_element(params: GetElementParams): Promise<GetElementResult> {
  try {
    const result = await invoke<{
      tag_name: string;
      id?: string;
      classes: string[];
      outer_html?: string;
      inner_text?: string;
      rect?: { x: number; y: number; width: number; height: number };
      selector: string;
    } | null>('cdp_get_element', { selector: params.selector });
    
    if (!result) {
      return { found: false };
    }
    
    return {
      found: true,
      element: {
        tag_name: result.tag_name,
        id: result.id,
        classes: result.classes,
        outer_html: result.outer_html,
        inner_text: result.inner_text,
        rect: result.rect,
        selector: result.selector,
      },
    };
  } catch (err) {
    return {
      found: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================================
// Tool: browser_get_elements (CDP)
// ============================================================================

export interface GetElementsParams {
  selector: string;
  limit?: number;
}

export interface GetElementsResult {
  count: number;
  elements: Array<{
    tag_name: string;
    id?: string;
    classes: string[];
    inner_text?: string;
  }>;
  error?: string;
}

export async function browser_get_elements(params: GetElementsParams): Promise<GetElementsResult> {
  try {
    const result = await invoke<Array<{
      tag_name: string;
      id?: string;
      classes: string[];
      inner_text?: string;
    }>>('cdp_get_elements', { 
      selector: params.selector,
      limit: params.limit || 10,
    });
    
    return {
      count: result.length,
      elements: result,
    };
  } catch (err) {
    return {
      count: 0,
      elements: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================================
// Tool: browser_evaluate (CDP)
// ============================================================================

export interface EvaluateParams {
  expression: string;
}

export interface EvaluateResult {
  success: boolean;
  value?: unknown;
  error?: string;
}

export async function browser_evaluate(params: EvaluateParams): Promise<EvaluateResult> {
  try {
    const result = await invoke<{ success: boolean; value: unknown; error?: string }>('cdp_evaluate', {
      expression: params.expression,
    });
    return result;
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================================
// Tool: browser_scroll (CDP)
// ============================================================================

export interface ScrollParams {
  selector?: string;  // Scroll to element
  x?: number;         // Or scroll by x pixels
  y?: number;         // Or scroll by y pixels
}

export interface ScrollResult {
  success: boolean;
  error?: string;
}

export async function browser_scroll(params: ScrollParams): Promise<ScrollResult> {
  try {
    if (params.selector) {
      await invoke('cdp_scroll_to_element', { selector: params.selector });
    } else {
      await invoke('cdp_scroll_by', { x: params.x || 0, y: params.y || 0 });
    }
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================================
// Tool: browser_wait_for (CDP)
// ============================================================================

export interface WaitForParams {
  selector: string;
  timeout_ms?: number;
}

export interface WaitForResult {
  found: boolean;
  error?: string;
}

export async function browser_wait_for(params: WaitForParams): Promise<WaitForResult> {
  try {
    const found = await invoke<boolean>('cdp_wait_for_selector', {
      selector: params.selector,
      timeoutMs: params.timeout_ms || 5000,
    });
    return { found };
  } catch (err) {
    return {
      found: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
