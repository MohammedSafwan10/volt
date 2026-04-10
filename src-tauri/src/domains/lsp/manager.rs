//! LSP Manager - Spawn and manage language server processes
//!
//! This module handles:
//! - Spawning language server processes using Tauri Shell plugin (sidecars)
//! - Spawning external language servers from PATH (e.g., Dart, Rust Analyzer)
//! - Managing server lifecycle (start, stop, restart)
//! - Routing JSON-RPC messages between frontend and servers
//! - Proper LSP message framing (Content-Length based)
//! - Clean shutdown on app/project close

use crate::observability::{debug_log, DebugScope};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::path::BaseDirectory;
use tauri::Manager;
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command as TokioCommand};
use tokio::sync::mpsc::{self, Receiver, Sender};

#[cfg(windows)]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

/// LSP-related errors
#[derive(Error, Debug, Serialize)]
#[serde(tag = "type")]
pub enum LspError {
    #[error("Server not found: {server_id}")]
    ServerNotFound { server_id: String },

    #[error("Server already running: {server_id}")]
    ServerAlreadyRunning { server_id: String },

    #[error("Failed to spawn server: {message}")]
    SpawnFailed { message: String },

    #[error("Failed to send message: {message}")]
    SendFailed { message: String },

    #[error("Server process error: {message}")]
    ProcessError { message: String },

    #[error("Invalid configuration: {message}")]
    InvalidConfig { message: String },
}

/// Configuration for an LSP server (sidecar mode - bundled with app)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspServerConfig {
    /// Unique identifier for this server instance
    pub server_id: String,
    /// Server type (e.g., "typescript", "tailwind", "eslint", "svelte")
    pub server_type: String,
    /// Sidecar name (matches externalBin in tauri.conf.json)
    pub sidecar_name: String,
    /// Language server entrypoint script (relative to bundle resources in production)
    pub entrypoint: String,
    /// Arguments for the sidecar
    pub args: Vec<String>,
    /// Working directory (usually project root)
    pub cwd: Option<String>,
    /// Environment variables
    pub env: Option<HashMap<String, String>>,
}

/// Configuration for an external LSP server (from user's PATH/SDK)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalLspConfig {
    /// Unique identifier for this server instance
    pub server_id: String,
    /// Server type (e.g., "dart", "rust-analyzer", "gopls")
    pub server_type: String,
    /// Command to execute (e.g., "dart", "rust-analyzer")
    pub command: String,
    /// Arguments for the command (e.g., ["language-server", "--client-id", "volt"])
    pub args: Vec<String>,
    /// Working directory (usually project root)
    pub cwd: Option<String>,
    /// Environment variables
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone)]
enum SavedServerConfig {
    Sidecar(LspServerConfig),
    External(ExternalLspConfig),
}

/// Information about a running LSP server
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspServerInfo {
    pub server_id: String,
    pub server_type: String,
    pub pid: Option<u32>,
    pub status: LspServerStatus,
}

/// Status of an LSP server
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum LspServerStatus {
    Starting,
    Running,
    Stopping,
    Stopped,
    Error,
}

/// Type of child process handle
enum ServerChild {
    /// Tauri sidecar (bundled with app)
    Sidecar(CommandChild),
    /// External process (from user's PATH)
    External {
        stdin_tx: Sender<String>,
        // Child handle stored for kill on drop
        _child: Child,
    },
}

/// Internal state for a running server
struct RunningServer {
    server_type: String,
    child: Option<ServerChild>,
    status: Arc<Mutex<LspServerStatus>>,
    pid: u32,
}

#[derive(Debug, Clone, Default)]
struct ReplayMessages {
    initialize: Option<String>,
    initialized: Option<String>,
    workspace_configuration: Option<String>,
}

#[derive(Debug, Clone)]
struct TrackedDocumentState {
    uri: String,
    language_id: String,
    version: i64,
    text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspDiagnosticProblem {
    file: String,
    file_name: String,
    line: usize,
    column: usize,
    end_line: usize,
    end_column: usize,
    message: String,
    severity: String,
    code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspDiagnosticsEvent {
    server_id: String,
    source: String,
    file_path: String,
    problems: Vec<LspDiagnosticProblem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspDiagnosticsClearFileEvent {
    server_id: String,
    source: String,
    file_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LspDiagnosticsSourceStateEvent {
    server_id: String,
    source: String,
    state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspTrackedDocumentSyncResult {
    kind: String,
    uri: String,
    version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspTrackedDocumentInfo {
    pub file_path: String,
    pub uri: String,
    pub language_id: String,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspProjectDiagnosticsPlan {
    pub action: String,
    pub run_id: Option<u64>,
    pub root_path: Option<String>,
    pub delay_ms: u64,
    pub stagger_ms: u64,
    pub sidecars: Vec<String>,
    pub stale_sources: Vec<String>,
    pub fresh_sources: Vec<String>,
}

#[derive(Debug, Default)]
struct ProjectDiagnosticsSchedulerState {
    active_run_id: Option<u64>,
    active_root: Option<String>,
    pending_root: Option<String>,
    next_run_id: u64,
    last_run_finished_at_ms: u64,
    sidecar_retry_after: HashMap<String, u64>,
    delayed_sources: HashSet<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LspRecoveryState {
    pub scheduled: bool,
    pub restarting: bool,
    pub attempts_in_window: usize,
}

#[derive(Debug, Default)]
struct RecoverySchedulerState {
    generation: u64,
    scheduled: bool,
    restarting: bool,
    attempt_timestamps: Vec<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspHealthStatus {
    pub healthy: bool,
    pub last_response_at: Option<u64>,
    pub consecutive_failures: u64,
    pub last_check_at: Option<u64>,
    pub avg_response_time_ms: Option<u64>,
    pub message: String,
}

#[derive(Debug, Default)]
struct HealthTrackerState {
    last_response_at: Option<u64>,
    consecutive_failures: u64,
    last_check_at: Option<u64>,
    response_times: Vec<u64>,
}

#[derive(Debug, Default)]
struct HealthMonitorState {
    generation: u64,
}

#[derive(Debug, Deserialize)]
struct PublishDiagnosticsParams {
    uri: String,
    diagnostics: Vec<PublishDiagnostic>,
}

#[derive(Debug, Deserialize)]
struct PublishDiagnostic {
    range: PublishDiagnosticRange,
    message: String,
    severity: Option<u8>,
    code: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct PublishDiagnosticRange {
    start: PublishDiagnosticPosition,
    end: PublishDiagnosticPosition,
}

#[derive(Debug, Deserialize)]
struct PublishDiagnosticPosition {
    line: usize,
    character: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DidOpenTextDocumentParams {
    text_document: DidOpenTextDocumentItem,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DidOpenTextDocumentItem {
    uri: String,
    language_id: String,
    version: i64,
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DidChangeTextDocumentParams {
    text_document: VersionedTextDocumentIdentifier,
    content_changes: Vec<TextDocumentContentChangeEvent>,
}

#[derive(Debug, Deserialize)]
struct VersionedTextDocumentIdentifier {
    uri: String,
    version: i64,
}

#[derive(Debug, Deserialize)]
struct TextDocumentContentChangeEvent {
    text: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DidCloseTextDocumentParams {
    text_document: TextDocumentIdentifier,
}

#[derive(Debug, Deserialize)]
struct TextDocumentIdentifier {
    uri: String,
}

/// LSP Manager - manages all language server processes (sidecars and external)
pub struct LspManager<R: Runtime> {
    servers: Arc<Mutex<HashMap<String, RunningServer>>>,
    saved_configs: Arc<Mutex<HashMap<String, SavedServerConfig>>>,
    replay_messages: Arc<Mutex<HashMap<String, ReplayMessages>>>,
    recovery_state: Arc<Mutex<HashMap<String, RecoverySchedulerState>>>,
    health_state: Arc<Mutex<HashMap<String, HealthTrackerState>>>,
    health_monitors: Arc<Mutex<HashMap<String, HealthMonitorState>>>,
    tracked_documents: Arc<Mutex<HashMap<String, HashMap<String, TrackedDocumentState>>>>,
    project_diagnostics: Arc<Mutex<ProjectDiagnosticsSchedulerState>>,
    app_handle: AppHandle<R>,
}

impl<R: Runtime> Clone for LspManager<R> {
    fn clone(&self) -> Self {
        Self {
            servers: Arc::clone(&self.servers),
            saved_configs: Arc::clone(&self.saved_configs),
            replay_messages: Arc::clone(&self.replay_messages),
            recovery_state: Arc::clone(&self.recovery_state),
            health_state: Arc::clone(&self.health_state),
            health_monitors: Arc::clone(&self.health_monitors),
            tracked_documents: Arc::clone(&self.tracked_documents),
            project_diagnostics: Arc::clone(&self.project_diagnostics),
            app_handle: self.app_handle.clone(),
        }
    }
}

impl<R: Runtime> LspManager<R> {
    /// Create a new LSP manager
    pub fn new(app_handle: AppHandle<R>) -> Self {
        Self {
            servers: Arc::new(Mutex::new(HashMap::new())),
            saved_configs: Arc::new(Mutex::new(HashMap::new())),
            replay_messages: Arc::new(Mutex::new(HashMap::new())),
            recovery_state: Arc::new(Mutex::new(HashMap::new())),
            health_state: Arc::new(Mutex::new(HashMap::new())),
            health_monitors: Arc::new(Mutex::new(HashMap::new())),
            tracked_documents: Arc::new(Mutex::new(HashMap::new())),
            project_diagnostics: Arc::new(Mutex::new(ProjectDiagnosticsSchedulerState::default())),
            app_handle,
        }
    }

    fn current_time_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0)
    }

    fn prune_recovery_attempts(
        scheduler: &mut RecoverySchedulerState,
        window_ms: u64,
        now: u64,
    ) {
        let cutoff = now.saturating_sub(window_ms);
        scheduler
            .attempt_timestamps
            .retain(|timestamp| *timestamp >= cutoff);
    }

    fn capture_recovery_snapshot(
        scheduler: &mut RecoverySchedulerState,
        window_ms: u64,
    ) -> LspRecoveryState {
        Self::prune_recovery_attempts(scheduler, window_ms, Self::current_time_ms());
        LspRecoveryState {
            scheduled: scheduler.scheduled,
            restarting: scheduler.restarting,
            attempts_in_window: scheduler.attempt_timestamps.len(),
        }
    }

    fn default_health_status() -> LspHealthStatus {
        LspHealthStatus {
            healthy: true,
            last_response_at: None,
            consecutive_failures: 0,
            last_check_at: None,
            avg_response_time_ms: None,
            message: "Not started".to_string(),
        }
    }

    fn reset_health_state_internal(&self, server_id: &str) -> LspHealthStatus {
        if let Ok(mut health_state) = self.health_state.lock() {
            health_state.insert(server_id.to_string(), HealthTrackerState::default());
        }

        Self::default_health_status()
    }

    fn trim_response_times(response_times: &mut Vec<u64>) {
        const RESPONSE_TIME_WINDOW: usize = 10;
        if response_times.len() > RESPONSE_TIME_WINDOW {
            let drain = response_times.len() - RESPONSE_TIME_WINDOW;
            response_times.drain(..drain);
        }
    }

    fn average_response_time_ms(response_times: &[u64]) -> Option<u64> {
        if response_times.is_empty() {
            return None;
        }

        Some(response_times.iter().sum::<u64>() / response_times.len() as u64)
    }

    fn reset_recovery_state_internal(&self, server_id: &str) -> LspRecoveryState {
        if let Ok(mut recovery_state) = self.recovery_state.lock() {
            let scheduler = recovery_state.entry(server_id.to_string()).or_default();
            scheduler.generation = scheduler.generation.saturating_add(1);
            scheduler.scheduled = false;
            scheduler.restarting = false;
            scheduler.attempt_timestamps.clear();
        }

        LspRecoveryState::default()
    }

    fn is_known_project_diagnostics_sidecar(sidecar: &str) -> bool {
        matches!(
            sidecar,
            "css" | "html" | "typescript" | "svelte" | "eslint" | "dart"
        )
    }

    fn diagnostics_source_for_sidecar(sidecar: &str) -> &str {
        match sidecar {
            "eslint" => "eslint",
            "typescript" => "typescript",
            other => other,
        }
    }

    fn collect_stale_sources(
        scheduler: &mut ProjectDiagnosticsSchedulerState,
        sidecars: &[String],
    ) -> Vec<String> {
        let stale = sidecars
            .iter()
            .map(|sidecar| Self::diagnostics_source_for_sidecar(sidecar).to_string())
            .collect::<Vec<_>>();
        for source in &stale {
            scheduler.delayed_sources.insert(source.clone());
        }
        stale
    }

    fn collect_fresh_sources(
        requested_sidecars: &[String],
        scheduled_sidecars: &[String],
    ) -> Vec<String> {
        let scheduled_sources = scheduled_sidecars
            .iter()
            .map(|sidecar| Self::diagnostics_source_for_sidecar(sidecar).to_string())
            .collect::<HashSet<_>>();
        let mut seen_sources = HashSet::new();
        let mut fresh_sources = Vec::new();

        for sidecar in requested_sidecars {
            let normalized = sidecar.trim();
            if normalized.is_empty() || !Self::is_known_project_diagnostics_sidecar(normalized) {
                continue;
            }

            let source = Self::diagnostics_source_for_sidecar(normalized).to_string();
            if !scheduled_sources.contains(&source) || !seen_sources.insert(source.clone()) {
                continue;
            }

            fresh_sources.push(source);
        }

        fresh_sources
    }

    fn take_stale_sources(scheduler: &mut ProjectDiagnosticsSchedulerState) -> Vec<String> {
        let stale = scheduler
            .delayed_sources
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        scheduler.delayed_sources.clear();
        stale
    }

    fn collect_cooldown_blocked_sources(
        scheduler: &mut ProjectDiagnosticsSchedulerState,
        requested_sidecars: &[String],
        now: u64,
    ) -> Vec<String> {
        let mut blocked_sources = Vec::new();
        let mut seen_sources = HashSet::new();

        for sidecar in requested_sidecars {
            let normalized = sidecar.trim();
            if normalized.is_empty() || !Self::is_known_project_diagnostics_sidecar(normalized) {
                continue;
            }

            let retry_after = scheduler
                .sidecar_retry_after
                .get(normalized)
                .copied()
                .unwrap_or(0);
            if retry_after <= now {
                continue;
            }

            let source = Self::diagnostics_source_for_sidecar(normalized).to_string();
            scheduler.delayed_sources.insert(source.clone());
            if seen_sources.insert(source.clone()) {
                blocked_sources.push(source);
            }
        }

        blocked_sources
    }

    fn should_cooldown_project_diagnostics_sidecar(
        error_type: Option<&str>,
        message: Option<&str>,
    ) -> bool {
        let error_type = error_type.unwrap_or_default();
        let message = message.unwrap_or_default().to_ascii_lowercase();

        matches!(
            error_type,
            "ServerNotFound" | "SpawnFailed" | "SendFailed" | "ProcessError"
        ) || message.contains("transport not connected")
            || message.contains("server exited")
            || message.contains("spawn failed")
    }

    fn map_diagnostic_severity(severity: Option<u8>) -> &'static str {
        match severity.unwrap_or(1) {
            1 => "error",
            2 => "warning",
            3 => "info",
            4 => "hint",
            _ => "info",
        }
    }

    fn uri_to_file_path(uri: &str) -> String {
        let mut path = uri.strip_prefix("file://").unwrap_or(uri).to_string();
        let decoded = urlencoding::decode(&path)
            .map(|value| value.into_owned())
            .unwrap_or(path);
        path = decoded;

        if cfg!(windows) && path.starts_with('/') && path.chars().nth(2) == Some(':') {
            path = path[1..].to_string();
        }

        path = path.replace('\\', "/");
        if path.len() >= 2 && path.as_bytes()[1] == b':' {
            let mut chars: Vec<char> = path.chars().collect();
            chars[0] = chars[0].to_ascii_lowercase();
            path = chars.into_iter().collect();
        }

        path
    }

    fn file_path_to_uri(file_path: &str) -> String {
        let mut normalized = file_path.replace('\\', "/");
        if normalized.len() >= 2 && normalized.as_bytes()[1] == b':' {
            let mut chars: Vec<char> = normalized.chars().collect();
            chars[0] = chars[0].to_ascii_lowercase();
            normalized = chars.into_iter().collect();
        }

        let encoded = normalized
            .split('/')
            .map(|segment| urlencoding::encode(segment).into_owned())
            .collect::<Vec<_>>()
            .join("/");

        if normalized.len() >= 2 && normalized.as_bytes()[1] == b':' {
            format!("file:///{}", encoded)
        } else {
            format!("file://{}", encoded)
        }
    }

    fn emit_diagnostics_source_state(
        app_handle: &AppHandle<R>,
        server_id: &str,
        source: &str,
        state: &str,
    ) {
        let _ = app_handle.emit(
            &format!("lsp://{}//diagnostics-source-state", server_id),
            LspDiagnosticsSourceStateEvent {
                server_id: server_id.to_string(),
                source: source.to_string(),
                state: state.to_string(),
            },
        );
    }

    fn emit_diagnostics_clear_file(
        app_handle: &AppHandle<R>,
        server_id: &str,
        source: &str,
        uri: &str,
    ) {
        let _ = app_handle.emit(
            &format!("lsp://{}//diagnostics-clear-file", server_id),
            LspDiagnosticsClearFileEvent {
                server_id: server_id.to_string(),
                source: source.to_string(),
                file_path: Self::uri_to_file_path(uri),
            },
        );
    }

    fn maybe_emit_publish_diagnostics(
        app_handle: &AppHandle<R>,
        server_id: &str,
        source: &str,
        json: &Value,
    ) {
        let Some(method) = json.get("method").and_then(Value::as_str) else {
            return;
        };
        if method != "textDocument/publishDiagnostics" {
            return;
        }

        let Some(params_value) = json.get("params").cloned() else {
            return;
        };
        let Ok(params) = serde_json::from_value::<PublishDiagnosticsParams>(params_value) else {
            return;
        };

        let file_path = Self::uri_to_file_path(&params.uri);
        let file_name = file_path
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(&file_path)
            .to_string();

        let problems = params
            .diagnostics
            .into_iter()
            .enumerate()
            .map(|(_index, diagnostic)| LspDiagnosticProblem {
                file: file_path.clone(),
                file_name: file_name.clone(),
                line: diagnostic.range.start.line + 1,
                column: diagnostic.range.start.character + 1,
                end_line: diagnostic.range.end.line + 1,
                end_column: diagnostic.range.end.character + 1,
                message: diagnostic.message,
                severity: Self::map_diagnostic_severity(diagnostic.severity).to_string(),
                code: diagnostic.code.map(|value| match value {
                    Value::String(text) => text,
                    other => other.to_string(),
                }),
            })
            .collect();

        let _ = app_handle.emit(
            &format!("lsp://{}//diagnostics", server_id),
            LspDiagnosticsEvent {
                server_id: server_id.to_string(),
                source: source.to_string(),
                file_path,
                problems,
            },
        );
    }

    fn upsert_tracked_document(&self, server_id: &str, document: TrackedDocumentState) {
        if let Ok(mut tracked) = self.tracked_documents.lock() {
            tracked
                .entry(server_id.to_string())
                .or_default()
                .insert(document.uri.clone(), document);
        }
    }

    fn update_tracked_document(&self, server_id: &str, params: DidChangeTextDocumentParams) {
        if let Ok(mut tracked) = self.tracked_documents.lock() {
            if let Some(server_docs) = tracked.get_mut(server_id) {
                if let Some(document) = server_docs.get_mut(&params.text_document.uri) {
                    document.version = params.text_document.version;
                    if let Some(text) = params
                        .content_changes
                        .iter()
                        .rev()
                        .find_map(|change| change.text.clone())
                    {
                        document.text = text;
                    }
                }
            }
        }
    }

    fn remove_tracked_document(&self, server_id: &str, uri: &str) {
        if let Ok(mut tracked) = self.tracked_documents.lock() {
            if let Some(server_docs) = tracked.get_mut(server_id) {
                server_docs.remove(uri);
            }
        }
    }

    fn clear_tracked_documents(&self, server_id: &str) {
        if let Ok(mut tracked) = self.tracked_documents.lock() {
            tracked.remove(server_id);
        }
    }

    fn clear_replay_messages(&self, server_id: &str) {
        if let Ok(mut replay_messages) = self.replay_messages.lock() {
            replay_messages.remove(server_id);
        }
    }

    fn sync_tracked_document(
        &self,
        server_id: &str,
        file_path: &str,
        language_id: &str,
        text: &str,
    ) -> Result<LspTrackedDocumentSyncResult, LspError> {
        let uri = Self::file_path_to_uri(file_path);
        let mut tracked = self
            .tracked_documents
            .lock()
            .map_err(|e| LspError::ProcessError {
                message: format!("Failed to acquire tracked document lock: {}", e),
            })?;
        let server_docs = tracked.entry(server_id.to_string()).or_default();

        if let Some(document) = server_docs.get_mut(&uri) {
            if document.text == text {
                return Ok(LspTrackedDocumentSyncResult {
                    kind: "noop".to_string(),
                    uri,
                    version: document.version,
                });
            }

            document.version += 1;
            document.text = text.to_string();
            if !language_id.trim().is_empty() {
                document.language_id = language_id.to_string();
            }

            return Ok(LspTrackedDocumentSyncResult {
                kind: "change".to_string(),
                uri,
                version: document.version,
            });
        }

        server_docs.insert(
            uri.clone(),
            TrackedDocumentState {
                uri: uri.clone(),
                language_id: language_id.to_string(),
                version: 1,
                text: text.to_string(),
            },
        );

        Ok(LspTrackedDocumentSyncResult {
            kind: "open".to_string(),
            uri,
            version: 1,
        })
    }

    fn collect_rehydrate_messages(&self, server_id: &str) -> Vec<String> {
        let Ok(tracked) = self.tracked_documents.lock() else {
            return Vec::new();
        };

        tracked
            .get(server_id)
            .map(|server_docs| {
                server_docs
                    .values()
                    .filter_map(|document| {
                        serde_json::to_string(&serde_json::json!({
                            "jsonrpc": "2.0",
                            "method": "textDocument/didOpen",
                            "params": {
                                "textDocument": {
                                    "uri": document.uri,
                                    "languageId": document.language_id,
                                    "version": document.version,
                                    "text": document.text,
                                }
                            }
                        }))
                        .ok()
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn list_tracked_documents(
        &self,
        server_id: &str,
    ) -> Result<Vec<LspTrackedDocumentInfo>, LspError> {
        let tracked = self
            .tracked_documents
            .lock()
            .map_err(|e| LspError::ProcessError {
                message: format!("Failed to acquire tracked document lock: {}", e),
            })?;

        let mut documents = tracked
            .get(server_id)
            .map(|server_docs| {
                server_docs
                    .values()
                    .map(|document| LspTrackedDocumentInfo {
                        file_path: Self::uri_to_file_path(&document.uri),
                        uri: document.uri.clone(),
                        language_id: document.language_id.clone(),
                        version: document.version,
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        documents.sort_by(|a, b| a.file_path.cmp(&b.file_path));
        Ok(documents)
    }

    pub fn begin_project_diagnostics(
        &self,
        root_path: &str,
        requested_sidecars: &[String],
    ) -> Result<LspProjectDiagnosticsPlan, LspError> {
        const MIN_INTERVAL_MS: u64 = 2_500;
        const STAGGER_MS: u64 = 150;

        let trimmed_root = root_path.trim();
        if trimmed_root.is_empty() {
            return Err(LspError::InvalidConfig {
                message: "Project diagnostics root path cannot be empty".to_string(),
            });
        }

        let mut scheduler =
            self.project_diagnostics
                .lock()
                .map_err(|e| LspError::ProcessError {
                    message: format!("Failed to acquire project diagnostics lock: {}", e),
                })?;
        let now = Self::current_time_ms();

        if scheduler.active_run_id.is_some() {
            scheduler.pending_root = Some(trimmed_root.to_string());
            return Ok(LspProjectDiagnosticsPlan {
                action: "queued".to_string(),
                run_id: None,
                root_path: Some(trimmed_root.to_string()),
                delay_ms: 0,
                stagger_ms: STAGGER_MS,
                sidecars: Vec::new(),
                stale_sources: Vec::new(),
                fresh_sources: Vec::new(),
            });
        }

        let elapsed = now.saturating_sub(scheduler.last_run_finished_at_ms);
        if scheduler.last_run_finished_at_ms != 0 && elapsed < MIN_INTERVAL_MS {
            scheduler.pending_root = Some(trimmed_root.to_string());
            let stale_sources = Self::collect_stale_sources(&mut scheduler, requested_sidecars);
            return Ok(LspProjectDiagnosticsPlan {
                action: "delay".to_string(),
                run_id: None,
                root_path: Some(trimmed_root.to_string()),
                delay_ms: MIN_INTERVAL_MS - elapsed,
                stagger_ms: STAGGER_MS,
                sidecars: Vec::new(),
                stale_sources,
                fresh_sources: Vec::new(),
            });
        }

        scheduler.next_run_id = scheduler.next_run_id.saturating_add(1);
        let run_id = scheduler.next_run_id;
        scheduler.active_run_id = Some(run_id);
        scheduler.active_root = Some(trimmed_root.to_string());

        let mut seen = HashSet::new();
        let sidecars = requested_sidecars
            .iter()
            .filter_map(|sidecar| {
                let normalized = sidecar.trim();
                if normalized.is_empty()
                    || !Self::is_known_project_diagnostics_sidecar(normalized)
                    || !seen.insert(normalized.to_string())
                {
                    return None;
                }

                let retry_after = scheduler
                    .sidecar_retry_after
                    .get(normalized)
                    .copied()
                    .unwrap_or(0);
                if retry_after > now {
                    return None;
                }

                Some(normalized.to_string())
            })
            .collect::<Vec<_>>();
        let mut stale_sources = Self::take_stale_sources(&mut scheduler);
        let cooldown_blocked_sources =
            Self::collect_cooldown_blocked_sources(&mut scheduler, requested_sidecars, now);
        for source in cooldown_blocked_sources {
            if !stale_sources.iter().any(|existing| existing == &source) {
                stale_sources.push(source);
            }
        }
        let fresh_sources = Self::collect_fresh_sources(requested_sidecars, &sidecars);

        Ok(LspProjectDiagnosticsPlan {
            action: "run".to_string(),
            run_id: Some(run_id),
            root_path: Some(trimmed_root.to_string()),
            delay_ms: 0,
            stagger_ms: STAGGER_MS,
            sidecars,
            stale_sources,
            fresh_sources,
        })
    }

    pub fn complete_project_diagnostics(
        &self,
        run_id: u64,
    ) -> Result<LspProjectDiagnosticsPlan, LspError> {
        const MIN_INTERVAL_MS: u64 = 2_500;
        const STAGGER_MS: u64 = 150;

        let mut scheduler =
            self.project_diagnostics
                .lock()
                .map_err(|e| LspError::ProcessError {
                    message: format!("Failed to acquire project diagnostics lock: {}", e),
                })?;

        if scheduler.active_run_id != Some(run_id) {
            return Ok(LspProjectDiagnosticsPlan {
                action: "noop".to_string(),
                run_id: None,
                root_path: None,
                delay_ms: 0,
                stagger_ms: STAGGER_MS,
                sidecars: Vec::new(),
                stale_sources: Vec::new(),
                fresh_sources: Vec::new(),
            });
        }

        scheduler.active_run_id = None;
        scheduler.active_root = None;
        scheduler.last_run_finished_at_ms = Self::current_time_ms();

        if let Some(root_path) = scheduler.pending_root.take() {
            return Ok(LspProjectDiagnosticsPlan {
                action: "delay".to_string(),
                run_id: None,
                root_path: Some(root_path),
                delay_ms: MIN_INTERVAL_MS,
                stagger_ms: STAGGER_MS,
                sidecars: Vec::new(),
                stale_sources: Vec::new(),
                fresh_sources: Vec::new(),
            });
        }

        Ok(LspProjectDiagnosticsPlan {
            action: "noop".to_string(),
            run_id: None,
            root_path: None,
            delay_ms: 0,
            stagger_ms: STAGGER_MS,
            sidecars: Vec::new(),
            stale_sources: Vec::new(),
            fresh_sources: Vec::new(),
        })
    }

    pub fn note_project_diagnostics_sidecar_failure(
        &self,
        sidecar: &str,
        error_type: Option<&str>,
        message: Option<&str>,
    ) -> Result<bool, LspError> {
        const RETRY_COOLDOWN_MS: u64 = 60_000;

        if !Self::is_known_project_diagnostics_sidecar(sidecar) {
            return Ok(false);
        }

        if !Self::should_cooldown_project_diagnostics_sidecar(error_type, message) {
            return Ok(false);
        }

        let mut scheduler =
            self.project_diagnostics
                .lock()
                .map_err(|e| LspError::ProcessError {
                    message: format!("Failed to acquire project diagnostics lock: {}", e),
                })?;
        scheduler.sidecar_retry_after.insert(
            sidecar.to_string(),
            Self::current_time_ms().saturating_add(RETRY_COOLDOWN_MS),
        );
        Ok(true)
    }

    pub fn reset_project_diagnostics_scheduler(&self) -> Result<(), LspError> {
        let mut scheduler =
            self.project_diagnostics
                .lock()
                .map_err(|e| LspError::ProcessError {
                    message: format!("Failed to acquire project diagnostics lock: {}", e),
                })?;
        *scheduler = ProjectDiagnosticsSchedulerState::default();
        Ok(())
    }

    pub fn reset_recovery_state(&self, server_id: &str) -> Result<LspRecoveryState, LspError> {
        Ok(self.reset_recovery_state_internal(server_id))
    }

    pub fn check_health(
        &self,
        server_id: &str,
        transport_connected: bool,
        failure_threshold: u64,
    ) -> Result<LspHealthStatus, LspError> {
        let start = Self::current_time_ms();
        let server_info = self.get_server_info(server_id)?;
        let now = Self::current_time_ms();
        let response_time = now.saturating_sub(start);

        let mut health_state = self.health_state.lock().map_err(|e| LspError::ProcessError {
            message: format!("Failed to acquire health state lock: {}", e),
        })?;
        let tracker = health_state.entry(server_id.to_string()).or_default();

        if transport_connected && server_info.status == LspServerStatus::Running {
            tracker.last_response_at = Some(now);
            tracker.consecutive_failures = 0;
            tracker.last_check_at = Some(now);
            tracker.response_times.push(response_time);
            Self::trim_response_times(&mut tracker.response_times);

            return Ok(LspHealthStatus {
                healthy: true,
                last_response_at: tracker.last_response_at,
                consecutive_failures: tracker.consecutive_failures,
                last_check_at: tracker.last_check_at,
                avg_response_time_ms: Self::average_response_time_ms(&tracker.response_times),
                message: format!("Healthy ({}ms)", response_time),
            });
        }

        tracker.consecutive_failures = tracker.consecutive_failures.saturating_add(1);
        tracker.last_check_at = Some(now);
        let healthy = tracker.consecutive_failures < failure_threshold;
        Ok(LspHealthStatus {
            healthy,
            last_response_at: tracker.last_response_at,
            consecutive_failures: tracker.consecutive_failures,
            last_check_at: tracker.last_check_at,
            avg_response_time_ms: Self::average_response_time_ms(&tracker.response_times),
            message: if healthy {
                format!("Warning: {}/{} failures", tracker.consecutive_failures, failure_threshold)
            } else {
                format!("Unhealthy: {} consecutive failures", tracker.consecutive_failures)
            },
        })
    }

    pub fn start_health_monitoring(
        &self,
        server_id: &str,
        interval_ms: u64,
        failure_threshold: u64,
    ) -> Result<(), LspError> {
        if !self
            .saved_configs
            .lock()
            .map_err(|e| LspError::ProcessError {
                message: format!("Failed to acquire saved config lock: {}", e),
            })?
            .contains_key(server_id)
        {
            return Err(LspError::ServerNotFound {
                server_id: server_id.to_string(),
            });
        }

        let generation = {
            let mut monitors =
                self.health_monitors
                    .lock()
                    .map_err(|e| LspError::ProcessError {
                        message: format!("Failed to acquire health monitor lock: {}", e),
                    })?;
            let state = monitors.entry(server_id.to_string()).or_default();
            state.generation = state.generation.saturating_add(1);
            state.generation
        };

        let manager = self.clone();
        let server_id = server_id.to_string();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(interval_ms)).await;

                let active = manager
                    .health_monitors
                    .lock()
                    .ok()
                    .and_then(|monitors| monitors.get(&server_id).map(|state| state.generation))
                    == Some(generation);
                if !active {
                    break;
                }

                match manager.check_health(&server_id, true, failure_threshold) {
                    Ok(status) => {
                        let _ = manager
                            .app_handle
                            .emit(&format!("lsp://{}//health", server_id), status.clone());
                        if !status.healthy {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = manager
                            .app_handle
                            .emit(&format!("lsp://{}//error", server_id), error.to_string());
                        break;
                    }
                }
            }

            if let Ok(mut monitors) = manager.health_monitors.lock() {
                if monitors
                    .get(&server_id)
                    .map(|state| state.generation)
                    == Some(generation)
                {
                    monitors.remove(&server_id);
                }
            }
        });

        Ok(())
    }

    pub fn stop_health_monitoring(&self, server_id: &str) -> Result<(), LspError> {
        let mut monitors = self
            .health_monitors
            .lock()
            .map_err(|e| LspError::ProcessError {
                message: format!("Failed to acquire health monitor lock: {}", e),
            })?;
        monitors.remove(server_id);
        Ok(())
    }

    pub fn schedule_recovery(
        &self,
        server_id: &str,
        reason: &str,
        base_delay_ms: u64,
        max_delay_ms: u64,
        max_attempts: usize,
        window_ms: u64,
    ) -> Result<LspRecoveryState, LspError> {
        if !self
            .saved_configs
            .lock()
            .map_err(|e| LspError::ProcessError {
                message: format!("Failed to acquire saved config lock: {}", e),
            })?
            .contains_key(server_id)
        {
            return Err(LspError::ServerNotFound {
                server_id: server_id.to_string(),
            });
        }

        let mut recovery_state = self.recovery_state.lock().map_err(|e| LspError::ProcessError {
            message: format!("Failed to acquire recovery state lock: {}", e),
        })?;
        let scheduler = recovery_state.entry(server_id.to_string()).or_default();
        let now = Self::current_time_ms();
        Self::prune_recovery_attempts(scheduler, window_ms, now);

        if scheduler.scheduled || scheduler.restarting {
            return Ok(Self::capture_recovery_snapshot(scheduler, window_ms));
        }

        if scheduler.attempt_timestamps.len() >= max_attempts {
            println!(
                "[LSP Recovery] Refusing to restart {}; exceeded {} attempts within {}ms ({})",
                server_id, max_attempts, window_ms, reason
            );
            return Ok(Self::capture_recovery_snapshot(scheduler, window_ms));
        }

        let exponent = u32::try_from(scheduler.attempt_timestamps.len()).unwrap_or(u32::MAX);
        let multiplier = 2_u64.saturating_pow(exponent);
        let delay_ms = base_delay_ms.saturating_mul(multiplier).min(max_delay_ms);

        scheduler.generation = scheduler.generation.saturating_add(1);
        let generation = scheduler.generation;
        scheduler.scheduled = true;
        let snapshot = Self::capture_recovery_snapshot(scheduler, window_ms);

        let manager = self.clone();
        let server_id = server_id.to_string();
        let reason = reason.to_string();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;

            {
                let Ok(mut recovery_state) = manager.recovery_state.lock() else {
                    return;
                };
                let Some(scheduler) = recovery_state.get_mut(&server_id) else {
                    return;
                };
                Self::prune_recovery_attempts(scheduler, window_ms, Self::current_time_ms());
                if scheduler.generation != generation || !scheduler.scheduled || scheduler.restarting
                {
                    return;
                }
                scheduler.scheduled = false;
                scheduler.restarting = true;
                scheduler.attempt_timestamps.push(Self::current_time_ms());
                Self::prune_recovery_attempts(scheduler, window_ms, Self::current_time_ms());
            }

            println!("[LSP Recovery] Restarting {} ({})", server_id, reason);
            match manager.restart_server(&server_id) {
                Ok(_) => {
                    manager.reset_recovery_state_internal(&server_id);
                }
                Err(error) => {
                    if let Ok(mut recovery_state) = manager.recovery_state.lock() {
                        if let Some(scheduler) = recovery_state.get_mut(&server_id) {
                            if scheduler.generation == generation {
                                scheduler.restarting = false;
                            }
                        }
                    }

                    let _ = manager
                        .app_handle
                        .emit(&format!("lsp://{}//error", server_id), error.to_string());
                }
            }
        });

        Ok(snapshot)
    }

    fn write_sidecar_message(sidecar: &mut CommandChild, message: &str) -> Result<(), LspError> {
        let content_length = message.len();
        let full_message = format!("Content-Length: {}\r\n\r\n{}", content_length, message);
        sidecar
            .write(full_message.as_bytes())
            .map_err(|e| LspError::SendFailed {
                message: format!("Failed to write to stdin: {}", e),
            })
    }

    fn send_external_message(stdin_tx: &Sender<String>, message: String) -> Result<(), LspError> {
        match stdin_tx.try_send(message) {
            Ok(()) => Ok(()),
            Err(tokio::sync::mpsc::error::TrySendError::Full(message)) => stdin_tx
                .blocking_send(message)
                .map_err(|e| LspError::SendFailed {
                    message: format!("Failed to send to stdin channel: {}", e),
                }),
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => Err(LspError::SendFailed {
                message: "Failed to send to stdin channel: channel closed".to_string(),
            }),
        }
    }

    /// Start a language server sidecar with the given configuration
    pub fn start_server(&self, config: LspServerConfig) -> Result<LspServerInfo, LspError> {
        let _scope = DebugScope::new(
            "lsp",
            format!(
                "start_sidecar server_id={} server_type={}",
                config.server_id, config.server_type
            ),
        );
        let mut servers = self.servers.lock().map_err(|e| LspError::ProcessError {
            message: format!("Failed to acquire lock: {}", e),
        })?;

        // Check if server is already running
        if servers.contains_key(&config.server_id) {
            return Err(LspError::ServerAlreadyRunning {
                server_id: config.server_id.clone(),
            });
        }

        // Get the shell plugin
        let shell = self.app_handle.shell();

        // Resolve the language server entrypoint.
        let entrypoint_path = resolve_entrypoint_path(&self.app_handle, &config.entrypoint)?;

        // Create the sidecar command using Tauri Shell plugin
        let mut command =
            shell
                .sidecar(&config.sidecar_name)
                .map_err(|e| LspError::SpawnFailed {
                    message: format!("Failed to create sidecar '{}': {}", config.sidecar_name, e),
                })?;

        // For JS-based language servers we run a Node sidecar and pass the entrypoint as first arg.
        command = command.arg(entrypoint_path).args(&config.args);

        // Set working directory if specified
        if let Some(ref cwd) = config.cwd {
            command = command.current_dir(cwd);
        }

        // Set environment variables if specified
        if let Some(ref env) = config.env {
            for (key, value) in env {
                command = command.env(key, value);
            }
        }

        // Spawn the sidecar process
        let (rx, child) = command.spawn().map_err(|e| LspError::SpawnFailed {
            message: format!("Failed to spawn sidecar '{}': {}", config.sidecar_name, e),
        })?;

        let pid = child.pid();
        let server_id = config.server_id.clone();
        let server_type = config.server_type.clone();
        let status = Arc::new(Mutex::new(LspServerStatus::Running));

        // Set up event handler for stdout/stderr
        let app_handle = self.app_handle.clone();
        let server_id_clone = server_id.clone();
        let server_type_clone = server_type.clone();
        let status_clone = Arc::clone(&status);
        let servers_clone = Arc::clone(&self.servers);

        // Spawn a task to handle events from the sidecar
        tauri::async_runtime::spawn(async move {
            Self::handle_sidecar_events(
                rx,
                app_handle,
                server_id_clone,
                server_type_clone,
                status_clone,
                servers_clone,
            )
            .await;
        });

        // Store the running server
        servers.insert(
            server_id.clone(),
            RunningServer {
                server_type: config.server_type.clone(),
                child: Some(ServerChild::Sidecar(child)),
                status,
                pid,
            },
        );

        if let Ok(mut saved_configs) = self.saved_configs.lock() {
            saved_configs.insert(
                server_id.clone(),
                SavedServerConfig::Sidecar(config.clone()),
            );
        }
        self.reset_recovery_state_internal(&server_id);
        self.reset_health_state_internal(&server_id);

        Ok(LspServerInfo {
            server_id,
            server_type,
            pid: Some(pid),
            status: LspServerStatus::Running,
        })
    }

    pub fn start_server_managed(&self, config: LspServerConfig) -> Result<LspServerInfo, LspError> {
        match self.start_server(config.clone()) {
            Ok(info) => Ok(info),
            Err(LspError::ServerAlreadyRunning { .. }) => {
                let _ = self.stop_server(&config.server_id, false);
                self.start_server(config)
            }
            Err(error) => Err(error),
        }
    }

    /// Start an external language server (from user's PATH, e.g., Dart, Rust Analyzer)
    pub fn start_external_server(
        &self,
        config: ExternalLspConfig,
    ) -> Result<LspServerInfo, LspError> {
        let _scope = DebugScope::new(
            "lsp",
            format!(
                "start_external server_id={} server_type={} command={}",
                config.server_id, config.server_type, config.command
            ),
        );
        let mut servers = self.servers.lock().map_err(|e| LspError::ProcessError {
            message: format!("Failed to acquire lock: {}", e),
        })?;

        // Check if server is already running
        if servers.contains_key(&config.server_id) {
            return Err(LspError::ServerAlreadyRunning {
                server_id: config.server_id.clone(),
            });
        }

        // Resolve command for Windows (.exe, .cmd, .bat)
        let cmd_name = if cfg!(windows) {
            match config.command.as_str() {
                "dart" => "dart.bat".to_string(),
                "flutter" => "flutter.bat".to_string(),
                "rust-analyzer" => "rust-analyzer.exe".to_string(),
                "gopls" => "gopls.exe".to_string(),
                other => other.to_string(),
            }
        } else {
            config.command.clone()
        };

        // Build the command
        let mut cmd = TokioCommand::new(&cmd_name);
        cmd.args(&config.args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        // Set working directory
        if let Some(ref cwd) = config.cwd {
            cmd.current_dir(cwd);
        }

        // Set environment variables
        if let Some(ref env) = config.env {
            for (key, value) in env {
                cmd.env(key, value);
            }
        }

        // Windows: hide console window
        #[cfg(windows)]
        {
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        // Spawn the process
        let mut child = cmd.spawn().map_err(|e| LspError::SpawnFailed {
            message: format!("Failed to spawn external server '{}': {}", cmd_name, e),
        })?;

        let pid = child.id().unwrap_or(0);
        let server_id = config.server_id.clone();
        let server_type = config.server_type.clone();
        let status = Arc::new(Mutex::new(LspServerStatus::Running));

        // Take stdin/stdout/stderr handles
        let stdin = child.stdin.take().ok_or_else(|| LspError::SpawnFailed {
            message: "Failed to get stdin handle".to_string(),
        })?;
        let stdout = child.stdout.take().ok_or_else(|| LspError::SpawnFailed {
            message: "Failed to get stdout handle".to_string(),
        })?;
        let stderr = child.stderr.take();

        // Create channel for sending messages to stdin
        let (stdin_tx, mut stdin_rx) = mpsc::channel::<String>(100);

        // Spawn stdin writer task
        tauri::async_runtime::spawn(async move {
            let mut stdin: ChildStdin = stdin;
            while let Some(msg) = stdin_rx.recv().await {
                // Write LSP message with Content-Length header
                let content_length = msg.len();
                let full_message = format!("Content-Length: {}\r\n\r\n{}", content_length, msg);
                if stdin.write_all(full_message.as_bytes()).await.is_err() {
                    break;
                }
                let _ = stdin.flush().await;
            }
        });

        // Spawn stdout reader task
        let app_handle = self.app_handle.clone();
        let server_id_clone = server_id.clone();
        let server_type_clone = server_type.clone();
        let status_clone = Arc::clone(&status);
        let servers_clone = Arc::clone(&self.servers);

        tauri::async_runtime::spawn(async move {
            Self::handle_external_stdout(
                stdout,
                app_handle.clone(),
                server_id_clone.clone(),
                server_type_clone,
                status_clone,
                servers_clone,
            )
            .await;
        });

        // Spawn stderr logger task
        if let Some(stderr) = stderr {
            let app_handle = self.app_handle.clone();
            let server_id_clone = server_id.clone();
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if !line.is_empty() {
                        let _ =
                            app_handle.emit(&format!("lsp://{}//stderr", server_id_clone), line);
                    }
                }
            });
        }

        // Store the running server
        servers.insert(
            server_id.clone(),
            RunningServer {
                server_type: config.server_type.clone(),
                child: Some(ServerChild::External {
                    stdin_tx,
                    _child: child,
                }),
                status,
                pid,
            },
        );

        if let Ok(mut saved_configs) = self.saved_configs.lock() {
            saved_configs.insert(
                server_id.clone(),
                SavedServerConfig::External(config.clone()),
            );
        }
        self.reset_recovery_state_internal(&server_id);
        self.reset_health_state_internal(&server_id);

        Ok(LspServerInfo {
            server_id,
            server_type,
            pid: Some(pid),
            status: LspServerStatus::Running,
        })
    }

    pub fn start_external_server_managed(
        &self,
        config: ExternalLspConfig,
    ) -> Result<LspServerInfo, LspError> {
        match self.start_external_server(config.clone()) {
            Ok(info) => Ok(info),
            Err(LspError::ServerAlreadyRunning { .. }) => {
                let _ = self.stop_server(&config.server_id, false);
                self.start_external_server(config)
            }
            Err(error) => Err(error),
        }
    }

    /// Handle stdout from external LSP server (parse LSP framing)
    fn mark_external_server_stopped(
        app_handle: &AppHandle<R>,
        server_id: &str,
        source: &str,
        status: &Arc<Mutex<LspServerStatus>>,
        servers: &Arc<Mutex<HashMap<String, RunningServer>>>,
        exit_code: i32,
        error: Option<String>,
    ) {
        if let Ok(mut s) = status.lock() {
            *s = LspServerStatus::Stopped;
        }
        if let Ok(mut servers_guard) = servers.lock() {
            servers_guard.remove(server_id);
        }
        Self::emit_diagnostics_source_state(app_handle, server_id, source, "stale");
        if let Some(err) = error {
            let _ = app_handle.emit(&format!("lsp://{}//error", server_id), err);
        }
        let _ = app_handle.emit(&format!("lsp://{}//exit", server_id), exit_code);
    }

    /// Handle stdout from external LSP server (parse LSP framing)
    async fn handle_external_stdout(
        stdout: tokio::process::ChildStdout,
        app_handle: AppHandle<R>,
        server_id: String,
        server_type: String,
        status: Arc<Mutex<LspServerStatus>>,
        servers: Arc<Mutex<HashMap<String, RunningServer>>>,
    ) {
        let mut reader = BufReader::new(stdout);
        let mut buffer = Vec::new();

        loop {
            // Read headers until we find Content-Length
            let mut headers = String::new();
            let mut content_length: Option<usize> = None;

            loop {
                let mut line = String::new();
                match reader.read_line(&mut line).await {
                    Ok(0) => {
                        // EOF - server exited
                        Self::mark_external_server_stopped(
                            &app_handle,
                            &server_id,
                            &server_type,
                            &status,
                            &servers,
                            0,
                            None,
                        );
                        return;
                    }
                    Ok(_) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            break; // End of headers
                        }
                        if let Some(len_str) = trimmed.strip_prefix("Content-Length:") {
                            content_length = len_str.trim().parse().ok();
                        }
                        headers.push_str(&line);
                    }
                    Err(err) => {
                        Self::mark_external_server_stopped(
                            &app_handle,
                            &server_id,
                            &server_type,
                            &status,
                            &servers,
                            -1,
                            Some(format!("Failed reading external LSP headers: {}", err)),
                        );
                        return;
                    }
                }
            }

            // Read the body
            if let Some(length) = content_length {
                buffer.resize(length, 0);
                match reader.read_exact(&mut buffer).await {
                    Ok(_) => {
                        if let Ok(json_str) = String::from_utf8(buffer.clone()) {
                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&json_str) {
                                let _ = app_handle
                                    .emit(&format!("lsp://{}//message", server_id), &json);
                                Self::maybe_emit_publish_diagnostics(
                                    &app_handle,
                                    &server_id,
                                    &server_type,
                                    &json,
                                );
                            }
                        }
                    }
                    Err(err) => {
                        Self::mark_external_server_stopped(
                            &app_handle,
                            &server_id,
                            &server_type,
                            &status,
                            &servers,
                            -1,
                            Some(format!("Failed reading external LSP body: {}", err)),
                        );
                        return;
                    }
                }
            }
        }
    }

    /// Handle events from the sidecar process (stdout, stderr, exit)
    async fn handle_sidecar_events(
        mut rx: Receiver<tauri_plugin_shell::process::CommandEvent>,
        app_handle: AppHandle<R>,
        server_id: String,
        server_type: String,
        status: Arc<Mutex<LspServerStatus>>,
        servers: Arc<Mutex<HashMap<String, RunningServer>>>,
    ) {
        use tauri_plugin_shell::process::CommandEvent;

        // Buffer for accumulating LSP message data
        let mut buffer = Vec::new();
        let mut expected_length: Option<usize> = None;
        let mut headers_complete = false;

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(data) => {
                    // Accumulate data in buffer
                    buffer.extend_from_slice(&data);

                    // Process complete LSP messages from buffer
                    loop {
                        if !headers_complete {
                            // Look for end of headers (\r\n\r\n)
                            if let Some(header_end) = find_header_end(&buffer) {
                                let headers = String::from_utf8_lossy(&buffer[..header_end]);

                                // Parse Content-Length
                                for line in headers.lines() {
                                    if let Some(len_str) = line.strip_prefix("Content-Length:") {
                                        expected_length = len_str.trim().parse().ok();
                                    }
                                }

                                // Remove headers from buffer
                                buffer = buffer[header_end + 4..].to_vec();
                                headers_complete = true;
                            } else {
                                break; // Need more data for headers
                            }
                        }

                        if headers_complete {
                            if let Some(length) = expected_length {
                                if buffer.len() >= length {
                                    // Extract the JSON body
                                    let body: Vec<u8> = buffer.drain(..length).collect();

                                    // Parse and emit the message
                                    if let Ok(json_str) = String::from_utf8(body) {
                                        if let Ok(json) =
                                            serde_json::from_str::<serde_json::Value>(&json_str)
                                        {
                                            let _ = app_handle.emit(
                                                &format!("lsp://{}//message", server_id),
                                                &json,
                                            );
                                            Self::maybe_emit_publish_diagnostics(
                                                &app_handle,
                                                &server_id,
                                                &server_type,
                                                &json,
                                            );
                                        }
                                    }

                                    // Reset for next message
                                    headers_complete = false;
                                    expected_length = None;
                                } else {
                                    break; // Need more data for body
                                }
                            } else {
                                headers_complete = false;
                                break;
                            }
                        }
                    }
                }
                CommandEvent::Stderr(data) => {
                    if let Ok(line) = String::from_utf8(data) {
                        let _ = app_handle.emit(&format!("lsp://{}//stderr", server_id), line);
                    }
                }
                CommandEvent::Error(error) => {
                    let _ =
                        app_handle.emit(&format!("lsp://{}//error", server_id), error.to_string());
                }
                CommandEvent::Terminated(payload) => {
                    // Update status
                    if let Ok(mut s) = status.lock() {
                        *s = LspServerStatus::Stopped;
                    }

                    // Remove from servers map
                    if let Ok(mut servers_guard) = servers.lock() {
                        servers_guard.remove(&server_id);
                    }

                    Self::emit_diagnostics_source_state(
                        &app_handle,
                        &server_id,
                        &server_type,
                        "stale",
                    );
                    // Emit exit event
                    let _ = app_handle.emit(&format!("lsp://{}//exit", server_id), payload.code);
                    break;
                }
                _ => {}
            }
        }
    }

    /// Send a JSON-RPC message to a running server
    pub fn send_message(&self, server_id: &str, message: &str) -> Result<(), LspError> {
        let mut servers = self.servers.lock().map_err(|e| LspError::ProcessError {
            message: format!("Failed to acquire lock: {}", e),
        })?;

        let server = servers
            .get_mut(server_id)
            .ok_or_else(|| LspError::ServerNotFound {
                server_id: server_id.to_string(),
            })?;

        // Check if server is still running
        {
            let status = server.status.lock().map_err(|e| LspError::ProcessError {
                message: format!("Failed to check status: {}", e),
            })?;
            if *status != LspServerStatus::Running {
                return Err(LspError::ProcessError {
                    message: "Server is not running".to_string(),
                });
            }
        }

        let mut emit_fresh_after_send = false;
        let mut replay_messages = Vec::new();
        let mut replay_workspace_configuration = None;
        let mut persist_initialize_message = None;
        let mut persist_initialized_message = None;
        let mut persist_workspace_configuration = None;

        if let Ok(json) = serde_json::from_str::<Value>(message) {
            if let Some(method) = json.get("method").and_then(Value::as_str) {
                match method {
                    "initialize" => {
                        persist_initialize_message = Some(message.to_string());
                    }
                    "initialized" => {
                        persist_initialized_message = Some(message.to_string());
                        emit_fresh_after_send = true;
                        replay_messages = self.collect_rehydrate_messages(server_id);
                        replay_workspace_configuration = self
                            .replay_messages
                            .lock()
                            .ok()
                            .and_then(|stored_messages| {
                                stored_messages
                                    .get(server_id)
                                    .and_then(|state| state.workspace_configuration.clone())
                            });
                    }
                    "workspace/didChangeConfiguration" => {
                        persist_workspace_configuration = Some(message.to_string());
                    }
                    "textDocument/didOpen" => {
                        if let Some(params) = json.get("params").cloned() {
                            if let Ok(params) =
                                serde_json::from_value::<DidOpenTextDocumentParams>(params)
                            {
                                self.upsert_tracked_document(
                                    server_id,
                                    TrackedDocumentState {
                                        uri: params.text_document.uri,
                                        language_id: params.text_document.language_id,
                                        version: params.text_document.version,
                                        text: params.text_document.text,
                                    },
                                );
                            }
                        }
                    }
                    "textDocument/didChange" => {
                        if let Some(params) = json.get("params").cloned() {
                            if let Ok(params) =
                                serde_json::from_value::<DidChangeTextDocumentParams>(params)
                            {
                                self.update_tracked_document(server_id, params);
                            }
                        }
                    }
                    "textDocument/didClose" => {
                        if let Some(params) = json.get("params").cloned() {
                            if let Ok(params) =
                                serde_json::from_value::<DidCloseTextDocumentParams>(params)
                            {
                                let uri = params.text_document.uri;
                                self.remove_tracked_document(server_id, &uri);
                                Self::emit_diagnostics_clear_file(
                                    &self.app_handle,
                                    server_id,
                                    &server.server_type,
                                    &uri,
                                );
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        if persist_initialize_message.is_some() || persist_initialized_message.is_some() {
            let mut stored_messages =
                self.replay_messages
                    .lock()
                    .map_err(|e| LspError::ProcessError {
                        message: format!("Failed to acquire replay message lock: {}", e),
                    })?;
            let state = stored_messages.entry(server_id.to_string()).or_default();
            if let Some(message) = persist_initialize_message {
                state.initialize = Some(message);
            }
            if let Some(message) = persist_initialized_message {
                state.initialized = Some(message);
            }
            if let Some(message) = persist_workspace_configuration {
                state.workspace_configuration = Some(message);
            }
        }

        // Get child handle and send message
        let child = server.child.as_mut().ok_or_else(|| LspError::SendFailed {
            message: "Server stdin not available".to_string(),
        })?;

        match child {
            ServerChild::Sidecar(sidecar) => {
                Self::write_sidecar_message(sidecar, message)?;
                if let Some(replay_workspace_configuration) = replay_workspace_configuration {
                    Self::write_sidecar_message(sidecar, &replay_workspace_configuration)?;
                }
                for replay_message in replay_messages {
                    Self::write_sidecar_message(sidecar, &replay_message)?;
                }
            }
            ServerChild::External { stdin_tx, .. } => {
                let stdin_tx = stdin_tx.clone();
                let server_type = server.server_type.clone();
                drop(servers);

                Self::send_external_message(&stdin_tx, message.to_string())?;
                if let Some(replay_workspace_configuration) = replay_workspace_configuration {
                    Self::send_external_message(&stdin_tx, replay_workspace_configuration)?;
                }
                for replay_message in replay_messages {
                    Self::send_external_message(&stdin_tx, replay_message)?;
                }

                if emit_fresh_after_send {
                    Self::emit_diagnostics_source_state(
                        &self.app_handle,
                        server_id,
                        &server_type,
                        "fresh",
                    );
                }
                return Ok(());
            }
        }

        if emit_fresh_after_send {
            Self::emit_diagnostics_source_state(
                &self.app_handle,
                server_id,
                &server.server_type,
                "fresh",
            );
        }

        Ok(())
    }

    pub fn sync_document(
        &self,
        server_id: &str,
        file_path: &str,
        language_id: &str,
        text: &str,
    ) -> Result<LspTrackedDocumentSyncResult, LspError> {
        if file_path.trim().is_empty() {
            return Err(LspError::InvalidConfig {
                message: "Document path cannot be empty".to_string(),
            });
        }

        if language_id.trim().is_empty() {
            return Err(LspError::InvalidConfig {
                message: "Document language_id cannot be empty".to_string(),
            });
        }

        let sync = self.sync_tracked_document(server_id, file_path, language_id, text)?;
        if sync.kind == "noop" {
            return Ok(sync);
        }

        let message = if sync.kind == "open" {
            serde_json::json!({
                "jsonrpc": "2.0",
                "method": "textDocument/didOpen",
                "params": {
                    "textDocument": {
                        "uri": sync.uri,
                        "languageId": language_id,
                        "version": sync.version,
                        "text": text,
                    }
                }
            })
        } else {
            serde_json::json!({
                "jsonrpc": "2.0",
                "method": "textDocument/didChange",
                "params": {
                    "textDocument": {
                        "uri": sync.uri,
                        "version": sync.version,
                    },
                    "contentChanges": [{ "text": text }],
                }
            })
        };

        let serialized = serde_json::to_string(&message).map_err(|e| LspError::SendFailed {
            message: format!("Failed to serialize document sync message: {}", e),
        })?;
        self.send_message(server_id, &serialized)?;
        Ok(sync)
    }

    pub fn close_document(&self, server_id: &str, file_path: &str) -> Result<bool, LspError> {
        if file_path.trim().is_empty() {
            return Err(LspError::InvalidConfig {
                message: "Document path cannot be empty".to_string(),
            });
        }

        let uri = Self::file_path_to_uri(file_path);
        let removed = {
            let mut tracked =
                self.tracked_documents
                    .lock()
                    .map_err(|e| LspError::ProcessError {
                        message: format!("Failed to acquire tracked document lock: {}", e),
                    })?;
            tracked
                .get_mut(server_id)
                .and_then(|server_docs| server_docs.remove(&uri))
                .is_some()
        };

        if !removed {
            return Ok(false);
        }

        let message = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didClose",
            "params": {
                "textDocument": {
                    "uri": uri,
                }
            }
        });
        let serialized = serde_json::to_string(&message).map_err(|e| LspError::SendFailed {
            message: format!("Failed to serialize document close message: {}", e),
        })?;
        self.send_message(server_id, &serialized)?;
        Ok(true)
    }

    /// Stop a running server
    pub fn stop_server(&self, server_id: &str, preserve_state: bool) -> Result<(), LspError> {
        let _scope = DebugScope::new(
            "lsp",
            format!("stop server_id={server_id} preserve_state={preserve_state}"),
        );
        let mut servers = self.servers.lock().map_err(|e| LspError::ProcessError {
            message: format!("Failed to acquire lock: {}", e),
        })?;

        let server = servers
            .remove(server_id)
            .ok_or_else(|| LspError::ServerNotFound {
                server_id: server_id.to_string(),
            })?;

        // Update status
        if let Ok(mut status) = server.status.lock() {
            *status = LspServerStatus::Stopping;
        }

        Self::emit_diagnostics_source_state(
            &self.app_handle,
            server_id,
            &server.server_type,
            "stale",
        );

        if !preserve_state {
            if let Ok(mut saved_configs) = self.saved_configs.lock() {
                saved_configs.remove(server_id);
            }
            self.reset_recovery_state_internal(server_id);
            self.reset_health_state_internal(server_id);
            self.clear_replay_messages(server_id);
            self.clear_tracked_documents(server_id);
        }

        // Kill the process based on type
        if let Some(child) = server.child {
            match child {
                ServerChild::Sidecar(sidecar) => {
                    let _ = sidecar.kill();
                }
                ServerChild::External { _child, .. } => {
                    // Child will be killed on drop due to kill_on_drop(true)
                    drop(_child);
                }
            }
        }

        // Emit stop event
        let _ = self
            .app_handle
            .emit(&format!("lsp://{}//stopped", server_id), ());

        Ok(())
    }

    pub fn restart_server(&self, server_id: &str) -> Result<LspServerInfo, LspError> {
        let saved_config = self
            .saved_configs
            .lock()
            .map_err(|e| LspError::ProcessError {
                message: format!("Failed to acquire saved config lock: {}", e),
            })?
            .get(server_id)
            .cloned()
            .ok_or_else(|| LspError::ServerNotFound {
                server_id: server_id.to_string(),
            })?;
        let replay_messages = self
            .replay_messages
            .lock()
            .map_err(|e| LspError::ProcessError {
                message: format!("Failed to acquire replay message lock: {}", e),
            })?
            .get(server_id)
            .cloned();

        if self.is_server_running(server_id) {
            let _ = self.stop_server(server_id, true);
        }

        let info = match saved_config {
            SavedServerConfig::Sidecar(config) => self.start_server(config)?,
            SavedServerConfig::External(config) => self.start_external_server(config)?,
        };

        if let Some(replay_messages) = replay_messages {
            if let Some(initialize) = replay_messages.initialize {
                self.send_message(server_id, &initialize)?;
            }
            if let Some(initialized) = replay_messages.initialized {
                self.send_message(server_id, &initialized)?;
            }
        }

        self.reset_recovery_state_internal(server_id);
        self.reset_health_state_internal(server_id);
        let _ = self
            .app_handle
            .emit(&format!("lsp://{}//restarted", server_id), info.clone());

        Ok(info)
    }

    /// Stop all running servers
    pub fn stop_all(&self) -> Result<(), LspError> {
        let _scope = DebugScope::new("lsp", "stop_all");
        let server_ids: Vec<String> = {
            let servers = self.servers.lock().map_err(|e| LspError::ProcessError {
                message: format!("Failed to acquire lock: {}", e),
            })?;
            servers.keys().cloned().collect()
        };
        debug_log("lsp", format!("stop_all count={}", server_ids.len()));

        for server_id in server_ids {
            let _ = self.stop_server(&server_id, false);
        }

        Ok(())
    }

    /// List all running servers
    pub fn list_servers(&self) -> Result<Vec<LspServerInfo>, LspError> {
        let servers = self.servers.lock().map_err(|e| LspError::ProcessError {
            message: format!("Failed to acquire lock: {}", e),
        })?;

        let infos: Vec<LspServerInfo> = servers
            .iter()
            .map(|(id, server)| {
                let status = server
                    .status
                    .lock()
                    .map(|s| s.clone())
                    .unwrap_or(LspServerStatus::Error);
                LspServerInfo {
                    server_id: id.clone(),
                    server_type: server.server_type.clone(),
                    pid: Some(server.pid),
                    status,
                }
            })
            .collect();

        Ok(infos)
    }

    /// Get info about a specific server
    pub fn get_server_info(&self, server_id: &str) -> Result<LspServerInfo, LspError> {
        let servers = self.servers.lock().map_err(|e| LspError::ProcessError {
            message: format!("Failed to acquire lock: {}", e),
        })?;

        let server = servers
            .get(server_id)
            .ok_or_else(|| LspError::ServerNotFound {
                server_id: server_id.to_string(),
            })?;

        let status = server
            .status
            .lock()
            .map(|s| s.clone())
            .unwrap_or(LspServerStatus::Error);

        Ok(LspServerInfo {
            server_id: server_id.to_string(),
            server_type: server.server_type.clone(),
            pid: Some(server.pid),
            status,
        })
    }

    /// Check if a server is running
    pub fn is_server_running(&self, server_id: &str) -> bool {
        if let Ok(servers) = self.servers.lock() {
            if let Some(server) = servers.get(server_id) {
                if let Ok(status) = server.status.lock() {
                    return *status == LspServerStatus::Running;
                }
            }
        }
        false
    }
}

impl<R: Runtime> Drop for LspManager<R> {
    fn drop(&mut self) {
        let _ = self.stop_all();
    }
}

/// Find the end of HTTP-style headers (\r\n\r\n)
fn find_header_end(buffer: &[u8]) -> Option<usize> {
    for i in 0..buffer.len().saturating_sub(3) {
        if buffer[i] == b'\r'
            && buffer[i + 1] == b'\n'
            && buffer[i + 2] == b'\r'
            && buffer[i + 3] == b'\n'
        {
            return Some(i);
        }
    }
    None
}

fn resolve_entrypoint_path<R: Runtime>(
    app_handle: &AppHandle<R>,
    entrypoint: &str,
) -> Result<PathBuf, LspError> {
    // 1) Production: bundled resource.
    if let Ok(resolved) = app_handle
        .path()
        .resolve(entrypoint, BaseDirectory::Resource)
    {
        if resolved.exists() {
            return Ok(resolved);
        }
    }

    // 2) Dev fallback: workspace node_modules (relative to src-tauri/Cargo.toml).
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(entrypoint);
    if dev_path.exists() {
        return Ok(dev_path);
    }

    Err(LspError::InvalidConfig {
        message: format!("LSP entrypoint not found: {entrypoint}"),
    })
}
