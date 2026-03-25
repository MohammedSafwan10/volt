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
}
