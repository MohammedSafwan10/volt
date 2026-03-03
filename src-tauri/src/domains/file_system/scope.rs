use tauri::AppHandle;
use tauri_plugin_fs::FsExt;

#[tauri::command]
pub fn fs_allow_directory(
    app: AppHandle,
    path: String,
    recursive: Option<bool>,
) -> Result<(), String> {
    let recursive = recursive.unwrap_or(false);

    app.fs_scope()
        .allow_directory(path, recursive)
        .map_err(|e| e.to_string())
}
