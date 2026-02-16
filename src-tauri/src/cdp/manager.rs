//! CDP Manager - Core CDP connection and event handling
//!
//! Manages the WebSocket connection to WebView2's CDP endpoint and provides
//! high-level APIs for browser automation.

use crate::cdp::types::*;
use chromiumoxide::browser::Browser;
use chromiumoxide::cdp::browser_protocol::network;
use chromiumoxide::cdp::browser_protocol::page;
use chromiumoxide::cdp::js_protocol::runtime;
use chromiumoxide::Page;
use futures::StreamExt;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use tauri::{AppHandle, Emitter, Runtime};

/// CDP Manager state
pub struct CdpManager {
    /// Connected browser instance
    browser: Arc<RwLock<Option<Browser>>>,
    /// Current page/tab
    page: Arc<RwLock<Option<Page>>>,
    /// Connection status
    status: Arc<RwLock<CdpStatus>>,
    /// Console logs buffer (last 500)
    console_logs: Arc<Mutex<Vec<CdpConsoleLog>>>,
    /// JS errors buffer (last 100)
    js_errors: Arc<Mutex<Vec<CdpJsError>>>,
    /// Network requests buffer (last 200)
    network_requests: Arc<Mutex<HashMap<String, CdpNetworkRequest>>>,
    /// Network responses buffer
    network_responses: Arc<Mutex<HashMap<String, CdpNetworkResponse>>>,
    /// Event handler task handle
    handler_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    /// Console event listener handle
    console_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    /// Network event listener handle
    network_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

impl Default for CdpManager {
    fn default() -> Self {
        Self::new()
    }
}

impl CdpManager {
    fn extract_origin(url: &str) -> Option<String> {
        let scheme_idx = url.find("://")?;
        let rest = &url[scheme_idx + 3..];
        let host_end = rest.find('/').unwrap_or(rest.len());
        let authority = &rest[..host_end];
        if authority.is_empty() {
            return None;
        }
        Some(format!("{}://{}", &url[..scheme_idx], authority))
    }

    fn is_ignored_volt_page(url: &str) -> bool {
        // Volt host app pages (dev/prod) should not be treated as browser targets by default.
        url.starts_with("tauri://")
            || url.starts_with("about:")
            || url.starts_with("http://tauri.localhost")
            || url.starts_with("https://tauri.localhost")
            || url.starts_with("http://localhost:1420")
            || url.starts_with("http://127.0.0.1:1420")
            || url.starts_with("http://localhost:1421")
            || url.starts_with("http://127.0.0.1:1421")
    }

    pub fn new() -> Self {
        Self {
            browser: Arc::new(RwLock::new(None)),
            page: Arc::new(RwLock::new(None)),
            status: Arc::new(RwLock::new(CdpStatus {
                connected: false,
                ws_url: None,
                target_id: None,
                error: None,
                available: cfg!(target_os = "windows"),
            })),
            console_logs: Arc::new(Mutex::new(Vec::with_capacity(500))),
            js_errors: Arc::new(Mutex::new(Vec::with_capacity(100))),
            network_requests: Arc::new(Mutex::new(HashMap::new())),
            network_responses: Arc::new(Mutex::new(HashMap::new())),
            handler_handle: Arc::new(Mutex::new(None)),
            console_handle: Arc::new(Mutex::new(None)),
            network_handle: Arc::new(Mutex::new(None)),
        }
    }

    /// Check if CDP is available on this platform
    pub fn is_available(&self) -> bool {
        cfg!(target_os = "windows")
    }

    /// Get current connection status
    pub async fn get_status(&self) -> CdpStatus {
        self.status.read().await.clone()
    }

    /// Connect to WebView2's CDP endpoint
    pub async fn connect(&self, ws_url: &str) -> Result<(), String> {
        self.disconnect().await?;

        tracing::info!("CDP: Connecting to {}", ws_url);

        let (browser, mut handler) = Browser::connect(ws_url)
            .await
            .map_err(|e| format!("CDP connection failed: {}", e))?;

        let handler_handle = tokio::spawn(async move {
            while handler.next().await.is_some() {}
            tracing::info!("CDP: Handler task ended");
        });

        *self.browser.write().await = Some(browser);
        *self.handler_handle.lock().await = Some(handler_handle);

        {
            let mut status = self.status.write().await;
            status.connected = true;
            status.ws_url = Some(ws_url.to_string());
            status.error = None;
        }

        tracing::info!("CDP: Connected successfully");
        Ok(())
    }

    /// Disconnect from CDP
    pub async fn disconnect(&self) -> Result<(), String> {
        tracing::info!("CDP: Disconnecting...");

        if let Some(handle) = self.console_handle.lock().await.take() {
            handle.abort();
        }
        if let Some(handle) = self.network_handle.lock().await.take() {
            handle.abort();
        }

        if let Some(mut browser) = self.browser.write().await.take() {
            let _ = browser.close().await;
        }

        if let Some(handle) = self.handler_handle.lock().await.take() {
            handle.abort();
        }

        *self.page.write().await = None;

        {
            let mut status = self.status.write().await;
            status.connected = false;
            status.ws_url = None;
            status.target_id = None;
        }

        tracing::info!("CDP: Disconnected");
        Ok(())
    }

    /// Attach to a specific page/target
    /// If target_url is provided, finds the page with that URL
    /// Otherwise attaches to the first non-Volt page (filters out tauri://localhost)
    pub async fn attach_to_page(&self, target_url: Option<&str>) -> Result<(), String> {
        let browser = self.browser.read().await;
        let browser = browser.as_ref().ok_or("CDP not connected")?;

        // Get all available pages
        let pages = browser.pages().await.map_err(|e| e.to_string())?;
        
        if pages.is_empty() {
            return Err("No pages available".to_string());
        }
        
        // Find the right page
        let page = if let Some(url) = target_url {
            // Find page with matching URL
            let mut found_page = None;
            let target_origin = Self::extract_origin(url);
            for p in pages {
                if let Ok(Some(page_url)) = p.url().await {
                    let same_url = page_url == url || page_url.starts_with(url);
                    let same_origin = match (&target_origin, Self::extract_origin(&page_url)) {
                        (Some(target), Some(page_origin)) => target == &page_origin,
                        _ => false,
                    };
                    if same_url || same_origin {
                        found_page = Some(p);
                        break;
                    }
                }
            }
            found_page.ok_or_else(|| format!("No page found with URL containing: {}", url))?
        } else {
            // Find first page that's not Volt's own app shell.
            let mut found_page = None;
            for p in pages {
                if let Ok(Some(page_url)) = p.url().await {
                    if !page_url.is_empty() && !Self::is_ignored_volt_page(&page_url) {
                        tracing::info!("CDP: Found browser page: {}", page_url);
                        found_page = Some(p);
                        break;
                    }
                }
            }
            found_page.ok_or("No browser page found (only Volt host windows detected)")?
        };

        *self.page.write().await = Some(page);
        Ok(())
    }

    /// Enable console logging and start streaming events
    pub async fn enable_console<R: Runtime>(&self, app: AppHandle<R>) -> Result<(), String> {
        let page = self.page.read().await;
        let page = page.as_ref().ok_or("No page attached")?;

        // Enable Runtime domain
        page.execute(runtime::EnableParams::default())
            .await
            .map_err(|e| format!("Failed to enable Runtime: {}", e))?;

        // Subscribe to console events
        let mut console_events = page
            .event_listener::<runtime::EventConsoleApiCalled>()
            .await
            .map_err(|e| format!("Failed to subscribe to console events: {}", e))?;

        // Subscribe to exception events
        let mut exception_events = page
            .event_listener::<runtime::EventExceptionThrown>()
            .await
            .map_err(|e| format!("Failed to subscribe to exception events: {}", e))?;

        let console_logs = self.console_logs.clone();
        let js_errors = self.js_errors.clone();
        let app_clone = app.clone();

        let console_handle = tokio::spawn(async move {
            loop {
                tokio::select! {
                    Some(event) = console_events.next() => {
                        let log = CdpConsoleLog {
                            level: format!("{:?}", event.r#type).to_lowercase(),
                            message: event.args.iter()
                                .filter_map(|arg| arg.value.as_ref().map(|v| v.to_string()))
                                .collect::<Vec<_>>()
                                .join(" "),
                            args: event.args.iter()
                                .filter_map(|arg| arg.value.as_ref().map(|v| v.to_string()))
                                .collect(),
                            source: None,
                            line: None,
                            column: None,
                            stack: event.stack_trace.as_ref().map(|st| format!("{:?}", st)),
                            timestamp: (event.timestamp.inner() * 1000.0) as u64,
                        };

                        {
                            let mut logs = console_logs.lock().await;
                            if logs.len() >= 500 { logs.remove(0); }
                            logs.push(log.clone());
                        }

                        let _ = app_clone.emit("cdp://console", &log);
                    }
                    Some(event) = exception_events.next() => {
                        let details = &event.exception_details;
                        let error = CdpJsError {
                            message: details.text.clone(),
                            description: details.exception.as_ref().and_then(|e| e.description.clone()),
                            url: details.url.clone(),
                            line: Some(details.line_number as u32 + 1),
                            column: Some(details.column_number as u32 + 1),
                            stack: details.stack_trace.as_ref().map(|st| format!("{:?}", st)),
                            error_type: details.exception.as_ref().and_then(|e| e.class_name.clone()),
                            timestamp: std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis() as u64,
                        };

                        {
                            let mut errors = js_errors.lock().await;
                            if errors.len() >= 100 { errors.remove(0); }
                            errors.push(error.clone());
                        }

                        let _ = app_clone.emit("cdp://error", &error);
                    }
                    else => break,
                }
            }
        });

        *self.console_handle.lock().await = Some(console_handle);
        tracing::info!("CDP: Console logging enabled");
        Ok(())
    }

    /// Enable network monitoring and start streaming events
    pub async fn enable_network<R: Runtime>(&self, app: AppHandle<R>) -> Result<(), String> {
        let page = self.page.read().await;
        let page = page.as_ref().ok_or("No page attached")?;

        page.execute(network::EnableParams::default())
            .await
            .map_err(|e| format!("Failed to enable Network: {}", e))?;

        let mut request_events = page
            .event_listener::<network::EventRequestWillBeSent>()
            .await
            .map_err(|e| format!("Failed to subscribe to request events: {}", e))?;

        let mut response_events = page
            .event_listener::<network::EventResponseReceived>()
            .await
            .map_err(|e| format!("Failed to subscribe to response events: {}", e))?;

        let network_requests = self.network_requests.clone();
        let network_responses = self.network_responses.clone();
        let app_clone = app.clone();

        let network_handle = tokio::spawn(async move {
            loop {
                tokio::select! {
                    Some(event) = request_events.next() => {
                        let request = CdpNetworkRequest {
                            id: event.request_id.inner().to_string(),
                            method: event.request.method.clone(),
                            url: event.request.url.clone(),
                            headers: HashMap::new(), // Headers are private
                            body: None,
                            resource_type: Some(format!("{:?}", event.r#type)),
                            initiator: Some(format!("{:?}", event.initiator.r#type)),
                            timestamp: (event.timestamp.inner() * 1000.0) as u64,
                        };

                        {
                            let mut requests = network_requests.lock().await;
                            if requests.len() >= 200 {
                                if let Some(oldest_key) = requests.keys().next().cloned() {
                                    requests.remove(&oldest_key);
                                }
                            }
                            requests.insert(request.id.clone(), request.clone());
                        }

                        let _ = app_clone.emit("cdp://network-request", &request);
                    }
                    Some(event) = response_events.next() => {
                        let response = CdpNetworkResponse {
                            id: event.request_id.inner().to_string(),
                            status: event.response.status as u16,
                            status_text: event.response.status_text.clone(),
                            headers: HashMap::new(),
                            mime_type: Some(event.response.mime_type.clone()),
                            body: None,
                            size: Some(event.response.encoded_data_length as u64),
                            duration: None,
                            from_cache: event.response.from_disk_cache.unwrap_or(false),
                            timestamp: (event.timestamp.inner() * 1000.0) as u64,
                        };

                        {
                            let mut responses = network_responses.lock().await;
                            responses.insert(response.id.clone(), response.clone());
                        }

                        let _ = app_clone.emit("cdp://network-response", &response);
                    }
                    else => break,
                }
            }
        });

        *self.network_handle.lock().await = Some(network_handle);
        tracing::info!("CDP: Network monitoring enabled");
        Ok(())
    }

    /// Get buffered console logs
    pub async fn get_console_logs(&self, limit: Option<usize>) -> Vec<CdpConsoleLog> {
        let logs = self.console_logs.lock().await;
        let limit = limit.unwrap_or(100).min(logs.len());
        logs.iter().rev().take(limit).cloned().collect::<Vec<_>>().into_iter().rev().collect()
    }

    /// Get buffered JS errors
    pub async fn get_js_errors(&self, limit: Option<usize>) -> Vec<CdpJsError> {
        let errors = self.js_errors.lock().await;
        let limit = limit.unwrap_or(50).min(errors.len());
        errors.iter().rev().take(limit).cloned().collect::<Vec<_>>().into_iter().rev().collect()
    }

    /// Get buffered network requests
    pub async fn get_network_requests(&self, limit: Option<usize>) -> Vec<CdpNetworkRequest> {
        let requests = self.network_requests.lock().await;
        let mut reqs: Vec<_> = requests.values().cloned().collect();
        reqs.sort_by_key(|r| r.timestamp);
        let limit = limit.unwrap_or(100).min(reqs.len());
        reqs.into_iter().rev().take(limit).collect::<Vec<_>>().into_iter().rev().collect()
    }

    /// Clear console logs buffer
    pub async fn clear_console_logs(&self) {
        self.console_logs.lock().await.clear();
    }

    /// Clear JS errors buffer
    pub async fn clear_js_errors(&self) {
        self.js_errors.lock().await.clear();
    }

    /// Clear network buffers
    pub async fn clear_network(&self) {
        self.network_requests.lock().await.clear();
        self.network_responses.lock().await.clear();
    }

    /// Navigate to a URL
    pub async fn navigate(&self, url: &str) -> Result<(), String> {
        let page = self.page.read().await;
        let page = page.as_ref().ok_or("No page attached")?;
        page.goto(url).await.map_err(|e| format!("Navigation failed: {}", e))?;
        Ok(())
    }

    /// Click an element by CSS selector
    pub async fn click(&self, selector: &str) -> Result<CdpClickResult, String> {
        let page = self.page.read().await;
        let page = page.as_ref().ok_or("No page attached")?;

        match page.find_element(selector).await {
            Ok(element) => {
                match element.click().await {
                    Ok(_) => Ok(CdpClickResult {
                        success: true,
                        element_found: true,
                        selector: selector.to_string(),
                        error: None,
                    }),
                    Err(e) => Ok(CdpClickResult {
                        success: false,
                        element_found: true,
                        selector: selector.to_string(),
                        error: Some(format!("Click failed: {}", e)),
                    }),
                }
            }
            Err(e) => Ok(CdpClickResult {
                success: false,
                element_found: false,
                selector: selector.to_string(),
                error: Some(format!("Element not found: {}", e)),
            }),
        }
    }

    /// Type text into the focused element or a specific element
    pub async fn type_text(&self, text: &str, selector: Option<&str>) -> Result<CdpTypeResult, String> {
        let page = self.page.read().await;
        let page = page.as_ref().ok_or("No page attached")?;

        if let Some(sel) = selector {
            match page.find_element(sel).await {
                Ok(element) => {
                    if let Err(e) = element.click().await {
                        return Ok(CdpTypeResult {
                            success: false,
                            text: text.to_string(),
                            error: Some(format!("Failed to focus element: {}", e)),
                        });
                    }
                    // Type into the element
                    if let Err(e) = element.type_str(text).await {
                        return Ok(CdpTypeResult {
                            success: false,
                            text: text.to_string(),
                            error: Some(format!("Type failed: {}", e)),
                        });
                    }
                }
                Err(e) => {
                    return Ok(CdpTypeResult {
                        success: false,
                        text: text.to_string(),
                        error: Some(format!("Element not found: {}", e)),
                    });
                }
            }
        }

        Ok(CdpTypeResult {
            success: true,
            text: text.to_string(),
            error: None,
        })
    }

    /// Press a key
    pub async fn press_key(&self, key: &str) -> Result<(), String> {
        let page = self.page.read().await;
        let page = page.as_ref().ok_or("No page attached")?;
        
        // Use keyboard input via evaluate
        let script = format!(
            r#"document.dispatchEvent(new KeyboardEvent('keydown', {{ key: '{}' }}))"#,
            key
        );
        page.evaluate(script).await.map_err(|e| format!("Key press failed: {}", e))?;
        Ok(())
    }

    /// Take a screenshot of the page
    pub async fn screenshot(&self, full_page: bool) -> Result<CdpScreenshot, String> {
        use chromiumoxide::page::ScreenshotParams;
        
        let page = self.page.read().await;
        let page = page.as_ref().ok_or("No page attached")?;

        let params = ScreenshotParams::builder()
            .format(page::CaptureScreenshotFormat::Png)
            .full_page(full_page)
            .build();

        let screenshot_bytes = page.screenshot(params)
            .await
            .map_err(|e| format!("Screenshot failed: {}", e))?;

        use base64::Engine;
        Ok(CdpScreenshot {
            data: base64::engine::general_purpose::STANDARD.encode(&screenshot_bytes),
            format: "png".to_string(),
            width: 0,
            height: 0,
        })
    }

    /// Take a screenshot of a specific element
    pub async fn screenshot_element(&self, selector: &str) -> Result<CdpScreenshot, String> {
        use base64::Engine;
        
        let page = self.page.read().await;
        let page = page.as_ref().ok_or("No page attached")?;

        let element = page.find_element(selector).await.map_err(|e| format!("Element not found: {}", e))?;
        let screenshot = element.screenshot(page::CaptureScreenshotFormat::Png).await.map_err(|e| format!("Screenshot failed: {}", e))?;

        Ok(CdpScreenshot {
            data: base64::engine::general_purpose::STANDARD.encode(&screenshot),
            format: "png".to_string(),
            width: 0,
            height: 0,
        })
    }

    /// Evaluate JavaScript expression and return result
    pub async fn evaluate(&self, expression: &str) -> Result<CdpEvaluateResult, String> {
        let page = self.page.read().await;
        let page = page.as_ref().ok_or("No page attached")?;

        match page.evaluate(expression.to_string()).await {
            Ok(result) => {
                let value = result.value().cloned().unwrap_or(serde_json::Value::Null);
                Ok(CdpEvaluateResult {
                    success: true,
                    value,
                    error: None,
                })
            }
            Err(e) => Ok(CdpEvaluateResult {
                success: false,
                value: serde_json::Value::Null,
                error: Some(format!("Evaluation failed: {}", e)),
            }),
        }
    }

    /// Get page HTML content
    pub async fn get_content(&self) -> Result<String, String> {
        let page = self.page.read().await;
        let page = page.as_ref().ok_or("No page attached")?;
        page.content().await.map_err(|e| format!("Failed to get content: {}", e))
    }

    /// Get page title
    pub async fn get_title(&self) -> Result<String, String> {
        let page = self.page.read().await;
        let page = page.as_ref().ok_or("No page attached")?;
        let result = page.evaluate("document.title".to_string()).await.map_err(|e| format!("Failed to get title: {}", e))?;
        Ok(result.value().and_then(|v| v.as_str()).unwrap_or("").to_string())
    }

    /// Get current URL
    pub async fn get_url(&self) -> Result<String, String> {
        let page = self.page.read().await;
        let page = page.as_ref().ok_or("No page attached")?;
        let result = page.evaluate("window.location.href".to_string()).await.map_err(|e| format!("Failed to get URL: {}", e))?;
        Ok(result.value().and_then(|v| v.as_str()).unwrap_or("").to_string())
    }

    /// Wait for an element to appear
    pub async fn wait_for_selector(&self, selector: &str, timeout_ms: u64) -> Result<bool, String> {
        let page = self.page.read().await;
        let page = page.as_ref().ok_or("No page attached")?;

        let start = std::time::Instant::now();
        let timeout = std::time::Duration::from_millis(timeout_ms);

        while start.elapsed() < timeout {
            if page.find_element(selector).await.is_ok() {
                return Ok(true);
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }

        Ok(false)
    }

    /// Get element information by selector
    pub async fn get_element(&self, selector: &str) -> Result<Option<CdpElement>, String> {
        let page = self.page.read().await;
        let page = page.as_ref().ok_or("No page attached")?;

        let script = format!(r#"
            (function() {{
                const el = document.querySelector('{}');
                if (!el) return null;
                const rect = el.getBoundingClientRect();
                return {{
                    tagName: el.tagName.toLowerCase(),
                    id: el.id || null,
                    classes: Array.from(el.classList),
                    outerHtml: el.outerHTML.slice(0, 5000),
                    innerText: el.innerText?.slice(0, 2000) || '',
                    rect: {{ x: rect.x, y: rect.y, width: rect.width, height: rect.height }},
                    selector: '{}',
                }};
            }})()
        "#, selector.replace('\'', "\\'"), selector.replace('\'', "\\'"));

        let result = page.evaluate(script).await.map_err(|e| e.to_string())?;
        
        if let Some(value) = result.value() {
            if value.is_null() {
                return Ok(None);
            }
            
            let el = CdpElement {
                node_id: 0,
                backend_node_id: None,
                tag_name: value.get("tagName").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                id: value.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()),
                classes: value.get("classes")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default(),
                attributes: HashMap::new(),
                outer_html: value.get("outerHtml").and_then(|v| v.as_str()).map(|s| s.to_string()),
                inner_text: value.get("innerText").and_then(|v| v.as_str()).map(|s| s.to_string()),
                computed_styles: HashMap::new(),
                rect: value.get("rect").and_then(|v| {
                    Some(CdpRect {
                        x: v.get("x")?.as_f64()?,
                        y: v.get("y")?.as_f64()?,
                        width: v.get("width")?.as_f64()?,
                        height: v.get("height")?.as_f64()?,
                    })
                }),
                selector: selector.to_string(),
                xpath: String::new(),
            };
            
            return Ok(Some(el));
        }
        
        Ok(None)
    }

    /// Get multiple elements by selector
    pub async fn get_elements(&self, selector: &str, limit: usize) -> Result<Vec<CdpElement>, String> {
        let page = self.page.read().await;
        let page = page.as_ref().ok_or("No page attached")?;

        let script = format!(r#"
            (function() {{
                const elements = document.querySelectorAll('{}');
                return Array.from(elements).slice(0, {}).map((el, idx) => {{
                    const rect = el.getBoundingClientRect();
                    return {{
                        tagName: el.tagName.toLowerCase(),
                        id: el.id || null,
                        classes: Array.from(el.classList),
                        innerText: el.innerText?.slice(0, 200) || '',
                        rect: {{ x: rect.x, y: rect.y, width: rect.width, height: rect.height }},
                    }};
                }});
            }})()
        "#, selector.replace('\'', "\\'"), limit);

        let result = page.evaluate(script).await.map_err(|e| e.to_string())?;
        
        if let Some(arr) = result.value().and_then(|v| v.as_array()) {
            let elements: Vec<CdpElement> = arr.iter().filter_map(|v| {
                Some(CdpElement {
                    node_id: 0,
                    backend_node_id: None,
                    tag_name: v.get("tagName")?.as_str()?.to_string(),
                    id: v.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    classes: v.get("classes")
                        .and_then(|v| v.as_array())
                        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
                        .unwrap_or_default(),
                    attributes: HashMap::new(),
                    outer_html: None,
                    inner_text: v.get("innerText").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    computed_styles: HashMap::new(),
                    rect: v.get("rect").and_then(|r| {
                        Some(CdpRect {
                            x: r.get("x")?.as_f64()?,
                            y: r.get("y")?.as_f64()?,
                            width: r.get("width")?.as_f64()?,
                            height: r.get("height")?.as_f64()?,
                        })
                    }),
                    selector: selector.to_string(),
                    xpath: String::new(),
                })
            }).collect();
            
            return Ok(elements);
        }
        
        Ok(vec![])
    }

    /// Get performance metrics
    pub async fn get_performance_metrics(&self) -> Result<CdpPerformanceMetrics, String> {
        let page = self.page.read().await;
        let page = page.as_ref().ok_or("No page attached")?;

        let script = r#"
            (function() {
                const perf = performance;
                const nav = perf.getEntriesByType('navigation')[0] || {};
                const paint = perf.getEntriesByType('paint') || [];
                const memory = perf.memory || {};
                
                const fcp = paint.find(p => p.name === 'first-contentful-paint');
                const fp = paint.find(p => p.name === 'first-paint');
                
                return {
                    domContentLoaded: nav.domContentLoadedEventEnd || null,
                    loadComplete: nav.loadEventEnd || null,
                    firstPaint: fp ? fp.startTime : null,
                    firstContentfulPaint: fcp ? fcp.startTime : null,
                    timeToFirstByte: nav.responseStart || null,
                    domNodes: document.getElementsByTagName('*').length,
                    jsHeapSize: memory.totalJSHeapSize || null,
                    jsHeapUsed: memory.usedJSHeapSize || null,
                };
            })()
        "#.to_string();

        let result = page.evaluate(script).await.map_err(|e| e.to_string())?;
        
        if let Some(v) = result.value() {
            return Ok(CdpPerformanceMetrics {
                dom_content_loaded: v.get("domContentLoaded").and_then(|v| v.as_u64()),
                load_complete: v.get("loadComplete").and_then(|v| v.as_u64()),
                first_paint: v.get("firstPaint").and_then(|v| v.as_u64()),
                first_contentful_paint: v.get("firstContentfulPaint").and_then(|v| v.as_u64()),
                largest_contentful_paint: None,
                time_to_first_byte: v.get("timeToFirstByte").and_then(|v| v.as_u64()),
                dom_nodes: v.get("domNodes").and_then(|v| v.as_u64()),
                js_heap_size: v.get("jsHeapSize").and_then(|v| v.as_u64()),
                js_heap_used: v.get("jsHeapUsed").and_then(|v| v.as_u64()),
                documents: None,
                frames: None,
                js_event_listeners: None,
                layout_count: None,
                style_recalc_count: None,
                timestamp: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
            });
        }
        
        Err("Failed to get performance metrics".to_string())
    }

    /// Scroll to an element
    pub async fn scroll_to_element(&self, selector: &str) -> Result<(), String> {
        let page = self.page.read().await;
        let page = page.as_ref().ok_or("No page attached")?;

        let script = format!(r#"
            (function() {{
                const el = document.querySelector('{}');
                if (el) {{
                    el.scrollIntoView({{ behavior: 'smooth', block: 'center' }});
                    return true;
                }}
                return false;
            }})()
        "#, selector.replace('\'', "\\'"));

        let result = page.evaluate(script).await.map_err(|e| e.to_string())?;
        
        if result.value().and_then(|v| v.as_bool()) == Some(true) {
            Ok(())
        } else {
            Err(format!("Element not found: {}", selector))
        }
    }

    /// Scroll the page by a specific amount
    pub async fn scroll_by(&self, x: i32, y: i32) -> Result<(), String> {
        let page = self.page.read().await;
        let page = page.as_ref().ok_or("No page attached")?;

        let script = format!("window.scrollBy({}, {})", x, y);
        page.evaluate(script).await.map_err(|e| e.to_string())?;
        
        Ok(())
    }

    /// Set viewport size
    /// Note: This uses CDP emulation which may not work with all WebView2 configurations
    /// Consider using JavaScript-based viewport detection instead
    pub async fn set_viewport(&self, width: u32, height: u32) -> Result<(), String> {
        let page = self.page.read().await;
        let page = page.as_ref().ok_or("No page attached")?;

        // Use JavaScript to set viewport meta tag as a fallback approach
        let script = format!(
            r#"
            (function() {{
                let viewport = document.querySelector('meta[name="viewport"]');
                if (!viewport) {{
                    viewport = document.createElement('meta');
                    viewport.name = 'viewport';
                    document.head.appendChild(viewport);
                }}
                viewport.content = 'width={}, height={}, initial-scale=1';
                return true;
            }})()
            "#,
            width, height
        );
        
        page.evaluate(script).await.map_err(|e| format!("Failed to set viewport: {}", e))?;
        Ok(())
    }

    /// Emulate a mobile device
    /// Uses viewport meta tag approach for compatibility
    pub async fn emulate_device(&self, device: &str) -> Result<(), String> {
        let (width, height) = match device.to_lowercase().as_str() {
            "iphone12" | "iphone 12" => (390, 844),
            "iphone14" | "iphone 14" => (393, 852),
            "pixel5" | "pixel 5" => (393, 851),
            "ipad" => (768, 1024),
            "ipadpro" | "ipad pro" => (1024, 1366),
            _ => return Err(format!("Unknown device: {}", device)),
        };

        self.set_viewport(width, height).await
    }

    /// Enable element picker mode - highlights elements on hover and captures clicks
    /// Returns the selected element info when user clicks
    pub async fn enable_element_picker<R: tauri::Runtime>(&self, app: tauri::AppHandle<R>) -> Result<(), String> {
        let page = self.page.read().await;
        let page = page.as_ref().ok_or("No page attached")?;

        // Inject element picker script
        let script = r#"
            (function() {
                // Remove any existing picker but keep selection highlight if present
                if (window.__voltElementPicker) {
                    window.__voltElementPicker.cleanup(false);
                }

                const highlight = document.createElement('div');
                highlight.id = '__volt-element-highlight';
                highlight.style.cssText = `
                    position: fixed;
                    pointer-events: none;
                    z-index: 2147483647;
                    border: 2px solid #89b4fa;
                    background: rgba(137, 180, 250, 0.1);
                    transition: all 0.1s ease;
                    display: none;
                `;
                document.body.appendChild(highlight);

                const label = document.createElement('div');
                label.id = '__volt-element-label';
                label.style.cssText = `
                    position: fixed;
                    pointer-events: none;
                    z-index: 2147483647;
                    background: #1e1e2e;
                    color: #cdd6f4;
                    font-family: monospace;
                    font-size: 11px;
                    padding: 2px 6px;
                    border-radius: 3px;
                    border: 1px solid #45475a;
                    display: none;
                `;
                document.body.appendChild(label);

                let currentElement = null;
                let isPickerActive = true;

                function getSelector(el) {
                    if (el.id) return '#' + el.id;
                    if (el.className && typeof el.className === 'string') {
                        const classes = el.className.trim().split(/\s+/).slice(0, 2).join('.');
                        if (classes) return el.tagName.toLowerCase() + '.' + classes;
                    }
                    return el.tagName.toLowerCase();
                }

                function getXPath(el) {
                    if (el.id) return '//*[@id="' + el.id + '"]';
                    const parts = [];
                    while (el && el.nodeType === 1) {
                        let idx = 1;
                        let sibling = el.previousSibling;
                        while (sibling) {
                            if (sibling.nodeType === 1 && sibling.tagName === el.tagName) idx++;
                            sibling = sibling.previousSibling;
                        }
                        parts.unshift(el.tagName.toLowerCase() + '[' + idx + ']');
                        el = el.parentNode;
                    }
                    return '/' + parts.join('/');
                }

                function updateHighlight(el) {
                    if (!el) return;
                    const rect = el.getBoundingClientRect();
                    highlight.style.display = 'block';
                    highlight.style.left = rect.left + 'px';
                    highlight.style.top = rect.top + 'px';
                    highlight.style.width = rect.width + 'px';
                    highlight.style.height = rect.height + 'px';
                    label.style.display = 'block';
                    label.textContent = getSelector(el);
                    label.style.left = rect.left + 'px';
                    label.style.top = Math.max(0, rect.top - 22) + 'px';
                }

                function handleMouseMove(e) {
                    if (!isPickerActive) return;
                    const el = document.elementFromPoint(e.clientX, e.clientY);
                    if (!el || el === highlight || el === label) return;
                    if (el.id === '__volt-element-highlight' || el.id === '__volt-element-label') return;
                    
                    currentElement = el;
                    updateHighlight(el);
                }

                function handleClick(e) {
                    if (!isPickerActive) return;
                    e.preventDefault();
                    e.stopPropagation();
                    
                    if (!currentElement) return;
                    
                    const el = currentElement;
                    const rect = el.getBoundingClientRect();
                    const computed = window.getComputedStyle(el);
                    
                    const elementInfo = {
                        tagName: el.tagName.toLowerCase(),
                        id: el.id || '',
                        classes: Array.from(el.classList),
                        html: el.outerHTML.slice(0, 5000),
                        css: {
                            display: computed.display,
                            position: computed.position,
                            width: computed.width,
                            height: computed.height,
                            margin: computed.margin,
                            padding: computed.padding,
                            color: computed.color,
                            backgroundColor: computed.backgroundColor,
                            fontSize: computed.fontSize,
                            fontFamily: computed.fontFamily,
                        },
                        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                        selector: getSelector(el),
                        xpath: getXPath(el),
                    };

                    // Send to Tauri via postMessage (will be captured by CDP)
                    window.__voltSelectedElement = elementInfo;
                    
                    // Store the selected element for highlight updates
                    window.__voltSelectedDomElement = el;
                    
                    // Stop picker mode but KEEP the highlight visible
                    cleanup(true);
                    
                    return false;
                }

                // removeHighlight: if true, keep highlight; if false, remove it
                function cleanup(keepHighlight) {
                    isPickerActive = false;
                    document.removeEventListener('mousemove', handleMouseMove, true);
                    document.removeEventListener('click', handleClick, true);
                    document.removeEventListener('keydown', handleKeyDown, true);
                    document.body.style.cursor = '';
                    
                    if (!keepHighlight) {
                        highlight.remove();
                        label.remove();
                        window.__voltSelectedDomElement = null;
                    }
                    
                    delete window.__voltElementPicker;
                }

                function handleKeyDown(e) {
                    if (e.key === 'Escape') {
                        cleanup(false);
                    }
                }

                // Function to clear the selection highlight (called from Volt)
                window.__voltClearSelectionHighlight = function() {
                    const h = document.getElementById('__volt-element-highlight');
                    const l = document.getElementById('__volt-element-label');
                    if (h) h.remove();
                    if (l) l.remove();
                    window.__voltSelectedDomElement = null;
                    window.__voltSelectedElement = null;
                };

                // Update highlight position on scroll/resize
                function updateSelectedHighlight() {
                    if (window.__voltSelectedDomElement) {
                        updateHighlight(window.__voltSelectedDomElement);
                    }
                }
                window.addEventListener('scroll', updateSelectedHighlight, true);
                window.addEventListener('resize', updateSelectedHighlight);

                document.addEventListener('mousemove', handleMouseMove, true);
                document.addEventListener('click', handleClick, true);
                document.addEventListener('keydown', handleKeyDown, true);
                document.body.style.cursor = 'crosshair';

                window.__voltElementPicker = { cleanup: (keep) => cleanup(keep || false) };
                
                return 'Element picker enabled';
            })()
        "#.to_string();
        page.evaluate(script).await.map_err(|e| format!("Failed to enable element picker: {}", e))?;
        
        // Start polling for selected element
        let page_clone = self.page.clone();
        let app_clone = app.clone();
        
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                
                let page_guard = page_clone.read().await;
                if let Some(page) = page_guard.as_ref() {
                    // Check if element was selected
                    let check_script = "window.__voltSelectedElement || null".to_string();
                    if let Ok(result) = page.evaluate(check_script).await {
                        if let Some(value) = result.value() {
                            if !value.is_null() {
                                // Element was selected! Emit event and clear
                                let _ = app_clone.emit("browser://element-selected", value.clone());
                                
                                // Also emit that select mode is now off
                                let _ = app_clone.emit("browser://select-mode", false);
                                
                                // Clear the selection
                                let _ = page.evaluate("window.__voltSelectedElement = null".to_string()).await;
                                break;
                            }
                        }
                    }
                    
                    // Check if picker was cancelled
                    let picker_check = "!!window.__voltElementPicker".to_string();
                    if let Ok(result) = page.evaluate(picker_check).await {
                        if result.value().and_then(|v| v.as_bool()) != Some(true) {
                            // Picker was cancelled
                            let _ = app_clone.emit("browser://select-mode", false);
                            break;
                        }
                    }
                } else {
                    let _ = app_clone.emit("browser://select-mode", false);
                    break;
                }
            }
        });

        Ok(())
    }

    /// Disable element picker mode and clear selection highlight
    pub async fn disable_element_picker(&self) -> Result<(), String> {
        let page = self.page.read().await;
        let page = page.as_ref().ok_or("No page attached")?;

        let script = r#"
            if (window.__voltElementPicker) {
                window.__voltElementPicker.cleanup(false);
            }
            if (window.__voltClearSelectionHighlight) {
                window.__voltClearSelectionHighlight();
            }
        "#.to_string();

        page.evaluate(script).await.map_err(|e| format!("Failed to disable element picker: {}", e))?;
        Ok(())
    }
}
