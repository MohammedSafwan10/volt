//! CDP Tauri Commands
//!
//! Exposes CDP functionality to the frontend via Tauri commands.

use crate::cdp::manager::CdpManager;
use crate::cdp::types::*;
use std::sync::Arc;
use tauri::{AppHandle, Runtime, State};
use tokio::sync::Mutex;

/// CDP state wrapper for Tauri
pub struct CdpState(pub Arc<Mutex<CdpManager>>);

impl Default for CdpState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(CdpManager::new())))
    }
}

// =============================================================================
// Connection Commands
// =============================================================================

/// Check if CDP is available on this platform
#[tauri::command]
pub async fn cdp_is_available(state: State<'_, CdpState>) -> Result<bool, String> {
    let manager = state.0.lock().await;
    Ok(manager.is_available())
}

/// Get CDP connection status
#[tauri::command]
pub async fn cdp_get_status(state: State<'_, CdpState>) -> Result<CdpStatus, String> {
    let manager = state.0.lock().await;
    Ok(manager.get_status().await)
}

/// Discover CDP WebSocket URL from the debug endpoint
/// WebView2 with --remote-debugging-port=9222 exposes http://127.0.0.1:9222/json/version
#[tauri::command]
pub async fn cdp_discover_url() -> Result<String, String> {
    // Query the CDP debug endpoint to get the WebSocket URL
    let client = reqwest::Client::new();
    let response = client
        .get("http://127.0.0.1:9222/json/version")
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
        .map_err(|e| {
            format!(
                "Failed to connect to CDP endpoint: {}. Make sure the browser is open.",
                e
            )
        })?;

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse CDP response: {}", e))?;

    let ws_url = json
        .get("webSocketDebuggerUrl")
        .and_then(|v| v.as_str())
        .ok_or("CDP endpoint did not return webSocketDebuggerUrl")?;

    Ok(ws_url.to_string())
}

/// Connect to CDP endpoint
#[tauri::command]
pub async fn cdp_connect(state: State<'_, CdpState>, ws_url: String) -> Result<(), String> {
    let manager = state.0.lock().await;
    manager.connect(&ws_url).await
}

/// Disconnect from CDP
#[tauri::command]
pub async fn cdp_disconnect(state: State<'_, CdpState>) -> Result<(), String> {
    let manager = state.0.lock().await;
    manager.disconnect().await
}

/// Attach to a page/target
#[tauri::command]
pub async fn cdp_attach_to_page(
    state: State<'_, CdpState>,
    target_id: Option<String>,
) -> Result<(), String> {
    let manager = state.0.lock().await;
    manager.attach_to_page(target_id.as_deref()).await
}

// =============================================================================
// Event Subscription Commands
// =============================================================================

/// Enable console logging
#[tauri::command]
pub async fn cdp_enable_console<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CdpState>,
) -> Result<(), String> {
    let manager = state.0.lock().await;
    manager.enable_console(app).await
}

/// Enable network monitoring
#[tauri::command]
pub async fn cdp_enable_network<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CdpState>,
) -> Result<(), String> {
    let manager = state.0.lock().await;
    manager.enable_network(app).await
}

// =============================================================================
// Data Retrieval Commands
// =============================================================================

/// Get buffered console logs
#[tauri::command]
pub async fn cdp_get_console_logs(
    state: State<'_, CdpState>,
    limit: Option<usize>,
) -> Result<Vec<CdpConsoleLog>, String> {
    let manager = state.0.lock().await;
    Ok(manager.get_console_logs(limit).await)
}

/// Get buffered JS errors
#[tauri::command]
pub async fn cdp_get_js_errors(
    state: State<'_, CdpState>,
    limit: Option<usize>,
) -> Result<Vec<CdpJsError>, String> {
    let manager = state.0.lock().await;
    Ok(manager.get_js_errors(limit).await)
}

/// Get buffered network requests
#[tauri::command]
pub async fn cdp_get_network_requests(
    state: State<'_, CdpState>,
    limit: Option<usize>,
) -> Result<Vec<CdpNetworkRequest>, String> {
    let manager = state.0.lock().await;
    Ok(manager.get_network_requests(limit).await)
}

/// Clear console logs buffer
#[tauri::command]
pub async fn cdp_clear_console(state: State<'_, CdpState>) -> Result<(), String> {
    let manager = state.0.lock().await;
    manager.clear_console_logs().await;
    Ok(())
}

/// Clear JS errors buffer
#[tauri::command]
pub async fn cdp_clear_errors(state: State<'_, CdpState>) -> Result<(), String> {
    let manager = state.0.lock().await;
    manager.clear_js_errors().await;
    Ok(())
}

/// Clear network buffer
#[tauri::command]
pub async fn cdp_clear_network(state: State<'_, CdpState>) -> Result<(), String> {
    let manager = state.0.lock().await;
    manager.clear_network().await;
    Ok(())
}

// =============================================================================
// Navigation Commands
// =============================================================================

/// Navigate to URL
#[tauri::command]
pub async fn cdp_navigate(state: State<'_, CdpState>, url: String) -> Result<(), String> {
    let manager = state.0.lock().await;
    manager.navigate(&url).await
}

/// Get current URL
#[tauri::command]
pub async fn cdp_get_url(state: State<'_, CdpState>) -> Result<String, String> {
    let manager = state.0.lock().await;
    manager.get_url().await
}

/// Get page title
#[tauri::command]
pub async fn cdp_get_title(state: State<'_, CdpState>) -> Result<String, String> {
    let manager = state.0.lock().await;
    manager.get_title().await
}

/// Get page HTML content
#[tauri::command]
pub async fn cdp_get_content(state: State<'_, CdpState>) -> Result<String, String> {
    let manager = state.0.lock().await;
    manager.get_content().await
}

// =============================================================================
// Automation Commands
// =============================================================================

/// Click an element by selector
#[tauri::command]
pub async fn cdp_click(
    state: State<'_, CdpState>,
    selector: String,
) -> Result<CdpClickResult, String> {
    let manager = state.0.lock().await;
    manager.click(&selector).await
}

/// Type text into an element
#[tauri::command]
pub async fn cdp_type(
    state: State<'_, CdpState>,
    text: String,
    selector: Option<String>,
) -> Result<CdpTypeResult, String> {
    let manager = state.0.lock().await;
    manager.type_text(&text, selector.as_deref()).await
}

/// Press a key
#[tauri::command]
pub async fn cdp_press_key(state: State<'_, CdpState>, key: String) -> Result<(), String> {
    let manager = state.0.lock().await;
    manager.press_key(&key).await
}

/// Evaluate JavaScript
#[tauri::command]
pub async fn cdp_evaluate(
    state: State<'_, CdpState>,
    expression: String,
) -> Result<CdpEvaluateResult, String> {
    let manager = state.0.lock().await;
    manager.evaluate(&expression).await
}

// =============================================================================
// Screenshot Commands
// =============================================================================

/// Take a screenshot of the page
#[tauri::command]
pub async fn cdp_screenshot(
    state: State<'_, CdpState>,
    full_page: Option<bool>,
) -> Result<CdpScreenshot, String> {
    let manager = state.0.lock().await;
    manager.screenshot(full_page.unwrap_or(false)).await
}

/// Take a screenshot of an element
#[tauri::command]
pub async fn cdp_screenshot_element(
    state: State<'_, CdpState>,
    selector: String,
) -> Result<CdpScreenshot, String> {
    let manager = state.0.lock().await;
    manager.screenshot_element(&selector).await
}

// =============================================================================
// Element Commands
// =============================================================================

/// Get element information by selector
#[tauri::command]
pub async fn cdp_get_element(
    state: State<'_, CdpState>,
    selector: String,
) -> Result<Option<CdpElement>, String> {
    let manager = state.0.lock().await;
    manager.get_element(&selector).await
}

/// Get multiple elements by selector
#[tauri::command]
pub async fn cdp_get_elements(
    state: State<'_, CdpState>,
    selector: String,
    limit: Option<usize>,
) -> Result<Vec<CdpElement>, String> {
    let manager = state.0.lock().await;
    manager.get_elements(&selector, limit.unwrap_or(10)).await
}

/// Wait for an element to appear
#[tauri::command]
pub async fn cdp_wait_for_selector(
    state: State<'_, CdpState>,
    selector: String,
    timeout_ms: Option<u64>,
) -> Result<bool, String> {
    let manager = state.0.lock().await;
    manager
        .wait_for_selector(&selector, timeout_ms.unwrap_or(5000))
        .await
}

/// Scroll to an element
#[tauri::command]
pub async fn cdp_scroll_to_element(
    state: State<'_, CdpState>,
    selector: String,
) -> Result<(), String> {
    let manager = state.0.lock().await;
    manager.scroll_to_element(&selector).await
}

/// Scroll the page
#[tauri::command]
pub async fn cdp_scroll_by(state: State<'_, CdpState>, x: i32, y: i32) -> Result<(), String> {
    let manager = state.0.lock().await;
    manager.scroll_by(x, y).await
}

// =============================================================================
// Performance Commands
// =============================================================================

/// Get performance metrics
#[tauri::command]
pub async fn cdp_get_performance(
    state: State<'_, CdpState>,
) -> Result<CdpPerformanceMetrics, String> {
    let manager = state.0.lock().await;
    manager.get_performance_metrics().await
}

// =============================================================================
// Viewport Commands
// =============================================================================

/// Set viewport size
#[tauri::command]
pub async fn cdp_set_viewport(
    state: State<'_, CdpState>,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let manager = state.0.lock().await;
    manager.set_viewport(width, height).await
}

/// Emulate a mobile device
#[tauri::command]
pub async fn cdp_emulate_device(state: State<'_, CdpState>, device: String) -> Result<(), String> {
    let manager = state.0.lock().await;
    manager.emulate_device(&device).await
}

/// Enable element picker mode (highlight on hover, capture on click)
#[tauri::command]
pub async fn cdp_enable_element_picker<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CdpState>,
) -> Result<(), String> {
    let manager = state.0.lock().await;
    manager.enable_element_picker(app).await
}

/// Disable element picker mode
#[tauri::command]
pub async fn cdp_disable_element_picker(state: State<'_, CdpState>) -> Result<(), String> {
    let manager = state.0.lock().await;
    manager.disable_element_picker().await
}
