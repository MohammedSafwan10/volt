use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use sysinfo::System;
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;

use crate::observability::{debug_log, DebugScope};

// Track running watch processes
static WATCH_PROCESSES: Lazy<Mutex<HashMap<String, std::process::Child>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn is_allowed_env_var(name: &str) -> bool {
    matches!(name, "JAVA_HOME" | "FLUTTER_ROOT" | "DART_SDK")
}

fn normalize_executable_name(command: &str) -> String {
    let trimmed = command.trim().trim_matches('"').trim_matches('\'');
    Path::new(trimmed)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(trimmed)
        .to_ascii_lowercase()
}

fn is_allowed_executable(command: &str) -> bool {
    let name = normalize_executable_name(command);
    matches!(
        name.as_str(),
        "npx"
            | "npx.cmd"
            | "where"
            | "which"
            | "java"
            | "java.exe"
            | "dart"
            | "dart.exe"
            | "flutter"
            | "flutter.exe"
            | "flutter.bat"
            | "yaml-language-server"
            | "yaml-language-server.cmd"
            | "yaml-language-server.exe"
            | "lemminx"
            | "lemminx.exe"
            | "prettier"
            | "prettier.cmd"
            | "prettier.exe"
    )
}

fn validate_command_invocation(command: &str, cwd: &Option<String>) -> Result<(), String> {
    if command.trim().is_empty() {
        return Err("Command cannot be empty".to_string());
    }

    if !is_allowed_executable(command) {
        return Err(format!(
            "Command '{}' is not allowed by secure allow-list",
            command
        ));
    }

    if let Some(path) = cwd {
        let cwd_path = Path::new(path);
        if !cwd_path.exists() {
            return Err(format!("Working directory does not exist: {}", path));
        }
        if !cwd_path.is_dir() {
            return Err(format!("Working directory is not a directory: {}", path));
        }
    }

    Ok(())
}

fn resolve_to_absolute(path: &str, base_dir: &Option<String>) -> Result<PathBuf, String> {
    let raw = PathBuf::from(path);
    if raw.is_absolute() {
        return Ok(raw);
    }

    if let Some(base) = base_dir {
        return Ok(Path::new(base).join(raw));
    }

    std::env::current_dir()
        .map(|cwd| cwd.join(raw))
        .map_err(|e| format!("Failed to resolve current directory: {}", e))
}

fn kill_watch_process(watch_id: &str) {
    if let Ok(mut processes) = WATCH_PROCESSES.lock() {
        if let Some(mut child) = processes.remove(watch_id) {
            let _ = child.kill();
        }
    }
}

/// System information returned to the frontend
#[derive(Debug, Serialize)]
pub struct SystemInfo {
    /// Operating system name (e.g., "Windows", "macOS", "Linux")
    pub os_name: Option<String>,
    /// OS version (e.g., "10.0.22631")
    pub os_version: Option<String>,
    /// Kernel version
    pub kernel_version: Option<String>,
    /// Host name
    pub host_name: Option<String>,
    /// Total RAM in bytes
    pub total_memory: u64,
    /// Number of CPU cores
    pub cpu_count: usize,
    /// CPU brand/model name
    pub cpu_brand: Option<String>,
}

/// Get system information for the About dialog and debugging
#[tauri::command]
pub fn get_system_info() -> SystemInfo {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_cpu_all();

    // Get CPU brand from first CPU if available
    let cpu_brand = sys.cpus().first().map(|cpu| cpu.brand().to_string());

    SystemInfo {
        os_name: System::name(),
        os_version: System::os_version(),
        kernel_version: System::kernel_version(),
        host_name: System::host_name(),
        // sysinfo returns memory in bytes
        total_memory: sys.total_memory(),
        cpu_count: sys.cpus().len(),
        cpu_brand,
    }
}

/// Result of running a command
#[derive(Debug, Serialize)]
pub struct CommandResult {
    /// Exit code of the command
    pub exit_code: i32,
    /// Standard output
    pub stdout: String,
    /// Standard error
    pub stderr: String,
}

/// Run a command and capture its output
#[tauri::command]
pub async fn run_command(
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<CommandResult, String> {
    validate_command_invocation(&command, &cwd)?;

    tokio::task::spawn_blocking(move || {
        use std::process::Command;

        // On Windows, hide the console window
        let mut cmd = if cfg!(windows) {
            use std::os::windows::process::CommandExt;
            let mut c = Command::new(&command);
            c.creation_flags(0x08000000); // CREATE_NO_WINDOW
            c
        } else {
            Command::new(&command)
        };

        if let Some(path) = cwd {
            cmd.current_dir(path);
        }

        let output = cmd
            .args(args)
            .output()
            .map_err(|e| format!("Failed to execute command: {}", e))?;

        Ok(CommandResult {
            exit_code: output.status.code().unwrap_or(0),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        })
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Get an environment variable
#[tauri::command]
pub fn get_env_var(name: String) -> Option<String> {
    if !is_allowed_env_var(name.trim()) {
        return None;
    }
    std::env::var(name).ok()
}

/// Open a file/folder externally, constrained to a trusted base directory.
/// This avoids broad opener permissions in capabilities while keeping UX working.
#[tauri::command]
pub fn open_path_scoped(
    app: AppHandle,
    path: String,
    base_dir: Option<String>,
) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("Path cannot be empty".to_string());
    }

    if path.contains("://") {
        return Err("URLs are not allowed in open_path_scoped".to_string());
    }

    let absolute_target = resolve_to_absolute(&path, &base_dir)?;
    let canonical_target = absolute_target
        .canonicalize()
        .map_err(|e| format!("Failed to resolve target path: {}", e))?;

    if !canonical_target.exists() {
        return Err(format!(
            "Path does not exist: {}",
            canonical_target.to_string_lossy()
        ));
    }

    if let Some(base) = base_dir {
        let canonical_base = Path::new(&base)
            .canonicalize()
            .map_err(|e| format!("Failed to resolve base directory: {}", e))?;
        if !canonical_target.starts_with(&canonical_base) {
            return Err("Path is outside the allowed project directory".to_string());
        }
    } else {
        // Without a base_dir, restrict to user's home directory for safety
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .map_err(|_| "Cannot determine home directory for path validation".to_string())?;
        let canonical_home = Path::new(&home)
            .canonicalize()
            .map_err(|e| format!("Cannot resolve home directory: {}", e))?;
        if !canonical_target.starts_with(&canonical_home) {
            return Err(
                "Without a project context, paths must be within your home directory".to_string(),
            );
        }
    }

    app.opener()
        .open_path(canonical_target.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("Failed to open path: {}", e))
}

/// Start a watch command that streams output via events
/// Used for `tsc --watch` and similar long-running processes
#[tauri::command]
pub async fn start_watch_command(
    app: AppHandle,
    watch_id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    let _scope = DebugScope::new(
        "watch-command",
        format!(
            "start watch_id={} command={} args={} cwd={}",
            watch_id,
            command,
            args.len(),
            cwd.as_deref().unwrap_or("<none>")
        ),
    );
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};
    use std::thread;

    validate_command_invocation(&command, &cwd)?;

    // Stop any existing watch with this ID
    {
        let mut processes = WATCH_PROCESSES.lock().map_err(|e| e.to_string())?;
        if let Some(mut child) = processes.remove(&watch_id) {
            let _ = child.kill();
        }
    }

    // Build command
    let mut cmd = if cfg!(windows) {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new(&command);
        c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        c
    } else {
        Command::new(&command)
    };

    if let Some(path) = cwd {
        cmd.current_dir(path);
    }

    cmd.args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn watch command: {}", e))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    // Store child process
    {
        let mut processes = WATCH_PROCESSES.lock().map_err(|e| e.to_string())?;
        processes.insert(watch_id.clone(), child);
    }

    let watch_id_clone = watch_id.clone();
    let app_clone = app.clone();

    // Stream stdout
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            if let Ok(line) = line {
                if app_clone
                    .emit(&format!("watch://{}//stdout", watch_id_clone), line)
                    .is_err()
                {
                    kill_watch_process(&watch_id_clone);
                    return;
                }
            }
        }
    });

    let watch_id_clone2 = watch_id.clone();
    let app_clone2 = app.clone();

    // Stream stderr
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(line) = line {
                if app_clone2
                    .emit(&format!("watch://{}//stderr", watch_id_clone2), line)
                    .is_err()
                {
                    kill_watch_process(&watch_id_clone2);
                    return;
                }
            }
        }
    });

    // Monitor for process exit
    let watch_id_exit = watch_id.clone();
    thread::spawn(move || {
        loop {
            thread::sleep(std::time::Duration::from_millis(500));
            // Minimize lock duration: only hold while calling try_wait
            let wait_result = {
                let mut processes = match WATCH_PROCESSES.lock() {
                    Ok(p) => p,
                    Err(_) => return,
                };
                match processes.get_mut(&watch_id_exit) {
                    Some(child) => Some(child.try_wait()),
                    None => None,
                }
            }; // Lock released here

            match wait_result {
                Some(Ok(Some(status))) => {
                    let _ = app.emit(
                        &format!("watch://{}//exit", watch_id_exit),
                        status.code().unwrap_or(-1),
                    );
                    if let Ok(mut p) = WATCH_PROCESSES.lock() {
                        p.remove(&watch_id_exit);
                    }
                    return;
                }
                Some(Ok(None)) => {} // Still running
                Some(Err(_)) => {
                    if let Ok(mut p) = WATCH_PROCESSES.lock() {
                        p.remove(&watch_id_exit);
                    }
                    return;
                }
                None => return, // Process removed externally
            }
        }
    });

    Ok(())
}

/// Stop a running watch command
#[tauri::command]
pub fn stop_watch_command(watch_id: String) -> Result<(), String> {
    debug_log("watch-command", format!("stop watch_id={watch_id}"));
    let mut processes = WATCH_PROCESSES.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = processes.remove(&watch_id) {
        let _ = child.kill();
        Ok(())
    } else {
        Err(format!("Watch '{}' not found", watch_id))
    }
}

/// Stop all running watch commands
#[tauri::command]
pub fn stop_all_watch_commands() -> Result<(), String> {
    let mut processes = WATCH_PROCESSES.lock().map_err(|e| e.to_string())?;
    debug_log(
        "watch-command",
        format!("stop_all count={}", processes.len()),
    );
    for (_, mut child) in processes.drain() {
        let _ = child.kill();
    }
    Ok(())
}

/// List active watch commands
#[tauri::command]
pub fn list_watch_commands() -> Vec<String> {
    WATCH_PROCESSES
        .lock()
        .map(|p| p.keys().cloned().collect())
        .unwrap_or_default()
}
