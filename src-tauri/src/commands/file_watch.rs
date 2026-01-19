//! Workspace file watching for incremental index updates
//!
//! Uses the `notify` crate with a small debounce window to watch for filesystem
//! changes and emit batched events to the frontend.

use notify::{event::ModifyKind, recommended_watcher, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// File change event sent to frontend
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeEvent {
    /// Type of change: "create", "delete", "rename", "modify"
    pub kind: String,
    /// Affected file paths (relative to workspace root)
    pub paths: Vec<String>,
    /// Full absolute paths
    pub absolute_paths: Vec<String>,
    /// Workspace root this event belongs to
    pub workspace_root: String,
}

/// Batch of file changes (debounced)
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeBatchEvent {
    /// All changes in this batch
    pub changes: Vec<FileChangeEvent>,
    /// Workspace root
    pub workspace_root: String,
    /// Number of changes in batch (for UI to decide if full rescan needed)
    pub total_changes: usize,
}

/// File watcher state
pub struct FileWatchState {
    /// Active watchers per workspace root
    watchers: Arc<Mutex<HashMap<String, WatcherHandle>>>,
}

struct WatcherHandle {
    /// Hold the watcher so it stays alive
    _watcher: RecommendedWatcher,
}

impl Default for FileWatchState {
    fn default() -> Self {
        Self {
            watchers: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// Error types for file watching
#[derive(Clone, Debug, Serialize, thiserror::Error)]
#[serde(tag = "type")]
pub enum WatchError {
    #[error("Invalid path: {path}")]
    InvalidPath { path: String },

    #[error("Watcher error: {message}")]
    WatcherError { message: String },

    #[error("Already watching: {path}")]
    AlreadyWatching { path: String },

    #[error("Not watching: {path}")]
    NotWatching { path: String },
}

impl From<notify::Error> for WatchError {
    fn from(err: notify::Error) -> Self {
        WatchError::WatcherError {
            message: err.to_string(),
        }
    }
}

/// Patterns to ignore completely when watching
const IGNORE_PATTERNS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".svelte-kit",
    ".next",
    ".nuxt",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    "coverage",
    ".nyc_output",
    ".turbo",
    ".vercel",
    ".netlify",
];

/// Git subdirectories to ignore (internal/noisy)
const GIT_IGNORE_SUBDIRS: &[&str] = &["objects", "hooks", "logs", "info"];

/// Check if a path should be ignored
fn should_ignore_path(path: &std::path::Path) -> bool {
    let mut in_git = false;
    for component in path.components() {
        if let std::path::Component::Normal(name) = component {
            let name_str = name.to_string_lossy();

            // Check global ignore patterns
            for pattern in IGNORE_PATTERNS {
                if name_str == *pattern {
                    return true;
                }
            }

            // Nuanced Git handling
            if name_str == ".git" {
                in_git = true;
                continue;
            }

            if in_git {
                // If we are inside .git, ignore large/noisy subdirs
                for pattern in GIT_IGNORE_SUBDIRS {
                    if name_str == *pattern {
                        return true;
                    }
                }
                // Allow anything else inside .git (index, HEAD, refs, etc.)
                // This is shallow - we want to watch files directly in .git or in refs/
                return false;
            }
        }
    }
    false
}

/// Resolve symlinks to get the canonical path, handling errors gracefully
/// Returns the original path if symlink resolution fails
fn resolve_symlink(path: &std::path::Path) -> PathBuf {
    // Try to resolve symlinks; fall back to original path on error
    // This handles broken symlinks, permission issues, and circular links
    match path.canonicalize() {
        Ok(resolved) => resolved,
        Err(_) => path.to_path_buf(),
    }
}

/// Check if a path is a symlink
fn is_symlink(path: &std::path::Path) -> bool {
    path.symlink_metadata()
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// Strip Windows long path prefix if present
fn strip_windows_prefix(path: &str) -> String {
    #[cfg(windows)]
    {
        path.strip_prefix("\\\\?\\").unwrap_or(path).to_string()
    }
    #[cfg(not(windows))]
    {
        path.to_string()
    }
}

/// Get relative path from workspace root
fn get_relative_path(path: &std::path::Path, root: &std::path::Path) -> String {
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string_lossy().to_string())
        .replace('\\', "/")
}

/// Start watching a workspace for file changes
///
/// Emits:
/// - `file-watch://change` (FileChangeBatchEvent) - batched file changes
#[tauri::command]
pub async fn start_file_watch(
    state: tauri::State<'_, FileWatchState>,
    app: AppHandle,
    workspace_root: String,
) -> Result<(), WatchError> {
    let root_path = PathBuf::from(&workspace_root);

    if !root_path.exists() || !root_path.is_dir() {
        return Err(WatchError::InvalidPath {
            path: workspace_root,
        });
    }

    // Check if already watching
    {
        let watchers = state
            .watchers
            .lock()
            .map_err(|_| WatchError::WatcherError {
                message: "Watcher state lock poisoned".to_string(),
            })?;
        if watchers.contains_key(&workspace_root) {
            return Err(WatchError::AlreadyWatching {
                path: workspace_root,
            });
        }
    }

    let workspace_root_clone = workspace_root.clone();
    let root_for_handler = root_path.clone();
    let app_handle = app.clone();

    // Debounce events in a background thread; this avoids flooding the frontend
    // during bursts (git checkout, npm install, etc.).
    let debounce_window = Duration::from_millis(200);
    let (tx, rx) = mpsc::channel::<Result<notify::Event, notify::Error>>();

    let mut watcher = recommended_watcher(move |res| {
        // Best-effort: if receiver is gone, just drop events.
        let _ = tx.send(res);
    })
    .map_err(|e| WatchError::WatcherError {
        message: e.to_string(),
    })?;

    watcher.watch(&root_path, RecursiveMode::Recursive)?;

    std::thread::spawn(move || {
        let mut buffered: Vec<notify::Event> = Vec::new();

        loop {
            // Block for the first event; exit if sender is dropped.
            let first = match rx.recv() {
                Ok(Ok(ev)) => ev,
                Ok(Err(_e)) => continue,
                Err(_) => break,
            };

            buffered.clear();
            buffered.push(first);

            // Collect until the debounce window passes with no new events.
            loop {
                match rx.recv_timeout(debounce_window) {
                    Ok(Ok(ev)) => buffered.push(ev),
                    Ok(Err(_e)) => continue,
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }

            let mut changes: Vec<FileChangeEvent> = Vec::new();

            for ev in &buffered {
                // Map notify EventKind to our simplified kinds.
                let kind: &str = match &ev.kind {
                    notify::EventKind::Create(_) => "create",
                    notify::EventKind::Remove(_) => "delete",
                    notify::EventKind::Modify(ModifyKind::Name(_)) => "rename",
                    notify::EventKind::Modify(_) => "modify",
                    _ => "modify",
                };

                // We only care about files; ignore directories when we can tell.
                // For delete events, the path often no longer exists.
                let mut rel_paths: Vec<String> = Vec::new();
                let mut abs_paths: Vec<String> = Vec::new();

                for path in &ev.paths {
                    // Resolve symlinks to get the actual target path
                    // This ensures we track the real file, not just the link
                    let resolved_path = if is_symlink(path) {
                        resolve_symlink(path)
                    } else {
                        path.to_path_buf()
                    };

                    if should_ignore_path(&resolved_path) {
                        rel_paths.clear();
                        abs_paths.clear();
                        break;
                    }

                    // Check if it's a directory (using resolved path for symlinks)
                    let is_dir = if resolved_path.exists() {
                        resolved_path.is_dir()
                    } else {
                        // For deleted paths, check the original path metadata if available
                        path.exists() && path.is_dir()
                    };

                    if is_dir {
                        // Skip directory events.
                        rel_paths.clear();
                        abs_paths.clear();
                        break;
                    }

                    // Use the original path for relative path calculation (preserves symlink names)
                    // but use resolved path for absolute path (points to actual file)
                    abs_paths.push(strip_windows_prefix(&path.to_string_lossy()));
                    rel_paths.push(get_relative_path(path, &root_for_handler));
                }

                if rel_paths.is_empty() || abs_paths.is_empty() {
                    continue;
                }

                changes.push(FileChangeEvent {
                    kind: kind.to_string(),
                    paths: rel_paths,
                    absolute_paths: abs_paths,
                    workspace_root: workspace_root_clone.clone(),
                });
            }

            if !changes.is_empty() {
                let total = changes.len();
                let batch = FileChangeBatchEvent {
                    changes,
                    workspace_root: workspace_root_clone.clone(),
                    total_changes: total,
                };

                let _ = app_handle.emit("file-watch://change", batch);
            }
        }
    });

    // Store the watcher handle
    {
        let mut watchers = state
            .watchers
            .lock()
            .map_err(|_| WatchError::WatcherError {
                message: "Watcher state lock poisoned".to_string(),
            })?;
        watchers.insert(workspace_root.clone(), WatcherHandle { _watcher: watcher });
    }

    Ok(())
}

/// Stop watching a workspace
#[tauri::command]
pub async fn stop_file_watch(
    state: tauri::State<'_, FileWatchState>,
    workspace_root: String,
) -> Result<(), WatchError> {
    let mut watchers = state
        .watchers
        .lock()
        .map_err(|_| WatchError::WatcherError {
            message: "Watcher state lock poisoned".to_string(),
        })?;

    if watchers.remove(&workspace_root).is_some() {
        Ok(())
    } else {
        Err(WatchError::NotWatching {
            path: workspace_root,
        })
    }
}

/// Stop all file watchers (called on app shutdown)
#[tauri::command]
pub async fn stop_all_file_watches(
    state: tauri::State<'_, FileWatchState>,
) -> Result<(), WatchError> {
    let mut watchers = state
        .watchers
        .lock()
        .map_err(|_| WatchError::WatcherError {
            message: "Watcher state lock poisoned".to_string(),
        })?;
    watchers.clear();
    Ok(())
}

/// Check if a workspace is being watched
#[tauri::command]
pub async fn is_watching(
    state: tauri::State<'_, FileWatchState>,
    workspace_root: String,
) -> Result<bool, WatchError> {
    let watchers = state
        .watchers
        .lock()
        .map_err(|_| WatchError::WatcherError {
            message: "Watcher state lock poisoned".to_string(),
        })?;
    Ok(watchers.contains_key(&workspace_root))
}
