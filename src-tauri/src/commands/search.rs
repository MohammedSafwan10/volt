use ignore::WalkBuilder;
use globset::{Glob, GlobSet, GlobSetBuilder};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, BufRead, BufReader};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Clone)]
pub struct SearchManagerState {
    current_search_id: Arc<AtomicU64>,
}

impl Default for SearchManagerState {
    fn default() -> Self {
        Self {
            current_search_id: Arc::new(AtomicU64::new(0)),
        }
    }
}

/// Search error types
#[derive(Clone, Debug, Serialize, thiserror::Error)]
#[serde(tag = "type")]
pub enum SearchError {
    #[error("Invalid regex pattern: {message}")]
    InvalidPattern { message: String },

    #[error("Search cancelled")]
    Cancelled,

    #[error("I/O error: {message}")]
    IoError { message: String },

    #[error("Invalid path: {path}")]
    InvalidPath { path: String },

    #[error("Invalid range: {message}")]
    InvalidRange { message: String },
}

impl From<io::Error> for SearchError {
    fn from(err: io::Error) -> Self {
        SearchError::IoError {
            message: err.to_string(),
        }
    }
}

impl From<regex::Error> for SearchError {
    fn from(err: regex::Error) -> Self {
        SearchError::InvalidPattern {
            message: err.to_string(),
        }
    }
}

/// Search options
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    /// Search query (plain text or regex)
    pub query: String,
    /// Root directory to search in
    pub root_path: String,
    /// Case sensitive search
    #[serde(default)]
    pub case_sensitive: bool,
    /// Use regex pattern
    #[serde(default)]
    pub use_regex: bool,
    /// Match whole word only
    #[serde(default)]
    pub whole_word: bool,
    /// Include hidden files
    #[serde(default)]
    pub include_hidden: bool,
    /// File glob patterns to include (e.g., "*.ts", "*.js")
    #[serde(default)]
    pub include_patterns: Vec<String>,
    /// File glob patterns to exclude
    #[serde(default)]
    pub exclude_patterns: Vec<String>,
    /// Maximum number of results (0 = unlimited)
    #[serde(default)]
    pub max_results: usize,

    /// Request id for cancellation/ordering
    #[serde(default)]
    pub request_id: u64,
}

/// A single match within a file
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    /// Line number (1-based)
    pub line: usize,
    /// Column start (0-based)
    pub column_start: usize,
    /// Column end (0-based)
    pub column_end: usize,
    /// The matched text
    pub match_text: String,
    /// The full line content
    pub line_content: String,
}

fn utf16_col(line: &str, byte_index: usize) -> usize {
    // Convert a UTF-8 byte index into a UTF-16 code unit offset.
    // LSP/Monaco columns are UTF-16 based, and JS string slicing uses UTF-16 code units.
    line[..byte_index].encode_utf16().count()
}

fn byte_index_from_utf16(line: &str, utf16_index: usize) -> Option<usize> {
    let mut units = 0usize;
    for (byte_idx, ch) in line.char_indices() {
        if units == utf16_index {
            return Some(byte_idx);
        }
        units += ch.len_utf16();
        if units > utf16_index {
            return None;
        }
    }
    if units == utf16_index {
        Some(line.len())
    } else {
        None
    }
}

/// Search results for a single file
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResult {
    /// File path
    pub path: String,
    /// Matches in this file
    pub matches: Vec<SearchMatch>,
}

/// Overall search results
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    /// Results grouped by file
    pub files: Vec<FileSearchResult>,
    /// Total number of matches
    pub total_matches: usize,
    /// Total number of files with matches
    pub total_files: usize,
    /// Whether the search was truncated due to max_results
    pub truncated: bool,
}

/// Streaming search chunk event
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchChunkEvent {
    pub request_id: u64,
    pub files: Vec<FileSearchResult>,
    pub total_matches: usize,
    pub truncated: bool,
}

/// Streaming search done event
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchDoneEvent {
    pub request_id: u64,
    pub total_matches: usize,
    pub total_files: usize,
    pub truncated: bool,
    pub cancelled: bool,
}

/// Streaming search error event
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchErrorEvent {
    pub request_id: u64,
    pub error: SearchError,
}

/// Build regex pattern from search options
fn build_pattern(options: &SearchOptions) -> Result<Regex, SearchError> {
    let pattern = if options.use_regex {
        options.query.clone()
    } else {
        // Escape special regex characters for literal search
        regex::escape(&options.query)
    };

    let pattern = if options.whole_word {
        format!(r"\b{}\b", pattern)
    } else {
        pattern
    };

    RegexBuilder::new(&pattern)
        .case_insensitive(!options.case_sensitive)
        .build()
        .map_err(SearchError::from)
}

fn build_globset(patterns: &[String]) -> Result<Option<GlobSet>, SearchError> {
    if patterns.is_empty() {
        return Ok(None);
    }

    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        let glob = Glob::new(pattern).map_err(|e| SearchError::InvalidPattern {
            message: e.to_string(),
        })?;
        builder.add(glob);
    }

    let set = builder.build().map_err(|e| SearchError::InvalidPattern {
        message: e.to_string(),
    })?;

    Ok(Some(set))
}

/// Search a single file for matches
fn search_file(
    path: &PathBuf,
    pattern: &Regex,
    max_results: usize,
    current_count: &mut usize,
    current_search_id: Option<Arc<AtomicU64>>,
    request_id: u64,
) -> Result<Option<FileSearchResult>, SearchError> {
    // Skip binary files by checking first few bytes
    let file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return Ok(None), // Skip files we can't open
    };

    let reader = BufReader::new(file);
    let mut matches = Vec::new();
    let path_str = path.to_string_lossy().to_string();

    // Strip \\?\ prefix on Windows for display
    #[cfg(windows)]
    let path_str = path_str
        .strip_prefix("\\\\?\\")
        .unwrap_or(&path_str)
        .to_string();

    for (line_idx, line_result) in reader.lines().enumerate() {
        if let Some(id) = &current_search_id {
            if id.load(Ordering::Relaxed) != request_id {
                return Err(SearchError::Cancelled);
            }
        }

        let line = match line_result {
            Ok(l) => l,
            Err(_) => continue, // Skip lines we can't read (binary content)
        };

        // Check for binary content (null bytes)
        if line.contains('\0') {
            return Ok(None); // Skip binary files
        }

        // Find all matches in this line
        for mat in pattern.find_iter(&line) {
            if max_results > 0 && *current_count >= max_results {
                break;
            }

            matches.push(SearchMatch {
                line: line_idx + 1, // 1-based line numbers
                column_start: utf16_col(&line, mat.start()),
                column_end: utf16_col(&line, mat.end()),
                match_text: mat.as_str().to_string(),
                line_content: line.clone(),
            });

            *current_count += 1;
        }

        if max_results > 0 && *current_count >= max_results {
            break;
        }
    }

    if matches.is_empty() {
        Ok(None)
    } else {
        Ok(Some(FileSearchResult {
            path: path_str,
            matches,
        }))
    }
}

/// Perform workspace search
#[tauri::command]
pub async fn workspace_search(
    state: tauri::State<'_, SearchManagerState>,
    options: SearchOptions,
) -> Result<SearchResults, SearchError> {
    if options.query.is_empty() {
        return Ok(SearchResults {
            files: Vec::new(),
            total_matches: 0,
            total_files: 0,
            truncated: false,
        });
    }

    if options.root_path.is_empty() {
        return Err(SearchError::InvalidPath {
            path: options.root_path,
        });
    }

    let pattern = build_pattern(&options)?;
    let root_path = PathBuf::from(&options.root_path);

    if !root_path.exists() {
        return Err(SearchError::InvalidPath {
            path: options.root_path,
        });
    }

    // Ensure we can cancel in-flight searches by starting a new request_id
    if options.request_id == 0 {
        return Err(SearchError::InvalidRange {
            message: "requestId is required".to_string(),
        });
    }

    state
        .current_search_id
        .store(options.request_id, Ordering::SeqCst);

    // Run search in blocking task to avoid blocking async runtime
    let max_results = if options.max_results == 0 {
        10000 // Default limit to prevent runaway searches
    } else {
        options.max_results
    };

    let include_hidden = options.include_hidden;
    let include_patterns = options.include_patterns.clone();
    let exclude_patterns = options.exclude_patterns.clone();
    let request_id = options.request_id;
    let current_search_id = state.current_search_id.clone();

    tokio::task::spawn_blocking(move || {
        let mut results = Vec::new();
        let mut total_matches = 0usize;
        let truncated = Arc::new(AtomicBool::new(false));

        // Compile include/exclude globs once
        let include_globs = build_globset(&include_patterns)?;
        let exclude_globs = build_globset(&exclude_patterns)?;

        // Build walker with gitignore support
        let mut builder = WalkBuilder::new(&root_path);
        builder
            .hidden(!include_hidden)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .ignore(true);

        let walker = builder.build();

        for entry in walker {
            if current_search_id.load(Ordering::Relaxed) != request_id {
                return Err(SearchError::Cancelled);
            }

            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };

            // Skip directories
            if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(true) {
                continue;
            }

            let path = entry.path().to_path_buf();

            // Match globs against path relative to root (VS Code-style patterns)
            let rel = path.strip_prefix(&root_path).unwrap_or(path.as_path());

            if let Some(exclude) = &exclude_globs {
                if exclude.is_match(rel) {
                    continue;
                }
            }

            if let Some(include) = &include_globs {
                if !include.is_match(rel) {
                    continue;
                }
            }

            // Search the file
            match search_file(
                &path,
                &pattern,
                max_results,
                &mut total_matches,
                Some(current_search_id.clone()),
                request_id,
            ) {
                Ok(Some(file_result)) => results.push(file_result),
                Ok(None) => {}
                Err(SearchError::Cancelled) => return Err(SearchError::Cancelled),
                Err(_) => {}
            }

            // Check if we've hit the limit
            if max_results > 0 && total_matches >= max_results {
                truncated.store(true, Ordering::SeqCst);
                break;
            }
        }

        let total_files = results.len();

        Ok(SearchResults {
            files: results,
            total_matches,
            total_files,
            truncated: truncated.load(Ordering::SeqCst),
        })
    })
    .await
    .map_err(|e| SearchError::IoError {
        message: format!("Task join error: {}", e),
    })?
}

/// Cancel the currently running workspace search (best-effort)
#[tauri::command]
pub async fn cancel_workspace_search(
    state: tauri::State<'_, SearchManagerState>,
    request_id: u64,
) -> Result<(), SearchError> {
    // Setting to 0 ensures any in-flight search observing request_id will stop.
    // If a newer search started, this is a no-op.
    let current = state.current_search_id.load(Ordering::SeqCst);
    if current == request_id {
        state.current_search_id.store(0, Ordering::SeqCst);
    }
    Ok(())
}

/// Perform workspace search with streamed incremental results.
///
/// Emits:
/// - `search://chunk` (SearchChunkEvent)
/// - `search://done` (SearchDoneEvent)
/// - `search://error` (SearchErrorEvent)
#[tauri::command]
pub async fn workspace_search_stream(
    state: tauri::State<'_, SearchManagerState>,
    app: AppHandle,
    options: SearchOptions,
) -> Result<(), SearchError> {
    if options.query.is_empty() {
        let _ = app.emit(
            "search://done",
            SearchDoneEvent {
                request_id: options.request_id,
                total_matches: 0,
                total_files: 0,
                truncated: false,
                cancelled: false,
            },
        );
        return Ok(());
    }

    if options.root_path.is_empty() {
        return Err(SearchError::InvalidPath {
            path: options.root_path,
        });
    }

    if options.request_id == 0 {
        return Err(SearchError::InvalidRange {
            message: "requestId is required".to_string(),
        });
    }

    let pattern = build_pattern(&options)?;
    let root_path = PathBuf::from(&options.root_path);

    if !root_path.exists() {
        return Err(SearchError::InvalidPath {
            path: options.root_path,
        });
    }

    // Mark this request as the current search (enables cancellation of older requests).
    state
        .current_search_id
        .store(options.request_id, Ordering::SeqCst);

    // Run streaming scan in blocking task.
    let max_results = if options.max_results == 0 {
        10000
    } else {
        options.max_results
    };

    let include_hidden = options.include_hidden;
    let include_patterns = options.include_patterns.clone();
    let exclude_patterns = options.exclude_patterns.clone();
    let request_id = options.request_id;
    let current_search_id = state.current_search_id.clone();

    let app_for_scan = app.clone();

    tokio::task::spawn_blocking(move || {
        let mut total_matches = 0usize;
        let mut total_files = 0usize;
        let truncated_flag = Arc::new(AtomicBool::new(false));

        let run = (|| -> Result<(), SearchError> {
            let include_globs = build_globset(&include_patterns)?;
            let exclude_globs = build_globset(&exclude_patterns)?;

            let mut builder = WalkBuilder::new(&root_path);
            builder
                .hidden(!include_hidden)
                .git_ignore(true)
                .git_global(true)
                .git_exclude(true)
                .ignore(true);

            let walker = builder.build();

            let mut batch: Vec<FileSearchResult> = Vec::new();
            const BATCH_SIZE: usize = 10;
            const BATCH_MAX_LATENCY: Duration = Duration::from_millis(75);
            let mut last_emit = Instant::now();

            for entry in walker {
                if current_search_id.load(Ordering::Relaxed) != request_id {
                    let _ = app_for_scan.emit(
                        "search://done",
                        SearchDoneEvent {
                            request_id,
                            total_matches,
                            total_files,
                            truncated: truncated_flag.load(Ordering::SeqCst),
                            cancelled: true,
                        },
                    );
                    return Ok(());
                }

                let entry = match entry {
                    Ok(e) => e,
                    Err(_) => continue,
                };

                if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(true) {
                    continue;
                }

                let path = entry.path().to_path_buf();
                let rel = path.strip_prefix(&root_path).unwrap_or(path.as_path());

                if let Some(exclude) = &exclude_globs {
                    if exclude.is_match(rel) {
                        continue;
                    }
                }

                if let Some(include) = &include_globs {
                    if !include.is_match(rel) {
                        continue;
                    }
                }

                match search_file(
                    &path,
                    &pattern,
                    max_results,
                    &mut total_matches,
                    Some(current_search_id.clone()),
                    request_id,
                ) {
                    Ok(Some(file_result)) => {
                        total_files += 1;
                        batch.push(file_result);

                        if batch.len() >= BATCH_SIZE || last_emit.elapsed() >= BATCH_MAX_LATENCY {
                            let payload = SearchChunkEvent {
                                request_id,
                                files: std::mem::take(&mut batch),
                                total_matches,
                                truncated: truncated_flag.load(Ordering::SeqCst),
                            };
                            let _ = app_for_scan.emit("search://chunk", payload);
                            last_emit = Instant::now();
                        }
                    }
                    Ok(None) => {}
                    Err(SearchError::Cancelled) => {
                        let _ = app_for_scan.emit(
                            "search://done",
                            SearchDoneEvent {
                                request_id,
                                total_matches,
                                total_files,
                                truncated: truncated_flag.load(Ordering::SeqCst),
                                cancelled: true,
                            },
                        );
                        return Ok(());
                    }
                    Err(_) => {}
                }

                if max_results > 0 && total_matches >= max_results {
                    truncated_flag.store(true, Ordering::SeqCst);
                    break;
                }
            }

            if !batch.is_empty() {
                let payload = SearchChunkEvent {
                    request_id,
                    files: batch,
                    total_matches,
                    truncated: truncated_flag.load(Ordering::SeqCst),
                };
                let _ = app_for_scan.emit("search://chunk", payload);
            }

            let _ = app_for_scan.emit(
                "search://done",
                SearchDoneEvent {
                    request_id,
                    total_matches,
                    total_files,
                    truncated: truncated_flag.load(Ordering::SeqCst),
                    cancelled: false,
                },
            );

            Ok(())
        })();

        if let Err(err) = run {
            let _ = app_for_scan.emit(
                "search://error",
                SearchErrorEvent {
                    request_id,
                    error: err.clone(),
                },
            );
            let _ = app_for_scan.emit(
                "search://done",
                SearchDoneEvent {
                    request_id,
                    total_matches,
                    total_files,
                    truncated: truncated_flag.load(Ordering::SeqCst),
                    cancelled: false,
                },
            );
        }
    });

    Ok(())
}

/// Replace text in a single file
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceInFileOptions {
    /// File path
    pub path: String,
    /// Search pattern
    pub search: String,
    /// Replacement text
    pub replace: String,
    /// Case sensitive
    #[serde(default)]
    pub case_sensitive: bool,
    /// Use regex
    #[serde(default)]
    pub use_regex: bool,
    /// Whole word
    #[serde(default)]
    pub whole_word: bool,
}

/// Replace a single occurrence in a file at an explicit range (UTF-16 columns)
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceOneInFileOptions {
    pub path: String,
    /// 1-based line number
    pub line: usize,
    /// UTF-16 column start (0-based)
    pub column_start: usize,
    /// UTF-16 column end (0-based)
    pub column_end: usize,
    /// Optional expected text at the range for safety
    #[serde(default)]
    pub expected: Option<String>,
    pub replace: String,
}

/// Result of a replace operation
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResult {
    /// Number of replacements made
    pub replacements: usize,
    /// New file content
    pub content: String,
}

#[tauri::command]
pub async fn replace_one_in_file(
    options: ReplaceOneInFileOptions,
) -> Result<ReplaceResult, SearchError> {
    if options.path.is_empty() {
        return Err(SearchError::InvalidPath { path: options.path });
    }

    if options.line == 0 {
        return Err(SearchError::InvalidRange {
            message: "line must be >= 1".to_string(),
        });
    }

    if options.column_end < options.column_start {
        return Err(SearchError::InvalidRange {
            message: "columnEnd must be >= columnStart".to_string(),
        });
    }

    let path = PathBuf::from(&options.path);
    if !path.exists() {
        return Err(SearchError::InvalidPath { path: options.path });
    }

    tokio::task::spawn_blocking(move || {
        let content = fs::read_to_string(&path)?;

        // Locate the requested line boundaries by scanning for '\n'
        let bytes = content.as_bytes();
        let mut line_start = 0usize;
        let mut line_end = content.len();
        let mut current_line = 1usize;

        for (i, b) in bytes.iter().enumerate() {
            if *b == b'\n' {
                if current_line == options.line {
                    line_end = i;
                    break;
                }
                current_line += 1;
                line_start = i + 1;
            }
        }

        if current_line != options.line {
            return Err(SearchError::InvalidRange {
                message: "line out of range".to_string(),
            });
        }

        // Exclude CR in CRLF when mapping columns
        let mut line_content_end = line_end;
        if line_content_end > line_start && bytes[line_content_end - 1] == b'\r' {
            line_content_end -= 1;
        }

        let line_str = &content[line_start..line_content_end];

        let start_in_line = byte_index_from_utf16(line_str, options.column_start).ok_or(
            SearchError::InvalidRange {
                message: "columnStart out of range".to_string(),
            },
        )?;
        let end_in_line = byte_index_from_utf16(line_str, options.column_end).ok_or(
            SearchError::InvalidRange {
                message: "columnEnd out of range".to_string(),
            },
        )?;

        if end_in_line < start_in_line {
            return Err(SearchError::InvalidRange {
                message: "invalid column range".to_string(),
            });
        }

        let abs_start = line_start + start_in_line;
        let abs_end = line_start + end_in_line;

        if let Some(expected) = &options.expected {
            let actual = &content[abs_start..abs_end];
            if actual != expected {
                return Err(SearchError::InvalidRange {
                    message: "match no longer exists at the specified range".to_string(),
                });
            }
        }

        let mut new_content = String::with_capacity(content.len() + options.replace.len());
        new_content.push_str(&content[..abs_start]);
        new_content.push_str(&options.replace);
        new_content.push_str(&content[abs_end..]);

        fs::write(&path, &new_content)?;

        Ok(ReplaceResult {
            replacements: 1,
            content: new_content,
        })
    })
    .await
    .map_err(|e| SearchError::IoError {
        message: format!("Task join error: {}", e),
    })?
}

/// Replace text in a single file
#[tauri::command]
pub async fn replace_in_file(options: ReplaceInFileOptions) -> Result<ReplaceResult, SearchError> {
    if options.path.is_empty() {
        return Err(SearchError::InvalidPath { path: options.path });
    }

    let path = PathBuf::from(&options.path);
    if !path.exists() {
        return Err(SearchError::InvalidPath { path: options.path });
    }

    // Build pattern
    let pattern_str = if options.use_regex {
        options.search.clone()
    } else {
        regex::escape(&options.search)
    };

    let pattern_str = if options.whole_word {
        format!(r"\b{}\b", pattern_str)
    } else {
        pattern_str
    };

    let pattern = RegexBuilder::new(&pattern_str)
        .case_insensitive(!options.case_sensitive)
        .build()?;

    let replace_text = options.replace.clone();

    tokio::task::spawn_blocking(move || {
        let content = fs::read_to_string(&path)?;
        let mut replacements = 0usize;

        // Count replacements
        for _ in pattern.find_iter(&content) {
            replacements += 1;
        }

        // Perform replacement
        let new_content = pattern.replace_all(&content, replace_text.as_str()).to_string();

        // Write back to file
        fs::write(&path, &new_content)?;

        Ok(ReplaceResult {
            replacements,
            content: new_content,
        })
    })
    .await
    .map_err(|e| SearchError::IoError {
        message: format!("Task join error: {}", e),
    })?
}
