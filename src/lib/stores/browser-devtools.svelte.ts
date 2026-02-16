/**
 * Browser DevTools Store - Captures console logs, errors, network requests
 * This data is accessible by AI tools for debugging assistance
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// ============================================================================
// Types
// ============================================================================

export type ConsoleLogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface ConsoleLog {
  id: string;
  level: ConsoleLogLevel;
  message: string;
  args?: string[];        // Stringified arguments
  source?: string;        // Source file
  line?: number;          // Line number
  column?: number;        // Column number
  stack?: string;         // Stack trace (for errors)
  timestamp: number;
}

export interface JsError {
  id: string;
  message: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  stack?: string;
  type: 'error' | 'unhandledrejection';
  timestamp: number;
}

export interface NetworkRequest {
  id: string;
  method: string;
  url: string;
  resourceType?: string;
  initiator?: string;
  headers?: Record<string, string>;
  body?: string;
  timestamp: number;
  // Response data (filled when response arrives)
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  duration?: number;
  size?: number;
  error?: string;
  completed: boolean;
}

export interface BrowserPerformanceEvent {
  id: string;
  timestamp: number;
  kind: 'navigation' | 'paint' | 'resource' | 'memory' | 'long-task';
  severity: 'low' | 'medium' | 'high';
  label: string;
  value?: number;
  unit?: string;
}

export interface PerformanceMetrics {
  // Navigation timing
  domContentLoaded?: number;
  loadComplete?: number;
  firstPaint?: number;
  firstContentfulPaint?: number;
  largestContentfulPaint?: number;
  // Resource summary
  totalResources?: number;
  totalSize?: number;
  // Memory (if available)
  jsHeapSize?: number;
  timestamp: number;
}

export interface BrowserPerformanceSnapshot extends PerformanceMetrics {
  eventCount: number;
  longTaskCount: number;
}

export interface BrowserStorageEntry {
  area: 'localStorage' | 'sessionStorage';
  origin: string;
  key: string;
  value_masked: string;
  value_length: number;
  is_sensitive: boolean;
  updated_at: number;
  value?: string;
}

export interface BrowserCookieEntry {
  name: string;
  value_masked: string;
  domain?: string;
  path?: string;
  expires?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  is_sensitive?: boolean;
  value?: string;
}

export interface BrowserIndexedDbSummary {
  name: string;
  version?: number;
  object_store_count: number;
  object_store_names: string[];
}

export interface BrowserApplicationSnapshot {
  origin: string;
  storage_entries: BrowserStorageEntry[];
  cookies: BrowserCookieEntry[];
  indexeddb: BrowserIndexedDbSummary[];
  captured_at: number;
}

export interface BrowserSecurityIssue {
  id: string;
  kind: 'mixed-content' | 'cors' | 'csp' | 'tls' | 'cert' | 'cookie-policy' | 'other';
  severity: 'low' | 'medium' | 'high';
  title: string;
  description: string;
  url?: string;
  request_id?: string;
  evidence?: unknown;
  timestamp: number;
  signature?: string;
}

export interface BrowserSecuritySnapshot {
  issues: BrowserSecurityIssue[];
  summary: { high: number; medium: number; low: number; total: number };
  captured_at: number;
  coverage: { mixed_content: boolean; cors: boolean; csp: boolean; tls: boolean };
}

// ============================================================================
// Constants
// ============================================================================

const MAX_CONSOLE_LOGS = 500;
const MAX_ERRORS = 100;
const MAX_NETWORK_REQUESTS = 200;
const MAX_PERFORMANCE_EVENTS = 500;
const MAX_SECURITY_ISSUES = 400;
const SENSITIVE_KEY_RE = /(token|auth|session|cookie|secret|jwt|bearer|api[-_]?key|password)/i;

// ============================================================================
// Store
// ============================================================================

class BrowserDevToolsStore {
  // Console logs
  consoleLogs = $state<ConsoleLog[]>([]);
  
  // JavaScript errors
  errors = $state<JsError[]>([]);
  
  // Network requests
  networkRequests = $state<NetworkRequest[]>([]);
  
  // Performance metrics
  performance = $state<PerformanceMetrics | null>(null);
  performanceEvents = $state<BrowserPerformanceEvent[]>([]);

  // Application diagnostics
  applicationSnapshot = $state<BrowserApplicationSnapshot | null>(null);
  applicationWarnings = $state<string[]>([]);

  // Security diagnostics
  securitySnapshot = $state<BrowserSecuritySnapshot | null>(null);
  securityIssues = $state<BrowserSecurityIssue[]>([]);
  
  // UI state
  isCapturing = $state(true);
  activeTab = $state<'console' | 'network' | 'performance' | 'application' | 'security'>('console');
  consoleFilter = $state<ConsoleLogLevel | 'all'>('all');
  
  // Derived counts
  get errorCount() {
    return this.consoleLogs.filter(l => l.level === 'error').length + this.errors.length;
  }
  
  get warningCount() {
    return this.consoleLogs.filter(l => l.level === 'warn').length;
  }
  
  get failedRequestCount() {
    return this.networkRequests.filter(r => r.status && r.status >= 400).length;
  }

  get securityHighCount() {
    return this.securityIssues.filter(i => i.severity === 'high').length;
  }

  // Event listeners
  private unlisteners: UnlistenFn[] = [];
  private initialized = false;
  private sessionStartedAt = Date.now();
  private activePageUrl: string | null = null;

  private isHostNoiseLog(log: { message: string; source?: string }): boolean {
    const message = (log.message || '').toLowerCase();
    const source = (log.source || '').toLowerCase();

    // Filter Volt/Tauri host-runtime noise that is not page-app diagnostics.
    if (message.includes("[tauri] couldn't find callback id")) return true;
    if (message.includes('webview.internal_')) return true;
    if (message.includes('not allowed on window "main"')) return true;
    if (message.includes('this might happen when the app is reloaded while rust is running')) return true;
    if (source.includes('tauri') && message.includes('callback id')) return true;
    if (message.startsWith('[ai]')) return true;
    if (message.startsWith('[mcp]')) return true;
    if (message.startsWith('[browser]')) return true;
    if (message.startsWith('[devtools]')) return true;
    if (message.startsWith('[projectdiagnostics]')) return true;
    if (message.startsWith('[eslint lsp]')) return true;
    if (message.includes('gemini streaming error')) return true;
    if (message.includes('openrouter streaming error')) return true;
    if (message.includes('anthropic streaming error')) return true;
    if (source.includes('/src/lib/stores/')) return true;
    if (source.includes('/src/lib/services/')) return true;

    return false;
  }

  private markNewSession(url?: string): void {
    this.sessionStartedAt = Date.now();
    if (typeof url === 'string' && url.trim().length > 0) {
      this.activePageUrl = url;
    }
  }

  // ============================================================================
  // Console Methods
  // ============================================================================

  addConsoleLog(log: Omit<ConsoleLog, 'id'>): void {
    if (!this.isCapturing) return;
    
    const newLog: ConsoleLog = {
      ...log,
      id: crypto.randomUUID(),
    };
    
    // Keep max logs, remove oldest
    if (this.consoleLogs.length >= MAX_CONSOLE_LOGS) {
      this.consoleLogs = [...this.consoleLogs.slice(1), newLog];
    } else {
      this.consoleLogs = [...this.consoleLogs, newLog];
    }

    this.trackSecurityFromConsoleMessage(newLog.message, newLog.source);
  }

  clearConsoleLogs(): void {
    this.consoleLogs = [];
  }

  getFilteredLogs(): ConsoleLog[] {
    if (this.consoleFilter === 'all') return this.consoleLogs;
    return this.consoleLogs.filter(l => l.level === this.consoleFilter);
  }

  // ============================================================================
  // Error Methods
  // ============================================================================

  addError(error: Omit<JsError, 'id'>): void {
    if (!this.isCapturing) return;
    
    const newError: JsError = {
      ...error,
      id: crypto.randomUUID(),
    };
    
    if (this.errors.length >= MAX_ERRORS) {
      this.errors = [...this.errors.slice(1), newError];
    } else {
      this.errors = [...this.errors, newError];
    }

    this.trackSecurityFromConsoleMessage(newError.message, newError.filename);
  }

  clearErrors(): void {
    this.errors = [];
  }

  // ============================================================================
  // Network Methods
  // ============================================================================

  addNetworkRequest(request: Omit<NetworkRequest, 'completed'> & { id?: string }): void {
    if (!this.isCapturing) return;

    const stableId = request.id || `${request.method}:${request.url}:${request.timestamp}`;
    const newRequest: NetworkRequest = {
      ...request,
      id: stableId,
      completed: false,
    };
    
    if (this.networkRequests.length >= MAX_NETWORK_REQUESTS) {
      this.networkRequests = [...this.networkRequests.slice(1), newRequest];
    } else {
      this.networkRequests = [...this.networkRequests, newRequest];
    }

    this.trackSecurityFromRequest(newRequest);
  }

  updateNetworkRequest(id: string, update: Partial<NetworkRequest>): void {
    this.networkRequests = this.networkRequests.map(r => 
      r.id === id ? { ...r, ...update, completed: true } : r
    );

    if (update.error) {
      this.trackSecurityFromConsoleMessage(update.error, undefined);
    }
    const req = this.networkRequests.find((item) => item.id === id);
    if (req) {
      this.trackSecurityFromResponse(req);
    }
  }

  clearNetworkRequests(): void {
    this.networkRequests = [];
  }

  // ============================================================================
  // Performance Methods
  // ============================================================================

  setPerformance(metrics: PerformanceMetrics): void {
    this.performance = metrics;
    this.recordPerformanceEvents(metrics);
  }

  clearPerformance(): void {
    this.performance = null;
    this.performanceEvents = [];
  }

  setApplicationSnapshot(raw: {
    origin?: string;
    storage_entries?: Array<{ area?: string; key?: string; value?: string }>;
    cookies?: Array<{ name?: string; value?: string; domain?: string; path?: string; expires?: string; secure?: boolean; httpOnly?: boolean; sameSite?: string }>;
    indexeddb?: Array<{ name?: string; version?: number; object_store_count?: number; object_store_names?: string[] }>;
    captured_at?: number;
    warnings?: string[];
  }): void {
    const origin = raw.origin || 'unknown';
    const capturedAt = raw.captured_at || Date.now();

    const storage_entries: BrowserStorageEntry[] = (raw.storage_entries || [])
      .map((entry) => {
        const key = entry.key || '';
        const value = entry.value || '';
        const isSensitive = this.isSensitiveKey(key);
        const area: BrowserStorageEntry['area'] =
          entry.area === 'sessionStorage' ? 'sessionStorage' : 'localStorage';
        return {
          area,
          origin,
          key,
          value_masked: isSensitive ? this.maskSensitiveValue(value) : value,
          value_length: value.length,
          is_sensitive: isSensitive,
          updated_at: capturedAt,
          value,
        };
      })
      .filter((entry) => entry.key.length > 0);

    const cookies: BrowserCookieEntry[] = (raw.cookies || [])
      .map((cookie) => {
        const name = cookie.name || '';
        const value = cookie.value || '';
        const isSensitive = this.isSensitiveKey(name);
        return {
          name,
          value_masked: isSensitive ? this.maskSensitiveValue(value) : value,
          value,
          domain: cookie.domain,
          path: cookie.path,
          expires: cookie.expires,
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
          sameSite: cookie.sameSite,
          is_sensitive: isSensitive,
        };
      })
      .filter((cookie) => cookie.name.length > 0);

    const indexeddb: BrowserIndexedDbSummary[] = (raw.indexeddb || [])
      .map((db) => ({
        name: db.name || 'unknown',
        version: db.version,
        object_store_count: db.object_store_count ?? db.object_store_names?.length ?? 0,
        object_store_names: db.object_store_names || [],
      }));

    this.applicationSnapshot = {
      origin,
      storage_entries,
      cookies,
      indexeddb,
      captured_at: capturedAt,
    };
    this.applicationWarnings = raw.warnings || [];
  }

  clearApplication(): void {
    this.applicationSnapshot = null;
    this.applicationWarnings = [];
  }

  clearSecurity(): void {
    this.securityIssues = [];
    this.securitySnapshot = null;
  }

  refreshSecuritySnapshot(): void {
    if (this.securityIssues.length === 0) {
      this.securitySnapshot = null;
      return;
    }
    const high = this.securityIssues.filter((item) => item.severity === 'high').length;
    const medium = this.securityIssues.filter((item) => item.severity === 'medium').length;
    const low = this.securityIssues.filter((item) => item.severity === 'low').length;
    const kinds = new Set(this.securityIssues.map((item) => item.kind));
    this.securitySnapshot = {
      issues: this.securityIssues,
      summary: { high, medium, low, total: this.securityIssues.length },
      captured_at: Date.now(),
      coverage: {
        mixed_content: kinds.has('mixed-content'),
        cors: kinds.has('cors'),
        csp: kinds.has('csp'),
        tls: kinds.has('tls') || kinds.has('cert'),
      },
    };
  }

  async refreshApplicationSnapshot(): Promise<{ success: boolean; warnings?: string[]; error?: string }> {
    const warnings: string[] = [];
    try {
      const { browserStore } = await import('$lib/stores/browser.svelte');
      if (!browserStore.isOpen) {
        return { success: false, error: 'Browser is not open' };
      }

      const { connectCdpToBrowser } = await import('$lib/services/browser');
      await connectCdpToBrowser(browserStore.url);
      const { cdp } = await import('$lib/services/browser/cdp');
      const snapshot = await cdp.getApplicationSnapshot();
      this.setApplicationSnapshot(snapshot);
      warnings.push(...(snapshot.warnings || []));
      // IndexedDB database names are async in browser APIs; enrich via injected fallback when needed.
      if ((snapshot.indexeddb || []).length === 0) {
        try {
          await browserStore.executeJs('window.__voltCaptureApplication && window.__voltCaptureApplication();');
          await new Promise((resolve) => setTimeout(resolve, 180));
          if ((this.applicationSnapshot?.indexeddb.length || 0) > 0) {
            warnings.push('IndexedDB metadata enriched via injected fallback capture.');
          }
        } catch {
          warnings.push('IndexedDB details are best-effort in embedded runtime.');
        }
      }
      this.applicationWarnings = warnings;
      return { success: true, warnings };
    } catch (err) {
      warnings.push('CDP snapshot failed; attempting injected fallback.');
      try {
        const { browserStore } = await import('$lib/stores/browser.svelte');
        await browserStore.executeJs('window.__voltCaptureApplication && window.__voltCaptureApplication();');
        if (this.applicationSnapshot) {
          this.applicationWarnings = warnings;
          return { success: true, warnings };
        }
      } catch {
        // ignore fallback errors
      }
      return {
        success: false,
        warnings,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ============================================================================
  // Bulk Operations
  // ============================================================================

  clearAll(): void {
    this.consoleLogs = [];
    this.errors = [];
    this.networkRequests = [];
    this.performance = null;
    this.performanceEvents = [];
    this.clearApplication();
    this.clearSecurity();
  }

  toggleCapturing(): void {
    this.isCapturing = !this.isCapturing;
  }

  // ============================================================================
  // AI Tool Helpers - These return data formatted for AI consumption
  // ============================================================================

  /**
   * Get console logs for AI - returns recent logs with optional filtering
   */
  getLogsForAI(options?: { 
    limit?: number; 
    level?: ConsoleLogLevel;
    since?: number;
  }): ConsoleLog[] {
    const floor = options?.since
      ? Math.max(options.since, this.sessionStartedAt)
      : this.sessionStartedAt;
    let logs = this.consoleLogs.filter((log) => log.timestamp >= floor);

    logs = logs.filter((log) => !this.isHostNoiseLog(log));
    
    if (options?.level) {
      logs = logs.filter(l => l.level === options.level);
    }
    
    if (options?.limit) {
      logs = logs.slice(-options.limit);
    }
    
    return logs;
  }

  /**
   * Get errors for AI - returns recent errors with stack traces
   */
  getErrorsForAI(options?: { limit?: number }): JsError[] {
    const limit = options?.limit || 20;
    return this.errors
      .filter((error) => error.timestamp >= this.sessionStartedAt)
      .filter((error) => !this.isHostNoiseLog({ message: error.message, source: error.filename }))
      .slice(-limit);
  }

  /**
   * Get network requests for AI - returns requests with optional filtering
   */
  getNetworkForAI(options?: {
    limit?: number;
    offset?: number;
    method?: string;
    method_in?: string[];
    status?: number;
    status_in?: number[];
    failed?: boolean;
    min_duration_ms?: number;
    sort_by?: 'timestamp' | 'duration' | 'status' | 'size';
    sort_order?: 'asc' | 'desc';
    url_contains?: string;
  }): NetworkRequest[] {
    let requests = this.networkRequests.filter((r) => r.timestamp >= this.sessionStartedAt);
    
    if (options?.method) {
      requests = requests.filter(r => r.method === options.method);
    }

    if (options?.method_in?.length) {
      const methods = new Set(options.method_in.map(m => m.toUpperCase()));
      requests = requests.filter(r => methods.has(r.method.toUpperCase()));
    }

    if (options?.status) {
      requests = requests.filter(r => r.status === options.status);
    }

    if (options?.status_in?.length) {
      const statuses = new Set(options.status_in);
      requests = requests.filter(r => typeof r.status === 'number' && statuses.has(r.status));
    }

    if (options?.failed) {
      requests = requests.filter(r => r.status && r.status >= 400);
    }

    if (typeof options?.min_duration_ms === 'number') {
      requests = requests.filter(r => (r.duration ?? 0) >= options.min_duration_ms!);
    }

    if (options?.url_contains) {
      const pattern = options.url_contains.toLowerCase();
      requests = requests.filter(r => r.url.toLowerCase().includes(pattern));
    }

    const sortBy = options?.sort_by ?? 'timestamp';
    const sortOrder = options?.sort_order ?? 'desc';
    const sortDirection = sortOrder === 'asc' ? 1 : -1;
    requests = [...requests].sort((a, b) => {
      const num = (value: number | undefined) => value ?? -1;
      if (sortBy === 'duration') return (num(a.duration) - num(b.duration)) * sortDirection;
      if (sortBy === 'status') return (num(a.status) - num(b.status)) * sortDirection;
      if (sortBy === 'size') return (num(a.size) - num(b.size)) * sortDirection;
      return (a.timestamp - b.timestamp) * sortDirection;
    });

    if (options?.offset) {
      requests = requests.slice(options.offset);
    }

    if (options?.limit) {
      requests = requests.slice(0, options.limit);
    }

    return requests;
  }

  getNetworkRequestById(id: string): NetworkRequest | null {
    return this.networkRequests.find(r => r.id === id) ?? null;
  }

  getApplicationForAI(options?: {
    area?: 'localStorage' | 'sessionStorage' | 'cookies' | 'indexeddb' | 'all';
    search?: string;
    limit?: number;
    include_sensitive?: boolean;
  }): {
    snapshot: BrowserApplicationSnapshot | null;
    warnings: string[];
  } {
    if (!this.applicationSnapshot) {
      return { snapshot: null, warnings: this.applicationWarnings };
    }

    const area = options?.area ?? 'all';
    const includeSensitive = options?.include_sensitive === true;
    const search = options?.search?.toLowerCase().trim();
    const limit = Math.max(1, Math.min(1000, options?.limit ?? 200));

    const match = (value: string): boolean => {
      if (!search) return true;
      return value.toLowerCase().includes(search);
    };

    const storageEntries = this.applicationSnapshot.storage_entries
      .filter((entry) => (area === 'all' ? true : area === entry.area))
      .filter((entry) => match(entry.key))
      .filter((entry) => includeSensitive || !entry.is_sensitive)
      .slice(0, limit)
      .map((entry) => ({
        ...entry,
        value: includeSensitive ? entry.value : undefined,
      }));

    const cookies = this.applicationSnapshot.cookies
      .filter(() => area === 'all' || area === 'cookies')
      .filter((cookie) => match(cookie.name))
      .filter((cookie) => includeSensitive || !cookie.is_sensitive)
      .slice(0, limit)
      .map((cookie) => ({
        ...cookie,
        value: includeSensitive ? cookie.value : undefined,
      }));

    const indexeddb = this.applicationSnapshot.indexeddb
      .filter((db) => area === 'all' || area === 'indexeddb')
      .filter((db) => match(db.name))
      .slice(0, limit);

    return {
      snapshot: {
        ...this.applicationSnapshot,
        storage_entries: storageEntries,
        cookies,
        indexeddb,
      },
      warnings: this.applicationWarnings,
    };
  }

  getSecurityForAI(options?: {
    severity_in?: Array<'low' | 'medium' | 'high'>;
    kind_in?: string[];
    limit?: number;
  }): {
    snapshot: BrowserSecuritySnapshot | null;
  } {
    if (!this.securitySnapshot) return { snapshot: null };
    const severities = options?.severity_in?.length ? new Set(options.severity_in) : null;
    const kinds = options?.kind_in?.length ? new Set(options.kind_in.map((k) => k.toLowerCase())) : null;
    const limit = Math.max(1, Math.min(500, options?.limit ?? 200));
    const issues = this.securityIssues
      .filter((issue) => (severities ? severities.has(issue.severity) : true))
      .filter((issue) => (kinds ? kinds.has(issue.kind.toLowerCase()) : true))
      .slice(0, limit);
    const high = issues.filter((issue) => issue.severity === 'high').length;
    const medium = issues.filter((issue) => issue.severity === 'medium').length;
    const low = issues.filter((issue) => issue.severity === 'low').length;
    return {
      snapshot: {
        ...this.securitySnapshot,
        issues,
        summary: { high, medium, low, total: issues.length },
      },
    };
  }

  getPerformanceForAI(options?: { window?: '10s' | '30s' | '2m' | 'session'; include_events?: boolean }): {
    snapshot: BrowserPerformanceSnapshot | null;
    events?: BrowserPerformanceEvent[];
  } {
    if (!this.performance) {
      return { snapshot: null, events: options?.include_events ? [] : undefined };
    }

    const windowMs =
      options?.window === '10s'
        ? 10_000
        : options?.window === '30s'
          ? 30_000
          : options?.window === '2m'
            ? 120_000
            : null;
    const cutoff = windowMs ? Date.now() - windowMs : 0;
    const events = this.performanceEvents.filter(e => e.timestamp >= cutoff);
    const longTaskCount = events.filter(e => e.kind === 'long-task').length;
    const snapshot: BrowserPerformanceSnapshot = {
      ...this.performance,
      eventCount: events.length,
      longTaskCount,
    };

    return {
      snapshot,
      events: options?.include_events ? events : undefined,
    };
  }

  private addPerformanceEvent(event: Omit<BrowserPerformanceEvent, 'id'>): void {
    const next: BrowserPerformanceEvent = {
      ...event,
      id: crypto.randomUUID(),
    };
    if (this.performanceEvents.length >= MAX_PERFORMANCE_EVENTS) {
      this.performanceEvents = [...this.performanceEvents.slice(1), next];
    } else {
      this.performanceEvents = [...this.performanceEvents, next];
    }
  }

  private recordPerformanceEvents(metrics: PerformanceMetrics): void {
    const addMetricEvent = (label: string, value: number | undefined, unit: string, kind: BrowserPerformanceEvent['kind'] = 'navigation') => {
      if (typeof value !== 'number') return;
      const severity: BrowserPerformanceEvent['severity'] =
        value >= 4000 ? 'high' : value >= 2000 ? 'medium' : 'low';
      this.addPerformanceEvent({
        timestamp: metrics.timestamp,
        kind,
        severity,
        label,
        value,
        unit,
      });
    };

    addMetricEvent('DOMContentLoaded', metrics.domContentLoaded, 'ms');
    addMetricEvent('Load Complete', metrics.loadComplete, 'ms');
    addMetricEvent('First Paint', metrics.firstPaint, 'ms', 'paint');
    addMetricEvent('First Contentful Paint', metrics.firstContentfulPaint, 'ms', 'paint');
    addMetricEvent('Largest Contentful Paint', metrics.largestContentfulPaint, 'ms', 'paint');
    addMetricEvent('JS Heap Size', metrics.jsHeapSize, 'bytes', 'memory');
  }

  private isSensitiveKey(key: string): boolean {
    return SENSITIVE_KEY_RE.test(key);
  }

  private maskSensitiveValue(value: string): string {
    if (!value) return '';
    if (value.length <= 4) return '*'.repeat(value.length);
    if (value.length <= 12) return `${value.slice(0, 2)}...${value.slice(-2)}`;
    return `${value.slice(0, 2)}…${value.slice(-2)}`;
  }

  private addSecurityIssue(issue: Omit<BrowserSecurityIssue, 'id'>): void {
    const signature = `${issue.kind}:${issue.url ?? ''}:${issue.description}`.toLowerCase();
    if (this.securityIssues.some((existing) => existing.signature === signature)) return;
    const next: BrowserSecurityIssue = {
      ...issue,
      id: crypto.randomUUID(),
      signature,
    };
    const updated = this.securityIssues.length >= MAX_SECURITY_ISSUES
      ? [...this.securityIssues.slice(1), next]
      : [...this.securityIssues, next];
    this.securityIssues = updated;
    this.refreshSecuritySnapshot();
  }

  private trackSecurityFromConsoleMessage(message: string, source?: string): void {
    const text = (message || '').toLowerCase();
    if (!text) return;
    if (text.includes('content security policy') || text.includes('securitypolicyviolation') || text.includes('csp')) {
      this.addSecurityIssue({
        kind: 'csp',
        severity: 'high',
        title: 'Content Security Policy violation',
        description: message,
        url: source,
        timestamp: Date.now(),
      });
    }
    if (text.includes('cors') || text.includes('cross-origin') || text.includes('preflight')) {
      this.addSecurityIssue({
        kind: 'cors',
        severity: 'high',
        title: 'CORS policy issue',
        description: message,
        url: source,
        timestamp: Date.now(),
      });
    }
    if (text.includes('mixed content')) {
      this.addSecurityIssue({
        kind: 'mixed-content',
        severity: 'high',
        title: 'Mixed content blocked',
        description: message,
        url: source,
        timestamp: Date.now(),
      });
    }
    if (text.includes('certificate') || text.includes('tls') || text.includes('ssl')) {
      this.addSecurityIssue({
        kind: 'cert',
        severity: 'medium',
        title: 'TLS/certificate warning',
        description: message,
        url: source,
        timestamp: Date.now(),
      });
    }
  }

  private trackSecurityFromRequest(request: NetworkRequest): void {
    try {
      const currentUrl = (typeof window !== 'undefined' && window.location?.href) ? window.location.href : '';
      if (currentUrl.startsWith('https://') && request.url.startsWith('http://')) {
        this.addSecurityIssue({
          kind: 'mixed-content',
          severity: 'high',
          title: 'Mixed content request',
          description: `Insecure resource requested over HTTP: ${request.url}`,
          url: request.url,
          request_id: request.id,
          timestamp: request.timestamp,
        });
      }
    } catch {
      // ignore
    }
  }

  private trackSecurityFromResponse(request: NetworkRequest): void {
    const url = request.url || '';
    const headers = request.responseHeaders || {};
    const hasCorsFailure = (request.error || '').toLowerCase().includes('cors');
    const headerLookup = (name: string): string | undefined => {
      const direct = headers[name];
      if (direct) return direct;
      const entry = Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase());
      return entry?.[1];
    };

    if (hasCorsFailure || request.status === 0) {
      this.addSecurityIssue({
        kind: 'cors',
        severity: 'high',
        title: 'CORS request failure',
        description: request.error || `Request failed: ${request.method} ${url}`,
        url,
        request_id: request.id,
        timestamp: request.timestamp,
      });
    }

    if (url.startsWith('https://')) {
      const hsts = headerLookup('strict-transport-security');
      if (!hsts) {
        this.addSecurityIssue({
          kind: 'tls',
          severity: 'medium',
          title: 'Missing HSTS header',
          description: 'HTTPS response is missing Strict-Transport-Security header.',
          url,
          request_id: request.id,
          timestamp: request.timestamp,
          evidence: { header: 'strict-transport-security' },
        });
      }
      const certHint = headerLookup('x-ssl-cert') || headerLookup('x-tls-version');
      if (certHint) {
        this.addSecurityIssue({
          kind: 'cert',
          severity: 'low',
          title: 'TLS/certificate metadata detected',
          description: 'Response exposed TLS/certificate metadata headers.',
          url,
          request_id: request.id,
          timestamp: request.timestamp,
          evidence: { cert_hint: certHint },
        });
      }
    }
  }

  /**
   * Get a summary for AI - quick overview of browser state
   */
  getSummaryForAI(): {
    consoleLogCount: number;
    errorCount: number;
    warningCount: number;
    networkRequestCount: number;
    failedRequestCount: number;
    recentErrors: JsError[];
    recentFailedRequests: NetworkRequest[];
  } {
    const scopedLogs = this.consoleLogs
      .filter((log) => log.timestamp >= this.sessionStartedAt)
      .filter((log) => !this.isHostNoiseLog(log));
    const scopedErrors = this.errors
      .filter((error) => error.timestamp >= this.sessionStartedAt)
      .filter((error) => !this.isHostNoiseLog({ message: error.message, source: error.filename }));
    const scopedNetwork = this.networkRequests.filter((r) => r.timestamp >= this.sessionStartedAt);

    return {
      consoleLogCount: scopedLogs.length,
      errorCount: scopedErrors.length,
      warningCount: scopedLogs.filter((l) => l.level === 'warn').length,
      networkRequestCount: scopedNetwork.length,
      failedRequestCount: scopedNetwork.filter((r) => r.status && r.status >= 400).length,
      recentErrors: scopedErrors.slice(-5),
      recentFailedRequests: scopedNetwork.filter(r => r.status && r.status >= 400).slice(-5),
    };
  }

  // ============================================================================
  // Event Listeners Setup
  // ============================================================================

  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    try {
      // Listen for console logs from browser (JS injection fallback)
      const unlistenConsole = await listen<ConsoleLog>('browser://console-log', (event) => {
        this.addConsoleLog(event.payload);
      });
      this.unlisteners.push(unlistenConsole);

      const unlistenCreated = await listen<string>('browser://created', (event) => {
        this.markNewSession(event.payload);
      });
      this.unlisteners.push(unlistenCreated);

      const unlistenNavigated = await listen<string>('browser://navigated', (event) => {
        this.markNewSession(event.payload);
      });
      this.unlisteners.push(unlistenNavigated);

      const unlistenClosed = await listen('browser://closed', () => {
        this.markNewSession();
      });
      this.unlisteners.push(unlistenClosed);

      // Listen for JS errors (JS injection fallback)
      const unlistenError = await listen<JsError>('browser://js-error', (event) => {
        this.addError(event.payload);
      });
      this.unlisteners.push(unlistenError);

      // Listen for network request start (JS injection fallback)
      const unlistenNetStart = await listen<NetworkRequest>('browser://network-request', (event) => {
        this.addNetworkRequest(event.payload);
      });
      this.unlisteners.push(unlistenNetStart);

      // Listen for network response (JS injection fallback)
      const unlistenNetResponse = await listen<{ id: string } & Partial<NetworkRequest>>('browser://network-response', (event) => {
        this.updateNetworkRequest(event.payload.id, event.payload);
      });
      this.unlisteners.push(unlistenNetResponse);

      // Listen for performance metrics
      const unlistenPerf = await listen<PerformanceMetrics>('browser://performance', (event) => {
        this.setPerformance(event.payload);
      });
      this.unlisteners.push(unlistenPerf);

      const unlistenApplication = await listen<{
        origin?: string;
        storage_entries?: Array<{ area?: string; key?: string; value?: string }>;
        cookies?: Array<{ name?: string; value?: string; domain?: string; path?: string; expires?: string; secure?: boolean; httpOnly?: boolean; sameSite?: string }>;
        indexeddb?: Array<{ name?: string; version?: number; object_store_count?: number; object_store_names?: string[] }>;
        captured_at?: number;
      }>('browser://application', (event) => {
        this.setApplicationSnapshot(event.payload);
      });
      this.unlisteners.push(unlistenApplication);

      const unlistenSecurityIssue = await listen<{
        kind?: BrowserSecurityIssue['kind'];
        severity?: BrowserSecurityIssue['severity'];
        title?: string;
        description?: string;
        url?: string;
        request_id?: string;
        evidence?: unknown;
        timestamp?: number;
      }>('browser://security-issue', (event) => {
        const p = event.payload;
        this.addSecurityIssue({
          kind: p.kind || 'other',
          severity: p.severity || 'medium',
          title: p.title || 'Security issue',
          description: p.description || 'Security issue detected',
          url: p.url,
          request_id: p.request_id,
          evidence: p.evidence,
          timestamp: p.timestamp || Date.now(),
        });
      });
      this.unlisteners.push(unlistenSecurityIssue);

      // ========================================================================
      // CDP Events (Professional browser automation - Windows only)
      // ========================================================================

      // CDP console logs
      const unlistenCdpConsole = await listen<{
        level: string;
        message: string;
        args: string[];
        source: string | null;
        line: number | null;
        column: number | null;
        stack: string | null;
        timestamp: number;
      }>('cdp://console', (event) => {
        const p = event.payload;
        this.addConsoleLog({
          level: (p.level as ConsoleLogLevel) || 'log',
          message: p.message,
          args: p.args,
          source: p.source || undefined,
          line: p.line || undefined,
          column: p.column || undefined,
          stack: p.stack || undefined,
          timestamp: p.timestamp,
        });
      });
      this.unlisteners.push(unlistenCdpConsole);

      // CDP JS errors
      const unlistenCdpError = await listen<{
        message: string;
        description: string | null;
        url: string | null;
        line: number | null;
        column: number | null;
        stack: string | null;
        error_type: string | null;
        timestamp: number;
      }>('cdp://error', (event) => {
        const p = event.payload;
        this.addError({
          message: p.description || p.message,
          filename: p.url || undefined,
          lineno: p.line || undefined,
          colno: p.column || undefined,
          stack: p.stack || undefined,
          type: 'error',
          timestamp: p.timestamp,
        });
      });
      this.unlisteners.push(unlistenCdpError);

      // CDP network requests
      const unlistenCdpNetRequest = await listen<{
        id: string;
        method: string;
        url: string;
        headers: Record<string, string>;
        body: string | null;
        resource_type: string | null;
        initiator: string | null;
        timestamp: number;
      }>('cdp://network-request', (event) => {
        const p = event.payload;
        this.addNetworkRequest({
          id: p.id,
          method: p.method,
          url: p.url,
          resourceType: p.resource_type || undefined,
          initiator: p.initiator || undefined,
          headers: p.headers,
          body: p.body || undefined,
          timestamp: p.timestamp,
        });
      });
      this.unlisteners.push(unlistenCdpNetRequest);

      // CDP network responses
      const unlistenCdpNetResponse = await listen<{
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
      }>('cdp://network-response', (event) => {
        const p = event.payload;
        this.updateNetworkRequest(p.id, {
          status: p.status,
          statusText: p.status_text,
          responseHeaders: p.headers,
          responseBody: p.body || undefined,
          size: p.size || undefined,
          duration: p.duration || undefined,
        });
      });
      this.unlisteners.push(unlistenCdpNetResponse);

      this.initialized = true;
      console.log('[DevTools] Store initialized with CDP support');
    } catch (err) {
      console.error('[DevTools] Failed to initialize:', err);
    }
  }

  async cleanup(): Promise<void> {
    for (const unlisten of this.unlisteners) {
      unlisten();
    }
    this.unlisteners = [];
    this.initialized = false;
    this.clearAll();
  }
}

// Export singleton instance
export const browserDevToolsStore = new BrowserDevToolsStore();
