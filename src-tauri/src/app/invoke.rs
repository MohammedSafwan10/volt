use crate::__cmd__ai_has_api_key;
use crate::__cmd__ai_remove_api_key;
use crate::__cmd__ai_set_api_key;
use crate::__cmd__ai_validate_api_key;
use crate::__cmd__anthropic_proxy;
use crate::__cmd__anthropic_proxy_stream;
use crate::__cmd__browser_add_bookmark;
use crate::__cmd__browser_back;
use crate::__cmd__browser_clear_history;
use crate::__cmd__browser_close;
use crate::__cmd__browser_content_extracted;
use crate::__cmd__browser_create;
use crate::__cmd__browser_devtools_application;
use crate::__cmd__browser_devtools_console_log;
use crate::__cmd__browser_devtools_js_error;
use crate::__cmd__browser_devtools_network_request;
use crate::__cmd__browser_devtools_network_response;
use crate::__cmd__browser_devtools_performance;
use crate::__cmd__browser_devtools_security_issue;
use crate::__cmd__browser_element_selected;
use crate::__cmd__browser_execute_js;
use crate::__cmd__browser_extract_content;
use crate::__cmd__browser_find;
use crate::__cmd__browser_find_clear;
use crate::__cmd__browser_find_next;
use crate::__cmd__browser_find_prev;
use crate::__cmd__browser_find_result;
use crate::__cmd__browser_forward;
use crate::__cmd__browser_generate_code;
use crate::__cmd__browser_get_bookmarks;
use crate::__cmd__browser_get_history;
use crate::__cmd__browser_get_state;
use crate::__cmd__browser_hard_reload;
use crate::__cmd__browser_hide;
use crate::__cmd__browser_navigate;
use crate::__cmd__browser_open_devtools;
use crate::__cmd__browser_reload;
use crate::__cmd__browser_remove_bookmark;
use crate::__cmd__browser_screenshot;
use crate::__cmd__browser_set_bounds;
use crate::__cmd__browser_set_responsive_mode;
use crate::__cmd__browser_set_select_mode;
use crate::__cmd__browser_set_zoom;
use crate::__cmd__browser_show;
use crate::__cmd__browser_stop;
use crate::__cmd__browser_zoom_in;
use crate::__cmd__browser_zoom_out;
use crate::__cmd__browser_zoom_reset;
use crate::__cmd__call_mcp_tool;
use crate::__cmd__cancel_index_workspace;
use crate::__cmd__cancel_workspace_search;
use crate::__cmd__find_files_by_name;
use crate::__cmd__cdp_attach_to_page;
use crate::__cmd__cdp_clear_console;
use crate::__cmd__cdp_clear_errors;
use crate::__cmd__cdp_clear_network;
use crate::__cmd__cdp_click;
use crate::__cmd__cdp_connect;
use crate::__cmd__cdp_disable_element_picker;
use crate::__cmd__cdp_disconnect;
use crate::__cmd__cdp_discover_url;
use crate::__cmd__cdp_emulate_device;
use crate::__cmd__cdp_enable_console;
use crate::__cmd__cdp_enable_element_picker;
use crate::__cmd__cdp_enable_network;
use crate::__cmd__cdp_evaluate;
use crate::__cmd__cdp_get_console_logs;
use crate::__cmd__cdp_get_content;
use crate::__cmd__cdp_get_element;
use crate::__cmd__cdp_get_elements;
use crate::__cmd__cdp_get_js_errors;
use crate::__cmd__cdp_get_network_requests;
use crate::__cmd__cdp_get_performance;
use crate::__cmd__cdp_get_status;
use crate::__cmd__cdp_get_title;
use crate::__cmd__cdp_get_url;
use crate::__cmd__cdp_is_available;
use crate::__cmd__cdp_navigate;
use crate::__cmd__cdp_press_key;
use crate::__cmd__cdp_screenshot;
use crate::__cmd__cdp_screenshot_element;
use crate::__cmd__cdp_scroll_by;
use crate::__cmd__cdp_scroll_to_element;
use crate::__cmd__cdp_set_viewport;
use crate::__cmd__cdp_type;
use crate::__cmd__cdp_wait_for_selector;
use crate::__cmd__chat_clear_all;
use crate::__cmd__chat_create_conversation;
use crate::__cmd__chat_delete_conversation;
use crate::__cmd__chat_get_conversation;
use crate::__cmd__chat_list_conversations;
use crate::__cmd__chat_save_message;
use crate::__cmd__chat_search_conversations;
use crate::__cmd__chat_toggle_pin;
use crate::__cmd__chat_truncate_conversation;
use crate::__cmd__chat_update_mode;
use crate::__cmd__chat_update_title;
use crate::__cmd__clear_index_cache;
use crate::__cmd__search_indexed_files;
use crate::__cmd__upsert_indexed_file;
use crate::__cmd__remove_indexed_file;
use crate::__cmd__rename_indexed_file;
use crate::__cmd__create_dir;
use crate::__cmd__create_file;
use crate::__cmd__delete_path;
use crate::__cmd__ensure_mcp_config;
use crate::__cmd__gemini_proxy;
use crate::__cmd__gemini_proxy_stream;
use crate::__cmd__get_env_var;
use crate::__cmd__get_file_info;
use crate::__cmd__get_git_branch;
use crate::__cmd__get_index_status;
use crate::__cmd__get_mcp_config_path;
use crate::__cmd__get_mcp_servers;
use crate::__cmd__get_mcp_tools;
use crate::__cmd__get_system_info;
use crate::__cmd__git_cancel;
use crate::__cmd__git_commit;
use crate::__cmd__git_diff_file;
use crate::__cmd__git_discard_file;
use crate::__cmd__git_has_uncommitted_changes;
use crate::__cmd__git_list_branches;
use crate::__cmd__git_stage_all;
use crate::__cmd__git_stage_file;
use crate::__cmd__git_status;
use crate::__cmd__git_switch_branch;
use crate::__cmd__git_unstage_all;
use crate::__cmd__git_unstage_file;
use crate::__cmd__index_workspace_stream;
use crate::__cmd__is_git_repo;
use crate::__cmd__is_watching;
use crate::__cmd__list_dir;
use crate::__cmd__list_dir_detailed;
use crate::__cmd__list_watch_commands;
use crate::__cmd__lsp_get_server_info;
use crate::__cmd__lsp_is_server_running;
use crate::__cmd__lsp_list_tracked_documents;
use crate::__cmd__lsp_list_servers;
use crate::__cmd__lsp_close_document;
use crate::__cmd__lsp_begin_project_diagnostics;
use crate::__cmd__lsp_complete_project_diagnostics;
use crate::__cmd__lsp_restart_server;
use crate::__cmd__lsp_note_project_diagnostics_sidecar_failure;
use crate::__cmd__lsp_reset_project_diagnostics_scheduler;
use crate::__cmd__lsp_send_message;
use crate::__cmd__lsp_start_external_server;
use crate::__cmd__lsp_start_server;
use crate::__cmd__lsp_stop_all;
use crate::__cmd__lsp_stop_server;
use crate::__cmd__lsp_sync_document;
use crate::__cmd__mistral_proxy;
use crate::__cmd__mistral_proxy_stream;
use crate::__cmd__open_path_scoped;
use crate::__cmd__openai_proxy;
use crate::__cmd__openai_proxy_stream;
use crate::__cmd__openrouter_proxy;
use crate::__cmd__openrouter_proxy_stream;
use crate::__cmd__read_file;
use crate::__cmd__read_binary_file_base64;
use crate::__cmd__read_mcp_config;
use crate::__cmd__rename_path;
use crate::__cmd__replace_in_file;
use crate::__cmd__replace_one_in_file;
use crate::__cmd__run_command;
use crate::__cmd__semantic_index_compact;
use crate::__cmd__semantic_index_query;
use crate::__cmd__semantic_index_rebuild;
use crate::__cmd__semantic_index_remove_paths;
use crate::__cmd__semantic_index_status;
use crate::__cmd__semantic_index_upsert_files;
use crate::__cmd__start_file_watch;
use crate::__cmd__start_mcp_server;
use crate::__cmd__start_watch_command;
use crate::__cmd__stop_all_file_watches;
use crate::__cmd__stop_all_mcp_servers;
use crate::__cmd__stop_all_watch_commands;
use crate::__cmd__stop_file_watch;
use crate::__cmd__stop_mcp_server;
use crate::__cmd__stop_watch_command;
use crate::__cmd__terminal_create;
use crate::__cmd__terminal_get_scrollback;
use crate::__cmd__terminal_kill;
use crate::__cmd__terminal_kill_all;
use crate::__cmd__terminal_list;
use crate::__cmd__terminal_resize;
use crate::__cmd__terminal_write;
use crate::__cmd__workspace_search;
use crate::__cmd__workspace_search_stream;
use crate::__cmd__write_file;
use crate::__cmd__write_mcp_config;
use crate::domains::cdp::commands::{
    cdp_attach_to_page, cdp_clear_console, cdp_clear_errors, cdp_clear_network, cdp_click,
    cdp_connect, cdp_disable_element_picker, cdp_disconnect, cdp_discover_url, cdp_emulate_device,
    cdp_enable_console, cdp_enable_element_picker, cdp_enable_network, cdp_evaluate,
    cdp_get_console_logs, cdp_get_content, cdp_get_element, cdp_get_elements, cdp_get_js_errors,
    cdp_get_network_requests, cdp_get_performance, cdp_get_status, cdp_get_title, cdp_get_url,
    cdp_is_available, cdp_navigate, cdp_press_key, cdp_screenshot, cdp_screenshot_element,
    cdp_scroll_by, cdp_scroll_to_element, cdp_set_viewport, cdp_type, cdp_wait_for_selector,
    CdpState,
};
use crate::domains::chat::store::{
    chat_clear_all, chat_create_conversation, chat_delete_conversation, chat_get_conversation,
    chat_list_conversations, chat_save_message, chat_search_conversations, chat_toggle_pin,
    chat_truncate_conversation, chat_update_mode, chat_update_title, ChatHistoryState,
};
use crate::domains::ai::commands::{
    ai_has_api_key, ai_remove_api_key, ai_set_api_key, ai_validate_api_key, anthropic_proxy,
    anthropic_proxy_stream, gemini_proxy, gemini_proxy_stream, mistral_proxy,
    mistral_proxy_stream, openai_proxy, openai_proxy_stream, openrouter_proxy,
    openrouter_proxy_stream,
};
use crate::domains::browser::commands::{
    browser_add_bookmark, browser_back, browser_clear_history, browser_close,
    browser_content_extracted, browser_create, browser_devtools_application,
    browser_devtools_console_log, browser_devtools_js_error, browser_devtools_network_request,
    browser_devtools_network_response, browser_devtools_performance,
    browser_devtools_security_issue, browser_element_selected, browser_execute_js,
    browser_extract_content, browser_find, browser_find_clear, browser_find_next,
    browser_find_prev, browser_find_result, browser_forward, browser_generate_code,
    browser_get_bookmarks, browser_get_history, browser_get_state, browser_hard_reload,
    browser_hide, browser_navigate, browser_open_devtools, browser_reload, browser_remove_bookmark,
    browser_screenshot, browser_set_bounds, browser_set_responsive_mode, browser_set_select_mode,
    browser_set_zoom, browser_show, browser_stop, browser_zoom_in, browser_zoom_out,
    browser_zoom_reset, BrowserState,
};
use crate::domains::file_system::index::{
    cancel_index_workspace, clear_index_cache, get_index_status, index_workspace_stream,
    remove_indexed_file, rename_indexed_file, search_indexed_files, upsert_indexed_file,
    FileIndexState,
};
use crate::domains::file_system::commands::{
    create_dir, create_file, delete_path, get_file_info, list_dir, list_dir_detailed,
    read_binary_file_base64, read_file, rename_path, write_file,
};
use crate::domains::file_system::watch::{
    is_watching, start_file_watch, stop_all_file_watches, stop_file_watch, FileWatchState,
};
use crate::domains::git::commands::{
    get_git_branch, git_cancel, git_commit, git_diff_file, git_discard_file,
    git_has_uncommitted_changes, git_list_branches, git_stage_all, git_stage_file, git_status,
    git_switch_branch, git_unstage_all, git_unstage_file, is_git_repo, GitProcessManager,
};
use crate::domains::lsp::commands::{
    lsp_begin_project_diagnostics, lsp_close_document, lsp_complete_project_diagnostics,
    lsp_get_server_info, lsp_is_server_running, lsp_list_servers, lsp_list_tracked_documents,
    lsp_note_project_diagnostics_sidecar_failure, lsp_reset_project_diagnostics_scheduler,
    lsp_restart_server, lsp_send_message, lsp_start_external_server, lsp_start_server,
    lsp_stop_all, lsp_stop_server, lsp_sync_document, LspManagerState,
};
use crate::domains::mcp::commands::{
    call_mcp_tool, ensure_mcp_config, get_mcp_config_path, get_mcp_servers, get_mcp_tools,
    read_mcp_config, start_mcp_server, stop_all_mcp_servers, stop_mcp_server, write_mcp_config,
    McpState,
};
use crate::domains::search::commands::{
    cancel_workspace_search, find_files_by_name, replace_in_file, replace_one_in_file,
    workspace_search, workspace_search_stream, SearchManagerState,
};
use crate::domains::semantic::commands::{
    semantic_index_compact, semantic_index_query, semantic_index_rebuild,
    semantic_index_remove_paths, semantic_index_status, semantic_index_upsert_files,
    SemanticIndexState,
};
use crate::domains::system::commands::{
    get_env_var, get_system_info, list_watch_commands, open_path_scoped, run_command,
    start_watch_command, stop_all_watch_commands, stop_watch_command,
};
use crate::domains::terminal::commands::{
    terminal_create, terminal_get_scrollback, terminal_kill, terminal_kill_all, terminal_list,
    terminal_resize, terminal_write,
};

pub fn invoke_handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
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
            browser_devtools_console_log,
            browser_devtools_js_error,
            browser_devtools_network_request,
            browser_devtools_network_response,
            browser_devtools_performance,
            browser_devtools_application,
            browser_devtools_security_issue,
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
            // File watching
            start_file_watch,
            stop_file_watch,
            stop_all_file_watches,
            is_watching,
    ]
}


