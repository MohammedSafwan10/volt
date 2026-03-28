use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Runtime};

use crate::domains::file_system::commands::{read_file, write_file, FileError};

const DOCUMENT_EVENT_CHANGED: &str = "document://changed";
const DOCUMENT_EVENT_CLOSED: &str = "document://closed";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentState {
    pub path: String,
    pub content: String,
    pub version: u64,
    pub disk_version: u64,
    pub is_dirty: bool,
    pub last_modified: u64,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentChangeEvent {
    pub path: String,
    pub content: String,
    pub version: u64,
    pub disk_version: u64,
    pub is_dirty: bool,
    pub source: String,
    pub previous_content: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCloseEvent {
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentWriteResult {
    pub success: bool,
    pub new_version: Option<u64>,
    pub error: Option<String>,
    pub conflict_content: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentApplyResult {
    pub state: DocumentState,
    pub previous_content: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DocumentWriteRequest {
    pub expected_version: Option<u64>,
    pub source: Option<String>,
    pub force: bool,
    pub create_if_missing: bool,
}

#[derive(Default)]
pub struct DocumentManagerState {
    documents: Mutex<HashMap<String, DocumentState>>,
}

impl DocumentManagerState {
    fn normalize_path(path: &str) -> String {
        path.replace('\\', "/")
    }

    fn detect_language(path: &str) -> Option<String> {
        let ext = path
            .rsplit('.')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let language = match ext.as_str() {
            "ts" => "typescript",
            "tsx" => "typescriptreact",
            "js" => "javascript",
            "jsx" => "javascriptreact",
            "svelte" => "svelte",
            "html" | "htm" => "html",
            "css" => "css",
            "scss" => "scss",
            "less" => "less",
            "json" => "json",
            "md" => "markdown",
            "yaml" | "yml" => "yaml",
            "xml" | "plist" | "xsd" => "xml",
            "dart" => "dart",
            "rs" => "rust",
            "py" => "python",
            "go" => "go",
            _ => "plaintext",
        };
        Some(language.to_string())
    }

    fn now_millis() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0)
    }

    async fn load_document_from_disk(
        &self,
        normalized_path: &str,
    ) -> Result<Option<DocumentState>, FileError> {
        let content = match read_file(normalized_path.to_string()).await {
            Ok(content) => content,
            Err(FileError::NotFound { .. }) => return Ok(None),
            Err(error) => return Err(error),
        };

        let mut documents = self.documents.lock().map_err(|err| FileError::IoError {
            message: format!("Failed to acquire document lock: {err}"),
        })?;

        let existing = documents.get(normalized_path).cloned();
        let mut version = existing.as_ref().map(|doc| doc.version).unwrap_or(1);
        let mut disk_version = existing
            .as_ref()
            .map(|doc| doc.disk_version)
            .unwrap_or(version);
        let is_dirty = existing.as_ref().map(|doc| doc.is_dirty).unwrap_or(false);

        if let Some(existing_doc) = existing {
            if existing_doc.content != content {
                version = existing_doc.version + 1;
                disk_version = version;
            }
        }

        let state = DocumentState {
            path: normalized_path.to_string(),
            content,
            version,
            disk_version,
            is_dirty,
            last_modified: Self::now_millis(),
            language: Self::detect_language(normalized_path),
        };

        documents.insert(normalized_path.to_string(), state.clone());
        Ok(Some(state))
    }

    fn emit_change<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        state: &DocumentState,
        source: &str,
        previous_content: Option<String>,
    ) {
        let _ = app.emit(
            DOCUMENT_EVENT_CHANGED,
            DocumentChangeEvent {
                path: state.path.clone(),
                content: state.content.clone(),
                version: state.version,
                disk_version: state.disk_version,
                is_dirty: state.is_dirty,
                source: source.to_string(),
                previous_content,
            },
        );
    }

    pub async fn read_document(
        &self,
        path: String,
        force_refresh: bool,
    ) -> Result<Option<DocumentState>, FileError> {
        let normalized_path = Self::normalize_path(&path);

        if !force_refresh {
            if let Ok(documents) = self.documents.lock() {
                if let Some(existing) = documents.get(&normalized_path) {
                    return Ok(Some(existing.clone()));
                }
            }
        }

        self.load_document_from_disk(&normalized_path).await
    }

    pub fn get_document(&self, path: String) -> Result<Option<DocumentState>, String> {
        let normalized_path = Self::normalize_path(&path);
        let documents = self
            .documents
            .lock()
            .map_err(|err| format!("Failed to acquire document lock: {err}"))?;
        Ok(documents.get(&normalized_path).cloned())
    }

    pub fn apply_document_edit<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        path: String,
        content: String,
        source: Option<String>,
    ) -> Result<DocumentApplyResult, String> {
        let normalized_path = Self::normalize_path(&path);
        let source = source.unwrap_or_else(|| "editor".to_string());
        let mut documents = self
            .documents
            .lock()
            .map_err(|err| format!("Failed to acquire document lock: {err}"))?;

        let existing = documents.get(&normalized_path).cloned();
        let new_version = existing.as_ref().map(|doc| doc.version + 1).unwrap_or(1);
        let previous_content = existing.as_ref().map(|doc| doc.content.clone());
        let disk_version = existing.as_ref().map(|doc| doc.disk_version).unwrap_or(0);

        let state = DocumentState {
            path: normalized_path.clone(),
            content,
            version: new_version,
            disk_version,
            is_dirty: true,
            last_modified: Self::now_millis(),
            language: existing
                .as_ref()
                .and_then(|doc| doc.language.clone())
                .or_else(|| Self::detect_language(&normalized_path)),
        };

        documents.insert(normalized_path, state.clone());
        drop(documents);
        self.emit_change(app, &state, &source, previous_content.clone());

        Ok(DocumentApplyResult {
            state,
            previous_content,
        })
    }

    pub async fn write_document<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        path: String,
        content: String,
        request: DocumentWriteRequest,
    ) -> Result<DocumentWriteResult, String> {
        let normalized_path = Self::normalize_path(&path);
        let source = request.source.unwrap_or_else(|| "editor".to_string());

        let existing = {
            let documents = self
                .documents
                .lock()
                .map_err(|err| format!("Failed to acquire document lock: {err}"))?;
            documents.get(&normalized_path).cloned()
        };

        let existing = if let Some(existing) = existing {
            Some(existing)
        } else if request.create_if_missing {
            None
        } else {
            self.load_document_from_disk(&normalized_path)
                .await
                .map_err(|error| error.to_string())?
        };

        if existing.is_none() && !request.create_if_missing {
            return Ok(DocumentWriteResult {
                success: false,
                new_version: None,
                error: Some("Document not found".to_string()),
                conflict_content: None,
            });
        }

        if let (Some(expected_version), Some(existing_doc)) =
            (request.expected_version, existing.clone())
        {
            if existing_doc.version != expected_version && !request.force {
                return Ok(DocumentWriteResult {
                    success: false,
                    new_version: None,
                    error: Some(format!(
                        "Version conflict: expected {}, current {}",
                        expected_version, existing_doc.version
                    )),
                    conflict_content: Some(existing_doc.content),
                });
            }
        }

        if let Some(existing_doc) = existing.as_ref() {
            if existing_doc.content == content && !request.force {
                return Ok(DocumentWriteResult {
                    success: true,
                    new_version: Some(existing_doc.version),
                    error: None,
                    conflict_content: None,
                });
            }
        }

        write_file(normalized_path.clone(), content.clone())
            .await
            .map_err(|error| error.to_string())?;

        let verification = read_file(normalized_path.clone())
            .await
            .map_err(|error| error.to_string())?;

        if verification != content {
            write_file(normalized_path.clone(), content.clone())
                .await
                .map_err(|error| error.to_string())?;
            let retry = read_file(normalized_path.clone())
                .await
                .map_err(|error| error.to_string())?;
            if retry != content {
                return Ok(DocumentWriteResult {
                    success: false,
                    new_version: None,
                    error: Some("Write verification failed after retry".to_string()),
                    conflict_content: None,
                });
            }
        }

        let previous_content = existing.as_ref().map(|doc| doc.content.clone());
        let new_version = existing.as_ref().map(|doc| doc.version + 1).unwrap_or(1);
        let state = DocumentState {
            path: normalized_path.clone(),
            content,
            version: new_version,
            disk_version: new_version,
            is_dirty: false,
            last_modified: Self::now_millis(),
            language: existing
                .as_ref()
                .and_then(|doc| doc.language.clone())
                .or_else(|| Self::detect_language(&normalized_path)),
        };

        let mut documents = self
            .documents
            .lock()
            .map_err(|err| format!("Failed to acquire document lock: {err}"))?;
        documents.insert(normalized_path, state.clone());
        drop(documents);

        self.emit_change(app, &state, &source, previous_content);

        Ok(DocumentWriteResult {
            success: true,
            new_version: Some(new_version),
            error: None,
            conflict_content: None,
        })
    }

    pub fn list_dirty_documents(&self) -> Result<Vec<DocumentState>, String> {
        let documents = self
            .documents
            .lock()
            .map_err(|err| format!("Failed to acquire document lock: {err}"))?;
        Ok(documents
            .values()
            .filter(|doc| doc.is_dirty)
            .cloned()
            .collect())
    }

    pub async fn save_document<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        path: String,
    ) -> Result<DocumentWriteResult, String> {
        let normalized_path = Self::normalize_path(&path);
        let existing = {
            let documents = self
                .documents
                .lock()
                .map_err(|err| format!("Failed to acquire document lock: {err}"))?;
            documents.get(&normalized_path).cloned()
        };

        let Some(document) = existing else {
            return Ok(DocumentWriteResult {
                success: false,
                new_version: None,
                error: Some("Document not found".to_string()),
                conflict_content: None,
            });
        };

        if !document.is_dirty {
            return Ok(DocumentWriteResult {
                success: true,
                new_version: Some(document.version),
                error: None,
                conflict_content: None,
            });
        }

        self.write_document(
            app,
            normalized_path,
            document.content,
            DocumentWriteRequest {
                expected_version: None,
                source: Some("editor".to_string()),
                force: true,
                create_if_missing: false,
            },
        )
        .await
    }

    pub async fn reload_document<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        path: String,
    ) -> Result<Option<DocumentState>, String> {
        let state = self
            .read_document(path, true)
            .await
            .map_err(|error| error.to_string())?;

        if let Some(document) = state.as_ref() {
            self.emit_change(app, document, "disk", None);
        }

        Ok(state)
    }

    pub fn close_document<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        path: String,
    ) -> Result<(), String> {
        let normalized_path = Self::normalize_path(&path);
        let mut documents = self
            .documents
            .lock()
            .map_err(|err| format!("Failed to acquire document lock: {err}"))?;
        documents.remove(&normalized_path);
        drop(documents);
        let _ = app.emit(
            DOCUMENT_EVENT_CLOSED,
            DocumentCloseEvent {
                path: normalized_path,
            },
        );
        Ok(())
    }
}
