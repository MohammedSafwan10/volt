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
}

const MAX_SCROLLBACK_CHARS: usize = 1_000_000;
const DEFAULT_SCROLLBACK_QUERY_CHARS: usize = 250_000;

fn close_terminal_input(session: &mut TerminalSession) {
    let _ = std::mem::replace(&mut session.writer, Box::new(std::io::sink()));
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
        "if ($null -ne $LASTEXITCODE) { Write-Host -NoNewline \"$e]633;D;$LASTEXITCODE$a\" }; ",
        "return $p; ",
        "} catch { return \"PS > \" } ",
        "}; ",
        "Write-Host -NoNewline \"$([char]27)]633;P;ShellIntegration=Volt$([char]7)\"; ",
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

            // Emit ready event after resize trick completes
            let _ = app_ready.emit(
                "terminal://ready",
                TerminalReadyEvent {
                    terminal_id: terminal_id_ready,
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
