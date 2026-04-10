//! LSP Commands - Tauri commands for managing language server sidecars
//!
//! These commands allow the frontend to:
//! - Start/stop language servers (bundled sidecars or external from PATH)
//! - Send JSON-RPC messages to servers
//! - Query server status

use crate::lsp::{
    ExternalLspConfig, LspError, LspHealthStatus, LspManager, LspProjectDiagnosticsPlan,
    LspRecoveryState, LspServerConfig, LspServerInfo, LspTrackedDocumentInfo,
    LspTrackedDocumentSyncResult,
};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Runtime, State};
use tokio::time::{sleep, Duration};

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

#[tauri::command]
pub async fn lsp_start_server_managed<R: Runtime>(
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

    state.with_manager(&app_handle, |manager| manager.start_server_managed(config))
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

#[tauri::command]
pub async fn lsp_start_external_server_managed<R: Runtime>(
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

    state.with_manager(&app_handle, |manager| manager.start_external_server_managed(config))
}

/// Stop a language server sidecar
#[tauri::command]
pub async fn lsp_stop_server<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, LspManagerState<R>>,
    server_id: String,
    preserve_state: Option<bool>,
) -> Result<(), LspError> {
    state.with_manager(&app_handle, |manager| {
        manager.stop_server(&server_id, preserve_state.unwrap_or(false))
    })
}

/// Stop all language server sidecars
#[tauri::command]
pub async fn lsp_stop_all<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, LspManagerState<R>>,
) -> Result<(), LspError> {
    state.with_manager(&app_handle, |manager| manager.stop_all())
}

#[tauri::command]
pub async fn lsp_restart_server<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, LspManagerState<R>>,
    server_id: String,
) -> Result<LspServerInfo, LspError> {
    state.with_manager(&app_handle, |manager| manager.restart_server(&server_id))
}

#[tauri::command]
pub async fn lsp_schedule_recovery<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, LspManagerState<R>>,
    server_id: String,
    reason: String,
    base_delay_ms: u64,
    max_delay_ms: u64,
    max_attempts: usize,
    window_ms: u64,
) -> Result<LspRecoveryState, LspError> {
    state.with_manager(&app_handle, |manager| {
        manager.schedule_recovery(
            &server_id,
            &reason,
            base_delay_ms,
            max_delay_ms,
            max_attempts,
            window_ms,
        )
    })
}

#[tauri::command]
pub async fn lsp_reset_recovery<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, LspManagerState<R>>,
    server_id: String,
) -> Result<LspRecoveryState, LspError> {
    state.with_manager(&app_handle, |manager| manager.reset_recovery_state(&server_id))
}

#[tauri::command]
pub async fn lsp_check_health<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, LspManagerState<R>>,
    server_id: String,
    transport_connected: bool,
    failure_threshold: u64,
) -> Result<LspHealthStatus, LspError> {
    state.with_manager(&app_handle, |manager| {
        manager.check_health(&server_id, transport_connected, failure_threshold)
    })
}

#[tauri::command]
pub async fn lsp_start_health_monitoring<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, LspManagerState<R>>,
    server_id: String,
    interval_ms: u64,
    failure_threshold: u64,
) -> Result<(), LspError> {
    state.with_manager(&app_handle, |manager| {
        manager.start_health_monitoring(&server_id, interval_ms, failure_threshold)
    })
}

#[tauri::command]
pub async fn lsp_stop_health_monitoring<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, LspManagerState<R>>,
    server_id: String,
) -> Result<(), LspError> {
    state.with_manager(&app_handle, |manager| manager.stop_health_monitoring(&server_id))
}

/// Send a JSON-RPC message to a language server
#[tauri::command]
pub async fn lsp_send_message<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, LspManagerState<R>>,
    server_id: String,
    message: String,
) -> Result<(), LspError> {
    state.with_manager(&app_handle, |manager| {
        manager.send_message(&server_id, &message)
    })
}

#[tauri::command]
pub async fn lsp_sync_document<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, LspManagerState<R>>,
    server_id: String,
    file_path: String,
    language_id: String,
    text: String,
) -> Result<LspTrackedDocumentSyncResult, LspError> {
    state.with_manager(&app_handle, |manager| {
        manager.sync_document(&server_id, &file_path, &language_id, &text)
    })
}

#[tauri::command]
pub async fn lsp_close_document<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, LspManagerState<R>>,
    server_id: String,
    file_path: String,
) -> Result<bool, LspError> {
    state.with_manager(&app_handle, |manager| {
        manager.close_document(&server_id, &file_path)
    })
}

#[tauri::command]
pub async fn lsp_list_tracked_documents<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, LspManagerState<R>>,
    server_id: String,
) -> Result<Vec<LspTrackedDocumentInfo>, LspError> {
    state.with_manager(&app_handle, |manager| {
        manager.list_tracked_documents(&server_id)
    })
}

#[tauri::command]
pub async fn lsp_begin_project_diagnostics<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, LspManagerState<R>>,
    root_path: String,
    sidecars: Vec<String>,
) -> Result<LspProjectDiagnosticsPlan, LspError> {
    state.with_manager(&app_handle, |manager| {
        manager.begin_project_diagnostics(&root_path, &sidecars)
    })
}

#[tauri::command]
pub async fn lsp_begin_project_diagnostics_managed<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, LspManagerState<R>>,
    root_path: String,
    sidecars: Vec<String>,
) -> Result<LspProjectDiagnosticsPlan, LspError> {
    loop {
        let plan = state.with_manager(&app_handle, |manager| {
            manager.begin_project_diagnostics(&root_path, &sidecars)
        })?;

        if plan.action != "delay" {
            return Ok(plan);
        }

        sleep(Duration::from_millis(plan.delay_ms)).await;
    }
}

#[tauri::command]
pub async fn lsp_complete_project_diagnostics<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, LspManagerState<R>>,
    run_id: u64,
) -> Result<LspProjectDiagnosticsPlan, LspError> {
    state.with_manager(&app_handle, |manager| {
        manager.complete_project_diagnostics(run_id)
    })
}

#[tauri::command]
pub async fn lsp_complete_project_diagnostics_managed<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, LspManagerState<R>>,
    run_id: u64,
    sidecars: Vec<String>,
) -> Result<LspProjectDiagnosticsPlan, LspError> {
    let mut plan = state.with_manager(&app_handle, |manager| {
        manager.complete_project_diagnostics(run_id)
    })?;

    while plan.action == "delay" {
        let Some(root_path) = plan.root_path.clone() else {
            return Ok(plan);
        };
        sleep(Duration::from_millis(plan.delay_ms)).await;
        plan = state.with_manager(&app_handle, |manager| {
            manager.begin_project_diagnostics(&root_path, &sidecars)
        })?;
    }

    Ok(plan)
}

#[tauri::command]
pub async fn lsp_wait_project_diagnostics_delay(delay_ms: u64) -> Result<(), LspError> {
    if delay_ms > 0 {
        sleep(Duration::from_millis(delay_ms)).await;
    }

    Ok(())
}

#[tauri::command]
pub async fn lsp_note_project_diagnostics_sidecar_failure<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, LspManagerState<R>>,
    sidecar: String,
    error_type: Option<String>,
    message: Option<String>,
) -> Result<bool, LspError> {
    state.with_manager(&app_handle, |manager| {
        manager.note_project_diagnostics_sidecar_failure(
            &sidecar,
            error_type.as_deref(),
            message.as_deref(),
        )
    })
}

#[tauri::command]
pub async fn lsp_reset_project_diagnostics_scheduler<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, LspManagerState<R>>,
) -> Result<(), LspError> {
    state.with_manager(&app_handle, |manager| {
        manager.reset_project_diagnostics_scheduler()
    })
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
    state.with_manager(&app_handle, |manager| {
        Ok(manager.is_server_running(&server_id))
    })
}
