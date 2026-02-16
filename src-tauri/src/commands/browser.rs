//! Browser Panel - Embedded webview using Tauri's add_child API
//! Full-featured browser with tabs, bookmarks, history, devtools, and AI integration

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
#[allow(dead_code)]
pub struct BrowserTab {
    pub id: String,
    pub url: String,
    pub title: String,
    pub favicon: Option<String>,
    pub loading: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bookmark {
    pub id: String,
    pub url: String,
    pub title: String,
    pub favicon: Option<String>,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub url: String,
    pub title: String,
    pub visited_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserInfo {
    pub is_open: bool,
    pub url: String,
    pub title: String,
    pub select_mode: bool,
    pub zoom_level: f64,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsoleMessage {
    pub level: String, // log, warn, error, info
    pub message: String,
    pub source: Option<String>,
    pub line: Option<u32>,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkRequest {
    pub id: String,
    pub method: String,
    pub url: String,
    pub status: Option<u16>,
    pub content_type: Option<String>,
    pub size: Option<u64>,
    pub duration: Option<u64>,
    pub timestamp: u64,
}

/// Browser state - holds reference to the child webview and all browser data
pub struct BrowserState {
    webview_label: Arc<Mutex<Option<String>>>,
    current_url: Arc<Mutex<String>>,
    current_title: Arc<Mutex<String>>,
    select_mode: Arc<Mutex<bool>>,
    zoom_level: Arc<Mutex<f64>>,
    history: Arc<Mutex<Vec<HistoryEntry>>>,
    bookmarks: Arc<Mutex<Vec<Bookmark>>>,
    console_messages: Arc<Mutex<Vec<ConsoleMessage>>>,
    network_requests: Arc<Mutex<Vec<NetworkRequest>>>,
    responsive_mode: Arc<Mutex<Option<(u32, u32)>>>, // width, height
}

impl BrowserState {
    pub fn new() -> Self {
        Self {
            webview_label: Arc::new(Mutex::new(None)),
            current_url: Arc::new(Mutex::new(String::new())),
            current_title: Arc::new(Mutex::new(String::from("New Tab"))),
            select_mode: Arc::new(Mutex::new(false)),
            zoom_level: Arc::new(Mutex::new(1.0)),
            history: Arc::new(Mutex::new(Vec::new())),
            bookmarks: Arc::new(Mutex::new(Vec::new())),
            console_messages: Arc::new(Mutex::new(Vec::new())),
            network_requests: Arc::new(Mutex::new(Vec::new())),
            responsive_mode: Arc::new(Mutex::new(None)),
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
                // Also turn off select mode locally
                window.__voltSetSelectMode(false);
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

/// Find in page script
fn get_find_script(query: &str, highlight: bool) -> String {
    if query.is_empty() {
        return r#"
            if (window.__voltFindCleanup) window.__voltFindCleanup();
        "#.to_string();
    }
    
    let escaped = query.replace('\\', "\\\\").replace('\'', "\\'").replace('\n', "\\n");
    format!(r#"
(function() {{
    if (window.__voltFindCleanup) window.__voltFindCleanup();
    
    const query = '{}';
    const highlights = [];
    let currentIndex = -1;
    
    function findAll() {{
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        const matches = [];
        let node;
        while (node = walker.nextNode()) {{
            const text = node.textContent;
            const lowerText = text.toLowerCase();
            const lowerQuery = query.toLowerCase();
            let idx = 0;
            while ((idx = lowerText.indexOf(lowerQuery, idx)) !== -1) {{
                matches.push({{ node, start: idx, end: idx + query.length }});
                idx += query.length;
            }}
        }}
        return matches;
    }}
    
    function highlightMatches(matches) {{
        matches.forEach((m, i) => {{
            try {{
                const range = document.createRange();
                range.setStart(m.node, m.start);
                range.setEnd(m.node, m.end);
                const span = document.createElement('span');
                span.className = '__volt_find_highlight';
                span.style.cssText = 'background:#f9e2af;color:#1e1e2e;border-radius:2px;';
                span.dataset.index = i;
                range.surroundContents(span);
                highlights.push(span);
            }} catch(e) {{}}
        }});
    }}
    
    const matches = findAll();
    if ({}) highlightMatches(matches);
    
    window.__voltFindNext = function() {{
        if (highlights.length === 0) return -1;
        if (currentIndex >= 0) highlights[currentIndex].style.background = '#f9e2af';
        currentIndex = (currentIndex + 1) % highlights.length;
        highlights[currentIndex].style.background = '#fab387';
        highlights[currentIndex].scrollIntoView({{ block: 'center' }});
        return currentIndex;
    }};
    
    window.__voltFindPrev = function() {{
        if (highlights.length === 0) return -1;
        if (currentIndex >= 0) highlights[currentIndex].style.background = '#f9e2af';
        currentIndex = currentIndex <= 0 ? highlights.length - 1 : currentIndex - 1;
        highlights[currentIndex].style.background = '#fab387';
        highlights[currentIndex].scrollIntoView({{ block: 'center' }});
        return currentIndex;
    }};
    
    window.__voltFindCleanup = function() {{
        highlights.forEach(h => {{
            const parent = h.parentNode;
            if (parent) {{
                parent.replaceChild(document.createTextNode(h.textContent), h);
                parent.normalize();
            }}
        }});
        highlights.length = 0;
        currentIndex = -1;
    }};
    
    window.__voltFindCount = matches.length;
    if (window.__TAURI__) {{
        window.__TAURI__.core.invoke('browser_find_result', {{ count: matches.length }});
    }}
}})();
"#, escaped, if highlight { "true" } else { "false" })
}

/// Page content extraction script for AI
fn get_extract_content_script() -> &'static str {
    r#"
(function() {
    function extractContent() {
        // Get main content
        const main = document.querySelector('main, article, [role="main"], .content, #content') || document.body;
        
        // Extract text content
        const text = main.innerText.slice(0, 50000);
        
        // Extract headings
        const headings = Array.from(document.querySelectorAll('h1, h2, h3')).map(h => ({
            level: parseInt(h.tagName[1]),
            text: h.textContent.trim()
        })).slice(0, 50);
        
        // Extract links
        const links = Array.from(document.querySelectorAll('a[href]')).map(a => ({
            text: a.textContent.trim().slice(0, 100),
            href: a.href
        })).filter(l => l.text && l.href.startsWith('http')).slice(0, 100);
        
        // Extract images
        const images = Array.from(document.querySelectorAll('img[src]')).map(img => ({
            alt: img.alt || '',
            src: img.src
        })).slice(0, 50);
        
        // Extract meta
        const meta = {
            title: document.title,
            description: document.querySelector('meta[name="description"]')?.content || '',
            url: window.location.href
        };
        
        return { text, headings, links, images, meta };
    }
    
    const content = extractContent();
    if (window.__TAURI__) {
        window.__TAURI__.core.invoke('browser_content_extracted', { content });
    }
    return content;
})();
"#
}

/// Generate code from selected element
fn get_generate_code_script() -> &'static str {
    r#"
(function() {
    function generateCode(el) {
        if (!el) return null;
        
        const html = el.outerHTML;
        const computed = window.getComputedStyle(el);
        
        // Extract relevant CSS
        const cssProps = [
            'display', 'position', 'width', 'height', 'margin', 'padding',
            'background', 'background-color', 'color', 'font-family', 'font-size',
            'font-weight', 'border', 'border-radius', 'box-shadow', 'flex',
            'flex-direction', 'justify-content', 'align-items', 'gap', 'grid'
        ];
        
        const css = {};
        cssProps.forEach(prop => {
            const val = computed.getPropertyValue(prop);
            if (val && val !== 'none' && val !== 'normal' && val !== 'auto') {
                css[prop] = val;
            }
        });
        
        return { html, css };
    }
    
    // Get last selected element or body
    const el = window.__voltLastSelected || document.body;
    return generateCode(el);
})();
"#
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

    let main_window = app
        .get_window("main")
        .ok_or("Main window not found")?;

    let webview_url = if url.starts_with("http://") || url.starts_with("https://") {
        WebviewUrl::External(url.parse().map_err(|e| format!("Invalid URL: {}", e))?)
    } else {
        WebviewUrl::External(
            format!("https://{}", url)
                .parse()
                .map_err(|e| format!("Invalid URL: {}", e))?,
        )
    };

    let webview_builder = WebviewBuilder::new(BROWSER_LABEL, webview_url);

    let _webview = main_window
        .add_child(
            webview_builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|e| format!("Failed to create browser: {}", e))?;

    *state.webview_label.lock().unwrap() = Some(BROWSER_LABEL.to_string());
    *state.current_url.lock().unwrap() = url.clone();
    *state.select_mode.lock().unwrap() = false;
    *state.zoom_level.lock().unwrap() = 1.0;

    // Add to history
    let entry = HistoryEntry {
        url: url.clone(),
        title: String::from("Loading..."),
        visited_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    };
    state.history.lock().unwrap().push(entry);

    let _ = app.emit("browser://created", &url);

    Ok(BrowserInfo {
        is_open: true,
        url,
        title: String::from("Loading..."),
        select_mode: false,
        zoom_level: 1.0,
        can_go_back: false,
        can_go_forward: false,
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
    *state.current_title.lock().unwrap() = String::from("New Tab");
    *state.select_mode.lock().unwrap() = false;
    *state.zoom_level.lock().unwrap() = 1.0;
    *state.responsive_mode.lock().unwrap() = None;
    state.console_messages.lock().unwrap().clear();
    state.network_requests.lock().unwrap().clear();
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

    // Add to history
    let entry = HistoryEntry {
        url: final_url.clone(),
        title: String::from("Loading..."),
        visited_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    };
    state.history.lock().unwrap().push(entry);

    let _ = app.emit("browser://navigated", &final_url);
    Ok(())
}

/// Go back
#[tauri::command]
pub async fn browser_back<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    let label = state.webview_label.lock().unwrap().clone().ok_or("Browser not open")?;
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview.eval("history.back();").map_err(|e| format!("Back failed: {}", e))?;
    Ok(())
}

/// Go forward
#[tauri::command]
pub async fn browser_forward<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    let label = state.webview_label.lock().unwrap().clone().ok_or("Browser not open")?;
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview.eval("history.forward();").map_err(|e| format!("Forward failed: {}", e))?;
    Ok(())
}

/// Reload page
#[tauri::command]
pub async fn browser_reload<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    let label = state.webview_label.lock().unwrap().clone().ok_or("Browser not open")?;
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview.eval("location.reload();").map_err(|e| format!("Reload failed: {}", e))?;
    Ok(())
}

/// Hard reload (clear cache)
#[tauri::command]
pub async fn browser_hard_reload<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    let label = state.webview_label.lock().unwrap().clone().ok_or("Browser not open")?;
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview.eval("location.reload(true);").map_err(|e| format!("Hard reload failed: {}", e))?;
    Ok(())
}

/// Stop loading
#[tauri::command]
pub async fn browser_stop<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    let label = state.webview_label.lock().unwrap().clone().ok_or("Browser not open")?;
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview.eval("window.stop();").map_err(|e| format!("Stop failed: {}", e))?;
    Ok(())
}

/// Toggle element selection mode
#[tauri::command]
pub async fn browser_set_select_mode<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
    enabled: bool,
) -> Result<(), String> {
    let label = state.webview_label.lock().unwrap().clone().ok_or("Browser not open")?;
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    let script = get_selector_script(enabled);
    webview.eval(&script).map_err(|e| format!("Set select mode failed: {}", e))?;
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
    let label = state.webview_label.lock().unwrap().clone().ok_or("Browser not open")?;
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview.eval(&script).map_err(|e| format!("Execute JS failed: {}", e))?;
    Ok(())
}

/// Update browser bounds
#[tauri::command]
pub async fn browser_set_bounds<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
    bounds: BrowserBounds,
) -> Result<(), String> {
    let label = state.webview_label.lock().unwrap().clone().ok_or("Browser not open")?;
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;

    let rect = Rect {
        position: LogicalPosition::new(bounds.x, bounds.y).into(),
        size: LogicalSize::new(bounds.width, bounds.height).into(),
    };
    
    webview.set_bounds(rect).map_err(|e| format!("Set bounds failed: {}", e))?;
    Ok(())
}

/// Hide browser
#[tauri::command]
pub async fn browser_hide<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    let label = state.webview_label.lock().unwrap().clone().ok_or("Browser not open")?;
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview.hide().map_err(|e| format!("Hide failed: {}", e))?;
    Ok(())
}

/// Show browser
#[tauri::command]
pub async fn browser_show<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    let label = state.webview_label.lock().unwrap().clone().ok_or("Browser not open")?;
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview.show().map_err(|e| format!("Show failed: {}", e))?;
    Ok(())
}

/// Zoom in
#[tauri::command]
pub async fn browser_zoom_in<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
) -> Result<f64, String> {
    let label = state.webview_label.lock().unwrap().clone().ok_or("Browser not open")?;
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    
    let mut zoom = state.zoom_level.lock().unwrap();
    *zoom = (*zoom + 0.1).min(3.0);
    let new_zoom = *zoom;
    
    webview.set_zoom(new_zoom).map_err(|e| format!("Zoom failed: {}", e))?;
    let _ = app.emit("browser://zoom-changed", new_zoom);
    Ok(new_zoom)
}

/// Zoom out
#[tauri::command]
pub async fn browser_zoom_out<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
) -> Result<f64, String> {
    let label = state.webview_label.lock().unwrap().clone().ok_or("Browser not open")?;
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    
    let mut zoom = state.zoom_level.lock().unwrap();
    *zoom = (*zoom - 0.1).max(0.25);
    let new_zoom = *zoom;
    
    webview.set_zoom(new_zoom).map_err(|e| format!("Zoom failed: {}", e))?;
    let _ = app.emit("browser://zoom-changed", new_zoom);
    Ok(new_zoom)
}

/// Reset zoom
#[tauri::command]
pub async fn browser_zoom_reset<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
) -> Result<f64, String> {
    let label = state.webview_label.lock().unwrap().clone().ok_or("Browser not open")?;
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    
    *state.zoom_level.lock().unwrap() = 1.0;
    webview.set_zoom(1.0).map_err(|e| format!("Zoom reset failed: {}", e))?;
    let _ = app.emit("browser://zoom-changed", 1.0);
    Ok(1.0)
}

/// Set specific zoom level
#[tauri::command]
pub async fn browser_set_zoom<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
    level: f64,
) -> Result<f64, String> {
    let label = state.webview_label.lock().unwrap().clone().ok_or("Browser not open")?;
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    
    let clamped = level.clamp(0.25, 3.0);
    *state.zoom_level.lock().unwrap() = clamped;
    webview.set_zoom(clamped).map_err(|e| format!("Set zoom failed: {}", e))?;
    let _ = app.emit("browser://zoom-changed", clamped);
    Ok(clamped)
}

/// Find in page
#[tauri::command]
pub async fn browser_find<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
    query: String,
    highlight: bool,
) -> Result<(), String> {
    let label = state.webview_label.lock().unwrap().clone().ok_or("Browser not open")?;
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    let script = get_find_script(&query, highlight);
    webview.eval(&script).map_err(|e| format!("Find failed: {}", e))?;
    Ok(())
}

/// Find next match
#[tauri::command]
pub async fn browser_find_next<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    let label = state.webview_label.lock().unwrap().clone().ok_or("Browser not open")?;
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview.eval("if(window.__voltFindNext) window.__voltFindNext();").map_err(|e| format!("Find next failed: {}", e))?;
    Ok(())
}

/// Find previous match
#[tauri::command]
pub async fn browser_find_prev<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    let label = state.webview_label.lock().unwrap().clone().ok_or("Browser not open")?;
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview.eval("if(window.__voltFindPrev) window.__voltFindPrev();").map_err(|e| format!("Find prev failed: {}", e))?;
    Ok(())
}

/// Clear find highlights
#[tauri::command]
pub async fn browser_find_clear<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    let label = state.webview_label.lock().unwrap().clone().ok_or("Browser not open")?;
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview.eval("if(window.__voltFindCleanup) window.__voltFindCleanup();").map_err(|e| format!("Find clear failed: {}", e))?;
    Ok(())
}

/// Find result callback
#[tauri::command]
pub async fn browser_find_result<R: Runtime>(
    app: AppHandle<R>,
    count: u32,
) -> Result<(), String> {
    let _ = app.emit("browser://find-result", count);
    Ok(())
}

/// Extract page content for AI
#[tauri::command]
pub async fn browser_extract_content<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    let label = state.webview_label.lock().unwrap().clone().ok_or("Browser not open")?;
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview.eval(get_extract_content_script()).map_err(|e| format!("Extract content failed: {}", e))?;
    Ok(())
}

/// Content extracted callback
#[tauri::command]
pub async fn browser_content_extracted<R: Runtime>(
    app: AppHandle<R>,
    content: serde_json::Value,
) -> Result<(), String> {
    let _ = app.emit("browser://content-extracted", content);
    Ok(())
}

/// Generate code from element
#[tauri::command]
pub async fn browser_generate_code<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    let label = state.webview_label.lock().unwrap().clone().ok_or("Browser not open")?;
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    webview.eval(get_generate_code_script()).map_err(|e| format!("Generate code failed: {}", e))?;
    Ok(())
}

/// Called when an element is selected in the browser
#[tauri::command]
pub async fn browser_element_selected<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
    element: SelectedElement,
) -> Result<(), String> {
    *state.select_mode.lock().unwrap() = false;
    let _ = app.emit("browser://select-mode", false);
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
    let title = state.current_title.lock().unwrap().clone();
    let select_mode = *state.select_mode.lock().unwrap();
    let zoom_level = *state.zoom_level.lock().unwrap();

    Ok(BrowserInfo {
        is_open,
        url,
        title,
        select_mode,
        zoom_level,
        can_go_back: false,
        can_go_forward: false,
    })
}

/// Add bookmark
#[tauri::command]
pub async fn browser_add_bookmark(
    state: tauri::State<'_, BrowserState>,
    url: String,
    title: String,
) -> Result<Bookmark, String> {
    let bookmark = Bookmark {
        id: uuid::Uuid::new_v4().to_string(),
        url,
        title,
        favicon: None,
        created_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    };
    state.bookmarks.lock().unwrap().push(bookmark.clone());
    Ok(bookmark)
}

/// Remove bookmark
#[tauri::command]
pub async fn browser_remove_bookmark(
    state: tauri::State<'_, BrowserState>,
    id: String,
) -> Result<(), String> {
    state.bookmarks.lock().unwrap().retain(|b| b.id != id);
    Ok(())
}

/// Get all bookmarks
#[tauri::command]
pub async fn browser_get_bookmarks(
    state: tauri::State<'_, BrowserState>,
) -> Result<Vec<Bookmark>, String> {
    Ok(state.bookmarks.lock().unwrap().clone())
}

/// Get browsing history
#[tauri::command]
pub async fn browser_get_history(
    state: tauri::State<'_, BrowserState>,
    limit: Option<usize>,
) -> Result<Vec<HistoryEntry>, String> {
    let history = state.history.lock().unwrap();
    let limit = limit.unwrap_or(100);
    let start = history.len().saturating_sub(limit);
    Ok(history[start..].to_vec())
}

/// Clear browsing history
#[tauri::command]
pub async fn browser_clear_history(
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    state.history.lock().unwrap().clear();
    Ok(())
}

/// Set responsive mode (viewport size)
#[tauri::command]
pub async fn browser_set_responsive_mode<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
    width: Option<u32>,
    height: Option<u32>,
) -> Result<(), String> {
    let label = state.webview_label.lock().unwrap().clone().ok_or("Browser not open")?;
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    
    match (width, height) {
        (Some(w), Some(h)) => {
            *state.responsive_mode.lock().unwrap() = Some((w, h));
            // Set viewport via CSS
            let script = format!(
                r#"document.documentElement.style.cssText = 'width:{}px !important;max-width:{}px !important;margin:0 auto;box-shadow:0 0 20px rgba(0,0,0,0.3);';"#,
                w, w
            );
            webview.eval(&script).map_err(|e| format!("Set responsive mode failed: {}", e))?;
        }
        _ => {
            *state.responsive_mode.lock().unwrap() = None;
            webview.eval("document.documentElement.style.cssText = '';").map_err(|e| format!("Clear responsive mode failed: {}", e))?;
        }
    }
    
    let _ = app.emit("browser://responsive-mode-changed", (width, height));
    Ok(())
}

/// Open DevTools (if supported)
#[tauri::command]
pub async fn browser_open_devtools<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    let label = state.webview_label.lock().unwrap().clone().ok_or("Browser not open")?;
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    
    #[cfg(debug_assertions)]
    webview.open_devtools();
    
    #[cfg(not(debug_assertions))]
    let _ = webview;
    
    Ok(())
}

/// Take screenshot (placeholder)
#[tauri::command]
pub async fn browser_screenshot() -> Result<String, String> {
    Err("Screenshot not yet implemented for embedded webview".to_string())
}

// ============================================================================
// DevTools Commands - Console, Errors, Network capture
// ============================================================================

/// Inject devtools capture scripts into the browser
#[allow(dead_code)]
#[tauri::command]
pub async fn browser_inject_devtools<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    let label = state.webview_label.lock().unwrap().clone().ok_or("Browser not open")?;
    let webview = app.get_webview(&label).ok_or("Browser webview not found")?;
    
    // The actual script is passed from the frontend
    // This command just confirms the browser is ready
    let _ = webview;
    Ok(())
}

/// Called from injected script when console.log/warn/error/info is called
#[allow(dead_code)]
#[tauri::command]
pub async fn browser_devtools_console_log<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
    level: String,
    message: String,
    args: Option<Vec<String>>,
    source: Option<String>,
    line: Option<u32>,
    column: Option<u32>,
    timestamp: u64,
) -> Result<(), String> {
    let log = ConsoleMessage {
        level,
        message,
        source,
        line,
        timestamp,
    };
    
    // Store in state (keep last 500)
    {
        let mut logs = state.console_messages.lock().unwrap();
        if logs.len() >= 500 {
            logs.remove(0);
        }
        logs.push(log.clone());
    }
    
    // Emit to frontend
    let _ = app.emit("browser://console-log", serde_json::json!({
        "level": log.level,
        "message": log.message,
        "args": args,
        "source": log.source,
        "line": log.line,
        "column": column,
        "timestamp": log.timestamp
    }));
    
    Ok(())
}

/// Called from injected script when a JS error occurs
#[allow(dead_code)]
#[tauri::command]
pub async fn browser_devtools_js_error<R: Runtime>(
    app: AppHandle<R>,
    message: String,
    filename: Option<String>,
    lineno: Option<u32>,
    colno: Option<u32>,
    stack: Option<String>,
    error_type: String,
    timestamp: u64,
) -> Result<(), String> {
    let _ = app.emit("browser://js-error", serde_json::json!({
        "message": message,
        "filename": filename,
        "lineno": lineno,
        "colno": colno,
        "stack": stack,
        "type": error_type,
        "timestamp": timestamp
    }));
    
    Ok(())
}

/// Called from injected script when a network request starts
#[allow(dead_code)]
#[tauri::command]
pub async fn browser_devtools_network_request<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
    id: String,
    method: String,
    url: String,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    timestamp: u64,
) -> Result<(), String> {
    let request = NetworkRequest {
        id: id.clone(),
        method: method.clone(),
        url: url.clone(),
        status: None,
        content_type: None,
        size: None,
        duration: None,
        timestamp,
    };
    
    // Store in state (keep last 200)
    {
        let mut requests = state.network_requests.lock().unwrap();
        if requests.len() >= 200 {
            requests.remove(0);
        }
        requests.push(request);
    }
    
    let _ = app.emit("browser://network-request", serde_json::json!({
        "id": id,
        "method": method,
        "url": url,
        "headers": headers,
        "body": body,
        "timestamp": timestamp
    }));
    
    Ok(())
}

/// Called from injected script when a network response is received
#[allow(dead_code)]
#[tauri::command]
pub async fn browser_devtools_network_response<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, BrowserState>,
    id: String,
    status: Option<u16>,
    status_text: Option<String>,
    response_headers: Option<HashMap<String, String>>,
    response_body: Option<String>,
    duration: Option<u64>,
    size: Option<u64>,
    error: Option<String>,
) -> Result<(), String> {
    // Update request in state
    {
        let mut requests = state.network_requests.lock().unwrap();
        if let Some(req) = requests.iter_mut().find(|r| r.id == id) {
            req.status = status;
            req.duration = duration;
            req.size = size;
            if let Some(headers) = &response_headers {
                req.content_type = headers.get("content-type").cloned();
            }
        }
    }
    
    let _ = app.emit("browser://network-response", serde_json::json!({
        "id": id,
        "status": status,
        "statusText": status_text,
        "responseHeaders": response_headers,
        "responseBody": response_body,
        "duration": duration,
        "size": size,
        "error": error
    }));
    
    Ok(())
}

/// Called from injected script with performance metrics
#[allow(dead_code)]
#[tauri::command]
pub async fn browser_devtools_performance<R: Runtime>(
    app: AppHandle<R>,
    dom_content_loaded: Option<u64>,
    load_complete: Option<u64>,
    first_paint: Option<u64>,
    first_contentful_paint: Option<u64>,
    largest_contentful_paint: Option<u64>,
    total_resources: Option<u32>,
    total_size: Option<u64>,
    js_heap_size: Option<u64>,
    timestamp: u64,
) -> Result<(), String> {
    let _ = app.emit("browser://performance", serde_json::json!({
        "domContentLoaded": dom_content_loaded,
        "loadComplete": load_complete,
        "firstPaint": first_paint,
        "firstContentfulPaint": first_contentful_paint,
        "largestContentfulPaint": largest_contentful_paint,
        "totalResources": total_resources,
        "totalSize": total_size,
        "jsHeapSize": js_heap_size,
        "timestamp": timestamp
    }));
    
    Ok(())
}

/// Called from injected script with application diagnostics snapshot
#[allow(dead_code)]
#[tauri::command]
pub async fn browser_devtools_application<R: Runtime>(
    app: AppHandle<R>,
    snapshot: serde_json::Value,
) -> Result<(), String> {
    let _ = app.emit("browser://application", snapshot);
    Ok(())
}

/// Called from injected script with a single security issue event
#[allow(dead_code)]
#[tauri::command]
pub async fn browser_devtools_security_issue<R: Runtime>(
    app: AppHandle<R>,
    issue: serde_json::Value,
) -> Result<(), String> {
    let _ = app.emit("browser://security-issue", issue);
    Ok(())
}

/// Get console messages from state
#[allow(dead_code)]
#[tauri::command]
pub async fn browser_get_console_messages(
    state: tauri::State<'_, BrowserState>,
    limit: Option<usize>,
) -> Result<Vec<ConsoleMessage>, String> {
    let messages = state.console_messages.lock().unwrap();
    let limit = limit.unwrap_or(100);
    let start = messages.len().saturating_sub(limit);
    Ok(messages[start..].to_vec())
}

/// Get network requests from state
#[allow(dead_code)]
#[tauri::command]
pub async fn browser_get_network_requests(
    state: tauri::State<'_, BrowserState>,
    limit: Option<usize>,
) -> Result<Vec<NetworkRequest>, String> {
    let requests = state.network_requests.lock().unwrap();
    let limit = limit.unwrap_or(100);
    let start = requests.len().saturating_sub(limit);
    Ok(requests[start..].to_vec())
}

/// Clear console messages
#[allow(dead_code)]
#[tauri::command]
pub async fn browser_clear_console(
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    state.console_messages.lock().unwrap().clear();
    Ok(())
}

/// Clear network requests
#[allow(dead_code)]
#[tauri::command]
pub async fn browser_clear_network(
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    state.network_requests.lock().unwrap().clear();
    Ok(())
}
