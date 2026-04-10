use crate::observability::{debug_log, DebugScope};
use base64::Engine as _;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Typed error enum for terminal operations
#[derive(Debug, Serialize, thiserror::Error)]
#[serde(tag = "type")]
pub enum TerminalError {
    #[error("Terminal not found: {terminal_id}")]
    NotFound { terminal_id: String },

    #[error("Failed to create terminal: {message}")]
    CreateFailed { message: String },

    #[error("Failed to write to terminal: {message}")]
    WriteFailed { message: String },

    #[error("Failed to resize terminal: {message}")]
    ResizeFailed { message: String },

    #[error("Failed to kill terminal: {message}")]
    KillFailed { message: String },

    #[error("Terminal already killed: {terminal_id}")]
    AlreadyKilled { terminal_id: String },

    #[error("I/O error: {message}")]
    IoError { message: String },
}

/// Terminal session info returned to frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub terminal_id: String,
    pub shell: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshot {
    pub info: TerminalInfo,
    pub scrollback: String,
}

/// Event payload for terminal data
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalDataEvent {
    terminal_id: String,
    data: String,
}

/// Event payload for terminal exit
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExitEvent {
    terminal_id: String,
    code: Option<i32>,
}

/// Event payload for terminal readiness
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalReadyEvent {
    terminal_id: String,
    shell_integration_identity: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCommandCompletion {
    exit_code: i32,
    output: String,
    cwd: Option<String>,
    timed_out: bool,
}

/// Internal terminal session state
struct TerminalSession {
    info: TerminalInfo,
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: u32,
    killed: bool,
    output_history: String,
    active_interrupt_token: Option<u64>,
}

const MAX_SCROLLBACK_CHARS: usize = 1_000_000;
const DEFAULT_SCROLLBACK_QUERY_CHARS: usize = 250_000;
const AI_SHELL_INTEGRATION_MARKER: &str = "ShellIntegration=Volt/2";

fn close_terminal_input(session: &mut TerminalSession) {
    let _ = std::mem::replace(&mut session.writer, Box::new(std::io::sink()));
}

fn interrupt_terminal_session(session: &mut TerminalSession) -> Result<(), TerminalError> {
    session
        .writer
        .write_all(b"\x03")
        .map_err(|e| TerminalError::WriteFailed {
            message: e.to_string(),
        })?;
    session
        .writer
        .flush()
        .map_err(|e| TerminalError::WriteFailed {
            message: e.to_string(),
        })?;
    Ok(())
}

fn terminal_has_output_fragment(
    manager: &Arc<Mutex<TerminalManager>>,
    terminal_id: &str,
    fragment: &str,
) -> bool {
    manager
        .lock()
        .ok()
        .and_then(|mgr| {
            mgr.sessions
                .get(terminal_id)
                .map(|session| session.output_history.contains(fragment))
        })
        .unwrap_or(false)
}

fn terminal_shell_integration_identity(
    manager: &Arc<Mutex<TerminalManager>>,
    terminal_id: &str,
) -> Option<String> {
    let output = manager
        .lock()
        .ok()
        .and_then(|mgr| mgr.sessions.get(terminal_id).map(|session| session.output_history.clone()))?;

    let marker_index = output.find("ShellIntegration=")?;
    let marker = &output[marker_index + "ShellIntegration=".len()..];
    let identity = marker
        .split(['\u{7}', '\u{1b}', '\r', '\n'])
        .next()
        .unwrap_or_default()
        .trim();

    if identity.is_empty() {
        None
    } else {
        Some(identity.to_string())
    }
}

fn terminal_wait_for_shell_integration_identity(
    manager: &Arc<Mutex<TerminalManager>>,
    terminal_id: &str,
    timeout_ms: u64,
    poll_interval_ms: u64,
) -> Option<String> {
    let started_at = std::time::Instant::now();
    let timeout = Duration::from_millis(timeout_ms);
    let poll_interval = Duration::from_millis(poll_interval_ms.max(10));

    loop {
        if let Some(identity) = terminal_shell_integration_identity(manager, terminal_id) {
            return Some(identity);
        }

        let exists = manager
            .lock()
            .ok()
            .map(|mgr| mgr.sessions.contains_key(terminal_id))
            .unwrap_or(false);

        if !exists || started_at.elapsed() >= timeout {
            return None;
        }

        thread::sleep(poll_interval);
    }
}

fn get_terminal_output_since(
    manager: &Arc<Mutex<TerminalManager>>,
    terminal_id: &str,
    start_offset: usize,
) -> Option<String> {
    let output = manager
        .lock()
        .ok()
        .and_then(|mgr| mgr.sessions.get(terminal_id).map(|session| session.output_history.clone()))?;

    if output.len() <= start_offset {
        return Some(String::new());
    }

    let mut start = start_offset.min(output.len());
    while start > 0 && !output.is_char_boundary(start) {
        start -= 1;
    }

    Some(output[start..].to_string())
}

fn extract_terminal_cwd(output: &str) -> Option<String> {
    let marker_index = output.rfind("Cwd=")?;
    let marker = &output[marker_index + "Cwd=".len()..];
    let cwd = marker
        .split(['\u{7}', '\u{1b}', '\r', '\n'])
        .next()
        .unwrap_or_default()
        .trim();

    if cwd.is_empty() {
        None
    } else {
        Some(cwd.to_string())
    }
}

fn contains_powershell_parser_error(output: &str) -> bool {
    output.lines().any(|line| {
        let trimmed = line.trim();
        trimmed.contains("ParserError")
            || trimmed.contains("FullyQualifiedErrorId : Invalid")
            || (trimmed.contains("The token '")
                && trimmed.contains("is not a valid statement separator"))
    })
}

/// Global terminal manager state
pub struct TerminalManager {
    sessions: HashMap<String, TerminalSession>,
    next_id: u64,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            next_id: 1,
        }
    }

    fn generate_id(&mut self) -> String {
        let id = format!("terminal-{}", self.next_id);
        self.next_id += 1;
        id
    }
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Lazy-initialized global terminal manager
static TERMINAL_MANAGER: std::sync::OnceLock<Arc<Mutex<TerminalManager>>> =
    std::sync::OnceLock::new();

fn get_terminal_manager() -> Arc<Mutex<TerminalManager>> {
    TERMINAL_MANAGER
        .get_or_init(|| Arc::new(Mutex::new(TerminalManager::new())))
        .clone()
}

fn lock_manager(
    manager: &Arc<Mutex<TerminalManager>>,
) -> Result<std::sync::MutexGuard<'_, TerminalManager>, TerminalError> {
    manager.lock().map_err(|_| TerminalError::IoError {
        message: "Terminal manager lock poisoned".to_string(),
    })
}

/// Detect the best shell to use based on the platform
#[cfg(windows)]
fn build_ai_powershell_args() -> Vec<String> {
    let script = concat!(
        "function prompt { ",
        "try { ",
        "$e = [char]27; $a = [char]7; $c = (Get-Location).Path; ",
        "Write-Host -NoNewline \"$e]633;P;Cwd=$c$a\"; ",
        "Write-Host -NoNewline \"$e]633;A$a\"; ",
        "$p = \"PS $c> \"; ",
        "Write-Host -NoNewline \"$e]633;B$a\"; ",
        "$voltExit = if ($?) { if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 } } else { if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 1 } }; ",
        "Write-Host -NoNewline \"$e]633;D;$voltExit$a\"; ",
        "return $p; ",
        "} catch { return \"PS > \" } ",
        "}; ",
        "Write-Host -NoNewline \"$([char]27)]633;P;ShellIntegration=Volt/2$([char]7)\"; ",
        "Write-Host -NoNewline \"$([char]27)]633;P;Cwd=$((Get-Location).Path)$([char]7)\";"
    );

    let utf16_bytes: Vec<u8> = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16_bytes);

    vec![
        "-NoLogo".to_string(),
        "-NoProfile".to_string(),
        "-NoExit".to_string(),
        "-EncodedCommand".to_string(),
        encoded,
    ]
}

fn detect_shell(ai: bool) -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        // On Windows, just use PowerShell directly - it's always available
        // Check common locations first for speed
        let powershell_paths = [
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            r"C:\Program Files\PowerShell\7\pwsh.exe",
        ];

        for path in &powershell_paths {
            if std::path::Path::new(path).exists() {
                let shell_name = if path.contains("pwsh") {
                    "pwsh"
                } else {
                    "powershell"
                };
                let args = if ai {
                    build_ai_powershell_args()
                } else {
                    vec!["-NoLogo".to_string()]
                };
                return (shell_name.to_string(), args);
            }
        }

        // Fallback to cmd.exe which is always available
        ("cmd.exe".to_string(), vec![])
    }

    #[cfg(not(windows))]
    {
        // Use $SHELL or fallback to /bin/bash
        if let Ok(shell) = std::env::var("SHELL") {
            return (shell, vec![]);
        }
        ("/bin/bash".to_string(), vec![])
    }
}

/// Create a new terminal session
/// Note: This runs synchronously but the heavy work (shell process) runs in background threads
#[tauri::command]
pub fn terminal_create(
    app: AppHandle,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    ai: Option<bool>,
) -> Result<TerminalInfo, TerminalError> {
    create_terminal_sync(app, cwd, cols, rows, ai.unwrap_or(false))
}

/// Synchronous terminal creation (runs in blocking thread)
fn create_terminal_sync(
    app: AppHandle,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    ai: bool,
) -> Result<TerminalInfo, TerminalError> {
    let _scope = DebugScope::new(
        "terminal",
        format!(
            "create cwd={} ai={ai}",
            cwd.clone().unwrap_or_else(|| "<default>".to_string())
        ),
    );
    let pty_system = native_pty_system();

    let cols = cols.unwrap_or(80);
    let rows = rows.unwrap_or(24);

    // Open PTY with specified size
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| TerminalError::CreateFailed {
            message: e.to_string(),
        })?;

    // Detect shell and build command
    let (shell, args) = detect_shell(ai);
    let mut cmd = CommandBuilder::new(&shell);
    for arg in &args {
        cmd.arg(arg);
    }

    // Set working directory
    let working_dir = cwd.clone().unwrap_or_else(|| {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string())
    });
    cmd.cwd(&working_dir);

    // Spawn the shell process
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| TerminalError::CreateFailed {
            message: e.to_string(),
        })?;

    // Clone a killer handle so we can terminate the process from other commands
    let killer = child.clone_killer();
    let pid = child.process_id().unwrap_or(0);

    // Get writer for sending input to the terminal
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| TerminalError::CreateFailed {
            message: e.to_string(),
        })?;

    // Get reader for receiving output from the terminal
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| TerminalError::CreateFailed {
            message: e.to_string(),
        })?;

    // Generate terminal ID and create info
    let manager = get_terminal_manager();
    let terminal_id = { lock_manager(&manager)?.generate_id() };

    let info = TerminalInfo {
        terminal_id: terminal_id.clone(),
        shell: shell.clone(),
        cwd: working_dir,
        cols,
        rows,
    };

    // Store session
    {
        let mut mgr = lock_manager(&manager)?;
        mgr.sessions.insert(
            terminal_id.clone(),
            TerminalSession {
                info: info.clone(),
                writer,
                master: pair.master,
                killer,
                pid,
                killed: false,
                output_history: String::new(),
                active_interrupt_token: None,
            },
        );
    }

    // Spawn thread to read output and emit events
    let app_clone = app.clone();
    let terminal_id_clone = terminal_id.clone();
    let manager_clone = manager.clone();

    // Emit a "ready" event and trigger initial resize to show prompt.
    // ConPTY on Windows often needs a resize event to trigger the shell prompt.
    // We delay to let the shell initialize first.
    {
        let app_ready = app.clone();
        let terminal_id_ready = terminal_id.clone();
        let manager_ready = manager.clone();
        let initial_cols = cols;
        let initial_rows = rows;
        let ai_ready = ai;

        thread::spawn(move || {
            // ConPTY Quirk Workaround:
            // Windows ConPTY sometimes doesn't display the initial shell prompt until
            // a resize event occurs. This is a known issue where the PTY buffers the
            // initial output. We work around this by:
            // 1. Waiting for the shell to initialize (polling with short intervals)
            // 2. Triggering a resize cycle (expand by 2 cols, then restore) to flush the buffer

            // Initial delay to let the shell process start (especially slow on Windows)
            thread::sleep(Duration::from_millis(250));

            // Poll for shell readiness - wait for it to be inserted into manager
            for _ in 0..10 {
                let exists = if let Ok(mgr) = manager_ready.lock() {
                    mgr.sessions.contains_key(&terminal_id_ready)
                } else {
                    false
                };

                if exists {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }

            // Trigger resize cycle to force prompt display
            // This exploits a ConPTY behavior where resize events flush buffered output
            if let Ok(mut mgr) = manager_ready.lock() {
                if let Some(session) = mgr.sessions.get_mut(&terminal_id_ready) {
                    // Step 1: Resize to slightly larger size (+2 for clearer change)
                    let _ = session.master.resize(PtySize {
                        rows: initial_rows,
                        cols: initial_cols + 2,
                        pixel_width: 0,
                        pixel_height: 0,
                    });

                    thread::sleep(Duration::from_millis(100));

                    // Step 2: Resize back to original dimensions
                    let _ = session.master.resize(PtySize {
                        rows: initial_rows,
                        cols: initial_cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    });

                    // Optional: nudge with a small write if it's still quiet
                    // But usually resize is enough and safer than writing characters
                }
            }

            if ai_ready {
                // AI terminals start with native shell integration bootstrap. Wait
                // briefly for that marker so the frontend can trust ready-state
                // without layering extra sleep loops on top.
                for _ in 0..15 {
                    if terminal_has_output_fragment(
                        &manager_ready,
                        &terminal_id_ready,
                        AI_SHELL_INTEGRATION_MARKER,
                    ) {
                        break;
                    }
                    thread::sleep(Duration::from_millis(100));
                }
            }

            // Emit ready event after resize trick completes
            let shell_integration_identity = if ai_ready {
                terminal_shell_integration_identity(&manager_ready, &terminal_id_ready)
            } else {
                None
            };

            let _ = app_ready.emit(
                "terminal://ready",
                TerminalReadyEvent {
                    terminal_id: terminal_id_ready,
                    shell_integration_identity,
                },
            );
        });
    }

    thread::spawn(move || {
        let mut buffer = [0u8; 4096];

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    // EOF - terminal closed
                    break;
                }
                Ok(n) => {
                    // Convert to string (lossy for non-UTF8 terminal output)
                    let data = String::from_utf8_lossy(&buffer[..n]).to_string();

                    // Persist scrollback so frontend can rehydrate after reload/HMR.
                    if let Ok(mut mgr) = manager_clone.lock() {
                        if let Some(session) = mgr.sessions.get_mut(&terminal_id_clone) {
                            session.output_history.push_str(&data);
                            if session.output_history.len() > MAX_SCROLLBACK_CHARS {
                                let overflow = session.output_history.len() - MAX_SCROLLBACK_CHARS;
                                session.output_history.drain(..overflow);
                            }
                        }
                    }

                    // Emit data event
                    let _ = app_clone.emit(
                        "terminal://data",
                        TerminalDataEvent {
                            terminal_id: terminal_id_clone.clone(),
                            data,
                        },
                    );
                }
                Err(e) => {
                    // Check if terminal was killed
                    let killed = {
                        let mgr = match manager_clone.lock() {
                            Ok(g) => g,
                            Err(_) => break,
                        };
                        mgr.sessions
                            .get(&terminal_id_clone)
                            .map(|s| s.killed)
                            .unwrap_or(true)
                    };

                    if !killed {
                        eprintln!("Terminal read error: {}", e);
                    }
                    break;
                }
            }
        }

        // Wait for child process to exit and get exit code
        let exit_code = child.wait().ok().map(|status| status.exit_code() as i32);

        // Emit exit event
        let _ = app_clone.emit(
            "terminal://exit",
            TerminalExitEvent {
                terminal_id: terminal_id_clone.clone(),
                code: exit_code,
            },
        );

        // Clean up session
        if let Ok(mut mgr) = manager_clone.lock() {
            mgr.sessions.remove(&terminal_id_clone);
        }
    });

    Ok(info)
}

/// Write data to a terminal
#[tauri::command]
pub fn terminal_write(terminal_id: String, data: String) -> Result<(), TerminalError> {
    let manager = get_terminal_manager();
    let mut mgr = lock_manager(&manager)?;

    let session = mgr
        .sessions
        .get_mut(&terminal_id)
        .ok_or_else(|| TerminalError::NotFound {
            terminal_id: terminal_id.clone(),
        })?;

    if session.killed {
        return Err(TerminalError::AlreadyKilled { terminal_id });
    }

    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| TerminalError::WriteFailed {
            message: e.to_string(),
        })?;

    session
        .writer
        .flush()
        .map_err(|e| TerminalError::WriteFailed {
            message: e.to_string(),
        })?;

    Ok(())
}

#[tauri::command]
pub fn terminal_interrupt(terminal_id: String) -> Result<(), TerminalError> {
    let manager = get_terminal_manager();
    let mut mgr = lock_manager(&manager)?;

    let session = mgr
        .sessions
        .get_mut(&terminal_id)
        .ok_or_else(|| TerminalError::NotFound {
            terminal_id: terminal_id.clone(),
        })?;

    if session.killed {
        return Err(TerminalError::AlreadyKilled { terminal_id });
    }

    session.active_interrupt_token = None;
    interrupt_terminal_session(session)
}

/// Resize a terminal
#[tauri::command]
pub fn terminal_resize(terminal_id: String, cols: u16, rows: u16) -> Result<(), TerminalError> {
    let manager = get_terminal_manager();
    let mut mgr = lock_manager(&manager)?;

    let session = mgr
        .sessions
        .get_mut(&terminal_id)
        .ok_or_else(|| TerminalError::NotFound {
            terminal_id: terminal_id.clone(),
        })?;

    if session.killed {
        return Err(TerminalError::AlreadyKilled { terminal_id });
    }

    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| TerminalError::ResizeFailed {
            message: e.to_string(),
        })?;

    // Update stored info
    session.info.cols = cols;
    session.info.rows = rows;

    Ok(())
}

/// Kill a terminal
#[tauri::command]
pub fn terminal_kill(terminal_id: String) -> Result<(), TerminalError> {
    let manager = get_terminal_manager();
    let mut mgr = lock_manager(&manager)?;

    let session = mgr
        .sessions
        .get_mut(&terminal_id)
        .ok_or_else(|| TerminalError::NotFound {
            terminal_id: terminal_id.clone(),
        })?;

    if session.killed {
        return Err(TerminalError::AlreadyKilled { terminal_id });
    }

    let pid = session.pid;
    let kill_result = session.killer.kill();

    match kill_result {
        Ok(()) => {
            session.killed = true;
            close_terminal_input(session);

            #[cfg(windows)]
            if pid > 0 {
                // On Windows, TerminateProcess only kills the shell.
                // We use taskkill to kill the whole process tree (e.g. build tools, dev servers).
                let _ = std::process::Command::new("taskkill")
                    .arg("/F")
                    .arg("/T")
                    .arg("/PID")
                    .arg(pid.to_string())
                    .output();
            }

            Ok(())
        }
        Err(e) => {
            let message = e.to_string();

            #[cfg(windows)]
            {
                let message_lower = message.to_lowercase();
                if message.contains("os error 0")
                    || message_lower.contains("operation completed successfully")
                {
                    session.killed = true;
                    close_terminal_input(session);

                    if pid > 0 {
                        let _ = std::process::Command::new("taskkill")
                            .arg("/F")
                            .arg("/T")
                            .arg("/PID")
                            .arg(pid.to_string())
                            .output();
                    }

                    return Ok(());
                }
            }

            Err(TerminalError::KillFailed { message })
        }
    }
}

/// List all active terminals
#[tauri::command]
pub fn terminal_list() -> Result<Vec<TerminalInfo>, TerminalError> {
    let manager = get_terminal_manager();
    let mgr = lock_manager(&manager)?;

    let terminals: Vec<TerminalInfo> = mgr
        .sessions
        .values()
        .filter(|s| !s.killed)
        .map(|s| s.info.clone())
        .collect();

    Ok(terminals)
}

#[tauri::command]
pub fn terminal_list_snapshots(
    max_chars: Option<usize>,
) -> Result<Vec<TerminalSnapshot>, TerminalError> {
    let manager = get_terminal_manager();
    let mgr = lock_manager(&manager)?;
    let limit = max_chars
        .unwrap_or(DEFAULT_SCROLLBACK_QUERY_CHARS)
        .min(MAX_SCROLLBACK_CHARS);

    let snapshots = mgr
        .sessions
        .values()
        .filter(|s| !s.killed)
        .map(|session| {
            let full = &session.output_history;
            let scrollback = if full.len() <= limit {
                full.clone()
            } else {
                let mut start = full.len() - limit;
                while start > 0 && !full.is_char_boundary(start) {
                    start -= 1;
                }
                full[start..].to_string()
            };

            TerminalSnapshot {
                info: session.info.clone(),
                scrollback,
            }
        })
        .collect();

    Ok(snapshots)
}

/// Fetch terminal scrollback for frontend rehydration after reload/HMR.
#[tauri::command]
pub fn terminal_get_scrollback(
    terminal_id: String,
    max_chars: Option<usize>,
) -> Result<String, TerminalError> {
    let manager = get_terminal_manager();
    let mgr = lock_manager(&manager)?;

    let session = mgr
        .sessions
        .get(&terminal_id)
        .ok_or_else(|| TerminalError::NotFound {
            terminal_id: terminal_id.clone(),
        })?;

    let limit = max_chars
        .unwrap_or(DEFAULT_SCROLLBACK_QUERY_CHARS)
        .min(MAX_SCROLLBACK_CHARS);

    let full = &session.output_history;
    if full.len() <= limit {
        return Ok(full.clone());
    }

    // Find a UTF-8 safe byte offset (floor_char_boundary equivalent for stable Rust)
    // Walking backwards from the target offset to find the nearest char boundary
    let mut start = full.len() - limit;
    while start > 0 && !full.is_char_boundary(start) {
        start -= 1;
    }
    Ok(full[start..].to_string())
}

#[tauri::command]
pub async fn terminal_wait_for_shell_integration(
    terminal_id: String,
    timeout_ms: Option<u64>,
) -> Result<Option<String>, TerminalError> {
    let manager = get_terminal_manager();
    Ok(terminal_wait_for_shell_integration_identity(
        &manager,
        &terminal_id,
        timeout_ms.unwrap_or(3_000),
        100,
    ))
}

#[tauri::command]
pub async fn terminal_execute_command_fallback(
    terminal_id: String,
    command: String,
    timeout_ms: Option<u64>,
) -> Result<TerminalCommandCompletion, TerminalError> {
    let manager = get_terminal_manager();
    let timeout = timeout_ms.unwrap_or(300_000);
    let sentinel = format!(
        "{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    );
    let capture = "$voltExit = if ($?) { if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 } } else { if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 1 } }";

    let start_offset = {
        let mut mgr = lock_manager(&manager)?;
        let session = mgr
            .sessions
            .get_mut(&terminal_id)
            .ok_or_else(|| TerminalError::NotFound {
                terminal_id: terminal_id.clone(),
            })?;

        if session.killed {
            return Err(TerminalError::AlreadyKilled { terminal_id });
        }

        let start_offset = session.output_history.len();
        let script = format!(
            "{command}; {capture}; echo \"__VOLT_EXIT_CODE_$voltExit__\"; echo \"__VOLT_DONE_{sentinel}__\"\r"
        );
        session
            .writer
            .write_all(script.as_bytes())
            .map_err(|e| TerminalError::WriteFailed {
                message: e.to_string(),
            })?;
        session
            .writer
            .flush()
            .map_err(|e| TerminalError::WriteFailed {
                message: e.to_string(),
            })?;

        start_offset
    };

    let started_at = std::time::Instant::now();
    let timeout_duration = Duration::from_millis(timeout);

    loop {
        let Some(raw_output) = get_terminal_output_since(&manager, &terminal_id, start_offset) else {
            return Ok(TerminalCommandCompletion {
                exit_code: 1,
                output: String::new(),
                cwd: None,
                timed_out: false,
            });
        };

        if raw_output.contains(&format!("__VOLT_DONE_{sentinel}__")) {
            let exit_code = raw_output
                .split("__VOLT_EXIT_CODE_")
                .nth(1)
                .and_then(|value| {
                    value.chars()
                        .take_while(|char| char.is_ascii_digit())
                        .collect::<String>()
                        .parse::<i32>()
                        .ok()
                })
                .unwrap_or(0);
            let cwd = extract_terminal_cwd(&raw_output);

            return Ok(TerminalCommandCompletion {
                exit_code,
                output: raw_output,
                cwd,
                timed_out: false,
            });
        }

        if contains_powershell_parser_error(&raw_output) {
            let cwd = extract_terminal_cwd(&raw_output);
            return Ok(TerminalCommandCompletion {
                exit_code: 1,
                output: raw_output,
                cwd,
                timed_out: false,
            });
        }

        if started_at.elapsed() >= timeout_duration {
            let mut mgr = lock_manager(&manager)?;
            if let Some(session) = mgr.sessions.get_mut(&terminal_id) {
                let _ = interrupt_terminal_session(session);
            }

            return Ok(TerminalCommandCompletion {
                exit_code: -1,
                output: get_terminal_output_since(&manager, &terminal_id, start_offset)
                    .unwrap_or_default(),
                cwd: None,
                timed_out: true,
            });
        }

        thread::sleep(Duration::from_millis(100));
    }
}

#[tauri::command]
pub async fn terminal_schedule_interrupt(
    terminal_id: String,
    delay_ms: u64,
    token: u64,
) -> Result<bool, TerminalError> {
    let manager = get_terminal_manager();
    {
        let mut mgr = lock_manager(&manager)?;
        let session = mgr
            .sessions
            .get_mut(&terminal_id)
            .ok_or_else(|| TerminalError::NotFound {
                terminal_id: terminal_id.clone(),
            })?;

        if session.killed {
            return Err(TerminalError::AlreadyKilled { terminal_id });
        }

        session.active_interrupt_token = Some(token);
    }

    tokio::time::sleep(Duration::from_millis(delay_ms)).await;

    let mut mgr = lock_manager(&manager)?;
    let session = match mgr.sessions.get_mut(&terminal_id) {
        Some(session) => session,
        None => return Ok(false),
    };

    if session.killed || session.active_interrupt_token != Some(token) {
        return Ok(false);
    }

    session.active_interrupt_token = None;
    interrupt_terminal_session(session)?;

    Ok(true)
}

#[tauri::command]
pub fn terminal_cancel_scheduled_interrupt(
    terminal_id: String,
    token: u64,
) -> Result<bool, TerminalError> {
    let manager = get_terminal_manager();
    let mut mgr = lock_manager(&manager)?;
    let session = match mgr.sessions.get_mut(&terminal_id) {
        Some(session) => session,
        None => return Ok(false),
    };

    if session.active_interrupt_token == Some(token) {
        session.active_interrupt_token = None;
        return Ok(true);
    }

    Ok(false)
}

#[tauri::command]
pub async fn terminal_wait_for_output(
    terminal_id: String,
    start_offset: usize,
    timeout_ms: Option<u64>,
) -> Result<Option<String>, TerminalError> {
    let manager = get_terminal_manager();
    let started_at = std::time::Instant::now();
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(10_000));

    loop {
        match get_terminal_output_since(&manager, &terminal_id, start_offset) {
            Some(output) if !output.is_empty() => return Ok(Some(output)),
            Some(_) => {}
            None => return Ok(None),
        }

        if started_at.elapsed() >= timeout {
            return Ok(None);
        }

        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Kill all active terminals
#[tauri::command]
pub fn terminal_kill_all() -> Result<(), TerminalError> {
    let _scope = DebugScope::new("terminal", "kill_all");
    let manager = get_terminal_manager();
    let mut mgr = lock_manager(&manager)?;
    debug_log("terminal", format!("kill_all count={}", mgr.sessions.len()));

    let terminal_ids: Vec<String> = mgr.sessions.keys().cloned().collect();

    for id in terminal_ids {
        if let Some(session) = mgr.sessions.get_mut(&id) {
            if !session.killed {
                let pid = session.pid;
                let _ = session.killer.kill();
                session.killed = true;
                close_terminal_input(session);

                #[cfg(windows)]
                if pid > 0 {
                    let _ = std::process::Command::new("taskkill")
                        .arg("/F")
                        .arg("/T")
                        .arg("/PID")
                        .arg(pid.to_string())
                        .output();
                }
            }
        }
    }

    mgr.sessions.clear();

    Ok(())
}
