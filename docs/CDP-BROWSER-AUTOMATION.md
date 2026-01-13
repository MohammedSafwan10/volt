# Volt CDP Browser Automation - Design Document

## Implementation Status

**Last Updated**: January 2026

| Component | Status | Notes |
|-----------|--------|-------|
| WebView2 CDP Flag | ✅ Done | `--remote-debugging-port=9222` in main.rs |
| chromiumoxide Crate | ✅ Done | Added to Cargo.toml |
| CDP Manager | ✅ Done | `src-tauri/src/cdp/manager.rs` |
| CDP Types | ✅ Done | `src-tauri/src/cdp/types.rs` |
| CDP Commands | ✅ Done | `src-tauri/src/cdp/commands.rs` |
| Frontend Client | ✅ Done | `src/lib/services/browser/cdp.ts` |
| DevTools Store | ✅ Done | Updated to listen to CDP events |
| Browser Store | ✅ Done | Auto-connects CDP on browser create |
| URL Discovery | ✅ Done | `cdp_discover_url` command |
| Console Capture | ✅ Done | Runtime.consoleAPICalled |
| Error Capture | ✅ Done | Runtime.exceptionThrown |
| Network Monitoring | ✅ Done | Network.requestWillBeSent/responseReceived |
| Element Selection | ✅ Done | Via CDP evaluate + DOM queries |
| Browser Automation | ✅ Done | click, type, pressKey, scroll |
| Screenshots | ✅ Done | Page.captureScreenshot |
| Performance Metrics | ✅ Done | Via JS evaluation |
| AI Tool Definitions | ✅ Done | All browser tools in definitions.ts |
| AI Tool Handlers | ✅ Done | CDP-based handlers in browser.ts |
| AI System Prompt | ✅ Done | Browser automation docs in prompts.ts |
| Tool Router | ✅ Done | All browser tools validated |

**Compilation**: ✅ Successful (12 warnings for unused old JS injection functions)

**What's Working**:
- CDP backend fully implemented in Rust
- All browser automation tools available to AI
- Console, errors, network monitoring via CDP
- Click, type, scroll, wait_for, evaluate via CDP
- Screenshots via CDP
- AI system prompt includes browser automation docs

---

## Executive Summary

This document outlines the implementation plan for integrating Chrome DevTools Protocol (CDP) into Volt's embedded browser. CDP is the industry-standard protocol used by Playwright, Puppeteer, and Selenium for browser automation. This upgrade will transform Volt from a basic browser with JS injection into a professional-grade AI-powered browser automation platform.

---

## Why CDP? (Research Findings)

### Current Approach: JS Injection
- **Problem**: `window.__TAURI__` is NOT available in child webviews created with `add_child`
- **Problem**: JS injection can be blocked by CSP (Content Security Policy)
- **Problem**: Limited access to browser internals (network timing, performance, etc.)
- **Problem**: Unreliable element selection IPC

### CDP Approach: Industry Standard
- **Used by**: Playwright, Puppeteer, Selenium 4, Chrome DevTools
- **Benefits**:
  - Native access to Console, Network, DOM, Performance, Runtime
  - Works on ALL sites (no JS injection restrictions)
  - Full browser automation (click, type, screenshot, PDF)
  - Real-time event streaming (console logs, network requests)
  - Future-proof and extensible

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              VOLT IDE                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         AI ASSISTANT                                 │   │
│  │  • browser_get_console_logs()  → CDP: Runtime.consoleAPICalled      │   │
│  │  • browser_get_errors()        → CDP: Runtime.exceptionThrown       │   │
│  │  • browser_get_network()       → CDP: Network.* events              │   │
│  │  • browser_click(selector)     → CDP: DOM + Input.dispatchMouseEvent│   │
│  │  • browser_type(text)          → CDP: Input.dispatchKeyEvent        │   │
│  │  • browser_screenshot()        → CDP: Page.captureScreenshot        │   │
│  │  • browser_get_dom()           → CDP: DOM.getDocument               │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    ↑                                        │
│                                    │ Tauri Commands                         │
│                                    ↓                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      RUST CDP CLIENT                                 │   │
│  │  ┌─────────────────────────────────────────────────────────────┐   │   │
│  │  │ chromiumoxide / cdp-rs                                       │   │   │
│  │  │ • Connects via WebSocket to ws://127.0.0.1:9222              │   │   │
│  │  │ • Subscribes to CDP domains (Runtime, Network, DOM, etc.)    │   │   │
│  │  │ • Sends commands, receives events                            │   │   │
│  │  │ • Streams events to frontend via Tauri events                │   │   │
│  │  └─────────────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    ↑                                        │
│                                    │ WebSocket (CDP)                        │
│                                    ↓                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      WEBVIEW2 (Windows)                              │   │
│  │  Started with: --remote-debugging-port=9222                         │   │
│  │  Exposes: ws://127.0.0.1:9222/devtools/browser/xxx                  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 1: Enable CDP in WebView2 (Windows)

WebView2 supports CDP via the `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` environment variable.

**Source**: [Playwright WebView2 Docs](https://playwright.dev/docs/webview2)

```rust
// In main.rs or browser.rs - BEFORE creating any webview
std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--remote-debugging-port=9222");
```

**Alternative**: Use `CoreWebView2EnvironmentOptions.AdditionalBrowserArguments` if wry exposes it.

**Note**: The env var must be set BEFORE the WebView2 process starts. This means:
1. Set it in `main()` before `tauri::Builder`
2. Or set it in a build script
3. Or pass it when launching the app

### Phase 2: Add CDP Client Crate

Add `chromiumoxide` to `Cargo.toml`:

```toml
[dependencies]
chromiumoxide = { version = "0.7", default-features = false, features = ["tokio-runtime"] }
```

**Why chromiumoxide?**
- High-level async Rust API
- Full CDP type coverage (auto-generated from Chrome PDL)
- Can connect to existing browser via WebSocket
- Active maintenance, 1.5k+ GitHub stars
- Used in production by web scraping tools

### Phase 3: CDP Connection Manager

Create a new module `src-tauri/src/cdp/mod.rs`:

```rust
use chromiumoxide::browser::Browser;
use chromiumoxide::cdp::browser_protocol::runtime::EventConsoleApiCalled;
use chromiumoxide::cdp::browser_protocol::network::{
    EventRequestWillBeSent, EventResponseReceived, EventLoadingFinished
};
use futures::StreamExt;
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct CdpManager {
    browser: Option<Browser>,
    page: Option<chromiumoxide::Page>,
}

impl CdpManager {
    pub fn new() -> Self {
        Self { browser: None, page: None }
    }

    /// Connect to WebView2's CDP endpoint
    pub async fn connect(&mut self, ws_url: &str) -> Result<(), String> {
        let (browser, mut handler) = Browser::connect(ws_url)
            .await
            .map_err(|e| format!("CDP connect failed: {}", e))?;

        // Spawn handler task
        tokio::spawn(async move {
            while handler.next().await.is_some() {}
        });

        self.browser = Some(browser);
        Ok(())
    }

    /// Get or create page for the current tab
    pub async fn get_page(&mut self) -> Result<&chromiumoxide::Page, String> {
        if self.page.is_none() {
            let browser = self.browser.as_ref().ok_or("Not connected")?;
            let pages = browser.pages().await.map_err(|e| e.to_string())?;
            self.page = pages.into_iter().next();
        }
        self.page.as_ref().ok_or("No page available".to_string())
    }
}
```

### Phase 4: CDP Event Subscriptions

Subscribe to CDP domains for real-time events:

```rust
use chromiumoxide::cdp::browser_protocol::runtime;
use chromiumoxide::cdp::browser_protocol::network;
use chromiumoxide::cdp::browser_protocol::log;

impl CdpManager {
    /// Enable console logging and subscribe to events
    pub async fn enable_console(&self, app: AppHandle) -> Result<(), String> {
        let page = self.get_page().await?;
        
        // Enable Runtime domain
        page.execute(runtime::EnableParams::default()).await?;
        
        // Subscribe to console events
        let mut console_events = page.event_listener::<EventConsoleApiCalled>().await?;
        
        let app_clone = app.clone();
        tokio::spawn(async move {
            while let Some(event) = console_events.next().await {
                let log = ConsoleLog {
                    level: event.r#type.to_string(),
                    message: event.args.iter()
                        .map(|a| a.value.as_ref().map(|v| v.to_string()).unwrap_or_default())
                        .collect::<Vec<_>>()
                        .join(" "),
                    timestamp: event.timestamp.inner() as u64,
                    stack: event.stack_trace.map(|s| format!("{:?}", s)),
                };
                let _ = app_clone.emit("cdp://console", &log);
            }
        });
        
        Ok(())
    }

    /// Enable network monitoring
    pub async fn enable_network(&self, app: AppHandle) -> Result<(), String> {
        let page = self.get_page().await?;
        
        // Enable Network domain
        page.execute(network::EnableParams::default()).await?;
        
        // Subscribe to request events
        let mut request_events = page.event_listener::<EventRequestWillBeSent>().await?;
        let mut response_events = page.event_listener::<EventResponseReceived>().await?;
        
        // Handle requests
        let app_clone = app.clone();
        tokio::spawn(async move {
            while let Some(event) = request_events.next().await {
                let req = NetworkRequest {
                    id: event.request_id.inner().to_string(),
                    method: event.request.method.clone(),
                    url: event.request.url.clone(),
                    timestamp: event.timestamp.inner() as u64,
                    ..Default::default()
                };
                let _ = app_clone.emit("cdp://network-request", &req);
            }
        });
        
        // Handle responses
        let app_clone = app.clone();
        tokio::spawn(async move {
            while let Some(event) = response_events.next().await {
                let resp = NetworkResponse {
                    id: event.request_id.inner().to_string(),
                    status: event.response.status as u16,
                    mime_type: event.response.mime_type.clone(),
                    ..Default::default()
                };
                let _ = app_clone.emit("cdp://network-response", &resp);
            }
        });
        
        Ok(())
    }
}
```

### Phase 5: Browser Automation Commands

```rust
impl CdpManager {
    /// Click element by selector
    pub async fn click(&self, selector: &str) -> Result<(), String> {
        let page = self.get_page().await?;
        let element = page.find_element(selector).await
            .map_err(|e| format!("Element not found: {}", e))?;
        element.click().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Type text into focused element
    pub async fn type_text(&self, text: &str) -> Result<(), String> {
        let page = self.get_page().await?;
        page.type_str(text).await.map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Take screenshot
    pub async fn screenshot(&self) -> Result<Vec<u8>, String> {
        let page = self.get_page().await?;
        let screenshot = page.screenshot(
            chromiumoxide::page::ScreenshotParams::builder()
                .format(chromiumoxide::cdp::browser_protocol::page::CaptureScreenshotFormat::Png)
                .build()
        ).await.map_err(|e| e.to_string())?;
        Ok(screenshot)
    }

    /// Get page HTML content
    pub async fn get_content(&self) -> Result<String, String> {
        let page = self.get_page().await?;
        page.content().await.map_err(|e| e.to_string())
    }

    /// Evaluate JavaScript
    pub async fn evaluate(&self, expression: &str) -> Result<serde_json::Value, String> {
        let page = self.get_page().await?;
        let result = page.evaluate(expression).await.map_err(|e| e.to_string())?;
        Ok(result.value().cloned().unwrap_or(serde_json::Value::Null))
    }

    /// Get DOM tree
    pub async fn get_dom(&self) -> Result<String, String> {
        let page = self.get_page().await?;
        let doc = page.execute(
            chromiumoxide::cdp::browser_protocol::dom::GetDocumentParams::builder()
                .depth(-1)
                .build()
        ).await.map_err(|e| e.to_string())?;
        Ok(format!("{:?}", doc.root))
    }
}
```

### Phase 6: Tauri Commands Integration

```rust
// src-tauri/src/commands/cdp.rs

use crate::cdp::CdpManager;
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct CdpState(pub Arc<Mutex<CdpManager>>);

#[tauri::command]
pub async fn cdp_connect(
    state: tauri::State<'_, CdpState>,
) -> Result<(), String> {
    let mut manager = state.0.lock().await;
    // WebView2 exposes CDP at this URL when --remote-debugging-port=9222 is set
    manager.connect("ws://127.0.0.1:9222").await
}

#[tauri::command]
pub async fn cdp_enable_console(
    app: tauri::AppHandle,
    state: tauri::State<'_, CdpState>,
) -> Result<(), String> {
    let manager = state.0.lock().await;
    manager.enable_console(app).await
}

#[tauri::command]
pub async fn cdp_enable_network(
    app: tauri::AppHandle,
    state: tauri::State<'_, CdpState>,
) -> Result<(), String> {
    let manager = state.0.lock().await;
    manager.enable_network(app).await
}

#[tauri::command]
pub async fn cdp_click(
    state: tauri::State<'_, CdpState>,
    selector: String,
) -> Result<(), String> {
    let manager = state.0.lock().await;
    manager.click(&selector).await
}

#[tauri::command]
pub async fn cdp_type(
    state: tauri::State<'_, CdpState>,
    text: String,
) -> Result<(), String> {
    let manager = state.0.lock().await;
    manager.type_text(&text).await
}

#[tauri::command]
pub async fn cdp_screenshot(
    state: tauri::State<'_, CdpState>,
) -> Result<String, String> {
    let manager = state.0.lock().await;
    let bytes = manager.screenshot().await?;
    Ok(base64::encode(&bytes))
}

#[tauri::command]
pub async fn cdp_evaluate(
    state: tauri::State<'_, CdpState>,
    expression: String,
) -> Result<serde_json::Value, String> {
    let manager = state.0.lock().await;
    manager.evaluate(&expression).await
}
```

---

## CDP Domains We'll Use

| Domain | Purpose | Events |
|--------|---------|--------|
| **Runtime** | Console logs, JS evaluation | `consoleAPICalled`, `exceptionThrown` |
| **Network** | HTTP requests/responses | `requestWillBeSent`, `responseReceived`, `loadingFinished` |
| **DOM** | DOM tree, element selection | `documentUpdated`, `childNodeInserted` |
| **Page** | Navigation, screenshots | `loadEventFired`, `frameNavigated` |
| **Input** | Mouse/keyboard events | (commands only) |
| **Performance** | Performance metrics | `metrics` |
| **Log** | Browser logs | `entryAdded` |

---

## Frontend Integration

### Updated Store (browser-devtools.svelte.ts)

```typescript
import { listen } from '@tauri-apps/api/event';

class BrowserDevToolsStore {
  consoleLogs = $state<ConsoleLog[]>([]);
  networkRequests = $state<Map<string, NetworkRequest>>(new Map());
  
  constructor() {
    // Listen to CDP events from Rust
    listen<ConsoleLog>('cdp://console', (event) => {
      this.consoleLogs = [...this.consoleLogs.slice(-499), event.payload];
    });
    
    listen<NetworkRequest>('cdp://network-request', (event) => {
      this.networkRequests.set(event.payload.id, event.payload);
    });
    
    listen<NetworkResponse>('cdp://network-response', (event) => {
      const req = this.networkRequests.get(event.payload.id);
      if (req) {
        req.status = event.payload.status;
        req.mimeType = event.payload.mimeType;
        this.networkRequests = new Map(this.networkRequests);
      }
    });
  }
}
```

### AI Tool Handlers (browser.ts)

```typescript
import { invoke } from '@tauri-apps/api/core';

export async function browser_click(params: { selector: string }) {
  await invoke('cdp_click', { selector: params.selector });
  return { success: true };
}

export async function browser_type(params: { text: string }) {
  await invoke('cdp_type', { text: params.text });
  return { success: true };
}

export async function browser_screenshot() {
  const base64 = await invoke<string>('cdp_screenshot');
  return { image: base64 };
}

export async function browser_evaluate(params: { expression: string }) {
  const result = await invoke('cdp_evaluate', { expression: params.expression });
  return { result };
}
```

---

## Migration Path

### Step 1: Keep Existing JS Injection (Fallback)
- CDP is Windows-only initially (WebView2)
- macOS/Linux will continue using JS injection until webkit2gtk/WKWebView CDP support

### Step 2: Feature Detection
```rust
pub fn is_cdp_available() -> bool {
    #[cfg(target_os = "windows")]
    { true }
    #[cfg(not(target_os = "windows"))]
    { false }
}
```

### Step 3: Gradual Migration
1. Console/Error capture → CDP Runtime domain
2. Network monitoring → CDP Network domain
3. Element selection → CDP DOM domain
4. Browser automation → CDP Input domain
5. Screenshots → CDP Page domain

---

## File Structure

```
src-tauri/src/
├── cdp/
│   ├── mod.rs           # CDP manager, connection handling
│   ├── console.rs       # Console/Runtime domain handlers
│   ├── network.rs       # Network domain handlers
│   ├── dom.rs           # DOM domain handlers
│   └── automation.rs    # Click, type, screenshot commands
├── commands/
│   ├── browser.rs       # Existing browser commands (keep for fallback)
│   └── cdp.rs           # New CDP Tauri commands
└── main.rs              # Set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS

src/lib/
├── stores/
│   └── browser-devtools.svelte.ts  # Updated to listen to CDP events
├── services/
│   ├── browser/
│   │   ├── cdp-client.ts           # Frontend CDP helpers
│   │   └── devtools-inject.ts      # Keep for fallback
│   └── ai/tools/handlers/
│       └── browser.ts              # Updated to use CDP commands
```

---

## Cargo.toml Changes

```toml
[dependencies]
# Existing deps...

# CDP Support
chromiumoxide = { version = "0.7", default-features = false, features = ["tokio-runtime"] }
base64 = "0.22"

# Optional: For WebSocket debugging
tracing = "0.1"
tracing-subscriber = "0.3"
```

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| WebView2 CDP port conflict | Use dynamic port allocation, check if port is available |
| CDP connection drops | Implement reconnection logic with exponential backoff |
| Performance overhead | Only enable needed CDP domains, batch events |
| macOS/Linux support | Keep JS injection as fallback, research webkit2gtk CDP |
| chromiumoxide compile time | Use precompiled CDP types, consider cdp-rs as lighter alternative |

---

## Success Metrics

- [ ] CDP connects successfully to WebView2 on Windows
- [ ] Console logs stream in real-time via CDP
- [ ] Network requests captured with timing data
- [ ] AI can click elements by selector
- [ ] AI can type text into inputs
- [ ] AI can take screenshots
- [ ] Element selection works reliably
- [ ] No performance degradation vs JS injection

---

## Implementation Timeline

### Sprint 1: Foundation (Week 1)
- [ ] Set `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` in main.rs
- [ ] Add chromiumoxide to Cargo.toml
- [ ] Create basic CdpManager with connect()
- [ ] Test CDP connection to WebView2

### Sprint 2: Console & Network (Week 2)
- [ ] Implement Runtime domain (console logs)
- [ ] Implement Network domain (requests/responses)
- [ ] Update frontend stores to listen to CDP events
- [ ] Test with real websites

### Sprint 3: Automation (Week 3)
- [ ] Implement DOM domain (element queries)
- [ ] Implement Input domain (click, type)
- [ ] Implement Page domain (screenshot, PDF)
- [ ] Update AI tool handlers

### Sprint 4: Polish & Fallback (Week 4)
- [ ] Add feature detection for CDP availability
- [ ] Keep JS injection as fallback for non-Windows
- [ ] Performance optimization
- [ ] Documentation and testing

---

## References

- [Chrome DevTools Protocol Docs](https://chromedevtools.github.io/devtools-protocol/)
- [chromiumoxide GitHub](https://github.com/mattsse/chromiumoxide)
- [Playwright WebView2 Docs](https://playwright.dev/docs/webview2)
- [WebView2 Browser Flags](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/webview-features-flags)
- [Tauri Webview Debugging](https://tauri.app/develop/debug/)

---

## Conclusion

CDP integration is the RIGHT approach for Volt's AI-powered browser. It's the same technology used by Playwright, Puppeteer, and professional browser automation tools. While it requires more initial setup than JS injection, it provides:

1. **Reliability**: No CSP restrictions, no IPC issues
2. **Completeness**: Full access to browser internals
3. **Performance**: Native event streaming, no JS overhead
4. **Future-proof**: Industry standard, well-documented
5. **AI-ready**: Perfect for browser automation agents

This will make Volt's browser truly unique among AI IDEs - the only one with professional-grade browser automation built-in.
