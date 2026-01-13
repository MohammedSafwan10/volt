# Volt Browser AI DevTools - System Design

## Vision

Transform Volt's browser into an AI-powered debugging companion. The AI can see everything happening in the browser - console logs, errors, network requests, performance metrics, and selected elements - and proactively help developers debug and improve their apps.

**This is unique to Volt** - no other IDE gives AI direct access to browser DevTools data.

---

## ⚠️ IMPORTANT: CDP Migration

**Status**: ✅ COMPLETE - Migrated from JS injection to Chrome DevTools Protocol (CDP).

**Why CDP?** The old JS injection approach had critical limitations:
- `window.__TAURI__` is NOT available in child webviews (element selection broken)
- JS injection can be blocked by CSP
- Limited access to browser internals

**New Approach**: CDP (same as Playwright/Puppeteer)
- See: [CDP-BROWSER-AUTOMATION.md](./CDP-BROWSER-AUTOMATION.md) for full design

**Current Status**:
- ✅ CDP backend fully implemented in Rust
- ✅ All browser automation tools available to AI
- ✅ Console, errors, network monitoring via CDP
- ✅ Click, type, scroll, wait_for, evaluate via CDP
- ✅ Screenshots via CDP
- ✅ AI system prompt includes browser automation docs
- ✅ Tool definitions and handlers complete

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              VOLT IDE                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         AI ASSISTANT                                 │   │
│  │  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │  │ AI Tools (can call these)                                    │   │   │
│  │  │ • browser_get_console_logs()                                 │   │   │
│  │  │ • browser_get_errors()                                       │   │   │
│  │  │ • browser_get_network_requests()                             │   │   │
│  │  │ • browser_get_performance()                                  │   │   │
│  │  │ • browser_screenshot()                                       │   │   │
│  │  │ • browser_get_selected_element()                             │   │   │
│  │  │ • browser_click() / browser_type() (automation)              │   │   │
│  │  └─────────────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    ↑                                        │
│                                    │ Reads from stores                      │
│                                    ↓                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      SVELTE STORES                                   │   │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                │   │
│  │  │ consoleLogs  │ │ networkReqs  │ │ performance  │                │   │
│  │  │ errors       │ │ selectedEl   │ │ screenshots  │                │   │
│  │  └──────────────┘ └──────────────┘ └──────────────┘                │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    ↑                                        │
│                                    │ Tauri Events                           │
│                                    ↓                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      RUST BACKEND                                    │   │
│  │  • Receives events from injected JS                                 │   │
│  │  • Manages webview lifecycle                                        │   │
│  │  • Takes screenshots                                                │   │
│  │  • Executes JS in webview                                           │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    ↑                                        │
│                                    │ window.__TAURI__.invoke()              │
│                                    ↓                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      BROWSER WEBVIEW                                 │   │
│  │  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │  │ Injected DevTools Script                                     │   │   │
│  │  │ • Intercepts console.log/warn/error                          │   │   │
│  │  │ • Captures unhandled errors + stack traces                   │   │   │
│  │  │ • Hooks fetch/XHR for network monitoring                     │   │   │
│  │  │ • Tracks performance metrics                                 │   │   │
│  │  │ • Element selection with hover highlight                     │   │   │
│  │  └─────────────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Features & Implementation

### Phase 1: Console & Error Capture

**Goal:** AI can see all console output and JS errors

#### 1.1 Injected Script (console-capture.js)
```javascript
(function() {
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info
  };

  function sendToVolt(type, args) {
    window.__TAURI__.invoke('browser_console_log', {
      type,
      message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '),
      timestamp: Date.now(),
      stack: new Error().stack
    });
  }

  console.log = (...args) => { sendToVolt('log', args); originalConsole.log(...args); };
  console.warn = (...args) => { sendToVolt('warn', args); originalConsole.warn(...args); };
  console.error = (...args) => { sendToVolt('error', args); originalConsole.error(...args); };
  console.info = (...args) => { sendToVolt('info', args); originalConsole.info(...args); };

  // Capture unhandled errors
  window.addEventListener('error', (e) => {
    window.__TAURI__.invoke('browser_js_error', {
      message: e.message,
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      stack: e.error?.stack || '',
      timestamp: Date.now()
    });
  });

  // Capture unhandled promise rejections
  window.addEventListener('unhandledrejection', (e) => {
    window.__TAURI__.invoke('browser_js_error', {
      message: `Unhandled Promise Rejection: ${e.reason}`,
      stack: e.reason?.stack || '',
      timestamp: Date.now()
    });
  });
})();
```

#### 1.2 Rust Commands
```rust
#[tauri::command]
fn browser_console_log(log_type: String, message: String, timestamp: u64, stack: String) {
    // Emit to frontend
    app.emit("browser://console-log", ConsoleLog { log_type, message, timestamp, stack });
}

#[tauri::command]
fn browser_js_error(message: String, filename: String, lineno: u32, colno: u32, stack: String) {
    app.emit("browser://js-error", JsError { message, filename, lineno, colno, stack });
}
```

#### 1.3 Svelte Store (browser-devtools.svelte.ts)
```typescript
interface ConsoleLog {
  type: 'log' | 'warn' | 'error' | 'info';
  message: string;
  timestamp: number;
  stack?: string;
}

interface JsError {
  message: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  stack?: string;
  timestamp: number;
}

class BrowserDevToolsStore {
  consoleLogs = $state<ConsoleLog[]>([]);
  errors = $state<JsError[]>([]);
  
  // Max 500 logs to prevent memory issues
  addLog(log: ConsoleLog) {
    this.consoleLogs = [...this.consoleLogs.slice(-499), log];
  }
  
  addError(error: JsError) {
    this.errors = [...this.errors.slice(-99), error];
  }
  
  clearLogs() { this.consoleLogs = []; }
  clearErrors() { this.errors = []; }
}
```

#### 1.4 AI Tools
```typescript
// tools/handlers/browser.ts
export async function browser_get_console_logs(params: { limit?: number, type?: string }) {
  const logs = browserDevToolsStore.consoleLogs;
  let filtered = logs;
  if (params.type) filtered = logs.filter(l => l.type === params.type);
  if (params.limit) filtered = filtered.slice(-params.limit);
  return filtered;
}

export async function browser_get_errors(params: { limit?: number }) {
  return browserDevToolsStore.errors.slice(-(params.limit || 20));
}
```

---

### Phase 2: Network Request Monitoring

**Goal:** AI can see all API calls, status codes, timing, and responses

#### 2.1 Injected Script (network-capture.js)
```javascript
(function() {
  // Hook fetch
  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    const startTime = performance.now();
    const request = new Request(...args);
    const id = crypto.randomUUID();
    
    window.__TAURI__.invoke('browser_network_request', {
      id,
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers),
      timestamp: Date.now()
    });
    
    try {
      const response = await originalFetch(...args);
      const duration = performance.now() - startTime;
      const clonedResponse = response.clone();
      
      // Try to get response body (may fail for large responses)
      let body = null;
      try {
        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          body = await clonedResponse.text();
        }
      } catch {}
      
      window.__TAURI__.invoke('browser_network_response', {
        id,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
        duration,
        body: body?.slice(0, 10000) // Limit body size
      });
      
      return response;
    } catch (error) {
      window.__TAURI__.invoke('browser_network_error', {
        id,
        error: error.message
      });
      throw error;
    }
  };

  // Hook XMLHttpRequest
  const originalXHR = window.XMLHttpRequest;
  // ... similar implementation
})();
```

#### 2.2 Store Structure
```typescript
interface NetworkRequest {
  id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  timestamp: number;
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  duration?: number;
  body?: string;
  error?: string;
}
```

#### 2.3 AI Tool
```typescript
export async function browser_get_network_requests(params: { 
  limit?: number,
  status?: number,  // Filter by status code
  method?: string,  // Filter by method
  urlPattern?: string  // Filter by URL pattern
}) {
  let requests = browserDevToolsStore.networkRequests;
  // Apply filters...
  return requests;
}
```

---

### Phase 3: Element Selection → Chat Integration

**Goal:** User selects element, attaches to chat, AI receives full context

#### 3.1 Enhanced Element Selection
```typescript
interface SelectedElement {
  tagName: string;
  id: string;
  classes: string[];
  attributes: Record<string, string>;
  html: string;           // outerHTML (truncated)
  innerText: string;      // Text content
  css: Record<string, string>;  // Computed styles
  rect: { x, y, width, height };
  selector: string;       // CSS selector
  xpath: string;          // XPath
  parentChain: string[];  // Parent tag names
  screenshot?: string;    // Base64 screenshot of element
}
```

#### 3.2 Chat Input Integration
```svelte
<!-- ChatInputBar.svelte -->
<div class="chat-input">
  {#if attachedElement}
    <div class="attached-element">
      <span class="element-tag">&lt;{attachedElement.tagName.toLowerCase()}&gt;</span>
      {#if attachedElement.id}
        <span class="element-id">#{attachedElement.id}</span>
      {/if}
      {#if attachedElement.classes.length}
        <span class="element-class">.{attachedElement.classes[0]}</span>
      {/if}
      <button onclick={() => attachedElement = null}>×</button>
    </div>
  {/if}
  
  <textarea placeholder="Ask about the selected element..." />
  <button>Send</button>
</div>
```

#### 3.3 Quick Actions on Selection
```svelte
<!-- ElementInspector.svelte - Add quick action buttons -->
<div class="quick-actions">
  <button onclick={() => askAI('Improve the styling of this element')}>
    ✨ Improve Style
  </button>
  <button onclick={() => askAI('Make this element accessible')}>
    ♿ Fix Accessibility
  </button>
  <button onclick={() => askAI('Add hover animation')}>
    🎬 Add Animation
  </button>
  <button onclick={() => findInCode()}>
    📁 Find in Code
  </button>
</div>
```

---

### Phase 4: Performance Metrics

**Goal:** AI can analyze page performance

#### 4.1 Metrics Captured
```typescript
interface PerformanceMetrics {
  // Navigation Timing
  domContentLoaded: number;
  loadComplete: number;
  firstPaint: number;
  firstContentfulPaint: number;
  largestContentfulPaint: number;
  
  // Resource Timing
  resources: {
    name: string;
    type: string;
    duration: number;
    size: number;
  }[];
  
  // Memory (if available)
  jsHeapSize?: number;
  
  // Custom marks
  marks: { name: string; timestamp: number }[];
}
```

#### 4.2 AI Tool
```typescript
export async function browser_get_performance() {
  return browserDevToolsStore.performanceMetrics;
}
```

---

### Phase 5: Screenshot Capture

**Goal:** AI can see the current page visually

#### 5.1 Rust Implementation
```rust
#[tauri::command]
async fn browser_take_screenshot(app: AppHandle) -> Result<String, String> {
    // Use wry's screenshot capability or platform-specific APIs
    // Return base64 encoded PNG
}

#[tauri::command]
async fn browser_screenshot_element(app: AppHandle, selector: String) -> Result<String, String> {
    // Screenshot specific element by selector
}
```

#### 5.2 AI Tool
```typescript
export async function browser_screenshot(params: { 
  selector?: string,  // Optional: screenshot specific element
  fullPage?: boolean  // Capture full scrollable page
}) {
  return await invoke('browser_take_screenshot', params);
}
```

---

## UI Components

### Console Panel (collapsible, bottom of browser)
```
┌─────────────────────────────────────────────────────────────┐
│ Console (12)  Errors (3)  Network (45)  Performance    [−] │
├─────────────────────────────────────────────────────────────┤
│ 📝 10:23:45  Object { user: "john", id: 123 }              │
│ ⚠️ 10:23:46  Warning: Each child should have unique key    │
│ ❌ 10:23:47  TypeError: Cannot read property 'map' of und  │
│ 📝 10:23:48  [HMR] Updated: App.svelte                     │
│ ℹ️ 10:23:49  API Response: 200 OK (145ms)                  │
├─────────────────────────────────────────────────────────────┤
│ [Clear] [Filter: All ▼] [🤖 Ask AI about errors]          │
└─────────────────────────────────────────────────────────────┘
```

### Network Panel
```
┌─────────────────────────────────────────────────────────────┐
│ Method │ URL                    │ Status │ Time  │ Size   │
├────────┼────────────────────────┼────────┼───────┼────────┤
│ GET    │ /api/users             │ 200    │ 145ms │ 2.3KB  │
│ POST   │ /api/login             │ 401    │ 89ms  │ 156B   │
│ GET    │ /api/products?page=1   │ 200    │ 234ms │ 15KB   │
└─────────────────────────────────────────────────────────────┘
```

---

## AI Integration Examples

### Example 1: Proactive Error Detection
```
AI: "I noticed 3 JavaScript errors in your app:

1. TypeError at UserProfile.tsx:42 - 'user' is undefined
   → You're accessing user.name before the data loads
   
2. Failed API call: POST /api/login returned 401
   → Check your authentication token
   
3. React key warning in ProductList.tsx
   → Add key prop to your map() items

Would you like me to fix these?"
```

### Example 2: Element Improvement
```
User: [Attaches <button class="btn">] "Make this look better"

AI: "I'll improve this button with modern styling:

- Added rounded corners and subtle shadow
- Improved hover state with smooth transition  
- Better padding and font weight
- Added focus ring for accessibility

[Shows code diff]

Want me to apply these changes?"
```

### Example 3: Performance Analysis
```
User: "Why is my page slow?"

AI: "I analyzed your page performance:

🔴 Issues Found:
- LCP (Largest Contentful Paint): 4.2s (should be < 2.5s)
- 3 render-blocking scripts in <head>
- hero-image.png is 2.4MB (should be < 200KB)
- 12 unused CSS rules (45KB)

🟢 Recommendations:
1. Lazy load images below the fold
2. Move scripts to end of body or use defer
3. Compress hero image with WebP format
4. Remove unused CSS with PurgeCSS

Want me to implement these optimizations?"
```

---

## File Structure

```
src/lib/
├── stores/
│   └── browser-devtools.svelte.ts    # Console, errors, network, perf stores
├── components/
│   └── browser/
│       ├── ConsolePanel.svelte       # Console log viewer
│       ├── NetworkPanel.svelte       # Network request viewer
│       ├── PerformancePanel.svelte   # Performance metrics
│       ├── DevToolsTabs.svelte       # Tab container
│       └── ElementInspector.svelte   # Enhanced with quick actions
├── services/
│   └── ai/
│       └── tools/
│           └── handlers/
│               └── browser.ts        # AI tool handlers

src-tauri/src/
├── commands/
│   └── browser.rs                    # Add devtools commands
└── scripts/
    ├── console-capture.js            # Injected console capture
    ├── network-capture.js            # Injected network capture
    └── element-selector.js           # Enhanced element selection
```

---

## Implementation Order

### Sprint 1: Console & Errors (Foundation) ✅ DONE
- [x] Create browser-devtools.svelte.ts store
- [x] Implement console capture (CDP Runtime domain)
- [x] Add Rust commands for console/error events
- [x] Create ConsolePanel.svelte UI
- [x] Add AI tools: browser_get_console_logs, browser_get_errors

### Sprint 2: CDP Migration ✅ DONE
- [x] Enable CDP in WebView2 (set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS)
- [x] Add chromiumoxide crate to Cargo.toml
- [x] Create CdpManager for connection handling
- [x] Migrate console capture to CDP Runtime domain
- [x] Fix element selection using CDP DOM domain
- See: [CDP-BROWSER-AUTOMATION.md](./CDP-BROWSER-AUTOMATION.md)

### Sprint 3: Browser Automation ✅ DONE
- [x] Implement click via CDP
- [x] Implement type via CDP
- [x] Implement scroll via CDP
- [x] Implement wait_for via CDP
- [x] Implement evaluate via CDP
- [x] Add AI tools: browser_click, browser_type, browser_scroll, etc.

### Sprint 4: Screenshots & Network ✅ DONE
- [x] Implement screenshot via CDP Page.captureScreenshot
- [x] Add AI tool: browser_screenshot
- [x] Enable CDP Network domain
- [x] Stream network events to frontend
- [x] Add AI tool: browser_get_network_requests

### Sprint 5: AI Integration ✅ DONE
- [x] Update AI tool definitions (definitions.ts)
- [x] Update AI tool handlers (browser.ts)
- [x] Update AI system prompt (prompts.ts)
- [x] Update tool router (router.ts)

### Sprint 6: Element → Chat Integration (TODO)
- [ ] Enhance ElementInspector with quick actions
- [ ] Add "Attach to chat" functionality
- [ ] Show attached element chip in ChatInputBar
- [ ] Include element context in AI messages
- [ ] Add "Find in code" feature (trace element to source file)

### Sprint 7: Polish & AI Proactivity (TODO)
- [ ] AI proactively mentions errors when detected
- [ ] Smart suggestions based on console output
- [ ] Performance recommendations
- [ ] Keyboard shortcuts for DevTools panels

---

## Success Metrics

- [ ] AI can read console logs and identify errors
- [ ] AI can see network requests and debug API issues
- [ ] User can select element and get AI suggestions in < 3 clicks
- [ ] AI can take screenshots and analyze UI
- [ ] DevTools panels are fast and don't impact browser performance
- [ ] All data is accessible via AI tools

---

## Notes

- Keep injected scripts minimal to avoid performance impact
- Limit stored data (max 500 logs, 200 network requests)
- Truncate large response bodies (max 10KB)
- Screenshots should be compressed
- Consider privacy: don't capture sensitive form data
