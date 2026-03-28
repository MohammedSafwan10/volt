mod chat_history;
mod commands;
mod domains;
mod lsp;
mod observability;

use observability::{debug_log, debug_log_frontend};
use tauri::Manager;

use chat_history::{
    chat_clear_all, chat_create_conversation, chat_delete_conversation, chat_get_conversation,
    chat_list_conversations, chat_save_message, chat_search_conversations, chat_toggle_pin,
    chat_truncate_conversation, chat_update_mode, chat_update_title, ChatHistoryState,
};
use commands::ai::{
    ai_has_api_key, ai_remove_api_key, ai_set_api_key, ai_validate_api_key, anthropic_proxy,
    anthropic_proxy_stream, gemini_proxy, gemini_proxy_stream, mistral_proxy, mistral_proxy_stream,
    openai_proxy, openai_proxy_stream, openrouter_proxy, openrouter_proxy_stream,
};
use commands::document::{
    document_apply_edit, document_close, document_get, document_list_dirty, document_read,
    document_reload, document_save, document_write,
};
use commands::file_index::{
    cancel_index_workspace, clear_index_cache, get_index_status, index_workspace_stream,
    remove_indexed_file, rename_indexed_file, search_indexed_files, upsert_indexed_file,
    FileIndexState,
};
use commands::file_ops::{
    create_dir, create_file, delete_path, get_file_info, list_dir, list_dir_detailed,
    read_binary_file_base64, read_file, rename_path, write_file,
};
use commands::file_watch::{
    is_watching, start_file_watch, stop_all_file_watches, stop_file_watch, FileWatchState,
};
use commands::git::{
    get_git_branch, git_cancel, git_commit, git_diff_file, git_discard_file,
    git_has_uncommitted_changes, git_list_branches, git_stage_all, git_stage_file, git_status,
    git_switch_branch, git_unstage_all, git_unstage_file, is_git_repo, GitProcessManager,
};
use commands::lsp::{
    lsp_begin_project_diagnostics, lsp_close_document, lsp_complete_project_diagnostics,
    lsp_get_server_info, lsp_is_server_running, lsp_list_servers, lsp_list_tracked_documents,
    lsp_note_project_diagnostics_sidecar_failure, lsp_reset_project_diagnostics_scheduler,
    lsp_restart_server, lsp_send_message, lsp_start_external_server, lsp_start_server,
    lsp_stop_all, lsp_stop_server, lsp_sync_document, LspManagerState,
};
use commands::mcp::{
    call_mcp_tool, ensure_mcp_config, get_mcp_config_path, get_mcp_servers, get_mcp_tools,
    read_mcp_config, start_mcp_server, stop_all_mcp_servers, stop_mcp_server, write_mcp_config,
    McpState,
};
use commands::search::{
    cancel_workspace_search, find_files_by_name, replace_in_file, replace_one_in_file,
    workspace_search, workspace_search_stream, SearchManagerState,
};
use commands::semantic_index::{
    semantic_index_compact, semantic_index_query, semantic_index_rebuild,
    semantic_index_remove_paths, semantic_index_status, semantic_index_upsert_files,
    SemanticIndexState,
};
use commands::system::{
    get_env_var, get_system_info, list_watch_commands, open_path_scoped, run_command,
    start_watch_command, stop_all_watch_commands, stop_watch_command,
};
use commands::terminal::{
    terminal_create, terminal_get_scrollback, terminal_kill, terminal_kill_all, terminal_list,
    terminal_resize, terminal_write,
};
use commands::workspace::{
    workspace_close, workspace_get_state, workspace_open, workspace_refresh,
    workspace_replace_recent_projects, WorkspaceManagerState,
};
use domains::agent_runtime::commands::{
    agent_runtime_apply, assistant_run_cancel, assistant_run_claim_dispatch_step,
    assistant_run_complete_dispatch_step, assistant_run_get_snapshot,
    assistant_run_register_approvals, assistant_run_resolve_approvals,
    assistant_run_resume_approval, assistant_run_set_dispatch_plan, assistant_run_start,
    assistant_run_update_approval, assistant_runtime_publish_event,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    debug_log("app", "starting tauri runtime");
    tauri::Builder::<tauri::Wry>::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .manage(LspManagerState::<tauri::Wry>::default())
        .manage(domains::agent_runtime::manager::AssistantRuntimeManagerState::default())
        .manage(domains::document::manager::DocumentManagerState::default())
        .manage(SearchManagerState::default())
        .manage(GitProcessManager::default())
        .manage(FileIndexState::default())
        .manage(FileWatchState::default())
        .manage(SemanticIndexState::default())
        .manage(McpState::default())
        .manage(ChatHistoryState::default())
        .manage(WorkspaceManagerState::default())
        .invoke_handler(tauri::generate_handler![
            // AI credentials (OS secure storage)
            ai_set_api_key,
            ai_has_api_key,
            ai_remove_api_key,
            ai_validate_api_key,
            anthropic_proxy,
            anthropic_proxy_stream,
            openai_proxy,
            openai_proxy_stream,
            openrouter_proxy,
            openrouter_proxy_stream,
            gemini_proxy,
            gemini_proxy_stream,
            mistral_proxy,
            mistral_proxy_stream,
            agent_runtime_apply,
            assistant_run_start,
            assistant_run_cancel,
            assistant_run_resume_approval,
            assistant_run_register_approvals,
            assistant_run_update_approval,
            assistant_run_resolve_approvals,
            assistant_run_set_dispatch_plan,
            assistant_run_claim_dispatch_step,
            assistant_run_complete_dispatch_step,
            assistant_run_get_snapshot,
            assistant_runtime_publish_event,
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
            document_read,
            document_get,
            document_apply_edit,
            document_write,
            document_save,
            document_list_dirty,
            document_reload,
            document_close,
            read_file,
            read_binary_file_base64,
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
            terminal_get_scrollback,
            // Workspace lifecycle
            workspace_get_state,
            workspace_replace_recent_projects,
            workspace_open,
            workspace_refresh,
            workspace_close,
            // LSP
            lsp_start_server,
            lsp_start_external_server,
            lsp_stop_server,
            lsp_stop_all,
            lsp_restart_server,
            lsp_send_message,
            lsp_sync_document,
            lsp_close_document,
            lsp_list_tracked_documents,
            lsp_begin_project_diagnostics,
            lsp_complete_project_diagnostics,
            lsp_note_project_diagnostics_sidecar_failure,
            lsp_reset_project_diagnostics_scheduler,
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
            // System
            get_system_info,
            run_command,
            get_env_var,
            open_path_scoped,
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
            find_files_by_name,
            replace_in_file,
            replace_one_in_file,
            // File indexing
            index_workspace_stream,
            cancel_index_workspace,
            clear_index_cache,
            get_index_status,
            search_indexed_files,
            upsert_indexed_file,
            remove_indexed_file,
            rename_indexed_file,
            // Semantic indexing
            semantic_index_upsert_files,
            semantic_index_remove_paths,
            semantic_index_query,
            semantic_index_status,
            semantic_index_rebuild,
            semantic_index_compact,
            debug_log_frontend,
            // File watching
            start_file_watch,
            stop_file_watch,
            stop_all_file_watches,
            is_watching,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                debug_log("app", "window close requested; starting cleanup");
                // Kill all terminal PTY sessions
                let _ = terminal_kill_all();

                // Kill all watch processes (tsc --watch, etc.)
                let _ = stop_all_watch_commands();

                // Stop all LSP servers
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

                // Stop all MCP servers (spawn async task)
                let mcp_app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = stop_all_mcp_servers(mcp_app).await;
                });
                debug_log("app", "window close cleanup dispatched");
            }
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|err| {
            debug_log("app", format!("tauri runtime exited with error: {err}"));
        });
}
