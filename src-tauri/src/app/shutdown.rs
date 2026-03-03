use tauri::Manager;

use crate::domains::lsp::commands::LspManagerState;
use crate::domains::mcp::commands::stop_all_mcp_servers;
use crate::domains::terminal::commands::terminal_kill_all;

pub fn handle_window_event(window: &tauri::Window<tauri::Wry>, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { .. } = event {
        let _ = terminal_kill_all();

        let app = window.app_handle().clone();
        let lsp_state: tauri::State<'_, LspManagerState<tauri::Wry>> = app.state();
        if let Ok(guard) = lsp_state.0.lock() {
            if let Some(ref manager) = *guard {
                let _ = manager.stop_all();
            }
        }

        let mcp_app = window.app_handle().clone();
        tauri::async_runtime::spawn(async move {
            let _ = stop_all_mcp_servers(mcp_app).await;
        });
    }
}
