use tauri::Manager;

use crate::domains::file_system::watch::FileWatchState;
use crate::domains::lsp::commands::LspManagerState;
use crate::domains::mcp::commands::stop_all_mcp_servers;
use crate::domains::system::commands::stop_all_watch_commands;
use crate::domains::terminal::commands::terminal_kill_all;

pub fn handle_window_event(window: &tauri::Window<tauri::Wry>, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { .. } = event {
        // Kill all terminal PTY sessions
        let _ = terminal_kill_all();

        // Kill all watch processes (tsc --watch, etc.)
        let _ = stop_all_watch_commands();

        // Stop all LSP language servers
        let app = window.app_handle().clone();
        let lsp_state: tauri::State<'_, LspManagerState<tauri::Wry>> = app.state();
        if let Ok(guard) = lsp_state.0.lock() {
            if let Some(ref manager) = *guard {
                let _ = manager.stop_all();
            }
        }

        // Stop all file watchers to release handles
        {
            let watch_state: tauri::State<'_, FileWatchState> = app.state();
            watch_state.clear_all();
        }

        // Stop all MCP servers (async — spawned as a task)
        let mcp_app = window.app_handle().clone();
        tauri::async_runtime::spawn(async move {
            let _ = stop_all_mcp_servers(mcp_app).await;
        });
    }
}
