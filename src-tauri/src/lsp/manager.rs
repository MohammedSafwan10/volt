//! LSP Manager - Spawn and manage language server processes
//!
//! This module handles:
//! - Spawning language server processes using Tauri Shell plugin (sidecars)
//! - Spawning external language servers from PATH (e.g., Dart, Rust Analyzer)
//! - Managing server lifecycle (start, stop, restart)
//! - Routing JSON-RPC messages between frontend and servers
//! - Proper LSP message framing (Content-Length based)
//! - Clean shutdown on app/project close

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
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

/// LSP Manager - manages all language server processes (sidecars and external)
pub struct LspManager<R: Runtime> {
    servers: Arc<Mutex<HashMap<String, RunningServer>>>,
    app_handle: AppHandle<R>,
}

impl<R: Runtime> LspManager<R> {
    /// Create a new LSP manager
    pub fn new(app_handle: AppHandle<R>) -> Self {
        Self {
            servers: Arc::new(Mutex::new(HashMap::new())),
            app_handle,
        }
    }

    /// Start a language server sidecar with the given configuration
    pub fn start_server(&self, config: LspServerConfig) -> Result<LspServerInfo, LspError> {
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
        let status_clone = Arc::clone(&status);
        let servers_clone = Arc::clone(&self.servers);

        // Spawn a task to handle events from the sidecar
        tauri::async_runtime::spawn(async move {
            Self::handle_sidecar_events(
                rx,
                app_handle,
                server_id_clone,
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

        Ok(LspServerInfo {
            server_id,
            server_type,
            pid: Some(pid),
            status: LspServerStatus::Running,
        })
    }

    /// Start an external language server (from user's PATH, e.g., Dart, Rust Analyzer)
    pub fn start_external_server(
        &self,
        config: ExternalLspConfig,
    ) -> Result<LspServerInfo, LspError> {
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
        let status_clone = Arc::clone(&status);
        let servers_clone = Arc::clone(&self.servers);

        tauri::async_runtime::spawn(async move {
            Self::handle_external_stdout(
                stdout,
                app_handle.clone(),
                server_id_clone.clone(),
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

        Ok(LspServerInfo {
            server_id,
            server_type,
            pid: Some(pid),
            status: LspServerStatus::Running,
        })
    }

    /// Handle stdout from external LSP server (parse LSP framing)
    fn mark_external_server_stopped(
        app_handle: &AppHandle<R>,
        server_id: &str,
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
                                let _ =
                                    app_handle.emit(&format!("lsp://{}//message", server_id), json);
                            }
                        }
                    }
                    Err(err) => {
                        Self::mark_external_server_stopped(
                            &app_handle,
                            &server_id,
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
                                                json,
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

        // Get child handle and send message
        let child = server.child.as_mut().ok_or_else(|| LspError::SendFailed {
            message: "Server stdin not available".to_string(),
        })?;

        match child {
            ServerChild::Sidecar(sidecar) => {
                // Write LSP message with Content-Length header
                let content_length = message.len();
                let full_message = format!("Content-Length: {}\r\n\r\n{}", content_length, message);
                sidecar
                    .write(full_message.as_bytes())
                    .map_err(|e| LspError::SendFailed {
                        message: format!("Failed to write to stdin: {}", e),
                    })?;
            }
            ServerChild::External { stdin_tx, .. } => {
                let stdin_tx = stdin_tx.clone();
                drop(servers);

                // Send via channel (stdin writer task handles framing).
                // Fall back to blocking send when the channel is full, but do it
                // outside the manager lock to avoid stalling unrelated LSP ops.
                let msg = message.to_string();
                match stdin_tx.try_send(msg) {
                    Ok(()) => {}
                    Err(tokio::sync::mpsc::error::TrySendError::Full(msg)) => {
                        stdin_tx
                            .blocking_send(msg)
                            .map_err(|e| LspError::SendFailed {
                                message: format!("Failed to send to stdin channel: {}", e),
                            })?;
                    }
                    Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                        return Err(LspError::SendFailed {
                            message: "Failed to send to stdin channel: channel closed".to_string(),
                        });
                    }
                }

                return Ok(());
            }
        }

        Ok(())
    }

    /// Stop a running server
    pub fn stop_server(&self, server_id: &str) -> Result<(), LspError> {
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

    /// Stop all running servers
    pub fn stop_all(&self) -> Result<(), LspError> {
        let server_ids: Vec<String> = {
            let servers = self.servers.lock().map_err(|e| LspError::ProcessError {
                message: format!("Failed to acquire lock: {}", e),
            })?;
            servers.keys().cloned().collect()
        };

        for server_id in server_ids {
            let _ = self.stop_server(&server_id);
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
