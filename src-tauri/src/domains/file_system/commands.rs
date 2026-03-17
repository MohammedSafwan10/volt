use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, ErrorKind};
use std::path::PathBuf;
use std::time::SystemTime;

/// Typed error enum for file operations
/// Uses serde tag for TypeScript discrimination
#[derive(Debug, Serialize, thiserror::Error)]
#[serde(tag = "type")]
pub enum FileError {
    #[error("File not found: {path}")]
    NotFound { path: String },

    #[error("Already exists: {path}")]
    AlreadyExists { path: String },

    #[error("Permission denied: {path}")]
    PermissionDenied { path: String },

    #[error("File is locked or in use: {path}")]
    FileLocked { path: String },

    #[error("Path too long: {path}")]
    PathTooLong { path: String },

    #[error("Invalid path: {path}")]
    InvalidPath { path: String },

    #[error("I/O error: {message}")]
    IoError { message: String },
}

impl From<io::Error> for FileError {
    fn from(err: io::Error) -> Self {
        match err.kind() {
            ErrorKind::NotFound => FileError::NotFound {
                path: String::new(),
            },
            ErrorKind::PermissionDenied => FileError::PermissionDenied {
                path: String::new(),
            },
            ErrorKind::WouldBlock => FileError::FileLocked {
                path: String::new(),
            },
            ErrorKind::InvalidInput | ErrorKind::InvalidData => FileError::InvalidPath {
                path: String::new(),
            },
            _ => {
                if let Some(os_error) = err.raw_os_error() {
                    // Windows ERROR_SHARING_VIOLATION (32) - file in use
                    // Windows ERROR_LOCK_VIOLATION (33) - file locked
                    if os_error == 32 || os_error == 33 {
                        return FileError::FileLocked {
                            path: String::new(),
                        };
                    }
                    // Windows ERROR_FILENAME_EXCED_RANGE (206) - path too long
                    if os_error == 206 {
                        return FileError::PathTooLong {
                            path: String::new(),
                        };
                    }
                }
                FileError::IoError {
                    message: err.to_string(),
                }
            }
        }
    }
}

/// Helper to convert io::Error with path context
fn io_error_with_path(err: io::Error, path: &str) -> FileError {
    let mut file_error = FileError::from(err);
    match &mut file_error {
        FileError::NotFound { path: p } => *p = path.to_string(),
        FileError::AlreadyExists { path: p } => *p = path.to_string(),
        FileError::PermissionDenied { path: p } => *p = path.to_string(),
        FileError::FileLocked { path: p } => *p = path.to_string(),
        FileError::PathTooLong { path: p } => *p = path.to_string(),
        FileError::InvalidPath { path: p } => *p = path.to_string(),
        FileError::IoError { .. } => {}
    }
    file_error
}

/// Normalize path for Windows long path support (>260 chars)
/// Adds \\?\ prefix on Windows for paths approaching the limit
#[cfg(windows)]
fn normalize_path(path: &str) -> PathBuf {
    // Windows MAX_PATH is 260, but we add prefix earlier to be safe
    // Skip if already has prefix or is a UNC path (\\server\share)
    if path.len() > 200 && !path.starts_with("\\\\?\\") && !path.starts_with("\\\\") {
        // Convert forward slashes to backslashes for Windows
        let normalized = path.replace('/', "\\");
        PathBuf::from(format!("\\\\?\\{}", normalized))
    } else {
        PathBuf::from(path)
    }
}

#[cfg(not(windows))]
fn normalize_path(path: &str) -> PathBuf {
    PathBuf::from(path)
}

/// Run blocking file operation on a separate thread to avoid blocking async runtime
async fn spawn_blocking<F, T>(f: F) -> Result<T, FileError>
where
    F: FnOnce() -> Result<T, FileError> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| FileError::IoError {
            message: format!("Task join error: {}", e),
        })?
}

/// File entry for directory listing
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_file: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified: Option<u64>,
}

/// Directory listing result with skipped entries.
///
/// `entries` contains successfully-read items.
/// `skipped` contains per-entry errors (permission denied, locked, etc.) that were skipped.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListDirResult {
    pub entries: Vec<FileEntry>,
    pub skipped: Vec<FileError>,
}

/// Detailed file information
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_file: bool,
    pub is_symlink: bool,
    pub is_readonly: bool,
    pub size: u64,
    pub created: Option<u64>,
    pub modified: Option<u64>,
    pub accessed: Option<u64>,
}

/// Helper to convert SystemTime to Unix timestamp (milliseconds)
fn system_time_to_millis(time: SystemTime) -> Option<u64> {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

fn should_allow_lossy_text_fallback(path: &str) -> bool {
    let ext = PathBuf::from(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    matches!(
        ext.as_str(),
        "txt"
            | "md"
            | "log"
            | "csv"
            | "json"
            | "yaml"
            | "yml"
            | "xml"
            | "html"
            | "css"
            | "js"
            | "ts"
            | "py"
            | "rs"
            | "java"
            | "c"
            | "cpp"
            | "h"
            | "hpp"
            | "go"
            | "svelte"
            | "vue"
            | "ini"
            | "conf"
            | "toml"
    )
}

fn decode_utf16_with_bom(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 2 {
        return None;
    }

    let little_endian = if bytes.starts_with(&[0xFF, 0xFE]) {
        true
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        false
    } else {
        return None;
    };

    let data = &bytes[2..];
    let mut units = Vec::with_capacity(data.len() / 2);
    let mut chunks = data.chunks_exact(2);
    for chunk in &mut chunks {
        let unit = if little_endian {
            u16::from_le_bytes([chunk[0], chunk[1]])
        } else {
            u16::from_be_bytes([chunk[0], chunk[1]])
        };
        units.push(unit);
    }

    Some(String::from_utf16_lossy(&units))
}

/// Read file contents as UTF-8 string
#[tauri::command]
pub async fn read_file(path: String) -> Result<String, FileError> {
    if path.is_empty() {
        return Err(FileError::InvalidPath { path });
    }

    let path_clone = path.clone();
    spawn_blocking(move || {
        let path_buf = normalize_path(&path_clone);
        let bytes = fs::read(&path_buf).map_err(|e| io_error_with_path(e, &path_clone))?;

        // Fast path: valid UTF-8.
        if let Ok(text) = String::from_utf8(bytes.clone()) {
            return Ok(text);
        }

        // Common Windows case: UTF-16 text files with BOM.
        if let Some(text) = decode_utf16_with_bom(&bytes) {
            return Ok(text);
        }

        // Fallback for text-like file extensions (e.g. ANSI/CP1252 .txt files).
        if should_allow_lossy_text_fallback(&path_clone) {
            return Ok(String::from_utf8_lossy(&bytes).to_string());
        }

        Err(io_error_with_path(
            io::Error::new(ErrorKind::InvalidData, "File is not valid UTF-8 text"),
            &path_clone,
        ))
    })
    .await
}

/// Write content to file (creates if not exists, overwrites if exists)
#[tauri::command]
pub async fn write_file(path: String, content: String) -> Result<(), FileError> {
    if path.is_empty() {
        return Err(FileError::InvalidPath { path });
    }

    let path_clone = path.clone();
    spawn_blocking(move || {
        let path_buf = normalize_path(&path_clone);

        // Ensure parent directory exists
        if let Some(parent) = path_buf.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent).map_err(|e| io_error_with_path(e, &path_clone))?;
            }
        }

        fs::write(&path_buf, content).map_err(|e| io_error_with_path(e, &path_clone))
    })
    .await
}

/// List directory contents
#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<FileEntry>, FileError> {
    Ok(list_dir_detailed(path).await?.entries)
}

/// List directory contents, including per-entry errors that were skipped.
#[tauri::command]
pub async fn list_dir_detailed(path: String) -> Result<ListDirResult, FileError> {
    if path.is_empty() {
        return Err(FileError::InvalidPath { path });
    }

    let path_clone = path.clone();
    spawn_blocking(move || {
        let path_buf = normalize_path(&path_clone);

        if !path_buf.exists() {
            return Err(FileError::NotFound { path: path_clone });
        }

        if !path_buf.is_dir() {
            return Err(FileError::InvalidPath {
                path: format!("{} is not a directory", path_clone),
            });
        }

        let entries = fs::read_dir(&path_buf).map_err(|e| io_error_with_path(e, &path_clone))?;

        let mut result = Vec::new();
        let mut skipped: Vec<FileError> = Vec::new();

        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    skipped.push(io_error_with_path(e, &path_clone));
                    continue;
                }
            };

            let entry_path = entry.path();
            let entry_path_str = entry_path.to_string_lossy().to_string();
            let name = entry.file_name().to_string_lossy().to_string();

            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(e) => {
                    skipped.push(io_error_with_path(e, &entry_path_str));
                    continue;
                }
            };

            let file_type = match entry.file_type() {
                Ok(ft) => Some(ft),
                Err(e) => {
                    skipped.push(io_error_with_path(e, &entry_path_str));
                    None
                }
            };
            let is_symlink = file_type.map(|ft| ft.is_symlink()).unwrap_or(false);

            // Return original path without \\\?\ prefix for display
            let display_path = entry_path_str;
            #[cfg(windows)]
            let display_path = display_path
                .strip_prefix("\\\\?\\")
                .unwrap_or(&display_path)
                .to_string();

            result.push(FileEntry {
                name,
                path: display_path,
                is_dir: metadata.is_dir(),
                is_file: metadata.is_file(),
                is_symlink,
                size: metadata.len(),
                modified: metadata.modified().ok().and_then(system_time_to_millis),
            });
        }

        // Sort: directories first, then files, alphabetically
        result.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });

        Ok(ListDirResult {
            entries: result,
            skipped,
        })
    })
    .await
}

/// Create a new empty file
#[tauri::command]
pub async fn create_file(path: String) -> Result<(), FileError> {
    if path.is_empty() {
        return Err(FileError::InvalidPath { path });
    }

    let path_clone = path.clone();
    spawn_blocking(move || {
        let path_buf = normalize_path(&path_clone);

        if path_buf.exists() {
            return Err(FileError::AlreadyExists { path: path_clone });
        }

        // Ensure parent directory exists
        if let Some(parent) = path_buf.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent).map_err(|e| io_error_with_path(e, &path_clone))?;
            }
        }

        fs::File::create(&path_buf).map_err(|e| io_error_with_path(e, &path_clone))?;
        Ok(())
    })
    .await
}

/// Create a new directory
#[tauri::command]
pub async fn create_dir(path: String) -> Result<(), FileError> {
    if path.is_empty() {
        return Err(FileError::InvalidPath { path });
    }

    let path_clone = path.clone();
    spawn_blocking(move || {
        let path_buf = normalize_path(&path_clone);

        if path_buf.exists() {
            return Err(FileError::AlreadyExists { path: path_clone });
        }

        fs::create_dir_all(&path_buf).map_err(|e| io_error_with_path(e, &path_clone))
    })
    .await
}

/// Delete a file or directory
#[tauri::command]
pub async fn delete_path(path: String) -> Result<(), FileError> {
    if path.is_empty() {
        return Err(FileError::InvalidPath { path });
    }

    let path_clone = path.clone();
    spawn_blocking(move || {
        let path_buf = normalize_path(&path_clone);

        if !path_buf.exists() {
            return Err(FileError::NotFound { path: path_clone });
        }

        // Windows specific handling for large deletions like node_modules
        #[cfg(windows)]
        {
            use std::thread;
            use std::time::Duration;

            let mut last_error = None;
            let mut last_error_kind = None;
            for attempt in 0..5 {
                if attempt > 0 {
                    // Exponential backoff: 50ms, 100ms, 200ms, 400ms
                    thread::sleep(Duration::from_millis(50 * (2u64.pow(attempt as u32 - 1))));
                }

                let result = if path_buf.is_dir() {
                    fs::remove_dir_all(&path_buf)
                } else {
                    fs::remove_file(&path_buf)
                };

                match result {
                    Ok(_) => return Ok(()),
                    Err(e) => {
                        last_error_kind = Some(e.kind());
                        // If it's permission denied, it might be a readonly file or a locked file
                        if e.kind() == std::io::ErrorKind::PermissionDenied {
                            // Try to clear readonly attributes recursively if it's a directory
                            if path_buf.is_dir() {
                                let _ = clear_readonly_recursively(&path_buf);
                            } else {
                                if let Ok(metadata) = fs::metadata(&path_buf) {
                                    let mut permissions = metadata.permissions();
                                    if permissions.readonly() {
                                        permissions.set_readonly(false);
                                        let _ = fs::set_permissions(&path_buf, permissions);
                                    }
                                }
                            }
                        }
                        last_error = Some(e);
                    }
                }
            }

            // Final Windows fallback: try native shell delete for stubborn paths (node_modules).
            if let Some(std::io::ErrorKind::PermissionDenied) = last_error_kind {
                if try_native_delete_windows(&path_buf) {
                    return Ok(());
                }
            }

            if let Some(e) = last_error {
                return Err(io_error_with_path(e, &path_clone));
            }
        }

        // Fallback/Non-Windows
        if path_buf.is_dir() {
            fs::remove_dir_all(&path_buf).map_err(|e| io_error_with_path(e, &path_clone))
        } else {
            fs::remove_file(&path_buf).map_err(|e| io_error_with_path(e, &path_clone))
        }
    })
    .await
}

#[cfg(windows)]
fn clear_readonly_recursively(path: &std::path::Path) -> std::io::Result<()> {
    if path.is_dir() {
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let path = entry.path();
            clear_readonly_recursively(&path)?;
        }
    }

    let metadata = fs::metadata(path)?;
    let mut permissions = metadata.permissions();
    if permissions.readonly() {
        permissions.set_readonly(false);
        fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

#[cfg(windows)]
fn try_native_delete_windows(path: &std::path::Path) -> bool {
    use std::process::Command;

    let path_str = path.to_string_lossy().to_string();
    if path_str.is_empty() {
        return false;
    }

    // Prefer PowerShell with -LiteralPath to handle special characters safely.
    let escaped = path_str.replace("'", "''");
    let ps_cmd = if path.is_dir() {
        format!(
            "Remove-Item -LiteralPath '{}' -Recurse -Force -ErrorAction SilentlyContinue",
            escaped
        )
    } else {
        format!(
            "Remove-Item -LiteralPath '{}' -Force -ErrorAction SilentlyContinue",
            escaped
        )
    };

    let ps_status = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &ps_cmd,
        ])
        .status();

    if ps_status.map(|s| s.success()).unwrap_or(false) && !path.exists() {
        return true;
    }

    // Fallback to cmd.exe for compatibility
    let cmd_status = if path.is_dir() {
        Command::new("cmd")
            .args(["/C", "rmdir", "/S", "/Q", &path_str])
            .status()
    } else {
        Command::new("cmd")
            .args(["/C", "del", "/F", "/Q", &path_str])
            .status()
    };

    cmd_status.map(|s| s.success()).unwrap_or(false) && !path.exists()
}

/// Rename/move a file or directory
#[tauri::command]
pub async fn rename_path(old_path: String, new_path: String) -> Result<(), FileError> {
    if old_path.is_empty() {
        return Err(FileError::InvalidPath { path: old_path });
    }

    if new_path.is_empty() {
        return Err(FileError::InvalidPath { path: new_path });
    }

    let old_clone = old_path.clone();
    let new_clone = new_path.clone();
    spawn_blocking(move || {
        let old_path_buf = normalize_path(&old_clone);
        let new_path_buf = normalize_path(&new_clone);

        if !old_path_buf.exists() {
            return Err(FileError::NotFound { path: old_clone });
        }

        if new_path_buf.exists() {
            #[cfg(windows)]
            {
                // Windows is typically case-insensitive. A rename that only changes casing
                // (e.g. Foo.txt -> foo.txt) will make `new_path_buf.exists()` true even though
                // it's the same entry. Handle this by renaming via a temporary path.
                let a = old_path_buf.to_string_lossy().to_string();
                let b = new_path_buf.to_string_lossy().to_string();
                if a.to_lowercase() == b.to_lowercase() {
                    let parent = old_path_buf.parent();
                    let parent = parent.unwrap_or_else(|| std::path::Path::new(""));

                    use std::time::{SystemTime, UNIX_EPOCH};
                    let nanos = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_nanos())
                        .unwrap_or(0);

                    let mut temp_path = parent.join(format!(".volt_rename_tmp_{}", nanos));
                    let mut attempts = 0u8;
                    while temp_path.exists() && attempts < 5 {
                        attempts += 1;
                        temp_path = parent.join(format!(".volt_rename_tmp_{}_{}", nanos, attempts));
                    }

                    fs::rename(&old_path_buf, &temp_path)
                        .map_err(|e| io_error_with_path(e, &old_clone))?;
                    fs::rename(&temp_path, &new_path_buf)
                        .map_err(|e| io_error_with_path(e, &new_clone))?;

                    return Ok(());
                }
            }

            return Err(FileError::AlreadyExists { path: new_clone });
        }

        // Ensure parent directory of destination exists
        if let Some(parent) = new_path_buf.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent).map_err(|e| io_error_with_path(e, &new_clone))?;
            }
        }

        // On Windows, file operations can fail with PermissionDenied if file watchers
        // or other processes have handles open. Retry with exponential backoff.
        #[cfg(windows)]
        {
            let mut last_error = None;
            for attempt in 0..5 {
                match fs::rename(&old_path_buf, &new_path_buf) {
                    Ok(()) => return Ok(()),
                    Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied && attempt < 4 => {
                        last_error = Some(e);
                        // Exponential backoff: 50ms, 100ms, 200ms, 400ms
                        std::thread::sleep(std::time::Duration::from_millis(50 << attempt));
                    }
                    Err(e) => return Err(io_error_with_path(e, &old_clone)),
                }
            }
            return Err(io_error_with_path(last_error.unwrap(), &old_clone));
        }

        #[cfg(not(windows))]
        fs::rename(&old_path_buf, &new_path_buf).map_err(|e| io_error_with_path(e, &old_clone))
    })
    .await
}

/// Get detailed file information
#[tauri::command]
pub async fn get_file_info(path: String) -> Result<FileInfo, FileError> {
    if path.is_empty() {
        return Err(FileError::InvalidPath { path });
    }

    let path_clone = path.clone();
    spawn_blocking(move || {
        let path_buf = normalize_path(&path_clone);

        if !path_buf.exists() {
            return Err(FileError::NotFound { path: path_clone });
        }

        let metadata = fs::metadata(&path_buf).map_err(|e| io_error_with_path(e, &path_clone))?;
        let symlink_metadata = fs::symlink_metadata(&path_buf).ok();

        let name = path_buf
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        let is_symlink = symlink_metadata
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);

        let is_readonly = metadata.permissions().readonly();

        // Return original path without \\?\ prefix for display
        let display_path = path_buf.to_string_lossy().to_string();
        #[cfg(windows)]
        let display_path = display_path
            .strip_prefix("\\\\?\\")
            .unwrap_or(&display_path)
            .to_string();

        Ok(FileInfo {
            name,
            path: display_path,
            is_dir: metadata.is_dir(),
            is_file: metadata.is_file(),
            is_symlink,
            is_readonly,
            size: metadata.len(),
            created: metadata.created().ok().and_then(system_time_to_millis),
            modified: metadata.modified().ok().and_then(system_time_to_millis),
            accessed: metadata.accessed().ok().and_then(system_time_to_millis),
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_read_write_file() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("test.txt");
        let path_str = file_path.to_string_lossy().to_string();

        let result = write_file(path_str.clone(), "Hello, World!".to_string()).await;
        assert!(result.is_ok());

        let content = read_file(path_str).await.unwrap();
        assert_eq!(content, "Hello, World!");
    }

    #[tokio::test]
    async fn test_read_nonexistent_file() {
        let result = read_file("/nonexistent/path/file.txt".to_string()).await;
        assert!(matches!(result, Err(FileError::NotFound { .. })));
    }

    #[tokio::test]
    async fn test_list_dir() {
        let dir = tempdir().unwrap();
        let dir_path = dir.path().to_string_lossy().to_string();

        fs::write(dir.path().join("file1.txt"), "content1").unwrap();
        fs::write(dir.path().join("file2.txt"), "content2").unwrap();
        fs::create_dir(dir.path().join("subdir")).unwrap();

        let entries = list_dir(dir_path).await.unwrap();
        assert_eq!(entries.len(), 3);

        // Directories should come first
        assert!(entries[0].is_dir);
        assert_eq!(entries[0].name, "subdir");
    }

    #[tokio::test]
    async fn test_create_and_delete_file() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("new_file.txt");
        let path_str = file_path.to_string_lossy().to_string();

        let result = create_file(path_str.clone()).await;
        assert!(result.is_ok());
        assert!(file_path.exists());

        let result = delete_path(path_str).await;
        assert!(result.is_ok());
        assert!(!file_path.exists());
    }

    #[tokio::test]
    async fn test_create_and_delete_dir() {
        let dir = tempdir().unwrap();
        let new_dir = dir.path().join("new_dir");
        let path_str = new_dir.to_string_lossy().to_string();

        let result = create_dir(path_str.clone()).await;
        assert!(result.is_ok());
        assert!(new_dir.exists());

        let result = delete_path(path_str).await;
        assert!(result.is_ok());
        assert!(!new_dir.exists());
    }

    #[tokio::test]
    async fn test_rename_path() {
        let dir = tempdir().unwrap();
        let old_path = dir.path().join("old.txt");
        let new_path = dir.path().join("new.txt");

        fs::write(&old_path, "content").unwrap();

        let result = rename_path(
            old_path.to_string_lossy().to_string(),
            new_path.to_string_lossy().to_string(),
        )
        .await;

        assert!(result.is_ok());
        assert!(!old_path.exists());
        assert!(new_path.exists());
    }

    #[tokio::test]
    async fn test_get_file_info() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("info_test.txt");
        fs::write(&file_path, "test content").unwrap();

        let info = get_file_info(file_path.to_string_lossy().to_string())
            .await
            .unwrap();

        assert_eq!(info.name, "info_test.txt");
        assert!(info.is_file);
        assert!(!info.is_dir);
        assert_eq!(info.size, 12);
    }

    #[tokio::test]
    async fn test_invalid_path() {
        let result = read_file("".to_string()).await;
        assert!(matches!(result, Err(FileError::InvalidPath { .. })));
    }

    #[tokio::test]
    async fn test_read_file_lossy_txt_fallback() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("cp1252.txt");
        let path_str = file_path.to_string_lossy().to_string();

        // Invalid UTF-8 byte 0x80 in middle.
        fs::write(&file_path, vec![b'H', b'i', b' ', 0x80, b'!']).unwrap();

        let content = read_file(path_str).await.unwrap();
        assert!(content.contains("Hi "));
    }

    #[tokio::test]
    async fn test_read_file_utf16_bom() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("utf16.txt");
        let path_str = file_path.to_string_lossy().to_string();

        let mut bytes = vec![0xFF, 0xFE]; // UTF-16 LE BOM
        for unit in "Hello".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        fs::write(&file_path, bytes).unwrap();

        let content = read_file(path_str).await.unwrap();
        assert_eq!(content, "Hello");
    }

    #[cfg(windows)]
    #[test]
    fn test_normalize_path_short() {
        let path = "C:\\Users\\test\\file.txt";
        let normalized = normalize_path(path);
        assert_eq!(normalized, PathBuf::from(path));
    }

    #[cfg(windows)]
    #[test]
    fn test_normalize_path_long() {
        let long_path = format!("C:\\Users\\test\\{}", "a".repeat(250));
        let normalized = normalize_path(&long_path);
        assert!(normalized.to_string_lossy().starts_with("\\\\?\\"));
    }
}
