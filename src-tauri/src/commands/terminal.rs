use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
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


/// Internal terminal session state
struct TerminalSession {
    info: TerminalInfo,
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    killed: bool,
}

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
fn detect_shell() -> (String, Vec<String>) {
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
                let shell_name = if path.contains("pwsh") { "pwsh" } else { "powershell" };
                return (shell_name.to_string(), vec!["-NoLogo".to_string()]);
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
) -> Result<TerminalInfo, TerminalError> {
    create_terminal_sync(app, cwd, cols, rows)
}

/// Synchronous terminal creation (runs in blocking thread)
fn create_terminal_sync(
    app: AppHandle,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<TerminalInfo, TerminalError> {
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
    let (shell, args) = detect_shell();
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

    // Get writer for sending input to the terminal
    let writer = pair.master.take_writer().map_err(|e| TerminalError::CreateFailed {
        message: e.to_string(),
    })?;

    // Get reader for receiving output from the terminal
    let mut reader = pair.master.try_clone_reader().map_err(|e| TerminalError::CreateFailed {
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
                killed: false,
            },
        );
    }

    // Spawn thread to read output and emit events
    let app_clone = app.clone();
    let terminal_id_clone = terminal_id.clone();
    let manager_clone = manager.clone();

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
        let exit_code = child
            .wait()
            .ok()
            .map(|status| status.exit_code() as i32);

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

    let kill_result = session.killer.kill();
    match kill_result {
        Ok(()) => {
            session.killed = true;
            close_terminal_input(session);
            Ok(())
        }
        Err(e) => {
            let message = e.to_string();

            #[cfg(windows)]
            {
                let message_lower = message.to_lowercase();
                if message.contains("os error 0") || message_lower.contains("operation completed successfully") {
                    session.killed = true;
                    close_terminal_input(session);
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
