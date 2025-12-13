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
