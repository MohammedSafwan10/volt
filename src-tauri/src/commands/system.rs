use serde::Serialize;
use sysinfo::System;

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
