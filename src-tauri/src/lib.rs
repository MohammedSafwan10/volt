mod commands;
mod lsp;

use commands::file_ops::{
    create_dir, create_file, delete_path, get_file_info, list_dir, list_dir_detailed, read_file,
    rename_path, write_file,
};
use commands::lsp::{
    lsp_get_server_info, lsp_is_server_running, lsp_list_servers, lsp_send_message,
    lsp_start_server, lsp_stop_all, lsp_stop_server, LspManagerState,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
