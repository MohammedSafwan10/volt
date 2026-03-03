use crate::app::{invoke, shutdown};
use crate::domains::browser::commands::BrowserState;
use crate::domains::cdp::commands::CdpState;
use crate::domains::chat::commands::ChatHistoryState;
use crate::domains::file_system::index::FileIndexState;
use crate::domains::file_system::watch::FileWatchState;
use crate::domains::git::commands::GitProcessManager;
use crate::domains::lsp::commands::LspManagerState;
use crate::domains::mcp::commands::McpState;
use crate::domains::search::commands::SearchManagerState;
use crate::domains::semantic::commands::SemanticIndexState;

pub fn run() {
    tauri::Builder::<tauri::Wry>::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .manage(LspManagerState::<tauri::Wry>::default())
        .manage(SearchManagerState::default())
        .manage(GitProcessManager::default())
        .manage(FileIndexState::default())
        .manage(FileWatchState::default())
        .manage(SemanticIndexState::default())
        .manage(McpState::default())
        .manage(BrowserState::default())
        .manage(CdpState::default())
        .manage(ChatHistoryState::default())
        .invoke_handler(invoke::invoke_handler())
        .on_window_event(|window, event| shutdown::handle_window_event(window, event))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
