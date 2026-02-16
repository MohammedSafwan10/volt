/**
 * DevTools Injection Scripts
 * These scripts are injected into the browser webview to capture console, errors, and network
 */

/**
 * Console capture script - intercepts console.log/warn/error/info
 * Sends captured logs to Rust via Tauri invoke
 */
export const CONSOLE_CAPTURE_SCRIPT = `
(function() {
  // Prevent double initialization
  if (window.__voltConsoleInit) return;
  window.__voltConsoleInit = true;

  // Store original console methods
  const originalConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console)
  };

  // Helper to stringify arguments safely
  function stringifyArg(arg) {
    if (arg === null) return 'null';
    if (arg === undefined) return 'undefined';
    if (typeof arg === 'string') return arg;
    if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
    if (arg instanceof Error) {
      return arg.stack || arg.message || String(arg);
    }
    try {
      return JSON.stringify(arg, null, 2);
    } catch {
      return String(arg);
    }
  }

  // Helper to get source location from stack
  function getSourceLocation() {
    const stack = new Error().stack;
    if (!stack) return {};
    
    const lines = stack.split('\\n');
    // Find first line that's not from this script
    for (let i = 3; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('__voltConsole') && !line.includes('devtools-inject')) {
        const match = line.match(/(?:at\\s+)?(?:.*?\\s+)?\\(?(.+?):(\\d+):(\\d+)\\)?$/);
        if (match) {
          return {
            source: match[1],
            line: parseInt(match[2], 10),
            column: parseInt(match[3], 10)
          };
        }
      }
    }
    return {};
  }

  // Send log to Volt
  function sendToVolt(level, args) {
    if (!window.__TAURI__) return;
    
    const location = getSourceLocation();
    const message = args.map(stringifyArg).join(' ');
    
    window.__TAURI__.core.invoke('browser_devtools_console_log', {
      level,
      message,
      args: args.map(stringifyArg),
      source: location.source,
      line: location.line,
      column: location.column,
      timestamp: Date.now()
    }).catch(() => {});
  }

  // Override console methods
  console.log = function(...args) {
    sendToVolt('log', args);
    originalConsole.log(...args);
  };

  console.info = function(...args) {
    sendToVolt('info', args);
    originalConsole.info(...args);
  };

  console.warn = function(...args) {
    sendToVolt('warn', args);
    originalConsole.warn(...args);
  };

  console.error = function(...args) {
    sendToVolt('error', args);
    originalConsole.error(...args);
  };

  console.debug = function(...args) {
    sendToVolt('debug', args);
    originalConsole.debug(...args);
  };

  // Expose original console for internal use
  window.__voltOriginalConsole = originalConsole;
})();
`;

/**
 * Error capture script - captures unhandled errors and promise rejections
 */
export const ERROR_CAPTURE_SCRIPT = `
(function() {
  if (window.__voltErrorInit) return;
  window.__voltErrorInit = true;

  // Capture unhandled errors
  window.addEventListener('error', function(event) {
    if (!window.__TAURI__) return;
    
    window.__TAURI__.core.invoke('browser_devtools_js_error', {
      message: event.message || 'Unknown error',
      filename: event.filename || '',
      lineno: event.lineno || 0,
      colno: event.colno || 0,
      stack: event.error?.stack || '',
      type: 'error',
      timestamp: Date.now()
    }).catch(() => {});
  }, true);

  // Capture unhandled promise rejections
  window.addEventListener('unhandledrejection', function(event) {
    if (!window.__TAURI__) return;
    
    let message = 'Unhandled Promise Rejection';
    let stack = '';
    
    if (event.reason) {
      if (event.reason instanceof Error) {
        message = event.reason.message || message;
        stack = event.reason.stack || '';
      } else if (typeof event.reason === 'string') {
        message = event.reason;
      } else {
        try {
          message = JSON.stringify(event.reason);
        } catch {
          message = String(event.reason);
        }
      }
    }
    
    window.__TAURI__.core.invoke('browser_devtools_js_error', {
      message,
      filename: '',
      lineno: 0,
      colno: 0,
      stack,
      type: 'unhandledrejection',
      timestamp: Date.now()
    }).catch(() => {});
  }, true);
})();
`;

/**
 * Network capture script - intercepts fetch and XMLHttpRequest
 */
export const NETWORK_CAPTURE_SCRIPT = `
(function() {
  if (window.__voltNetworkInit) return;
  window.__voltNetworkInit = true;

  // Helper to generate unique ID
  function generateId() {
    return 'net_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
  }

  // Helper to safely get headers
  function headersToObject(headers) {
    const obj = {};
    if (headers) {
      if (typeof headers.forEach === 'function') {
        headers.forEach((value, key) => { obj[key] = value; });
      } else if (typeof headers === 'object') {
        Object.assign(obj, headers);
      }
    }
    return obj;
  }

  // ============================================================================
  // Fetch Interception
  // ============================================================================
  
  const originalFetch = window.fetch;
  
  window.fetch = async function(input, init) {
    if (!window.__TAURI__) {
      return originalFetch.apply(this, arguments);
    }

    const id = generateId();
    const startTime = performance.now();
    
    // Parse request info
    let url, method, headers, body;
    
    if (input instanceof Request) {
      url = input.url;
      method = input.method;
      headers = headersToObject(input.headers);
      // Can't easily get body from Request
    } else {
      url = String(input);
      method = init?.method || 'GET';
      headers = headersToObject(init?.headers);
      body = init?.body ? String(init.body).slice(0, 5000) : undefined;
    }

    // Send request start event
    window.__TAURI__.core.invoke('browser_devtools_network_request', {
      id,
      method,
      url,
      headers,
      body,
      timestamp: Date.now()
    }).catch(() => {});

    try {
      const response = await originalFetch.apply(this, arguments);
      const duration = Math.round(performance.now() - startTime);
      
      // Clone response to read body
      const clonedResponse = response.clone();
      let responseBody = null;
      let size = 0;
      
      try {
        const contentType = response.headers.get('content-type') || '';
        // Only capture text/json responses, limit size
        if (contentType.includes('json') || contentType.includes('text')) {
          responseBody = await clonedResponse.text();
          size = responseBody.length;
          if (responseBody.length > 10000) {
            responseBody = responseBody.slice(0, 10000) + '... [truncated]';
          }
        }
      } catch {}

      // Send response event
      window.__TAURI__.core.invoke('browser_devtools_network_response', {
        id,
        status: response.status,
        statusText: response.statusText,
        responseHeaders: headersToObject(response.headers),
        responseBody,
        duration,
        size
      }).catch(() => {});

      return response;
    } catch (error) {
      const duration = Math.round(performance.now() - startTime);
      
      // Send error event
      window.__TAURI__.core.invoke('browser_devtools_network_response', {
        id,
        error: error.message || 'Network error',
        duration
      }).catch(() => {});

      throw error;
    }
  };

  // ============================================================================
  // XMLHttpRequest Interception
  // ============================================================================
  
  const originalXHR = window.XMLHttpRequest;
  
  window.XMLHttpRequest = function() {
    const xhr = new originalXHR();
    const id = generateId();
    let method, url, startTime, requestHeaders = {};

    // Override open
    const originalOpen = xhr.open;
    xhr.open = function(m, u, ...rest) {
      method = m;
      url = u;
      return originalOpen.apply(this, [m, u, ...rest]);
    };

    // Override setRequestHeader
    const originalSetHeader = xhr.setRequestHeader;
    xhr.setRequestHeader = function(name, value) {
      requestHeaders[name] = value;
      return originalSetHeader.apply(this, arguments);
    };

    // Override send
    const originalSend = xhr.send;
    xhr.send = function(body) {
      if (!window.__TAURI__) {
        return originalSend.apply(this, arguments);
      }

      startTime = performance.now();

      // Send request start event
      window.__TAURI__.core.invoke('browser_devtools_network_request', {
        id,
        method: method || 'GET',
        url: url || '',
        headers: requestHeaders,
        body: body ? String(body).slice(0, 5000) : undefined,
        timestamp: Date.now()
      }).catch(() => {});

      // Listen for completion
      xhr.addEventListener('loadend', function() {
        const duration = Math.round(performance.now() - startTime);
        
        let responseBody = null;
        let size = 0;
        
        try {
          const contentType = xhr.getResponseHeader('content-type') || '';
          if (contentType.includes('json') || contentType.includes('text')) {
            responseBody = xhr.responseText;
            size = responseBody.length;
            if (responseBody.length > 10000) {
              responseBody = responseBody.slice(0, 10000) + '... [truncated]';
            }
          }
        } catch {}

        // Get response headers
        const responseHeaders = {};
        try {
          const headerStr = xhr.getAllResponseHeaders();
          if (headerStr) {
            headerStr.split('\\r\\n').forEach(line => {
              const parts = line.split(': ');
              if (parts.length === 2) {
                responseHeaders[parts[0]] = parts[1];
              }
            });
          }
        } catch {}

        window.__TAURI__.core.invoke('browser_devtools_network_response', {
          id,
          status: xhr.status,
          statusText: xhr.statusText,
          responseHeaders,
          responseBody,
          duration,
          size,
          error: xhr.status === 0 ? 'Network error' : undefined
        }).catch(() => {});
      });

      return originalSend.apply(this, arguments);
    };

    return xhr;
  };
  
  // Copy static properties
  Object.keys(originalXHR).forEach(key => {
    try {
      window.XMLHttpRequest[key] = originalXHR[key];
    } catch {}
  });
})();
`;

/**
 * Performance capture script - captures page load metrics
 */
export const PERFORMANCE_CAPTURE_SCRIPT = `
(function() {
  if (window.__voltPerfInit) return;
  window.__voltPerfInit = true;

  function capturePerformance() {
    if (!window.__TAURI__) return;
    
    const perf = window.performance;
    if (!perf) return;

    const timing = perf.timing || {};
    const navStart = timing.navigationStart || 0;
    
    const metrics = {
      domContentLoaded: timing.domContentLoadedEventEnd ? timing.domContentLoadedEventEnd - navStart : undefined,
      loadComplete: timing.loadEventEnd ? timing.loadEventEnd - navStart : undefined,
      timestamp: Date.now()
    };

    // Get paint timing
    try {
      const paintEntries = perf.getEntriesByType('paint');
      paintEntries.forEach(entry => {
        if (entry.name === 'first-paint') {
          metrics.firstPaint = Math.round(entry.startTime);
        } else if (entry.name === 'first-contentful-paint') {
          metrics.firstContentfulPaint = Math.round(entry.startTime);
        }
      });
    } catch {}

    // Get LCP
    try {
      const lcpEntries = perf.getEntriesByType('largest-contentful-paint');
      if (lcpEntries.length > 0) {
        metrics.largestContentfulPaint = Math.round(lcpEntries[lcpEntries.length - 1].startTime);
      }
    } catch {}

    // Get resource summary
    try {
      const resources = perf.getEntriesByType('resource');
      metrics.totalResources = resources.length;
      metrics.totalSize = resources.reduce((sum, r) => sum + (r.transferSize || 0), 0);
    } catch {}

    // Get memory (Chrome only)
    try {
      if (perf.memory) {
        metrics.jsHeapSize = perf.memory.usedJSHeapSize;
      }
    } catch {}

    window.__TAURI__.core.invoke('browser_devtools_performance', metrics).catch(() => {});
  }

  // Capture on load
  if (document.readyState === 'complete') {
    setTimeout(capturePerformance, 100);
  } else {
    window.addEventListener('load', () => setTimeout(capturePerformance, 100));
  }

  // Expose for manual capture
  window.__voltCapturePerformance = capturePerformance;
})();
`;

/**
 * Application capture script - storage/cookies/indexedDB summary (best effort)
 */
export const APPLICATION_CAPTURE_SCRIPT = `
(function() {
  if (window.__voltAppInit) return;
  window.__voltAppInit = true;

  function collectStorage(storage, area) {
    const out = [];
    try {
      if (!storage) return out;
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key) continue;
        out.push({
          area,
          key,
          value: storage.getItem(key) || ''
        });
      }
    } catch {}
    return out;
  }

  function collectCookies() {
    const out = [];
    try {
      const raw = document.cookie || '';
      raw.split(';').forEach((part) => {
        const trimmed = part.trim();
        if (!trimmed) return;
        const idx = trimmed.indexOf('=');
        if (idx < 0) {
          out.push({ name: trimmed, value: '' });
          return;
        }
        out.push({
          name: trimmed.slice(0, idx).trim(),
          value: trimmed.slice(idx + 1).trim()
        });
      });
    } catch {}
    return out;
  }

  async function collectIndexedDb() {
    if (!window.indexedDB || typeof window.indexedDB.databases !== 'function') return [];
    try {
      const dbs = await window.indexedDB.databases();
      return (dbs || []).map((db) => ({
        name: db.name || 'unknown',
        version: Number(db.version || 0)
      }));
    } catch {
      return [];
    }
  }

  window.__voltCaptureApplication = async function() {
    if (!window.__TAURI__) return null;
    const indexeddb = await collectIndexedDb();
    const payload = {
      origin: location.origin,
      storage_entries: [
        ...collectStorage(window.localStorage, 'localStorage'),
        ...collectStorage(window.sessionStorage, 'sessionStorage')
      ],
      cookies: collectCookies(),
      indexeddb,
      captured_at: Date.now()
    };
    window.__TAURI__.core.invoke('browser_devtools_application', {
      snapshot: payload
    }).catch(() => {});
    return payload;
  };
})();
`;

/**
 * Security capture script - CSP + mixed-content hints from browser events
 */
export const SECURITY_CAPTURE_SCRIPT = `
(function() {
  if (window.__voltSecurityInit) return;
  window.__voltSecurityInit = true;

  function emitIssue(issue) {
    if (!window.__TAURI__) return;
    window.__TAURI__.core.invoke('browser_devtools_security_issue', {
      issue
    }).catch(() => {});
  }

  window.addEventListener('securitypolicyviolation', function(event) {
    emitIssue({
      kind: 'csp',
      severity: 'high',
      title: 'Content Security Policy violation',
      description: event.violatedDirective || event.effectiveDirective || 'CSP violation',
      url: event.blockedURI || location.href,
      evidence: {
        directive: event.effectiveDirective,
        violated_directive: event.violatedDirective,
        blocked_uri: event.blockedURI,
        source_file: event.sourceFile,
        line: event.lineNumber,
        column: event.columnNumber
      },
      timestamp: Date.now()
    });
  }, true);

  window.addEventListener('error', function(event) {
    const msg = String(event?.message || '').toLowerCase();
    if (!msg.includes('mixed content')) return;
    emitIssue({
      kind: 'mixed-content',
      severity: 'high',
      title: 'Mixed content blocked',
      description: event.message || 'Mixed content blocked',
      url: location.href,
      evidence: { source: event.filename, line: event.lineno, column: event.colno },
      timestamp: Date.now()
    });
  }, true);
})();
`;

/**
 * Combined script that includes all devtools functionality
 */
export const DEVTOOLS_FULL_SCRIPT = `
${CONSOLE_CAPTURE_SCRIPT}
${ERROR_CAPTURE_SCRIPT}
${NETWORK_CAPTURE_SCRIPT}
${PERFORMANCE_CAPTURE_SCRIPT}
${APPLICATION_CAPTURE_SCRIPT}
${SECURITY_CAPTURE_SCRIPT}
`;

/**
 * Get the full devtools injection script
 */
export function getDevToolsScript(): string {
  return DEVTOOLS_FULL_SCRIPT;
}
