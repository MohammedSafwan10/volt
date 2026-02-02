use serde::Serialize;
use sysinfo::System;
use std::collections::HashMap;
use std::sync::Mutex;
use once_cell::sync::Lazy;
use tauri::{AppHandle, Emitter};

// Track running watch processes
static WATCH_PROCESSES: Lazy<Mutex<HashMap<String, std::process::Child>>> = Lazy::new(|| Mutex::new(HashMap::new()));

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
    use std::process::Command;

    // On Windows, hide the console window
    let mut cmd = if cfg!(windows) {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new(command);
        c.creation_flags(0x08000000); // CREATE_NO_WINDOW
        c
    } else {
        Command::new(command)
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
}

/// Get an environment variable
#[tauri::command]
pub fn get_env_var(name: String) -> Option<String> {
    std::env::var(name).ok()
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
    use std::process::{Command, Stdio};
    use std::io::{BufRead, BufReader};
    use std::thread;

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

    let mut child = cmd.spawn()
        .map_err(|e| format!("Failed to spawn watch command: {}", e))?;

    let stdout = child.stdout.take()
        .ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take()
        .ok_or("Failed to capture stderr")?;

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
                let _ = app_clone.emit(&format!("watch://{}//stdout", watch_id_clone), line);
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
                let _ = app_clone2.emit(&format!("watch://{}//stderr", watch_id_clone2), line);
            }
        }
    });

    // Monitor for process exit
    let watch_id_exit = watch_id.clone();
    thread::spawn(move || {
        loop {
            thread::sleep(std::time::Duration::from_millis(500));
            let mut processes = match WATCH_PROCESSES.lock() {
                Ok(p) => p,
                Err(_) => return,
            };
            if let Some(child) = processes.get_mut(&watch_id_exit) {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        let _ = app.emit(&format!("watch://{}//exit", watch_id_exit), status.code().unwrap_or(-1));
                        processes.remove(&watch_id_exit);
                        return;
                    }
                    Ok(None) => {} // Still running
                    Err(_) => {
                        processes.remove(&watch_id_exit);
                        return;
                    }
                }
            } else {
                return; // Process removed (stopped externally)
            }
        }
    });

    Ok(())
}

/// Stop a running watch command
#[tauri::command]
pub fn stop_watch_command(watch_id: String) -> Result<(), String> {
    let mut processes = WATCH_PROCESSES.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = processes.remove(&watch_id) {
        let _ = child.kill();
        Ok(())
    } else {
        Err(format!("Watch '{}' not found", watch_id))
    }
}

/// List active watch commands
#[tauri::command]
pub fn list_watch_commands() -> Vec<String> {
    WATCH_PROCESSES.lock()
        .map(|p| p.keys().cloned().collect())
        .unwrap_or_default()
}
