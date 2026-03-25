use tauri::{AppHandle, Runtime, State};

use super::manager::{
    DocumentApplyResult, DocumentManagerState, DocumentState, DocumentWriteRequest, DocumentWriteResult,
};

#[tauri::command]
pub async fn document_read<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, DocumentManagerState>,
    path: String,
    force_refresh: Option<bool>,
) -> Result<Option<DocumentState>, String> {
    state
        .read_document(path, force_refresh.unwrap_or(false))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn document_get<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, DocumentManagerState>,
    path: String,
) -> Result<Option<DocumentState>, String> {
    state.get_document(path)
}

#[tauri::command]
pub fn document_apply_edit<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DocumentManagerState>,
    path: String,
    content: String,
    source: Option<String>,
) -> Result<DocumentApplyResult, String> {
    state.apply_document_edit(&app, path, content, source)
}

#[tauri::command]
pub async fn document_write<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DocumentManagerState>,
    path: String,
    content: String,
    expected_version: Option<u64>,
    source: Option<String>,
    force: Option<bool>,
    create_if_missing: Option<bool>,
) -> Result<DocumentWriteResult, String> {
    state
        .write_document(
            &app,
            path,
            content,
            DocumentWriteRequest {
                expected_version,
                source,
                force: force.unwrap_or(false),
                create_if_missing: create_if_missing.unwrap_or(false),
            },
        )
        .await
}

#[tauri::command]
pub async fn document_save<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DocumentManagerState>,
    path: String,
) -> Result<DocumentWriteResult, String> {
    state.save_document(&app, path).await
}

#[tauri::command]
pub fn document_list_dirty<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, DocumentManagerState>,
) -> Result<Vec<DocumentState>, String> {
    state.list_dirty_documents()
}

#[tauri::command]
pub async fn document_reload<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DocumentManagerState>,
    path: String,
) -> Result<Option<DocumentState>, String> {
    state.reload_document(&app, path).await
}

#[tauri::command]
pub fn document_close<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DocumentManagerState>,
    path: String,
) -> Result<(), String> {
    state.close_document(&app, path)
}
