mod cdp;
mod chat_history;
mod commands;
mod lsp;

use tauri::Manager;

use cdp::commands::{
    cdp_attach_to_page, cdp_clear_console, cdp_clear_errors, cdp_clear_network, cdp_click,
    cdp_connect, cdp_disable_element_picker, cdp_disconnect, cdp_discover_url, cdp_emulate_device,
    cdp_enable_console, cdp_enable_element_picker, cdp_enable_network, cdp_evaluate,
    cdp_get_console_logs, cdp_get_content, cdp_get_element, cdp_get_elements, cdp_get_js_errors,
    cdp_get_network_requests, cdp_get_performance, cdp_get_status, cdp_get_title, cdp_get_url,
    cdp_is_available, cdp_navigate, cdp_press_key, cdp_screenshot, cdp_screenshot_element,
    cdp_scroll_by, cdp_scroll_to_element, cdp_set_viewport, cdp_type, cdp_wait_for_selector,
    CdpState,
};
use chat_history::{
    chat_clear_all, chat_create_conversation, chat_delete_conversation, chat_get_conversation,
    chat_list_conversations, chat_save_message, chat_search_conversations, chat_toggle_pin,
    chat_truncate_conversation, chat_update_mode, chat_update_title, ChatHistoryState,
};
use commands::ai::{
    ai_get_api_key, ai_has_api_key, ai_remove_api_key, ai_set_api_key, anthropic_proxy,
    anthropic_proxy_stream, openai_proxy, openai_proxy_stream, openrouter_proxy,
    openrouter_proxy_stream,
};
use commands::browser::{
    browser_add_bookmark, browser_back, browser_clear_history, browser_close,
    browser_content_extracted, browser_create, browser_element_selected, browser_execute_js,
    browser_extract_content, browser_find, browser_find_clear, browser_find_next,
    browser_find_prev, browser_find_result, browser_forward, browser_generate_code,
    browser_get_bookmarks, browser_get_history, browser_get_state, browser_hard_reload,
    browser_hide, browser_navigate, browser_open_devtools, browser_reload, browser_remove_bookmark,
    browser_screenshot, browser_set_bounds, browser_set_responsive_mode, browser_set_select_mode,
    browser_set_zoom, browser_show, browser_stop, browser_zoom_in, browser_zoom_out,
    browser_zoom_reset, BrowserState,
};
use commands::file_index::{
    cancel_index_workspace, clear_index_cache, get_index_status, index_workspace_stream,
    FileIndexState,
};
use commands::file_ops::{
    create_dir, create_file, delete_path, get_file_info, list_dir, list_dir_detailed, read_file,
    rename_path, write_file,
};
use commands::file_watch::{
    is_watching, start_file_watch, stop_all_file_watches, stop_file_watch, FileWatchState,
};
use commands::fs_scope::fs_allow_directory;
use commands::git::{
    get_git_branch, git_cancel, git_commit, git_diff_file, git_discard_file,
    git_has_uncommitted_changes, git_list_branches, git_stage_all, git_stage_file, git_status,
    git_switch_branch, git_unstage_all, git_unstage_file, is_git_repo, GitProcessManager,
};
use commands::lsp::{
    lsp_get_server_info, lsp_is_server_running, lsp_list_servers, lsp_send_message,
    lsp_start_external_server, lsp_start_server, lsp_stop_all, lsp_stop_server, LspManagerState,
};
use commands::mcp::{
    call_mcp_tool, ensure_mcp_config, get_mcp_config_path, get_mcp_servers, get_mcp_tools,
    read_mcp_config, start_mcp_server, stop_all_mcp_servers, stop_mcp_server, write_mcp_config,
    McpState,
};
use commands::search::{
    cancel_workspace_search, replace_in_file, replace_one_in_file, workspace_search,
    workspace_search_stream, SearchManagerState,
};
use commands::system::{
    get_env_var, get_system_info, list_watch_commands, run_command, start_watch_command,
    stop_all_watch_commands, stop_watch_command,
};
use commands::terminal::{
    terminal_create, terminal_kill, terminal_kill_all, terminal_list, terminal_resize,
    terminal_write,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
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
        .manage(McpState::default())
        .manage(BrowserState::default())
        .manage(CdpState::default())
        .manage(ChatHistoryState::default())
        .invoke_handler(tauri::generate_handler![
            // AI credentials (OS secure storage)
            ai_set_api_key,
            ai_get_api_key,
            ai_has_api_key,
            ai_remove_api_key,
            anthropic_proxy,
            anthropic_proxy_stream,
            openai_proxy,
            openai_proxy_stream,
            openrouter_proxy,
            openrouter_proxy_stream,
            // Chat history persistence
            chat_create_conversation,
            chat_list_conversations,
            chat_get_conversation,
            chat_save_message,
            chat_update_title,
            chat_update_mode,
            chat_toggle_pin,
            chat_delete_conversation,
            chat_search_conversations,
            chat_truncate_conversation,
            chat_clear_all,
            // File operations
            read_file,
            write_file,
            list_dir,
            list_dir_detailed,
            create_file,
            create_dir,
            delete_path,
            rename_path,
            get_file_info,
            // Terminal
            terminal_create,
            terminal_write,
            terminal_resize,
            terminal_kill,
            terminal_kill_all,
            terminal_list,
            // FS scope helpers
            fs_allow_directory,
            // LSP
            lsp_start_server,
            lsp_start_external_server,
            lsp_stop_server,
            lsp_stop_all,
            lsp_send_message,
            lsp_list_servers,
            lsp_get_server_info,
            lsp_is_server_running,
            // MCP
            start_mcp_server,
            stop_mcp_server,
            stop_all_mcp_servers,
            call_mcp_tool,
            get_mcp_servers,
            get_mcp_tools,
            get_mcp_config_path,
            ensure_mcp_config,
            read_mcp_config,
            write_mcp_config,
            // Browser
            browser_create,
            browser_close,
            browser_navigate,
            browser_back,
            browser_forward,
            browser_reload,
            browser_hard_reload,
            browser_stop,
            browser_set_select_mode,
            browser_execute_js,
            browser_set_bounds,
            browser_hide,
            browser_show,
            browser_zoom_in,
            browser_zoom_out,
            browser_zoom_reset,
            browser_set_zoom,
            browser_find,
            browser_find_next,
            browser_find_prev,
            browser_find_clear,
            browser_find_result,
            browser_extract_content,
            browser_content_extracted,
            browser_generate_code,
            browser_element_selected,
            browser_get_state,
            browser_add_bookmark,
            browser_remove_bookmark,
            browser_get_bookmarks,
            browser_get_history,
            browser_clear_history,
            browser_set_responsive_mode,
            browser_open_devtools,
            browser_screenshot,
            // CDP (Chrome DevTools Protocol) - Professional browser automation
            cdp_is_available,
            cdp_get_status,
            cdp_discover_url,
            cdp_connect,
            cdp_disconnect,
            cdp_attach_to_page,
            cdp_enable_console,
            cdp_enable_network,
            cdp_get_console_logs,
            cdp_get_js_errors,
            cdp_get_network_requests,
            cdp_clear_console,
            cdp_clear_errors,
            cdp_clear_network,
            cdp_navigate,
            cdp_get_url,
            cdp_get_title,
            cdp_get_content,
            cdp_click,
            cdp_type,
            cdp_press_key,
            cdp_evaluate,
            cdp_screenshot,
            cdp_screenshot_element,
            cdp_get_element,
            cdp_get_elements,
            cdp_wait_for_selector,
            cdp_scroll_to_element,
            cdp_scroll_by,
            cdp_get_performance,
            cdp_set_viewport,
            cdp_emulate_device,
            cdp_enable_element_picker,
            cdp_disable_element_picker,
            // System
            get_system_info,
            run_command,
            get_env_var,
            start_watch_command,
            stop_watch_command,
            stop_all_watch_commands,
            list_watch_commands,
            // Git
            get_git_branch,
            is_git_repo,
            git_status,
            git_cancel,
            git_stage_file,
            git_stage_all,
            git_unstage_file,
            git_unstage_all,
            git_commit,
            git_list_branches,
            git_switch_branch,
            git_diff_file,
            git_has_uncommitted_changes,
            git_discard_file,
            // Search
            workspace_search,
            workspace_search_stream,
            cancel_workspace_search,
            replace_in_file,
            replace_one_in_file,
            // File indexing
            index_workspace_stream,
            cancel_index_workspace,
            clear_index_cache,
            get_index_status,
            // File watching
            start_file_watch,
            stop_file_watch,
            stop_all_file_watches,
            is_watching,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Kill all terminals when window closes
                let _ = terminal_kill_all();

                // Stop all LSP servers
                let app = window.app_handle().clone();
                let lsp_state: tauri::State<'_, LspManagerState<tauri::Wry>> = app.state();
                if let Ok(guard) = lsp_state.0.lock() {
                    if let Some(ref manager) = *guard {
                        let _ = manager.stop_all();
                    }
                }

                // Stop all MCP servers (spawn async task)
                let mcp_app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = stop_all_mcp_servers(mcp_app).await;
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
