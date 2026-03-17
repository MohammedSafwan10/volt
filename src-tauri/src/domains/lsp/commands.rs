//! LSP Commands - Tauri commands for managing language server sidecars
//!
//! These commands allow the frontend to:
//! - Start/stop language servers (bundled sidecars or external from PATH)
//! - Send JSON-RPC messages to servers
//! - Query server status

use crate::lsp::{ExternalLspConfig, LspError, LspManager, LspServerConfig, LspServerInfo};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Runtime, State};

/// Global LSP manager state
pub struct LspManagerState<R: Runtime>(pub Mutex<Option<LspManager<R>>>);

impl<R: Runtime> Default for LspManagerState<R> {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

impl<R: Runtime> LspManagerState<R> {
    /// Ensure the manager is initialized, then run a closure with a reference to it.
    /// This eliminates the repetitive ensure→lock→unwrap pattern in every command.
    fn with_manager<T>(
        &self,
        app_handle: &AppHandle<R>,
        f: impl FnOnce(&LspManager<R>) -> Result<T, LspError>,
    ) -> Result<T, LspError> {
        // Ensure initialized
        {
            let mut manager_opt = self.0.lock().map_err(|e| LspError::ProcessError {
                message: format!("Failed to acquire lock: {}", e),
            })?;
            if manager_opt.is_none() {
                *manager_opt = Some(LspManager::new(app_handle.clone()));
            }
        }
        // Run the closure
        let manager_opt = self.0.lock().map_err(|e| LspError::ProcessError {
            message: format!("Failed to acquire lock: {}", e),
        })?;
        let manager = manager_opt.as_ref().ok_or_else(|| LspError::ProcessError {
            message: "LSP manager not initialized".to_string(),
        })?;
        f(manager)
    }
}

/// Start a language server sidecar
#[tauri::command]
pub async fn lsp_start_server<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, LspManagerState<R>>,
    server_id: String,
    server_type: String,
    sidecar_name: String,
    entrypoint: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
) -> Result<LspServerInfo, LspError> {
    let config = LspServerConfig {
        server_id,
        server_type,
        sidecar_name,
        entrypoint,
        args,
        cwd,
        env,
    };

    state.with_manager(&app_handle, |manager| manager.start_server(config))
}

/// Start an external language server (from user's PATH, e.g., Dart, Rust Analyzer)
#[tauri::command]
pub async fn lsp_start_external_server<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, LspManagerState<R>>,
    server_id: String,
    server_type: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
) -> Result<LspServerInfo, LspError> {
    let config = ExternalLspConfig {
        server_id,
        server_type,
        command,
        args,
        cwd,
        env,
    };

    state.with_manager(&app_handle, |manager| manager.start_external_server(config))
}

/// Stop a language server sidecar
#[tauri::command]
pub async fn lsp_stop_server<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, LspManagerState<R>>,
    server_id: String,
) -> Result<(), LspError> {
    state.with_manager(&app_handle, |manager| manager.stop_server(&server_id))
}

/// Stop all language server sidecars
#[tauri::command]
pub async fn lsp_stop_all<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, LspManagerState<R>>,
) -> Result<(), LspError> {
    state.with_manager(&app_handle, |manager| manager.stop_all())
}

/// Send a JSON-RPC message to a language server
#[tauri::command]
pub async fn lsp_send_message<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, LspManagerState<R>>,
    server_id: String,
    message: String,
) -> Result<(), LspError> {
    state.with_manager(&app_handle, |manager| manager.send_message(&server_id, &message))
}

/// List all running language servers
#[tauri::command]
pub async fn lsp_list_servers<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, LspManagerState<R>>,
) -> Result<Vec<LspServerInfo>, LspError> {
    state.with_manager(&app_handle, |manager| manager.list_servers())
}

/// Get info about a specific language server
#[tauri::command]
pub async fn lsp_get_server_info<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, LspManagerState<R>>,
    server_id: String,
) -> Result<LspServerInfo, LspError> {
    state.with_manager(&app_handle, |manager| manager.get_server_info(&server_id))
}

/// Check if a language server is running
#[tauri::command]
pub async fn lsp_is_server_running<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, LspManagerState<R>>,
    server_id: String,
) -> Result<bool, LspError> {
    state.with_manager(&app_handle, |manager| Ok(manager.is_server_running(&server_id)))
}
