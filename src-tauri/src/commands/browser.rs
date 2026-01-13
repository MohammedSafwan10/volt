//! Browser Panel - Embedded webview using Tauri's add_child API
//! Creates a truly embedded browser inside the main window

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{
    AppHandle, Emitter, Manager, Runtime, WebviewBuilder, WebviewUrl,
    LogicalPosition, LogicalSize, Rect,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectedElement {
    #[serde(rename = "tagName")]
    pub tag_name: String,
    pub id: String,
    pub classes: Vec<String>,
    pub html: String,
    pub css: HashMap<String, String>,
    pub rect: ElementRect,
    pub selector: String,
    pub xpath: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ElementRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserInfo {
    pub is_open: bool,
    pub url: String,
    pub select_mode: bool,
}

/// Browser state - holds reference to the child webview
pub struct BrowserState {
    webview_label: Arc<Mutex<Option<String>>>,
    current_url: Arc<Mutex<String>>,
    select_mode: Arc<Mutex<bool>>,
}

impl BrowserState {
    pub fn new() -> Self {
        Self {
            webview_label: Arc::new(Mutex::new(None)),
            current_url: Arc::new(Mutex::new(String::new())),
            select_mode: Arc::new(Mutex::new(false)),
        }
    }
}

impl Default for BrowserState {
    fn default() -> Self {
        Self::new()
    }
}

const BROWSER_LABEL: &str = "volt-browser";

/// Element selection script to inject into the browser
fn get_selector_script(enabled: bool) -> String {
    format!(r#"
(function() {{
    if (!window.__voltSelectorInit) {{
        window.__voltSelectorInit = true;
        let overlay = null;
        let tooltip = null;
        let selectMode = false;
        
        function createOverlay() {{
            if (overlay) return;
            overlay = document.createElement('div');
            overlay.id = '__volt_overlay';
            overlay.style.cssText = 'position:fixed;pointer-events:none;border:2px solid #89b4fa;background:rgba(137,180,250,0.15);z-index:2147483647;display:none;border-radius:2px;transition:all 0.1s ease';
            document.documentElement.appendChild(overlay);
            
            tooltip = document.createElement('div');
            tooltip.id = '__volt_tooltip';
            tooltip.style.cssText = 'position:fixed;background:#1e1e2e;color:#cdd6f4;padding:4px 8px;border-radius:4px;font-size:11px;font-family:monospace;z-index:2147483647;pointer-events:none;display:none;box-shadow:0 2px 8px rgba(0,0,0,0.3)';
            document.documentElement.appendChild(tooltip);
        }}
        
        function getSelector(el) {{
            if (!el || el.nodeType !== 1) return '';
            if (el.id && !el.id.startsWith('__volt')) return '#' + el.id;
            const path = [];
            let cur = el;
            while (cur && cur.nodeType === 1 && path.length < 4) {{
                let sel = cur.tagName.toLowerCase();
                if (cur.className && typeof cur.className === 'string') {{
                    const cls = cur.className.trim().split(/\\s+/).filter(c => c && !c.startsWith('__volt')).slice(0, 2);
                    if (cls.length) sel += '.' + cls.join('.');
                }}
                path.unshift(sel);
                cur = cur.parentElement;
            }}
            return path.join(' > ');
        }}
        
        function getXPath(el) {{
            if (!el || el.nodeType !== 1) return '';
            const parts = [];
            let cur = el;
            while (cur && cur.nodeType === 1) {{
                let idx = 1;
                let sib = cur.previousSibling;
                while (sib) {{
                    if (sib.nodeType === 1 && sib.tagName === cur.tagName) idx++;
                    sib = sib.previousSibling;
                }}
                parts.unshift(cur.tagName.toLowerCase() + '[' + idx + ']');
                cur = cur.parentElement;
            }}
            return '/' + parts.join('/');
        }}
        
        function highlight(el) {{
            if (!overlay || !el || !selectMode) return;
            if (el.id && el.id.startsWith('__volt')) return;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return;
            overlay.style.display = 'block';
            overlay.style.left = r.left + 'px';
            overlay.style.top = r.top + 'px';
            overlay.style.width = r.width + 'px';
            overlay.style.height = r.height + 'px';
            const tag = el.tagName.toLowerCase();
            const id = el.id ? '#' + el.id : '';
            const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : '';
            tooltip.textContent = tag + id + cls;
            tooltip.style.display = 'block';
            tooltip.style.left = Math.max(0, r.left) + 'px';
            tooltip.style.top = (r.top > 30 ? r.top - 26 : r.bottom + 4) + 'px';
        }}
        
        function hideOverlay() {{
            if (overlay) overlay.style.display = 'none';
            if (tooltip) tooltip.style.display = 'none';
        }}
        
        function getComputedStyles(el) {{
            const computed = window.getComputedStyle(el);
            const important = ['color', 'background-color', 'font-size', 'font-family', 'padding', 'margin', 'border', 'display', 'position', 'width', 'height'];
            const styles = {{}};
            important.forEach(prop => {{
                styles[prop] = computed.getPropertyValue(prop);
            }});
            return styles;
        }}
        
        function selectEl(el) {{
            if (!el || (el.id && el.id.startsWith('__volt'))) return;
            const r = el.getBoundingClientRect();
            const data = {{
                tagName: el.tagName.toLowerCase(),
                id: el.id || '',
                classes: el.className && typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(c => c) : [],
                html: el.outerHTML.slice(0, 3000),
                css: getComputedStyles(el),
                rect: {{ x: r.x, y: r.y, width: r.width, height: r.height }},
                selector: getSelector(el),
                xpath: getXPath(el)
            }};
            if (window.__TAURI__) {{
                window.__TAURI__.core.invoke('browser_element_selected', {{ element: data }});
            }}
        }}
        
        let lastTarget = null;
        document.addEventListener('mousemove', function(e) {{
            if (!selectMode) return;
            if (e.target !== lastTarget) {{
                lastTarget = e.target;
                highlight(e.target);
            }}
        }}, true);
        
        document.addEventListener('click', function(e) {{
            if (!selectMode) return;
            e.preventDefault();
            e.stopPropagation();
            selectEl(e.target);
            return false;
        }}, true);
        
        window.__voltSetSelectMode = function(en) {{
            selectMode = en;
            if (en) {{
                createOverlay();
                document.body.style.cursor = 'crosshair';
            }} else {{
                hideOverlay();
                document.body.style.cursor = '';
                lastTarget = null;
            }}
        }};
    }}
    window.__voltSetSelectMode({});
}})();
"#, enabled)
}

/// Create embedded browser webview
#[tauri::command]
pub async fn browser_create<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
    url: String,
    bounds: BrowserBounds,
) -> Result<BrowserInfo, String> {
    // Close existing if any
    if let Some(label) = state.webview_label.lock().unwrap().take() {
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.close();
        }
    }

    // Get main window using Manager trait (unstable feature)
    let main_window = app
        .get_window("main")
        .ok_or("Main window not found")?;

    // Parse URL
    let webview_url = if url.starts_with("http://") || url.starts_with("https://") {
        WebviewUrl::External(url.parse().map_err(|e| format!("Invalid URL: {}", e))?)
    } else {
        WebviewUrl::External(
            format!("https://{}", url)
                .parse()
                .map_err(|e| format!("Invalid URL: {}", e))?,
        )
    };

    // Create child webview using add_child (truly embedded)
    let webview_builder = WebviewBuilder::new(BROWSER_LABEL, webview_url);

    let _webview = main_window
        .add_child(
            webview_builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|e| format!("Failed to create browser: {}", e))?;

    // Store state
    *state.webview_label.lock().unwrap() = Some(BROWSER_LABEL.to_string());
    *state.current_url.lock().unwrap() = url.clone();
    *state.select_mode.lock().unwrap() = false;

    // Emit creation event
    let _ = app.emit("browser://created", &url);

    Ok(BrowserInfo {
        is_open: true,
        url,
        select_mode: false,
    })
}

/// Close the browser
#[tauri::command]
pub async fn browser_close<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    if let Some(label) = state.webview_label.lock().unwrap().take() {
        if let Some(webview) = app.get_webview(&label) {
            webview.close().map_err(|e| format!("Close failed: {}", e))?;
        }
    }
    *state.current_url.lock().unwrap() = String::new();
    *state.select_mode.lock().unwrap() = false;
    let _ = app.emit("browser://closed", ());
    Ok(())
}

/// Navigate to URL
#[tauri::command]
pub async fn browser_navigate<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
    url: String,
) -> Result<(), String> {
    let label = state
        .webview_label
        .lock()
        .unwrap()
        .clone()
        .ok_or("Browser not open")?;

    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;

    // Navigate using eval (location.href)
    let final_url = if url.starts_with("http://") || url.starts_with("https://") {
        url.clone()
    } else if url.contains(' ') || !url.contains('.') {
        format!(
            "https://www.google.com/search?q={}",
            urlencoding::encode(&url)
        )
    } else {
        format!("https://{}", url)
    };

    webview
        .eval(&format!("window.location.href = '{}';", final_url.replace('\'', "\\'")))
        .map_err(|e| format!("Navigate failed: {}", e))?;

    *state.current_url.lock().unwrap() = final_url.clone();
    let _ = app.emit("browser://navigated", &final_url);
    Ok(())
}

/// Go back
#[tauri::command]
pub async fn browser_back<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    let label = state
        .webview_label
        .lock()
        .unwrap()
        .clone()
        .ok_or("Browser not open")?;

    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview
        .eval("history.back();")
        .map_err(|e| format!("Back failed: {}", e))?;
    Ok(())
}

/// Go forward
#[tauri::command]
pub async fn browser_forward<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    let label = state
        .webview_label
        .lock()
        .unwrap()
        .clone()
        .ok_or("Browser not open")?;

    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview
        .eval("history.forward();")
        .map_err(|e| format!("Forward failed: {}", e))?;
    Ok(())
}

/// Reload page
#[tauri::command]
pub async fn browser_reload<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    let label = state
        .webview_label
        .lock()
        .unwrap()
        .clone()
        .ok_or("Browser not open")?;

    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview
        .eval("location.reload();")
        .map_err(|e| format!("Reload failed: {}", e))?;
    Ok(())
}

/// Toggle element selection mode
#[tauri::command]
pub async fn browser_set_select_mode<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
    enabled: bool,
) -> Result<(), String> {
    let label = state
        .webview_label
        .lock()
        .unwrap()
        .clone()
        .ok_or("Browser not open")?;

    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;

    // Inject selector script
    let script = get_selector_script(enabled);
    webview
        .eval(&script)
        .map_err(|e| format!("Set select mode failed: {}", e))?;

    *state.select_mode.lock().unwrap() = enabled;
    let _ = app.emit("browser://select-mode", enabled);
    Ok(())
}

/// Execute arbitrary JavaScript
#[tauri::command]
pub async fn browser_execute_js<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
    script: String,
) -> Result<(), String> {
    let label = state
        .webview_label
        .lock()
        .unwrap()
        .clone()
        .ok_or("Browser not open")?;

    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview
        .eval(&script)
        .map_err(|e| format!("Execute JS failed: {}", e))?;
    Ok(())
}

/// Update browser bounds (position and size)
#[tauri::command]
pub async fn browser_set_bounds<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
    bounds: BrowserBounds,
) -> Result<(), String> {
    let label = state
        .webview_label
        .lock()
        .unwrap()
        .clone()
        .ok_or("Browser not open")?;

    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;

    // Log the bounds being set
    println!("[Browser] Setting bounds: x={}, y={}, w={}, h={}", 
             bounds.x, bounds.y, bounds.width, bounds.height);

    // Use set_bounds with Rect for atomic position+size update
    let rect = Rect {
        position: LogicalPosition::new(bounds.x, bounds.y).into(),
        size: LogicalSize::new(bounds.width, bounds.height).into(),
    };
    
    webview
        .set_bounds(rect)
        .map_err(|e| format!("Set bounds failed: {}", e))?;

    // Log the actual bounds after setting
    if let Ok(actual) = webview.bounds() {
        println!("[Browser] Actual bounds after set: {:?}", actual);
    }

    Ok(())
}

/// Hide browser
#[tauri::command]
pub async fn browser_hide<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    let label = state
        .webview_label
        .lock()
        .unwrap()
        .clone()
        .ok_or("Browser not open")?;

    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview
        .hide()
        .map_err(|e| format!("Hide failed: {}", e))?;
    Ok(())
}

/// Show browser
#[tauri::command]
pub async fn browser_show<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    let label = state
        .webview_label
        .lock()
        .unwrap()
        .clone()
        .ok_or("Browser not open")?;

    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview
        .show()
        .map_err(|e| format!("Show failed: {}", e))?;
    Ok(())
}

/// Called when an element is selected in the browser
#[tauri::command]
pub async fn browser_element_selected<R: Runtime>(
    app: AppHandle<R>,
    element: SelectedElement,
) -> Result<(), String> {
    let _ = app.emit("browser://element-selected", &element);
    Ok(())
}

/// Get current browser state
#[tauri::command]
pub async fn browser_get_state(
    state: tauri::State<'_, BrowserState>,
) -> Result<BrowserInfo, String> {
    let is_open = state.webview_label.lock().unwrap().is_some();
    let url = state.current_url.lock().unwrap().clone();
    let select_mode = *state.select_mode.lock().unwrap();

    Ok(BrowserInfo {
        is_open,
        url,
        select_mode,
    })
}

/// Take screenshot (placeholder - WebView2 doesn't expose this easily)
#[tauri::command]
pub async fn browser_screenshot() -> Result<String, String> {
    Err("Screenshot not yet implemented for embedded webview".to_string())
}
