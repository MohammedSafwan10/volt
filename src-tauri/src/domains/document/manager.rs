use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Runtime};

use crate::domains::file_system::commands::{delete_path, read_file, rename_path, write_file, FileError};

const DOCUMENT_EVENT_CHANGED: &str = "document://changed";
const DOCUMENT_EVENT_CLOSED: &str = "document://closed";
const DOCUMENT_EVENT_RENAMED: &str = "document://renamed";

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
pub struct DocumentRenamedEvent {
    pub old_path: String,
    pub new_path: String,
    pub state: Option<DocumentState>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentWriteResult {
    pub success: bool,
    pub new_version: Option<u64>,
    pub error: Option<String>,
    pub conflict_content: Option<String>,
    pub state: Option<DocumentState>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentBatchWriteInput {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentBatchWriteResult {
    pub success: bool,
    pub error: Option<String>,
    pub conflict_content: Option<String>,
    pub states: Vec<DocumentState>,
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

    fn is_same_or_descendant_path(scope_path: &str, candidate_path: &str) -> bool {
        candidate_path == scope_path
            || candidate_path
                .strip_prefix(scope_path)
                .is_some_and(|suffix| suffix.starts_with('/'))
    }

    fn remap_scoped_path(path: &str, old_root: &str, new_root: &str) -> Option<String> {
        if path == old_root {
            return Some(new_root.to_string());
        }

        path.strip_prefix(old_root)
            .filter(|suffix| suffix.starts_with('/'))
            .map(|suffix| format!("{new_root}{suffix}"))
    }

    fn remove_scoped_documents(
        documents: &mut HashMap<String, DocumentState>,
        scope_path: &str,
    ) -> Vec<DocumentState> {
        let mut matching_paths = documents
            .keys()
            .filter(|path| Self::is_same_or_descendant_path(scope_path, path))
            .cloned()
            .collect::<Vec<_>>();
        matching_paths.sort();

        let mut removed_documents = Vec::with_capacity(matching_paths.len());
        for path in matching_paths {
            if let Some(document) = documents.remove(&path) {
                removed_documents.push(document);
            }
        }
        removed_documents
    }

    fn move_scoped_documents(
        documents: &mut HashMap<String, DocumentState>,
        old_root: &str,
        new_root: &str,
    ) -> Vec<DocumentRenamedEvent> {
        let removed_documents = Self::remove_scoped_documents(documents, old_root);
        let mut renamed_documents = Vec::with_capacity(removed_documents.len());

        for mut state in removed_documents {
            let old_path = state.path.clone();
            let Some(new_path) = Self::remap_scoped_path(&old_path, old_root, new_root) else {
                continue;
            };

            state.path = new_path.clone();
            state.language = Self::detect_language(&new_path);
            state.last_modified = Self::now_millis();
            documents.insert(new_path.clone(), state.clone());
            renamed_documents.push(DocumentRenamedEvent {
                old_path,
                new_path,
                state: Some(state),
            });
        }

        renamed_documents
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

    #[cfg(test)]
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
    ) -> Result<(), String> {
        let normalized_path = Self::normalize_path(&path);
        let source = source.unwrap_or_else(|| "editor".to_string());
        let mut documents = self
            .documents
            .lock()
            .map_err(|err| format!("Failed to acquire document lock: {err}"))?;

        let existing = documents.get(&normalized_path).cloned();
        if let Some(existing_doc) = existing.as_ref() {
            if existing_doc.content == content {
                return Ok(());
            }
        }
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

        Ok(())
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
                state: None,
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
                    state: None,
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
                    state: Some(existing_doc.clone()),
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
                    state: None,
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
            state: Some(state),
        })
    }

    pub async fn batch_write_documents<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        writes: Vec<DocumentBatchWriteInput>,
        request: DocumentWriteRequest,
    ) -> Result<DocumentBatchWriteResult, String> {
        let normalized_writes = writes
            .into_iter()
            .map(|write| DocumentBatchWriteInput {
                path: Self::normalize_path(&write.path),
                content: write.content,
            })
            .collect::<Vec<_>>();

        let mut snapshots: Vec<(String, Option<DocumentState>)> = Vec::new();

        for write in &normalized_writes {
            let existing = {
                let documents = self
                    .documents
                    .lock()
                    .map_err(|err| format!("Failed to acquire document lock: {err}"))?;
                documents.get(&write.path).cloned()
            };

            let existing = if let Some(existing) = existing {
                Some(existing)
            } else if request.create_if_missing {
                None
            } else {
                self.load_document_from_disk(&write.path)
                    .await
                    .map_err(|error| error.to_string())?
            };

            if existing.is_none() && !request.create_if_missing {
                return Ok(DocumentBatchWriteResult {
                    success: false,
                    error: Some(format!("Document not found: {}", write.path)),
                    conflict_content: None,
                    states: vec![],
                });
            }

            if let (Some(expected_version), Some(existing_doc)) =
                (request.expected_version, existing.clone())
            {
                if existing_doc.version != expected_version && !request.force {
                    return Ok(DocumentBatchWriteResult {
                        success: false,
                        error: Some(format!("Version conflict in {}", write.path)),
                        conflict_content: Some(existing_doc.content),
                        states: vec![],
                    });
                }
            }

            snapshots.push((write.path.clone(), existing));
        }

        let mut committed_states = Vec::new();

        for (index, write) in normalized_writes.iter().enumerate() {
            let result = self
                .write_document(
                    app,
                    write.path.clone(),
                    write.content.clone(),
                    DocumentWriteRequest {
                        expected_version: None,
                        source: request.source.clone(),
                        force: true,
                        create_if_missing: request.create_if_missing,
                    },
                )
                .await?;

            if !result.success {
                self.rollback_batch_write(app, &snapshots[..index]).await;
                return Ok(DocumentBatchWriteResult {
                    success: false,
                    error: result
                        .error
                        .or_else(|| Some(format!("Batch write failed at {}", write.path))),
                    conflict_content: result.conflict_content,
                    states: vec![],
                });
            }

            if let Some(state) = result.state {
                committed_states.push(state);
            }
        }

        Ok(DocumentBatchWriteResult {
            success: true,
            error: None,
            conflict_content: None,
            states: committed_states,
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
                state: None,
            });
        };

        if !document.is_dirty {
            return Ok(DocumentWriteResult {
                success: true,
                new_version: Some(document.version),
                error: None,
                conflict_content: None,
                state: Some(document),
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

    pub async fn delete_document<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        path: String,
    ) -> Result<(), String> {
        let normalized_path = Self::normalize_path(&path);
        delete_path(normalized_path.clone())
            .await
            .map_err(|error| error.to_string())?;

        let mut closed_paths = {
            let mut documents = self
                .documents
                .lock()
                .map_err(|err| format!("Failed to acquire document lock: {err}"))?;
            Self::remove_scoped_documents(&mut documents, &normalized_path)
                .into_iter()
                .map(|document| document.path)
                .collect::<Vec<_>>()
        };

        if !closed_paths.iter().any(|path| path == &normalized_path) {
            closed_paths.push(normalized_path);
        }

        for closed_path in closed_paths {
            let _ = app.emit(DOCUMENT_EVENT_CLOSED, DocumentCloseEvent { path: closed_path });
        }

        Ok(())
    }

    pub async fn rename_document<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        old_path: String,
        new_path: String,
    ) -> Result<(), String> {
        let normalized_old_path = Self::normalize_path(&old_path);
        let normalized_new_path = Self::normalize_path(&new_path);
        rename_path(normalized_old_path.clone(), normalized_new_path.clone())
            .await
            .map_err(|error| error.to_string())?;

        let renamed_documents = {
            let mut documents = self
                .documents
                .lock()
                .map_err(|err| format!("Failed to acquire document lock: {err}"))?;
            Self::move_scoped_documents(&mut documents, &normalized_old_path, &normalized_new_path)
        };

        if renamed_documents.is_empty() {
            let _ = app.emit(
                DOCUMENT_EVENT_RENAMED,
                DocumentRenamedEvent {
                    old_path: normalized_old_path,
                    new_path: normalized_new_path,
                    state: None,
                },
            );
            return Ok(());
        }

        for renamed_document in renamed_documents {
            if let Some(state) = renamed_document.state.as_ref() {
                self.emit_change(app, state, "disk", None);
            }

            let _ = app.emit(DOCUMENT_EVENT_RENAMED, renamed_document);
        }

        Ok(())
    }

    async fn rollback_batch_write<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        snapshots: &[(String, Option<DocumentState>)],
    ) {
        for (path, snapshot) in snapshots.iter().rev() {
            match snapshot {
                Some(existing) => {
                    let _ = self
                        .write_document(
                            app,
                            path.clone(),
                            existing.content.clone(),
                            DocumentWriteRequest {
                                expected_version: None,
                                source: Some("disk".to_string()),
                                force: true,
                                create_if_missing: false,
                            },
                        )
                        .await;
                }
                None => {
                    let _ = self.delete_document(app, path.clone()).await;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(path: &str, version: u64) -> DocumentState {
        DocumentState {
            path: path.to_string(),
            content: path.to_string(),
            version,
            disk_version: version,
            is_dirty: false,
            last_modified: version,
            language: Some("plaintext".to_string()),
        }
    }

    #[test]
    fn remove_scoped_documents_removes_descendants() {
        let mut documents = HashMap::from([
            ("c:/workspace/src/a.ts".to_string(), doc("c:/workspace/src/a.ts", 1)),
            (
                "c:/workspace/src/nested/b.ts".to_string(),
                doc("c:/workspace/src/nested/b.ts", 2),
            ),
            (
                "c:/workspace/README.md".to_string(),
                doc("c:/workspace/README.md", 3),
            ),
        ]);

        let removed = DocumentManagerState::remove_scoped_documents(&mut documents, "c:/workspace/src");

        assert_eq!(removed.len(), 2);
        assert!(documents.contains_key("c:/workspace/README.md"));
        assert!(!documents.contains_key("c:/workspace/src/a.ts"));
        assert!(!documents.contains_key("c:/workspace/src/nested/b.ts"));
    }

    #[test]
    fn move_scoped_documents_remaps_descendants() {
        let mut documents = HashMap::from([
            ("c:/workspace/src/a.ts".to_string(), doc("c:/workspace/src/a.ts", 1)),
            (
                "c:/workspace/src/nested/b.ts".to_string(),
                doc("c:/workspace/src/nested/b.ts", 2),
            ),
        ]);

        let renamed = DocumentManagerState::move_scoped_documents(
            &mut documents,
            "c:/workspace/src",
            "c:/workspace/lib",
        );

        assert_eq!(renamed.len(), 2);
        assert!(documents.contains_key("c:/workspace/lib/a.ts"));
        assert!(documents.contains_key("c:/workspace/lib/nested/b.ts"));
        assert!(!documents.contains_key("c:/workspace/src/a.ts"));
        assert!(!documents.contains_key("c:/workspace/src/nested/b.ts"));
        assert_eq!(renamed[0].old_path, "c:/workspace/src/a.ts");
        assert_eq!(renamed[0].new_path, "c:/workspace/lib/a.ts");
        assert_eq!(renamed[1].old_path, "c:/workspace/src/nested/b.ts");
        assert_eq!(renamed[1].new_path, "c:/workspace/lib/nested/b.ts");
    }
}
