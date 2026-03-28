#[cfg(test)]
mod tests {
    use crate::domains::document::manager::{DocumentManagerState, DocumentWriteRequest};
    use tempfile::tempdir;

    #[test]
    fn default_state_starts_empty() {
        let manager = DocumentManagerState::default();
        let dirty = manager.list_dirty_documents().unwrap();
        assert!(dirty.is_empty());
    }

    #[test]
    fn document_write_request_carries_expected_version() {
        let request = DocumentWriteRequest {
            expected_version: Some(7),
            source: Some("ai".to_string()),
            force: false,
            create_if_missing: true,
        };

        assert_eq!(request.expected_version, Some(7));
        assert_eq!(request.source.as_deref(), Some("ai"));
        assert!(!request.force);
        assert!(request.create_if_missing);
    }

    #[test]
    fn temp_file_setup_for_document_paths_works() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("doc.txt");
        std::fs::write(&file_path, "hello").unwrap();
        let normalized = file_path.to_string_lossy().replace('\\', "/");
        assert!(normalized.ends_with("doc.txt"));
    }

    #[tokio::test]
    async fn read_document_hydrates_existing_disk_file_into_cache() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("doc.tsx");
        std::fs::write(&file_path, "export const value = 1;\n").unwrap();
        let normalized = file_path.to_string_lossy().replace('\\', "/");
        let manager = DocumentManagerState::default();

        let state = manager
            .read_document(normalized.clone(), false)
            .await
            .unwrap()
            .expect("existing disk file should load");

        assert_eq!(state.path, normalized);
        assert_eq!(state.content, "export const value = 1;\n");
        assert_eq!(state.version, 1);
        assert_eq!(state.disk_version, 1);
        assert!(!state.is_dirty);
        assert_eq!(state.language.as_deref(), Some("typescriptreact"));

        let cached = manager
            .get_document(file_path.to_string_lossy().into_owned())
            .unwrap()
            .expect("loaded file should be cached");
        assert_eq!(cached.content, state.content);
        assert_eq!(cached.version, state.version);
    }
}
