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

// ============================================================================
// Constants
// ============================================================================

const MAX_CONSOLE_LOGS = 500;
const MAX_ERRORS = 100;
const MAX_NETWORK_REQUESTS = 200;

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
  
  // UI state
  isCapturing = $state(true);
  activeTab = $state<'console' | 'network' | 'performance'>('console');
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

  // Event listeners
  private unlisteners: UnlistenFn[] = [];
  private initialized = false;

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
  }

  clearErrors(): void {
    this.errors = [];
  }

  // ============================================================================
  // Network Methods
  // ============================================================================

  addNetworkRequest(request: Omit<NetworkRequest, 'completed'> & { id?: string }): void {
    if (!this.isCapturing) return;
    
    const newRequest: NetworkRequest = {
      ...request,
      id: request.id || crypto.randomUUID(),
      completed: false,
    };
    
    if (this.networkRequests.length >= MAX_NETWORK_REQUESTS) {
      this.networkRequests = [...this.networkRequests.slice(1), newRequest];
    } else {
      this.networkRequests = [...this.networkRequests, newRequest];
    }
  }

  updateNetworkRequest(id: string, update: Partial<NetworkRequest>): void {
    this.networkRequests = this.networkRequests.map(r => 
      r.id === id ? { ...r, ...update, completed: true } : r
    );
  }

  clearNetworkRequests(): void {
    this.networkRequests = [];
  }

  // ============================================================================
  // Performance Methods
  // ============================================================================

  setPerformance(metrics: PerformanceMetrics): void {
    this.performance = metrics;
  }

  clearPerformance(): void {
    this.performance = null;
  }

  // ============================================================================
  // Bulk Operations
  // ============================================================================

  clearAll(): void {
    this.consoleLogs = [];
    this.errors = [];
    this.networkRequests = [];
    this.performance = null;
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
    let logs = this.consoleLogs;
    
    if (options?.level) {
      logs = logs.filter(l => l.level === options.level);
    }
    
    if (options?.since) {
      const sinceTime = options.since;
      logs = logs.filter(l => l.timestamp >= sinceTime);
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
    return this.errors.slice(-limit);
  }

  /**
   * Get network requests for AI - returns requests with optional filtering
   */
  getNetworkForAI(options?: {
    limit?: number;
    method?: string;
    status?: number;
    failed?: boolean;
  }): NetworkRequest[] {
    let requests = this.networkRequests;
    
    if (options?.method) {
      requests = requests.filter(r => r.method === options.method);
    }
    
    if (options?.status) {
      requests = requests.filter(r => r.status === options.status);
    }
    
    if (options?.failed) {
      requests = requests.filter(r => r.status && r.status >= 400);
    }
    
    if (options?.limit) {
      requests = requests.slice(-options.limit);
    }
    
    return requests;
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
    return {
      consoleLogCount: this.consoleLogs.length,
      errorCount: this.errors.length,
      warningCount: this.warningCount,
      networkRequestCount: this.networkRequests.length,
      failedRequestCount: this.failedRequestCount,
      recentErrors: this.errors.slice(-5),
      recentFailedRequests: this.networkRequests.filter(r => r.status && r.status >= 400).slice(-5),
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
