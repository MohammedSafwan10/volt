/**
 * Browser AI Tool Handlers
 * These tools allow the AI to access browser devtools data for debugging assistance
 */

import { browserDevToolsStore } from '$lib/stores/browser-devtools.svelte';
import { browserStore } from '$lib/stores/browser.svelte';
import { invoke } from '@tauri-apps/api/core';

let devtoolsInitialized = false;
const knownNetworkRequestIds = new Set<string>();

async function ensureBrowserTelemetryReady(): Promise<void> {
  if (devtoolsInitialized) return;
  await browserDevToolsStore.initialize();
  devtoolsInitialized = true;
}

async function ensureCdpReady(): Promise<{ ok: boolean; error?: string }> {
  if (!browserStore.isOpen) {
    return { ok: false, error: 'Browser is not open. Run browser_navigate first.' };
  }

  try {
    if (!browserStore.isVisible) {
      await browserStore.setVisible(true);
    }

    const { cdp } = await import('$lib/services/browser/cdp');
    const status = await cdp.getStatus();
    if (status.connected) {
      return { ok: true };
    }

    const { connectCdpToBrowser } = await import('$lib/services/browser');
    const connected = await connectCdpToBrowser(browserStore.url);
    if (!connected) {
      return {
        ok: false,
        error: 'CDP is not connected to the browser page. Open browser panel and navigate once, then retry.',
      };
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function getLiveBrowserUrl(): Promise<string> {
  if (!browserStore.isOpen) return browserStore.url;
  try {
    const { cdp } = await import('$lib/services/browser/cdp');
    const status = await cdp.getStatus();
    if (status.connected) {
      const liveUrl = await cdp.getUrl();
      if (typeof liveUrl === 'string' && liveUrl.trim().length > 0) {
        return liveUrl;
      }
    }
  } catch {
    // Fall back to store URL
  }
  return browserStore.url;
}

type GuidedBrowserActionType =
  | 'reload_page'
  | 'clear_console'
  | 'clear_network'
  | 'clear_performance'
  | 'capture_screenshot'
  | 'summarize_failures';

interface GuidedBrowserAction {
  id: string;
  type: GuidedBrowserActionType;
  label: string;
  reason: string;
  risk: 'low' | 'medium';
}

const GUIDED_ACTION_TTL_MS = 2 * 60 * 1000;
const guidedActionCache = new Map<string, { action: GuidedBrowserAction; expiresAt: number }>();

function makeActionId(type: GuidedBrowserActionType): string {
  return `browser_action:${type}:${crypto.randomUUID().slice(0, 8)}`;
}

function cacheGuidedActions(actions: GuidedBrowserAction[]): void {
  const expiresAt = Date.now() + GUIDED_ACTION_TTL_MS;
  for (const action of actions) {
    guidedActionCache.set(action.id, { action, expiresAt });
  }
}

function getGuidedAction(actionId: string): GuidedBrowserAction | null {
  const entry = guidedActionCache.get(actionId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    guidedActionCache.delete(actionId);
    return null;
  }
  return entry.action;
}

const actionApprovalTokens = new Map<string, { actionId: string; expiresAt: number }>();
const ACTION_APPROVAL_TTL_MS = 60 * 1000;

function purgeExpiredGuidedCaches(): void {
  const now = Date.now();
  for (const [id, entry] of guidedActionCache) {
    if (entry.expiresAt < now) {
      guidedActionCache.delete(id);
    }
  }
  for (const [token, entry] of actionApprovalTokens) {
    if (entry.expiresAt < now) {
      actionApprovalTokens.delete(token);
    }
  }
}

function issueApprovalToken(actionId: string): string {
  const token = crypto.randomUUID();
  actionApprovalTokens.set(token, {
    actionId,
    expiresAt: Date.now() + ACTION_APPROVAL_TTL_MS,
  });
  return token;
}

function consumeApprovalToken(actionId: string, token: string): boolean {
  const entry = actionApprovalTokens.get(token);
  if (!entry) return false;
  actionApprovalTokens.delete(token);
  return entry.actionId === actionId && entry.expiresAt >= Date.now();
}

// ============================================================================
// Tool: browser_get_console_logs
// ============================================================================

export interface GetConsoleLogsParams {
  limit?: number;
  level?: 'log' | 'info' | 'warn' | 'error' | 'debug';
  since_minutes?: number;
}

export interface GetConsoleLogsResult {
  success: boolean;
  data: {
    logs: Array<{
      level: string;
      message: string;
      source?: string;
      line?: number;
      timestamp: number;
    }>;
  };
  meta: {
    total: number;
    window: string;
    truncated: boolean;
    error_count: number;
    warning_count: number;
  };
  warnings?: string[];
}

export async function browser_get_console_logs(params: GetConsoleLogsParams): Promise<GetConsoleLogsResult> {
  await ensureBrowserTelemetryReady();
  const since = params.since_minutes 
    ? Date.now() - (params.since_minutes * 60 * 1000)
    : undefined;

  const filteredAll = browserDevToolsStore.getLogsForAI({
    level: params.level,
    since,
  });
  const logs = browserDevToolsStore.getLogsForAI({
    limit: params.limit || 50,
    level: params.level,
    since,
  });

  return {
    success: true,
    data: {
      logs: logs.map(l => ({
        level: l.level,
        message: l.message,
        source: l.source,
        line: l.line,
        timestamp: l.timestamp,
      })),
    },
    meta: {
      total: filteredAll.length,
      window: params.since_minutes ? `${params.since_minutes}m` : 'session',
      truncated: logs.length < filteredAll.length,
      error_count: filteredAll.filter((log) => log.level === 'error').length,
      warning_count: filteredAll.filter((log) => log.level === 'warn').length,
    },
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
  success: boolean;
  data: {
    errors: Array<{
      message: string;
      filename?: string;
      line?: number;
      column?: number;
      stack?: string;
      type: string;
      timestamp: number;
    }>;
  };
  meta: {
    total: number;
    window: string;
    truncated: boolean;
  };
  warnings?: string[];
}

export async function browser_get_errors(params: GetErrorsParams): Promise<GetErrorsResult> {
  await ensureBrowserTelemetryReady();
  const jsErrors = browserDevToolsStore.getErrorsForAI({ limit: params.limit || 20 });

  type BrowserErrorItem = GetErrorsResult['data']['errors'][number];
  let allErrors: BrowserErrorItem[] = jsErrors.map(e => ({
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
    const consoleErrors = browserDevToolsStore
      .getLogsForAI({ level: 'error', limit: params.limit || 20 })
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
    success: true,
    data: {
      errors: allErrors,
    },
    meta: {
      total: allErrors.length,
      window: 'session',
      truncated: allErrors.length === (params.limit || 20),
    },
  };
}

// ============================================================================
// Tool: browser_get_network_requests
// ============================================================================

export interface GetNetworkRequestsParams {
  limit?: number;
  offset?: number;
  method?: string;
  method_in?: string[];
  status?: number;
  status_in?: number[];
  failed_only?: boolean;
  only_errors?: boolean;
  url_contains?: string;
  min_duration_ms?: number;
  sort_by?: 'timestamp' | 'duration' | 'status' | 'size';
  sort_order?: 'asc' | 'desc';
}

export interface GetNetworkRequestsResult {
  success: boolean;
  data: {
    requests: Array<{
      id: string;
      method: string;
      url: string;
      resource_type?: string;
      status?: number;
      status_text?: string;
      duration?: number;
      size?: number;
      error?: string;
      timestamp: number;
    }>;
  };
  meta: {
    total: number;
    window: string;
    truncated: boolean;
    failed_count: number;
  };
  warnings?: string[];
}

export async function browser_get_network_requests(params: GetNetworkRequestsParams): Promise<GetNetworkRequestsResult> {
  await ensureBrowserTelemetryReady();
  const effectiveLimit = params.limit || 50;
  const effectiveOffset = params.offset || 0;

  const baseFilter = {
    method: params.method,
    method_in: params.method_in,
    status: params.status,
    status_in: params.status_in,
    min_duration_ms: params.min_duration_ms,
    sort_by: params.sort_by,
    sort_order: params.sort_order,
    url_contains: params.url_contains,
  } as const;

  const allMatching = browserDevToolsStore.getNetworkForAI({
    ...baseFilter,
    failed: params.failed_only || params.only_errors,
  });

  const allFailedMatching = browserDevToolsStore.getNetworkForAI({
    ...baseFilter,
    failed: true,
  });

  let requests = browserDevToolsStore.getNetworkForAI({
    limit: effectiveLimit,
    offset: effectiveOffset,
    method: params.method,
    method_in: params.method_in,
    status: params.status,
    status_in: params.status_in,
    failed: params.failed_only || params.only_errors,
    min_duration_ms: params.min_duration_ms,
    sort_by: params.sort_by,
    sort_order: params.sort_order,
    url_contains: params.url_contains,
  });

  return {
    success: true,
    data: {
      requests: requests.map(r => {
        knownNetworkRequestIds.add(r.id);
        return ({
        id: r.id,
        method: r.method,
        url: r.url,
        resource_type: r.resourceType,
        status: r.status,
        status_text: r.statusText,
        duration: r.duration,
        size: r.size,
        error: r.error,
        timestamp: r.timestamp,
      })}),
    },
    meta: {
      total: allMatching.length,
      window: 'session',
      truncated: effectiveOffset + requests.length < allMatching.length,
      failed_count: allFailedMatching.length,
    },
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
  warnings?: string[];
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
  await ensureBrowserTelemetryReady();
  const warnings: string[] = [];
  if (!knownNetworkRequestIds.has(params.request_id)) {
    warnings.push('request_id was not seen in current session list. Call browser_get_network_requests first and reuse its id.');
  }
  const request = browserDevToolsStore.getNetworkRequestById(params.request_id);
  
  if (!request) {
    return { found: false, ...(warnings.length > 0 ? { warnings } : {}) };
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
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

// ============================================================================
// Tool: browser_get_performance
// ============================================================================

export interface GetPerformanceResult {
  success: boolean;
  data: {
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
    events?: Array<{
      timestamp: number;
      kind: string;
      severity: string;
      label: string;
      value?: number;
      unit?: string;
    }>;
  };
  meta: {
    total: number;
    window: string;
    truncated: boolean;
  };
  warnings?: string[];
}

export async function browser_get_performance(
  params: { window?: '10s' | '30s' | '2m' | 'session'; include_events?: boolean } = {},
): Promise<GetPerformanceResult> {
  await ensureBrowserTelemetryReady();
  const perf = browserDevToolsStore.getPerformanceForAI({
    window: params.window,
    include_events: params.include_events,
  });
  
  if (!perf.snapshot) {
    return {
      success: true,
      data: { metrics: null, events: params.include_events ? [] : undefined },
      meta: {
        total: 0,
        window: params.window ?? 'session',
        truncated: false,
      },
    };
  }

  return {
    success: true,
    data: {
      metrics: {
        dom_content_loaded: perf.snapshot.domContentLoaded,
        load_complete: perf.snapshot.loadComplete,
        first_paint: perf.snapshot.firstPaint,
        first_contentful_paint: perf.snapshot.firstContentfulPaint,
        largest_contentful_paint: perf.snapshot.largestContentfulPaint,
        total_resources: perf.snapshot.totalResources,
        total_size: perf.snapshot.totalSize,
        js_heap_size: perf.snapshot.jsHeapSize,
      },
      events: perf.events?.map(e => ({
        timestamp: e.timestamp,
        kind: e.kind,
        severity: e.severity,
        label: e.label,
        value: e.value,
        unit: e.unit,
      })),
    },
    meta: {
      total: perf.snapshot.eventCount,
      window: params.window ?? 'session',
      truncated: false,
    },
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
  await ensureBrowserTelemetryReady();
  const summary = browserDevToolsStore.getSummaryForAI();
  const liveUrl = await getLiveBrowserUrl();
  
  return {
    is_open: browserStore.isOpen,
    url: liveUrl,
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
// Tool: browser_get_application_storage
// ============================================================================

export interface GetApplicationStorageParams {
  area?: 'localStorage' | 'sessionStorage' | 'cookies' | 'indexeddb' | 'all';
  search?: string;
  limit?: number;
  include_sensitive?: boolean;
}

export interface GetApplicationStorageResult {
  success: boolean;
  data: {
    snapshot: ReturnType<typeof browserDevToolsStore.getApplicationForAI>['snapshot'];
  };
  meta: {
    total: number;
    window: string;
    truncated: boolean;
  };
  warnings?: string[];
}

export async function browser_get_application_storage(
  params: GetApplicationStorageParams = {},
): Promise<GetApplicationStorageResult> {
  await ensureBrowserTelemetryReady();
  if (!browserDevToolsStore.applicationSnapshot) {
    await browserDevToolsStore.refreshApplicationSnapshot();
  }
  const { snapshot, warnings } = browserDevToolsStore.getApplicationForAI({
    area: params.area,
    search: params.search,
    limit: params.limit,
    include_sensitive: params.include_sensitive,
  });
  const total =
    (snapshot?.storage_entries.length || 0) +
    (snapshot?.cookies.length || 0) +
    (snapshot?.indexeddb.length || 0);
  const redactionWarnings: string[] = [...warnings];
  if (!params.include_sensitive && snapshot) {
    const maskedStorage = snapshot.storage_entries.some((entry) => entry.is_sensitive);
    const maskedCookies = snapshot.cookies.some((cookie) => cookie.is_sensitive);
    if (maskedStorage || maskedCookies) {
      redactionWarnings.push('Sensitive values are masked by default. Set include_sensitive=true to include raw values.');
    }
  }
  return {
    success: true,
    data: { snapshot },
    meta: {
      total,
      window: 'session',
      truncated: false,
    },
    warnings: redactionWarnings.length > 0 ? redactionWarnings : undefined,
  };
}

// ============================================================================
// Tool: browser_get_security_report
// ============================================================================

export interface GetSecurityReportParams {
  severity_in?: Array<'low' | 'medium' | 'high'>;
  kind_in?: string[];
  limit?: number;
}

export interface GetSecurityReportResult {
  success: boolean;
  data: {
    issues: ReturnType<typeof browserDevToolsStore.getSecurityForAI>['snapshot'] extends infer T
      ? T extends { issues: infer I } ? I : []
      : [];
    summary: { high: number; medium: number; low: number; total: number };
    coverage: { mixed_content: boolean; cors: boolean; csp: boolean; tls: boolean };
  };
  meta: {
    total: number;
    window: string;
    truncated: boolean;
  };
  warnings?: string[];
}

export async function browser_get_security_report(
  params: GetSecurityReportParams = {},
): Promise<GetSecurityReportResult> {
  await ensureBrowserTelemetryReady();
  const { snapshot } = browserDevToolsStore.getSecurityForAI({
    severity_in: params.severity_in,
    kind_in: params.kind_in,
    limit: params.limit,
  });
  if (!snapshot) {
    return {
      success: true,
      data: {
        issues: [],
        summary: { high: 0, medium: 0, low: 0, total: 0 },
        coverage: { mixed_content: false, cors: false, csp: false, tls: false },
      },
      meta: {
        total: 0,
        window: 'session',
        truncated: false,
      },
      warnings: ['No security issues captured yet. Navigate/reload the page to collect diagnostics.'],
    };
  }
  const warnings: string[] = [];
  if (!snapshot.coverage.tls) {
    warnings.push('TLS/certificate deep details are not available in this embedded view runtime.');
  }
  return {
    success: true,
    data: {
      issues: snapshot.issues,
      summary: snapshot.summary,
      coverage: snapshot.coverage,
    },
    meta: {
      total: snapshot.summary.total,
      window: 'session',
      truncated: false,
    },
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

// ============================================================================
// Tool: browser_propose_action
// ============================================================================

export interface BrowserProposeActionParams {
  intent?: string;
  max_actions?: number;
}

export interface BrowserProposeActionResult {
  success: boolean;
  data: {
    actions: GuidedBrowserAction[];
  };
  meta: {
    total: number;
    window: string;
    truncated: boolean;
  };
}

export async function browser_propose_action(
  params: BrowserProposeActionParams = {},
): Promise<BrowserProposeActionResult> {
  purgeExpiredGuidedCaches();
  await ensureBrowserTelemetryReady();
  const summary = browserDevToolsStore.getSummaryForAI();
  const actions: GuidedBrowserAction[] = [];

  if (summary.failedRequestCount > 0) {
    actions.push({
      id: makeActionId('summarize_failures'),
      type: 'summarize_failures',
      label: 'Summarize failed requests',
      reason: `Detected ${summary.failedRequestCount} failed requests`,
      risk: 'low',
    });
  }

  if (summary.consoleLogCount > 0 || summary.errorCount > 0) {
    actions.push({
      id: makeActionId('clear_console'),
      type: 'clear_console',
      label: 'Clear console logs',
      reason: 'Reset console signal to isolate fresh errors',
      risk: 'low',
    });
  }

  if (summary.networkRequestCount > 0) {
    actions.push({
      id: makeActionId('clear_network'),
      type: 'clear_network',
      label: 'Clear network requests',
      reason: 'Start a fresh network capture',
      risk: 'low',
    });
  }

  if (browserDevToolsStore.performance || browserDevToolsStore.performanceEvents.length > 0) {
    actions.push({
      id: makeActionId('clear_performance'),
      type: 'clear_performance',
      label: 'Clear performance timeline',
      reason: 'Start a clean performance capture window',
      risk: 'low',
    });
  }

  if (browserStore.isOpen) {
    actions.push({
      id: makeActionId('reload_page'),
      type: 'reload_page',
      label: 'Reload current page',
      reason: 'Re-run diagnostics on a clean page lifecycle',
      risk: 'low',
    });
    actions.push({
      id: makeActionId('capture_screenshot'),
      type: 'capture_screenshot',
      label: 'Capture screenshot',
      reason: 'Collect current visual state for debugging context',
      risk: 'low',
    });
  }

  const maxActions = Math.max(1, Math.min(10, params.max_actions ?? 5));
  const limited = actions.slice(0, maxActions);
  cacheGuidedActions(limited);

  return {
    success: true,
    data: {
      actions: limited,
    },
    meta: {
      total: actions.length,
      window: 'session',
      truncated: actions.length > limited.length,
    },
  };
}

// ============================================================================
// Tool: browser_preview_action
// ============================================================================

export interface BrowserPreviewActionParams {
  action_id: string;
}

export interface BrowserPreviewActionResult {
  success: boolean;
  data: {
    action_id: string;
    action_type: GuidedBrowserActionType;
    label: string;
    reason: string;
    risk: 'low' | 'medium';
    requires_approval: true;
    approval_token: string;
    expires_in_seconds: number;
  } | null;
  meta: {
    total: number;
    window: string;
    truncated: boolean;
  };
  warnings?: string[];
}

export async function browser_preview_action(
  params: BrowserPreviewActionParams,
): Promise<BrowserPreviewActionResult> {
  purgeExpiredGuidedCaches();
  const action = getGuidedAction(params.action_id);
  if (!action) {
    return {
      success: false,
      data: null,
      meta: {
        total: 0,
        window: 'session',
        truncated: false,
      },
      warnings: ['Unknown or expired action_id. Call browser_propose_action again.'],
    };
  }

  const approvalToken = issueApprovalToken(action.id);
  return {
    success: true,
    data: {
      action_id: action.id,
      action_type: action.type,
      label: action.label,
      reason: action.reason,
      risk: action.risk,
      requires_approval: true,
      approval_token: approvalToken,
      expires_in_seconds: Math.round(ACTION_APPROVAL_TTL_MS / 1000),
    },
    meta: {
      total: 1,
      window: 'session',
      truncated: false,
    },
  };
}

// ============================================================================
// Tool: browser_execute_action
// ============================================================================

export interface BrowserExecuteActionParams {
  action_id: string;
  approval_token: string;
}

export interface BrowserExecuteActionResult {
  success: boolean;
  data: {
    action_id: string;
    action_type: GuidedBrowserActionType;
    performed: boolean;
    output?: unknown;
  } | null;
  meta: {
    total: number;
    window: string;
    truncated: boolean;
  };
  warnings?: string[];
}

export async function browser_execute_action(
  params: BrowserExecuteActionParams,
): Promise<BrowserExecuteActionResult> {
  purgeExpiredGuidedCaches();
  const action = getGuidedAction(params.action_id);
  if (!action) {
    return {
      success: false,
      data: null,
      meta: { total: 0, window: 'session', truncated: false },
      warnings: ['Unknown or expired action_id.'],
    };
  }

  if (!consumeApprovalToken(action.id, params.approval_token)) {
    return {
      success: false,
      data: null,
      meta: { total: 0, window: 'session', truncated: false },
      warnings: ['Invalid or expired approval_token. Use browser_preview_action again.'],
    };
  }

  await ensureBrowserTelemetryReady();

  switch (action.type) {
    case 'reload_page': {
      if (!browserStore.isOpen) {
        return {
          success: false,
          data: null,
          meta: { total: 0, window: 'session', truncated: false },
          warnings: ['Browser is not open.'],
        };
      }
      await browserStore.reload();
      return {
        success: true,
        data: { action_id: action.id, action_type: action.type, performed: true },
        meta: { total: 1, window: 'session', truncated: false },
      };
    }
    case 'clear_console':
      browserDevToolsStore.clearConsoleLogs();
      return {
        success: true,
        data: { action_id: action.id, action_type: action.type, performed: true },
        meta: { total: 1, window: 'session', truncated: false },
      };
    case 'clear_network':
      browserDevToolsStore.clearNetworkRequests();
      return {
        success: true,
        data: { action_id: action.id, action_type: action.type, performed: true },
        meta: { total: 1, window: 'session', truncated: false },
      };
    case 'clear_performance':
      browserDevToolsStore.clearPerformance();
      return {
        success: true,
        data: { action_id: action.id, action_type: action.type, performed: true },
        meta: { total: 1, window: 'session', truncated: false },
      };
    case 'capture_screenshot': {
      const shot = await browser_screenshot({});
      return {
        success: shot.success,
        data: {
          action_id: action.id,
          action_type: action.type,
          performed: shot.success,
          output: shot,
        },
        meta: { total: 1, window: 'session', truncated: false },
        warnings: shot.success ? undefined : [shot.error || 'Screenshot failed'],
      };
    }
    case 'summarize_failures': {
      const failures = browserDevToolsStore.getNetworkForAI({ failed: true, limit: 20 });
      return {
        success: true,
        data: {
          action_id: action.id,
          action_type: action.type,
          performed: true,
          output: failures.map((r) => ({
            id: r.id,
            method: r.method,
            url: r.url,
            status: r.status,
            error: r.error,
            duration: r.duration,
          })),
        },
        meta: { total: failures.length, window: 'session', truncated: false },
      };
    }
  }
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
    const cdpReady = await ensureCdpReady();
    if (!cdpReady.ok) {
      return { success: false, error: cdpReady.error };
    }

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
        full_page: params.full_page || false,
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
    const requestedUrl = params.url.trim();
    const currentUrl = browserStore.url || '';
    const isLoopback = (value: string): boolean => /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/i.test(value);
    const isFileUrl = (value: string): boolean => /^file:\/\//i.test(value);

    // Guardrail: in active localhost debugging sessions, avoid accidental file:// overrides.
    // This commonly causes the agent to inspect the wrong page and return misleading diagnostics.
    if (
      browserStore.isOpen &&
      isLoopback(currentUrl) &&
      isFileUrl(requestedUrl) &&
      requestedUrl !== currentUrl
    ) {
      return {
        success: false,
        url: currentUrl,
        error:
          'Refused navigation to file:// because browser is already on a localhost app. Reuse current URL or explicitly ask to switch away from dev server.',
      };
    }

    if (!browserStore.isOpen) {
      await browserStore.open(params.url);
    } else {
      if (!browserStore.isVisible) {
        await browserStore.setVisible(true);
      }
      await browserStore.navigate(params.url);
    }
    const liveUrl = await getLiveBrowserUrl();
    return {
      success: true,
      url: liveUrl,
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
    const cdpReady = await ensureCdpReady();
    if (!cdpReady.ok) {
      return {
        success: false,
        element_found: false,
        error: cdpReady.error,
      };
    }

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
    const cdpReady = await ensureCdpReady();
    if (!cdpReady.ok) {
      return { success: false, error: cdpReady.error };
    }

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
    const cdpReady = await ensureCdpReady();
    if (!cdpReady.ok) {
      return { found: false, error: cdpReady.error };
    }

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
    const cdpReady = await ensureCdpReady();
    if (!cdpReady.ok) {
      return { count: 0, elements: [], error: cdpReady.error };
    }

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
    const cdpReady = await ensureCdpReady();
    if (!cdpReady.ok) {
      return { success: false, error: cdpReady.error };
    }

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
    const cdpReady = await ensureCdpReady();
    if (!cdpReady.ok) {
      return { success: false, error: cdpReady.error };
    }

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
    const cdpReady = await ensureCdpReady();
    if (!cdpReady.ok) {
      return { found: false, error: cdpReady.error };
    }

    const found = await invoke<boolean>('cdp_wait_for_selector', {
      selector: params.selector,
      timeout_ms: params.timeout_ms || 5000,
    });
    return { found };
  } catch (err) {
    return {
      found: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
