//! CDP Types - Data structures for CDP events and responses

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Console log entry from CDP Runtime.consoleAPICalled
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CdpConsoleLog {
    /// Log level: log, debug, info, error, warning, dir, table, trace, clear, etc.
    pub level: String,
    /// Formatted message content
    pub message: String,
    /// Raw arguments (serialized)
    pub args: Vec<String>,
    /// Source URL where the log originated
    pub source: Option<String>,
    /// Line number in source
    pub line: Option<u32>,
    /// Column number in source
    pub column: Option<u32>,
    /// Stack trace (for errors, warnings, traces)
    pub stack: Option<String>,
    /// Timestamp in milliseconds
    pub timestamp: u64,
}

/// JavaScript error from CDP Runtime.exceptionThrown
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CdpJsError {
    /// Error message
    pub message: String,
    /// Exception description
    pub description: Option<String>,
    /// Source file URL
    pub url: Option<String>,
    /// Line number (1-based)
    pub line: Option<u32>,
    /// Column number (1-based)
    pub column: Option<u32>,
    /// Stack trace
    pub stack: Option<String>,
    /// Error type (TypeError, ReferenceError, etc.)
    pub error_type: Option<String>,
    /// Timestamp in milliseconds
    pub timestamp: u64,
}

/// Network request from CDP Network.requestWillBeSent
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CdpNetworkRequest {
    /// Unique request ID
    pub id: String,
    /// HTTP method (GET, POST, etc.)
    pub method: String,
    /// Request URL
    pub url: String,
    /// Request headers
    pub headers: HashMap<String, String>,
    /// POST body (if any, truncated)
    pub body: Option<String>,
    /// Resource type (Document, Script, Stylesheet, Image, etc.)
    pub resource_type: Option<String>,
    /// Initiator type (parser, script, etc.)
    pub initiator: Option<String>,
    /// Timestamp when request was sent
    pub timestamp: u64,
}

/// Network response from CDP Network.responseReceived
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CdpNetworkResponse {
    /// Request ID this response belongs to
    pub id: String,
    /// HTTP status code
    pub status: u16,
    /// HTTP status text
    pub status_text: String,
    /// Response headers
    pub headers: HashMap<String, String>,
    /// MIME type
    pub mime_type: Option<String>,
    /// Response body (truncated for large responses)
    pub body: Option<String>,
    /// Response size in bytes
    pub size: Option<u64>,
    /// Time from request to response in milliseconds
    pub duration: Option<u64>,
    /// Whether response was from cache
    pub from_cache: bool,
    /// Timestamp when response was received
    pub timestamp: u64,
}

/// Network error from CDP Network.loadingFailed
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct CdpNetworkError {
    /// Request ID that failed
    pub id: String,
    /// Error message
    pub error: String,
    /// Whether request was cancelled
    pub canceled: bool,
    /// Blocked reason (if blocked)
    pub blocked_reason: Option<String>,
    /// Timestamp
    pub timestamp: u64,
}

/// DOM element information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CdpElement {
    /// Node ID in CDP DOM tree
    pub node_id: i64,
    /// Backend node ID (stable across navigations)
    pub backend_node_id: Option<i64>,
    /// Tag name (lowercase)
    pub tag_name: String,
    /// Element ID attribute
    pub id: Option<String>,
    /// Element classes
    pub classes: Vec<String>,
    /// Element attributes
    pub attributes: HashMap<String, String>,
    /// Outer HTML (truncated)
    pub outer_html: Option<String>,
    /// Inner text content
    pub inner_text: Option<String>,
    /// Computed CSS styles (important properties only)
    pub computed_styles: HashMap<String, String>,
    /// Bounding box
    pub rect: Option<CdpRect>,
    /// CSS selector to find this element
    pub selector: String,
    /// XPath to find this element
    pub xpath: String,
}

/// Rectangle for element bounds
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CdpRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Performance metrics from CDP Performance.getMetrics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CdpPerformanceMetrics {
    /// DOM content loaded time (ms)
    pub dom_content_loaded: Option<u64>,
    /// Page load complete time (ms)
    pub load_complete: Option<u64>,
    /// First paint time (ms)
    pub first_paint: Option<u64>,
    /// First contentful paint time (ms)
    pub first_contentful_paint: Option<u64>,
    /// Largest contentful paint time (ms)
    pub largest_contentful_paint: Option<u64>,
    /// Time to first byte (ms)
    pub time_to_first_byte: Option<u64>,
    /// Total DOM nodes
    pub dom_nodes: Option<u64>,
    /// JS heap size in bytes
    pub js_heap_size: Option<u64>,
    /// JS heap used in bytes
    pub js_heap_used: Option<u64>,
    /// Number of documents
    pub documents: Option<u64>,
    /// Number of frames
    pub frames: Option<u64>,
    /// Number of JS event listeners
    pub js_event_listeners: Option<u64>,
    /// Layout count
    pub layout_count: Option<u64>,
    /// Style recalc count
    pub style_recalc_count: Option<u64>,
    /// Timestamp
    pub timestamp: u64,
}

/// CDP connection status
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CdpStatus {
    /// Whether CDP is connected
    pub connected: bool,
    /// WebSocket URL if connected
    pub ws_url: Option<String>,
    /// Target/page ID if connected
    pub target_id: Option<String>,
    /// Error message if connection failed
    pub error: Option<String>,
    /// Whether CDP is available on this platform
    pub available: bool,
}

/// Screenshot result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CdpScreenshot {
    /// Base64 encoded image data
    pub data: String,
    /// Image format (png, jpeg, webp)
    pub format: String,
    /// Image width
    pub width: u32,
    /// Image height
    pub height: u32,
}

/// Click result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CdpClickResult {
    pub success: bool,
    pub element_found: bool,
    pub selector: String,
    pub error: Option<String>,
}

/// Type result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CdpTypeResult {
    pub success: bool,
    pub text: String,
    pub error: Option<String>,
}

/// Evaluate result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CdpEvaluateResult {
    pub success: bool,
    pub value: serde_json::Value,
    pub error: Option<String>,
}
