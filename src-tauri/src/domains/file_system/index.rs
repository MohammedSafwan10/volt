//! Scalable workspace file indexing for 500K+ files
//!
//! Uses the `ignore` crate for fast filesystem walking with gitignore support.
//! Streams results to the frontend in batches for responsive Quick Open.

use crate::observability::{debug_log, DebugScope};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

/// Indexed file entry
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedFile {
    /// File name
    pub name: String,
    /// Full path
    pub path: String,
    /// Relative path from project root
    pub relative_path: String,
    /// Parent directory name (relative)
    pub parent_dir: String,
    /// Whether this is a directory
    pub is_dir: bool,
}

/// Index status
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub indexing: bool,
    pub count: usize,
    pub root_path: Option<String>,
}

/// Batch of indexed files sent to frontend
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexChunkEvent {
    pub request_id: u64,
    pub files: Vec<IndexedFile>,
    pub total_count: usize,
    pub done: bool,
}

/// Index completion event
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDoneEvent {
    pub request_id: u64,
    pub total_count: usize,
    pub cancelled: bool,
    pub duration_ms: u64,
}

/// Index error event
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct IndexErrorEvent {
    pub request_id: u64,
    pub message: String,
}

/// Cached index for a workspace
#[derive(Clone, Debug, Serialize, Deserialize)]
struct CachedIndex {
    /// Timestamp when cache was created
    timestamp: u64,
    /// Root path this cache is for
    root_path: String,
    /// Indexed files
    files: Vec<IndexedFile>,
}

/// File index manager state
#[derive(Clone)]
pub struct FileIndexState {
    /// Current indexing request ID (0 = no active indexing)
    current_request_id: Arc<AtomicU64>,
    /// Flag to signal cancellation
    cancelled: Arc<AtomicBool>,
    /// In-memory cache per workspace root
    cache: Arc<Mutex<HashMap<String, CachedIndex>>>,
}

impl Default for FileIndexState {
    fn default() -> Self {
        Self {
            current_request_id: Arc::new(AtomicU64::new(0)),
            cancelled: Arc::new(AtomicBool::new(false)),
            cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// Index error types
#[derive(Clone, Debug, Serialize, thiserror::Error)]
#[serde(tag = "type")]
#[allow(dead_code)]
pub enum IndexError {
    #[error("Invalid path: {path}")]
    InvalidPath { path: String },

    #[error("Indexing cancelled")]
    Cancelled,

    #[error("I/O error: {message}")]
    IoError { message: String },
}

impl From<std::io::Error> for IndexError {
    fn from(err: std::io::Error) -> Self {
        IndexError::IoError {
            message: err.to_string(),
        }
    }
}

/// Get current timestamp in seconds
fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Cache validity duration (5 minutes)
const CACHE_VALIDITY_SECS: u64 = 300;

/// Disk cache validity duration (1 day)
const DISK_CACHE_VALIDITY_SECS: u64 = 60 * 60 * 24;

/// Maximum files to cache in memory. The renderer no longer owns the full index,
/// so the backend can keep a substantially larger cache without UI jank.
const MAX_CACHE_FILES: usize = 1_000_000;

/// Maximum files to persist to disk
const MAX_DISK_CACHE_FILES: usize = 1_000_000;

/// Disk cache format version
const DISK_CACHE_VERSION: u32 = 3;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiskCacheMeta {
    version: u32,
    timestamp: u64,
    root_path: String,
    count: usize,
}

fn cache_key_for_root(root_path: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    root_path.hash(&mut hasher);
    hasher.finish()
}

fn get_disk_cache_dir(app: &AppHandle) -> Result<PathBuf, IndexError> {
    app.path()
        .app_cache_dir()
        .map_err(|e| IndexError::IoError {
            message: e.to_string(),
        })
        .map(|p| p.join("file-index"))
}

fn join_root_relative(root: &std::path::Path, relative_path: &str) -> PathBuf {
    relative_path
        .split('/')
        .filter(|p| !p.is_empty())
        .fold(root.to_path_buf(), |acc, part| acc.join(part))
}

fn strip_windows_long_path_prefix(path: String) -> String {
    #[cfg(windows)]
    {
        path.strip_prefix("\\\\?\\").unwrap_or(&path).to_string()
    }

    #[cfg(not(windows))]
    {
        path
    }
}

fn normalize_relative_path(path: &str) -> String {
    path.replace('\\', "/").trim_start_matches("./").to_string()
}

fn should_ignore_relative_path(relative_path: &str) -> bool {
    let normalized = normalize_relative_path(relative_path).to_lowercase();
    normalized.split('/').any(|part| {
        matches!(
            part,
            "node_modules" | ".git" | ".next" | "dist" | "target" | "build" | "out"
        )
    })
}

fn get_parent_dir(relative_path: &str) -> String {
    PathBuf::from(relative_path)
        .parent()
        .map(|parent| parent.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default()
}

fn camel_boundaries(name: &str) -> Vec<usize> {
    let chars: Vec<char> = name.chars().collect();
    if chars.is_empty() {
        return Vec::new();
    }

    let mut boundaries = vec![0];
    for i in 1..chars.len() {
        let ch = chars[i];
        let prev = chars[i - 1];
        let next = chars.get(i + 1).copied().unwrap_or('\0');

        if (ch.is_ascii_uppercase() && prev.is_ascii_lowercase())
            || (ch.is_ascii_uppercase() && prev.is_ascii_uppercase() && next.is_ascii_lowercase())
        {
            boundaries.push(i);
        }
    }
    boundaries
}

fn matches_camel_case(query: &str, name: &str) -> bool {
    let query_chars: Vec<char> = query.chars().collect();
    let name_chars: Vec<char> = name.chars().collect();
    if query_chars.is_empty() || query_chars.len() > name_chars.len() {
        return false;
    }

    let boundaries = camel_boundaries(name);
    if boundaries.len() < query_chars.len() {
        return false;
    }

    let mut matched = 0usize;
    for boundary in boundaries {
        if matched >= query_chars.len() {
            break;
        }
        if name_chars.get(boundary) == Some(&query_chars[matched]) {
            matched += 1;
        }
    }

    matched == query_chars.len()
}

fn matches_path_segments(query: &str, segments: &[String]) -> i32 {
    let parts: Vec<&str> = query
        .split(|c: char| c == '/' || c == '\\' || c.is_whitespace())
        .filter(|part| !part.is_empty())
        .collect();
    if parts.is_empty() {
        return 0;
    }

    let mut score = 0i32;
    let mut segment_idx = 0usize;

    for part in parts {
        let mut found = false;
        for idx in segment_idx..segments.len() {
            let segment = &segments[idx];
            if segment.starts_with(part) {
                score += 50 + ((part.len() as f32 / segment.len().max(1) as f32) * 30.0) as i32;
                segment_idx = idx + 1;
                found = true;
                break;
            }
            if segment.contains(part) {
                score += 20 + ((part.len() as f32 / segment.len().max(1) as f32) * 10.0) as i32;
                segment_idx = idx + 1;
                found = true;
                break;
            }
        }
        if !found {
            return 0;
        }
    }

    score
}

fn fuzzy_score(query: &str, file: &IndexedFile) -> i32 {
    let name_lower = file.name.to_lowercase();
    let path_lower = file.relative_path.to_lowercase();

    if name_lower == query {
        return 1000;
    }

    if name_lower.starts_with(query) {
        let length_bonus = (100i32 - ((name_lower.len() as i32 - query.len() as i32) * 2)).max(0);
        return 800 + length_bonus;
    }

    if query.len() >= 2 && matches_camel_case(query, &name_lower) {
        let length_bonus = (80i32 - (name_lower.len() as i32 - query.len() as i32)).max(0);
        return 700 + length_bonus;
    }

    if let Some(idx) = name_lower.find(query) {
        let position_bonus = (50i32 - (idx as i32 * 5)).max(0);
        let length_bonus = ((query.len() as f32 / name_lower.len().max(1) as f32) * 50.0) as i32;
        return 500 + position_bonus + length_bonus;
    }

    let path_segments_lower: Vec<String> = path_lower
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| segment.to_string())
        .collect();
    let segment_score = matches_path_segments(query, &path_segments_lower);
    if segment_score > 0 {
        return 300 + segment_score;
    }

    if path_lower.contains(query) {
        let length_bonus = ((query.len() as f32 / path_lower.len().max(1) as f32) * 100.0) as i32;
        return 200 + length_bonus;
    }

    let name_chars: Vec<char> = name_lower.chars().collect();
    let query_chars: Vec<char> = query.chars().collect();
    let boundaries = camel_boundaries(&file.name);
    let mut query_idx = 0usize;
    let mut score = 0i32;
    let mut consecutive_bonus = 0i32;
    let mut last_match_idx: Option<usize> = None;

    for (idx, ch) in name_chars.iter().enumerate() {
        if query_idx >= query_chars.len() {
            break;
        }
        if *ch == query_chars[query_idx] {
            score += 10 + consecutive_bonus;
            consecutive_bonus += 5;

            let prev = idx.checked_sub(1).and_then(|i| name_chars.get(i)).copied();
            if idx == 0 || boundaries.contains(&idx) || prev == Some('_') || prev == Some('-') {
                score += 15;
            }

            if let Some(last_idx) = last_match_idx {
                if idx.saturating_sub(last_idx) > 3 {
                    score -= ((idx - last_idx - 3) as i32) * 2;
                }
            }

            last_match_idx = Some(idx);
            query_idx += 1;
        } else {
            consecutive_bonus = 0;
        }
    }

    if query_idx < query_chars.len() {
        return -1;
    }

    score.min(199)
}

fn clear_root_disk_cache(app: &AppHandle, root_path: &str) {
    if let Ok((meta_path, list_path)) = get_disk_cache_paths(app, root_path) {
        let _ = std::fs::remove_file(meta_path);
        let _ = std::fs::remove_file(list_path);
    }
}

fn upsert_cached_file(
    cached: &mut CachedIndex,
    absolute_path: &str,
    relative_path: &str,
    is_dir: bool,
) {
    if should_ignore_relative_path(relative_path) {
        cached.files.retain(|file| file.path != absolute_path);
        cached.timestamp = current_timestamp();
        return;
    }

    let name = PathBuf::from(relative_path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let updated = IndexedFile {
        name,
        path: absolute_path.to_string(),
        relative_path: relative_path.to_string(),
        parent_dir: get_parent_dir(relative_path),
        is_dir,
    };

    if let Some(existing) = cached
        .files
        .iter_mut()
        .find(|file| file.path == absolute_path)
    {
        *existing = updated;
    } else {
        cached.files.push(updated);
    }
    cached.timestamp = current_timestamp();
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SearchKind {
    All,
    Files,
    Directories,
}

impl SearchKind {
    fn from_option(value: Option<&str>) -> Self {
        match value.unwrap_or("all").to_ascii_lowercase().as_str() {
            "file" | "files" => Self::Files,
            "directory" | "directories" | "dirs" => Self::Directories,
            _ => Self::All,
        }
    }

    fn matches(self, file: &IndexedFile) -> bool {
        match self {
            Self::All => true,
            Self::Files => !file.is_dir,
            Self::Directories => file.is_dir,
        }
    }
}

fn get_disk_cache_paths(
    app: &AppHandle,
    root_path: &str,
) -> Result<(PathBuf, PathBuf), IndexError> {
    let base = get_disk_cache_dir(app)?;

    let key = cache_key_for_root(root_path);
    let meta_path = base.join(format!("index_{key}.meta.json"));
    let list_path = base.join(format!("index_{key}.files.txt"));
    Ok((meta_path, list_path))
}

fn load_disk_cache_stream(
    app: &AppHandle,
    root_path: &str,
    request_id: u64,
    cancelled: &AtomicBool,
    current_id: &AtomicU64,
    cache: &Arc<Mutex<HashMap<String, CachedIndex>>>,
) -> Result<Option<usize>, IndexError> {
    use std::fs;
    use std::io::{BufRead, BufReader};

    let (meta_path, list_path) = get_disk_cache_paths(app, root_path)?;
    if !meta_path.exists() || !list_path.exists() {
        return Ok(None);
    }

    let meta_bytes = match fs::read(&meta_path) {
        Ok(b) => b,
        Err(_) => return Ok(None),
    };

    let meta: DiskCacheMeta = match serde_json::from_slice(&meta_bytes) {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };

    // Skip if version mismatch, path mismatch, or empty cache (likely corrupted)
    if meta.version != DISK_CACHE_VERSION || meta.root_path != root_path || meta.count == 0 {
        return Ok(None);
    }

    let now = current_timestamp();
    if now.saturating_sub(meta.timestamp) > DISK_CACHE_VALIDITY_SECS {
        return Ok(None);
    }

    let root = PathBuf::from(root_path);
    let file = match fs::File::open(&list_path) {
        Ok(f) => f,
        Err(_) => return Ok(None),
    };

    const BATCH_SIZE: usize = 500;
    let mut batch: Vec<IndexedFile> = Vec::with_capacity(BATCH_SIZE);
    let mut cached_files: Vec<IndexedFile> = Vec::new();
    let mut total_count = 0usize;

    for line in BufReader::new(file).lines() {
        if cancelled.load(Ordering::Relaxed) || current_id.load(Ordering::Relaxed) != request_id {
            let _ = app.emit(
                "file-index://done",
                IndexDoneEvent {
                    request_id,
                    total_count,
                    cancelled: true,
                    duration_ms: 0,
                },
            );
            return Ok(Some(total_count));
        }

        let relative_path = match line {
            Ok(l) => l,
            Err(_) => continue,
        };

        if relative_path.trim().is_empty() {
            continue;
        }

        let (is_dir, relative_path) = if let Some((kind, raw_path)) = relative_path.split_once('\t')
        {
            (kind == "D", normalize_relative_path(raw_path))
        } else {
            (false, normalize_relative_path(&relative_path))
        };

        let name = PathBuf::from(&relative_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let parent_dir = get_parent_dir(&relative_path);

        let full_path = join_root_relative(&root, &relative_path);
        let path_str = strip_windows_long_path_prefix(full_path.to_string_lossy().to_string());

        if should_ignore_relative_path(&relative_path) {
            continue;
        }

        let indexed = IndexedFile {
            name,
            path: path_str,
            relative_path,
            parent_dir,
            is_dir,
        };
        batch.push(indexed.clone());
        cached_files.push(indexed);
        total_count += 1;

        if batch.len() >= BATCH_SIZE {
            let _ = app.emit(
                "file-index://chunk",
                IndexChunkEvent {
                    request_id,
                    files: std::mem::take(&mut batch),
                    total_count,
                    done: false,
                },
            );
        }
    }

    if !batch.is_empty() {
        let _ = app.emit(
            "file-index://chunk",
            IndexChunkEvent {
                request_id,
                files: batch,
                total_count,
                done: false,
            },
        );
    }

    let _ = app.emit(
        "file-index://done",
        IndexDoneEvent {
            request_id,
            total_count,
            cancelled: false,
            duration_ms: 0,
        },
    );

    if !cached_files.is_empty() {
        let mut cache_guard = cache.lock().unwrap();
        cache_guard.insert(
            root_path.to_string(),
            CachedIndex {
                timestamp: current_timestamp(),
                root_path: root_path.to_string(),
                files: cached_files,
            },
        );
    }

    Ok(Some(total_count))
}

/// Start indexing a workspace with streaming results
///
/// Emits:
/// - `file-index://chunk` (IndexChunkEvent) - batches of files
/// - `file-index://done` (IndexDoneEvent) - completion
/// - `file-index://error` (IndexErrorEvent) - errors
#[tauri::command]
pub async fn index_workspace_stream(
    state: tauri::State<'_, FileIndexState>,
    app: AppHandle,
    root_path: String,
    request_id: u64,
    use_cache: bool,
) -> Result<(), IndexError> {
    let scope = DebugScope::new(
        "file-index",
        format!("request={request_id} root={root_path} use_cache={use_cache}"),
    );
    if root_path.is_empty() {
        return Err(IndexError::InvalidPath { path: root_path });
    }

    let path = PathBuf::from(&root_path);
    if !path.exists() || !path.is_dir() {
        return Err(IndexError::InvalidPath { path: root_path });
    }

    // Normalize root path for consistent prefix stripping on Windows
    let path = if cfg!(windows) {
        let p_str = path.to_string_lossy().to_string();
        PathBuf::from(strip_windows_long_path_prefix(p_str))
    } else {
        path
    };

    // Cancel any previous indexing
    state.cancelled.store(true, Ordering::SeqCst);

    // Small delay to let previous task notice cancellation
    tokio::time::sleep(Duration::from_millis(10)).await;

    // Set new request ID and reset cancellation flag
    state.current_request_id.store(request_id, Ordering::SeqCst);
    state.cancelled.store(false, Ordering::SeqCst);

    // Check cache first
    if use_cache {
        let cache_guard = state.cache.lock().unwrap();
        if let Some(cached) = cache_guard.get(&root_path) {
            let now = current_timestamp();
            // Skip empty caches (likely corrupted or from interrupted indexing)
            if now - cached.timestamp < CACHE_VALIDITY_SECS
                && cached.root_path == root_path
                && !cached.files.is_empty()
            {
                scope.checkpoint(format!("served memory cache count={}", cached.files.len()));
                // Send cached results immediately
                let files = cached.files.clone();
                drop(cache_guard);

                let total = files.len();

                // Send in batches for consistency
                const BATCH_SIZE: usize = 500;
                for chunk in files.chunks(BATCH_SIZE) {
                    let _ = app.emit(
                        "file-index://chunk",
                        IndexChunkEvent {
                            request_id,
                            files: chunk.to_vec(),
                            total_count: total,
                            done: false,
                        },
                    );
                }

                let _ = app.emit(
                    "file-index://done",
                    IndexDoneEvent {
                        request_id,
                        total_count: total,
                        cancelled: false,
                        duration_ms: 0, // Instant from cache
                    },
                );

                return Ok(());
            }
        }
    }

    // Check disk cache next (persistent across restarts)
    if use_cache {
        // Stream from disk cache without loading everything into memory.
        if let Ok(Some(_count)) = load_disk_cache_stream(
            &app,
            &root_path,
            request_id,
            &state.cancelled,
            &state.current_request_id,
            &state.cache,
        ) {
            scope.checkpoint("served disk cache");
            return Ok(());
        }
    }

    // Run indexing in blocking task
    let cancelled = state.cancelled.clone();
    let current_id = state.current_request_id.clone();
    let cache = state.cache.clone();
    let root_path_clone = root_path.clone();
    let persist_cache = use_cache;

    tokio::task::spawn_blocking(move || {
        debug_log(
            "file-index",
            format!("spawn_blocking begin request={request_id} root={root_path_clone}"),
        );
        use std::fs;
        use std::io::{BufWriter, Write};

        let start = Instant::now();
        let mut memory_files: Vec<IndexedFile> = Vec::new();
        let mut batch: Vec<IndexedFile> = Vec::new();
        let mut total_count = 0usize;

        {
            let mut cache_guard = cache.lock().unwrap();
            cache_guard.insert(
                root_path_clone.clone(),
                CachedIndex {
                    timestamp: current_timestamp(),
                    root_path: root_path_clone.clone(),
                    files: Vec::new(),
                },
            );
        }

        // Prepare disk cache writer (best-effort). Write incrementally to avoid huge memory usage.
        let (meta_path, list_path, list_tmp_path, mut disk_writer): (
            Option<PathBuf>,
            Option<PathBuf>,
            Option<PathBuf>,
            Option<BufWriter<fs::File>>,
        ) = if persist_cache {
            match get_disk_cache_paths(&app, &root_path_clone) {
                Ok((meta_path, list_path)) => {
                    let base_dir = meta_path.parent().map(|p| p.to_path_buf());
                    if let Some(dir) = base_dir {
                        let _ = fs::create_dir_all(dir);
                    }
                    let tmp = list_path.with_extension("tmp");
                    match fs::File::create(&tmp) {
                        Ok(f) => (
                            Some(meta_path),
                            Some(list_path),
                            Some(tmp),
                            Some(BufWriter::new(f)),
                        ),
                        Err(_) => (Some(meta_path), Some(list_path), Some(tmp), None),
                    }
                }
                Err(_) => (None, None, None, None),
            }
        } else {
            (None, None, None, None)
        };

        const BATCH_SIZE: usize = 200;
        const BATCH_MAX_LATENCY: Duration = Duration::from_millis(50);
        let mut last_emit = Instant::now();

        // Build walker with gitignore support
        let mut builder = WalkBuilder::new(&path);
        builder
            .hidden(false) // Include hidden files (user may want .env, etc.)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .ignore(true)
            .parents(true)
            .follow_links(false)
            .max_depth(None); // No depth limit

        builder.filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            if name == "node_modules"
                || name == ".git"
                || name == ".next"
                || name == "dist"
                || name == "target"
                || name == "build"
                || name == "out"
                || name == ".DS_Store"
            {
                return false; // Skip this and all descendants
            }
            true
        });

        let walker = builder.build();

        for entry in walker {
            // Check for cancellation
            if cancelled.load(Ordering::Relaxed) || current_id.load(Ordering::Relaxed) != request_id
            {
                debug_log(
                    "file-index",
                    format!(
                        "cancelled request={request_id} root={} count={total_count}",
                        root_path_clone
                    ),
                );
                if let Some(tmp) = list_tmp_path.as_ref() {
                    let _ = fs::remove_file(tmp);
                }
                let _ = app.emit(
                    "file-index://done",
                    IndexDoneEvent {
                        request_id,
                        total_count,
                        cancelled: true,
                        duration_ms: start.elapsed().as_millis() as u64,
                    },
                );
                return;
            }

            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };

            // The filter_entry above already handles pruning directories.
            // This is an extra safety check for the current entry.
            let name = entry.file_name().to_string_lossy();
            if name == ".DS_Store" {
                continue;
            }

            // Index both files and directories
            let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);

            let entry_path = entry.path();
            let path_str = strip_windows_long_path_prefix(entry_path.to_string_lossy().to_string());

            let name = entry_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();

            // Calculate relative path
            let relative_path = entry_path
                .strip_prefix(&path)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| path_str.clone());

            // Normalize path separators for display
            let relative_path = normalize_relative_path(&relative_path);
            if relative_path.is_empty() || should_ignore_relative_path(&relative_path) {
                continue;
            }

            // Get parent directory
            let parent_dir = get_parent_dir(&relative_path);

            let indexed_file = IndexedFile {
                name,
                path: path_str,
                relative_path,
                parent_dir,
                is_dir,
            };

            // Stream to UI
            batch.push(indexed_file.clone());

            // Best-effort in-memory cache (bounded)
            if total_count < MAX_CACHE_FILES {
                memory_files.push(indexed_file.clone());
            }

            // Best-effort disk cache (bounded)
            if total_count < MAX_DISK_CACHE_FILES {
                if let Some(w) = disk_writer.as_mut() {
                    let kind = if indexed_file.is_dir { "D" } else { "F" };
                    let _ = writeln!(w, "{kind}\t{}", indexed_file.relative_path);
                }
            }

            total_count += 1;

            // Emit batch when full or after timeout
            if batch.len() >= BATCH_SIZE || last_emit.elapsed() >= BATCH_MAX_LATENCY {
                if app
                    .emit(
                        "file-index://chunk",
                        IndexChunkEvent {
                            request_id,
                            files: std::mem::take(&mut batch),
                            total_count,
                            done: false,
                        },
                    )
                    .is_err()
                {
                    return;
                }

                if total_count <= MAX_CACHE_FILES {
                    let mut cache_guard = cache.lock().unwrap();
                    if let Some(cached) = cache_guard.get_mut(&root_path_clone) {
                        cached
                            .files
                            .extend(memory_files.iter().skip(cached.files.len()).cloned());
                        cached.timestamp = current_timestamp();
                    }
                }
                last_emit = Instant::now();
            }
        }

        // Emit remaining files
        if !batch.is_empty()
            && app
                .emit(
                    "file-index://chunk",
                    IndexChunkEvent {
                        request_id,
                        files: batch,
                        total_count,
                        done: false,
                    },
                )
                .is_err()
        {
            return;
        }

        // Update in-memory cache only if it is complete.
        if total_count > 0 && total_count <= MAX_CACHE_FILES {
            let mut cache_guard = cache.lock().unwrap();
            cache_guard.insert(
                root_path_clone.clone(),
                CachedIndex {
                    timestamp: current_timestamp(),
                    root_path: root_path_clone.clone(),
                    files: memory_files,
                },
            );
        } else {
            let mut cache_guard = cache.lock().unwrap();
            cache_guard.remove(&root_path_clone);
        }

        // Finalize disk cache (best-effort) only if not cancelled.
        if !cancelled.load(Ordering::Relaxed) && current_id.load(Ordering::Relaxed) == request_id {
            if let (Some(meta_path), Some(list_path), Some(list_tmp_path)) =
                (meta_path, list_path, list_tmp_path)
            {
                // If we exceeded the disk cache cap, skip persisting.
                if total_count > 0 && total_count <= MAX_DISK_CACHE_FILES {
                    if let Some(mut w) = disk_writer {
                        let _ = w.flush();
                    }

                    let _ = fs::rename(&list_tmp_path, &list_path);

                    let meta = DiskCacheMeta {
                        version: DISK_CACHE_VERSION,
                        timestamp: current_timestamp(),
                        root_path: root_path_clone.clone(),
                        count: total_count,
                    };

                    let _ = fs::write(&meta_path, serde_json::to_vec(&meta).unwrap_or_default());
                } else {
                    let _ = fs::remove_file(&list_tmp_path);
                    let _ = fs::remove_file(&meta_path);
                }
            }
        }

        // Emit completion
        let _ = app.emit(
            "file-index://done",
            IndexDoneEvent {
                request_id,
                total_count,
                cancelled: false,
                duration_ms: start.elapsed().as_millis() as u64,
            },
        );
        debug_log(
            "file-index",
            format!(
                "finished request={request_id} root={} count={total_count} duration_ms={}",
                root_path_clone,
                start.elapsed().as_millis()
            ),
        );
    });

    Ok(())
}

/// Cancel the current indexing operation
#[tauri::command]
pub async fn cancel_index_workspace(
    state: tauri::State<'_, FileIndexState>,
    request_id: u64,
) -> Result<(), IndexError> {
    let current = state.current_request_id.load(Ordering::SeqCst);
    if current == request_id || request_id == 0 {
        state.cancelled.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// Clear the index cache for a workspace
#[tauri::command]
pub async fn clear_index_cache(
    state: tauri::State<'_, FileIndexState>,
    app: AppHandle,
    root_path: Option<String>,
) -> Result<(), IndexError> {
    let mut cache_guard = state.cache.lock().unwrap();
    if let Some(path) = root_path {
        cache_guard.remove(&path);

        // Best-effort remove disk cache for this root
        clear_root_disk_cache(&app, &path);
    } else {
        cache_guard.clear();

        // Best-effort clear disk cache directory
        if let Ok(dir) = get_disk_cache_dir(&app) {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn search_indexed_files(
    state: tauri::State<'_, FileIndexState>,
    root_path: String,
    query: String,
    recent_paths: Vec<String>,
    limit: Option<usize>,
    kind: Option<String>,
) -> Result<Vec<IndexedFile>, IndexError> {
    let search_kind = SearchKind::from_option(kind.as_deref());
    let capped_limit = limit.unwrap_or(50).clamp(1, 200);
    let recent_set: HashSet<String> = recent_paths.iter().cloned().collect();

    let cache_guard = state.cache.lock().unwrap();
    let Some(cached) = cache_guard.get(&root_path) else {
        return Ok(Vec::new());
    };

    let trimmed_query = query.trim();
    if trimmed_query.is_empty() {
        let mut results: Vec<IndexedFile> = Vec::new();
        let mut seen = HashSet::new();

        for recent_path in &recent_paths {
            if let Some(file) = cached.files.iter().find(|file| file.path == *recent_path) {
                if search_kind.matches(file) && !should_ignore_relative_path(&file.relative_path) {
                    seen.insert(file.path.clone());
                    results.push(file.clone());
                }
            }
        }

        for file in &cached.files {
            if results.len() >= capped_limit {
                break;
            }
            if seen.contains(&file.path)
                || !search_kind.matches(file)
                || should_ignore_relative_path(&file.relative_path)
            {
                continue;
            }
            if search_kind == SearchKind::All && file.is_dir {
                continue;
            }
            results.push(file.clone());
        }

        return Ok(results);
    }

    let query_lower = trimmed_query.to_lowercase();
    let mut ranked: Vec<(IndexedFile, i32)> = cached
        .files
        .iter()
        .filter(|file| {
            search_kind.matches(file) && !should_ignore_relative_path(&file.relative_path)
        })
        .filter_map(|file| {
            let mut score = fuzzy_score(&query_lower, file);
            if score <= 0 {
                return None;
            }
            if recent_set.contains(&file.path) {
                score += 100;
            }
            Some((file.clone(), score))
        })
        .collect();

    ranked.sort_by(|(left_file, left_score), (right_file, right_score)| {
        right_score
            .cmp(left_score)
            .then_with(|| left_file.is_dir.cmp(&right_file.is_dir))
            .then_with(|| {
                left_file
                    .relative_path
                    .len()
                    .cmp(&right_file.relative_path.len())
            })
            .then_with(|| left_file.relative_path.cmp(&right_file.relative_path))
    });

    Ok(ranked
        .into_iter()
        .take(capped_limit)
        .map(|(file, _)| file)
        .collect())
}

#[tauri::command]
pub async fn upsert_indexed_file(
    state: tauri::State<'_, FileIndexState>,
    app: AppHandle,
    root_path: String,
    absolute_path: String,
    relative_path: String,
    is_dir: bool,
) -> Result<(), IndexError> {
    let normalized_relative = normalize_relative_path(&relative_path);
    let mut cache_guard = state.cache.lock().unwrap();
    let Some(cached) = cache_guard.get_mut(&root_path) else {
        return Ok(());
    };
    upsert_cached_file(cached, &absolute_path, &normalized_relative, is_dir);
    drop(cache_guard);
    clear_root_disk_cache(&app, &root_path);
    Ok(())
}

#[tauri::command]
pub async fn remove_indexed_file(
    state: tauri::State<'_, FileIndexState>,
    app: AppHandle,
    root_path: String,
    absolute_path: String,
) -> Result<(), IndexError> {
    let mut cache_guard = state.cache.lock().unwrap();
    if let Some(cached) = cache_guard.get_mut(&root_path) {
        cached.files.retain(|file| file.path != absolute_path);
        cached.timestamp = current_timestamp();
    }
    drop(cache_guard);
    clear_root_disk_cache(&app, &root_path);
    Ok(())
}

#[tauri::command]
pub async fn rename_indexed_file(
    state: tauri::State<'_, FileIndexState>,
    app: AppHandle,
    root_path: String,
    old_absolute_path: String,
    new_absolute_path: String,
    new_relative_path: String,
    is_dir: bool,
) -> Result<(), IndexError> {
    let normalized_relative = normalize_relative_path(&new_relative_path);
    let mut cache_guard = state.cache.lock().unwrap();
    if let Some(cached) = cache_guard.get_mut(&root_path) {
        cached.files.retain(|file| file.path != old_absolute_path);
        upsert_cached_file(cached, &new_absolute_path, &normalized_relative, is_dir);
    }
    drop(cache_guard);
    clear_root_disk_cache(&app, &root_path);
    Ok(())
}

/// Get index status
#[tauri::command]
pub async fn get_index_status(
    state: tauri::State<'_, FileIndexState>,
    root_path: String,
) -> Result<IndexStatus, IndexError> {
    let current_id = state.current_request_id.load(Ordering::SeqCst);
    let indexing = current_id != 0 && !state.cancelled.load(Ordering::SeqCst);

    let cache_guard = state.cache.lock().unwrap();
    let count = cache_guard
        .get(&root_path)
        .map(|c| c.files.len())
        .unwrap_or(0);

    Ok(IndexStatus {
        indexing,
        count,
        root_path: if count > 0 { Some(root_path) } else { None },
    })
}
