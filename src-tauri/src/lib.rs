mod commands;
mod lsp;

use commands::file_index::{
    cancel_index_workspace, clear_index_cache, get_index_status, index_workspace_stream,
    FileIndexState,
};
use commands::file_ops::{
    create_dir, create_file, delete_path, get_file_info, list_dir, list_dir_detailed, read_file,
    rename_path, write_file,
};
use commands::fs_scope::fs_allow_directory;
use commands::git::{
    get_git_branch, git_cancel, git_commit, git_diff_file, git_discard_file,
    git_has_uncommitted_changes, git_list_branches, git_stage_all, git_stage_file, git_status,
    git_switch_branch, git_unstage_all, git_unstage_file, is_git_repo, GitProcessManager,
};
use commands::lsp::{
    lsp_get_server_info, lsp_is_server_running, lsp_list_servers, lsp_send_message,
    lsp_start_server, lsp_stop_all, lsp_stop_server, LspManagerState,
};
use commands::search::{
    cancel_workspace_search, replace_in_file, replace_one_in_file, workspace_search,
    workspace_search_stream, SearchManagerState,
};
use commands::system::get_system_info;
use commands::terminal::{
    terminal_create, terminal_kill, terminal_list, terminal_resize, terminal_write,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .manage(LspManagerState::<tauri::Wry>::default())
        .manage(SearchManagerState::default())
        .manage(GitProcessManager::default())
        .manage(FileIndexState::default())
        .invoke_handler(tauri::generate_handler![
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
            terminal_list,
            // FS scope helpers
            fs_allow_directory,
            // LSP
            lsp_start_server,
            lsp_stop_server,
            lsp_stop_all,
            lsp_send_message,
            lsp_list_servers,
            lsp_get_server_info,
            lsp_is_server_running,
            // System
            get_system_info,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
