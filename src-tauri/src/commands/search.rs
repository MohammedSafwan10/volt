use ignore::WalkBuilder;
use globset::{Glob, GlobSet, GlobSetBuilder};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{self, BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tracing::{info, warn};

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

    /// Optional engine override for runtime diagnostics/testing.
    /// Supported values: auto | rg | legacy
    #[serde(default)]
    pub engine: Option<String>,
}

/// Find-files options (filename/path search)
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindFilesOptions {
    /// File name or path fragment query
    pub query: String,
    /// Root directory to search in
    pub root_path: String,
    /// Include hidden files
    #[serde(default)]
    pub include_hidden: bool,
    /// File glob patterns to include
    #[serde(default)]
    pub include_patterns: Vec<String>,
    /// File glob patterns to exclude
    #[serde(default)]
    pub exclude_patterns: Vec<String>,
    /// Maximum number of results (0 = 25 default)
    #[serde(default)]
    pub max_results: usize,
    /// Optional engine override for diagnostics/testing.
    /// Supported values: auto | rg | legacy
    #[serde(default)]
    pub engine: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindFilesResult {
    pub files: Vec<String>,
    pub total_files: usize,
    pub truncated: bool,
    pub engine: String,
    pub fallback_used: bool,
    pub fallback_reason: Option<String>,
    pub elapsed_ms: u64,
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
    /// Diagnostics metadata for engine selection and fallback behavior.
    pub telemetry: Option<SearchTelemetry>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchTelemetry {
    pub requested_engine: String,
    pub engine: String,
    pub fallback_used: bool,
    pub fallback_reason: Option<String>,
    pub elapsed_ms: u64,
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
    pub telemetry: Option<SearchTelemetry>,
}

/// Streaming search error event
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchErrorEvent {
    pub request_id: u64,
    pub error: SearchError,
}

fn utf16_col_checked(line: &str, byte_index: usize) -> Option<usize> {
    if byte_index > line.len() || !line.is_char_boundary(byte_index) {
        return None;
    }
    Some(utf16_col(line, byte_index))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SearchEngineMode {
    Auto,
    Rg,
    Legacy,
}

#[derive(Debug)]
enum RgSearchError {
    NotAvailable(String),
    Failed(String),
    Cancelled,
}

impl SearchEngineMode {
    fn from_input(option: Option<&str>) -> Self {
        let env_mode = env::var("VOLT_SEARCH_ENGINE").ok();
        let raw = option
            .and_then(|s| {
                let t = s.trim();
                if t.is_empty() { None } else { Some(t.to_string()) }
            })
            .or(env_mode)
            .unwrap_or_else(|| "auto".to_string())
            .to_ascii_lowercase();

        match raw.as_str() {
            "rg" => SearchEngineMode::Rg,
            "legacy" => SearchEngineMode::Legacy,
            _ => SearchEngineMode::Auto,
        }
    }
}

fn search_engine_mode_name(mode: SearchEngineMode) -> &'static str {
    match mode {
        SearchEngineMode::Auto => "auto",
        SearchEngineMode::Rg => "rg",
        SearchEngineMode::Legacy => "legacy",
    }
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

fn normalize_path_for_display(path: &str) -> String {
    #[cfg(windows)]
    {
        path.strip_prefix("\\\\?\\").unwrap_or(path).to_string()
    }
    #[cfg(not(windows))]
    {
        path.to_string()
    }
}

fn rg_output_path_to_display(path: &str, root_path: &str) -> String {
    let p = PathBuf::from(path);
    if p.is_absolute() {
        return normalize_path_for_display(path);
    }
    let full = PathBuf::from(root_path).join(p);
    normalize_path_for_display(&full.to_string_lossy())
}

fn trim_line_endings(mut line: String) -> String {
    if line.ends_with('\n') {
        line.pop();
        if line.ends_with('\r') {
            line.pop();
        }
    }
    line
}

fn escape_glob_for_rg(pattern: &str) -> String {
    if pattern.starts_with('!') {
        pattern.to_string()
    } else {
        pattern.to_string()
    }
}

fn build_rg_args(options: &SearchOptions) -> Vec<String> {
    let mut args = vec![
        "--json".to_string(),
        "--line-number".to_string(),
        "--column".to_string(),
        "--no-heading".to_string(),
        "--color".to_string(),
        "never".to_string(),
    ];

    if options.include_hidden {
        args.push("--hidden".to_string());
    }
    if !options.case_sensitive {
        args.push("-i".to_string());
    }

    for pattern in &options.include_patterns {
        args.push("-g".to_string());
        args.push(escape_glob_for_rg(pattern));
    }
    for pattern in &options.exclude_patterns {
        args.push("-g".to_string());
        if pattern.starts_with('!') {
            args.push(pattern.clone());
        } else {
            args.push(format!("!{}", pattern));
        }
    }

    let query = if options.use_regex {
        if options.whole_word {
            format!(r"\b(?:{})\b", options.query)
        } else {
            options.query.clone()
        }
    } else if options.whole_word {
        format!(r"\b{}\b", regex::escape(&options.query))
    } else {
        args.push("-F".to_string());
        options.query.clone()
    };

    args.push(query);
    args.push(options.root_path.clone());
    args
}

#[allow(dead_code)]
fn build_rg_files_args(options: &FindFilesOptions) -> Vec<String> {
    let mut args = vec!["--files".to_string(), "--color".to_string(), "never".to_string()];
    if options.include_hidden {
        args.push("--hidden".to_string());
    }
    for pattern in &options.include_patterns {
        args.push("-g".to_string());
        args.push(escape_glob_for_rg(pattern));
    }
    for pattern in &options.exclude_patterns {
        args.push("-g".to_string());
        if pattern.starts_with('!') {
            args.push(pattern.clone());
        } else {
            args.push(format!("!{}", pattern));
        }
    }
    args.push(options.root_path.clone());
    args
}

#[allow(dead_code)]
fn normalize_relative_path_for_output(path: &str) -> String {
    path.replace('\\', "/")
}

#[allow(dead_code)]
fn normalize_query_tokens(query: &str) -> Vec<String> {
    query
        .to_ascii_lowercase()
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .map(ToString::to_string)
        .collect()
}

#[allow(dead_code)]
fn file_matches_query(relative_path: &str, query_tokens: &[String]) -> bool {
    if query_tokens.is_empty() {
        return false;
    }
    let rel = relative_path.to_ascii_lowercase();
    let file_name = relative_path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(relative_path)
        .to_ascii_lowercase();

    query_tokens
        .iter()
        .all(|token| rel.contains(token) || file_name.contains(token))
}

fn parse_rg_json_line(line: &str) -> Result<Option<Value>, RgSearchError> {
    if line.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str::<Value>(line)
        .map(Some)
        .map_err(|e| RgSearchError::Failed(format!("Failed to parse rg JSON output: {e}")))
}

fn extract_text_field(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|n| n.get("text"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn add_match_to_file(
    file_result: &mut FileSearchResult,
    line_number: usize,
    line_text: String,
    start: usize,
    end: usize,
    match_text: String,
) -> bool {
    let clean = trim_line_endings(line_text);
    let Some(start_utf16) = utf16_col_checked(&clean, start) else {
        return false;
    };
    let Some(end_utf16) = utf16_col_checked(&clean, end) else {
        return false;
    };
    file_result.matches.push(SearchMatch {
        line: line_number,
        column_start: start_utf16,
        column_end: end_utf16,
        match_text,
        line_content: clean,
    });
    true
}

fn rg_search_sync(
    options: &SearchOptions,
    current_search_id: Arc<AtomicU64>,
) -> Result<SearchResults, RgSearchError> {
    let max_results = if options.max_results == 0 {
        10000
    } else {
        options.max_results
    };
    let mut cmd = Command::new("rg");
    cmd.args(build_rg_args(options))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            RgSearchError::NotAvailable("ripgrep binary (rg) was not found in PATH".to_string())
        } else {
            RgSearchError::Failed(format!("Failed to start rg: {e}"))
        }
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| RgSearchError::Failed("rg stdout was not available".to_string()))?;
    let mut reader = BufReader::new(stdout);

    let mut files: Vec<FileSearchResult> = Vec::new();
    let mut index_by_path: HashMap<String, usize> = HashMap::new();
    let mut total_matches = 0usize;
    let mut truncated = false;
    let mut line = String::new();

    loop {
        if current_search_id.load(Ordering::Relaxed) != options.request_id {
            let _ = child.kill();
            let _ = child.wait();
            return Err(RgSearchError::Cancelled);
        }

        line.clear();
        let read = reader
            .read_line(&mut line)
            .map_err(|e| RgSearchError::Failed(format!("Failed reading rg output: {e}")))?;
        if read == 0 {
            break;
        }

        let evt = match parse_rg_json_line(&line)? {
            Some(v) => v,
            None => continue,
        };
        let ty = evt.get("type").and_then(Value::as_str).unwrap_or_default();
        if ty != "match" {
            continue;
        }

        let data = match evt.get("data") {
            Some(v) => v,
            None => continue,
        };
        let path_text = match extract_text_field(data, "path") {
            Some(p) => rg_output_path_to_display(&p, &options.root_path),
            None => continue,
        };
        let line_text = extract_text_field(data, "lines").unwrap_or_default();
        let line_number = data
            .get("line_number")
            .and_then(Value::as_u64)
            .unwrap_or(1) as usize;
        let submatches = match data.get("submatches").and_then(Value::as_array) {
            Some(s) => s,
            None => continue,
        };

        let idx = *index_by_path.entry(path_text.clone()).or_insert_with(|| {
            let idx = files.len();
            files.push(FileSearchResult {
                path: path_text.clone(),
                matches: Vec::new(),
            });
            idx
        });
        let file = &mut files[idx];

        for sub in submatches {
            if max_results > 0 && total_matches >= max_results {
                truncated = true;
                break;
            }
            let start = match sub.get("start").and_then(Value::as_u64) {
                Some(v) => v as usize,
                None => continue,
            };
            let end = match sub.get("end").and_then(Value::as_u64) {
                Some(v) => v as usize,
                None => continue,
            };
            let match_text = extract_text_field(sub, "match").unwrap_or_default();
            if add_match_to_file(file, line_number, line_text.clone(), start, end, match_text) {
                total_matches += 1;
            }
        }

        if truncated {
            let _ = child.kill();
            break;
        }
    }

    let status = child
        .wait()
        .map_err(|e| RgSearchError::Failed(format!("Failed waiting for rg: {e}")))?;
    let code = status.code().unwrap_or(2);
    if code != 0 && code != 1 {
        return Err(RgSearchError::Failed(format!(
            "rg exited with non-zero status: {status}"
        )));
    }

    Ok(SearchResults {
        total_files: files.len(),
        files,
        total_matches,
        truncated,
        telemetry: None,
    })
}

fn rg_search_stream(
    app: &AppHandle,
    options: &SearchOptions,
    current_search_id: Arc<AtomicU64>,
) -> Result<(), RgSearchError> {
    let max_results = if options.max_results == 0 {
        10000
    } else {
        options.max_results
    };
    let mut cmd = Command::new("rg");
    cmd.args(build_rg_args(options))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            RgSearchError::NotAvailable("ripgrep binary (rg) was not found in PATH".to_string())
        } else {
            RgSearchError::Failed(format!("Failed to start rg: {e}"))
        }
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| RgSearchError::Failed("rg stdout was not available".to_string()))?;
    let mut reader = BufReader::new(stdout);

    let mut total_matches = 0usize;
    let mut total_files = 0usize;
    let mut truncated = false;
    let mut batch: Vec<FileSearchResult> = Vec::new();
    const BATCH_SIZE: usize = 10;
    const BATCH_MAX_LATENCY: Duration = Duration::from_millis(75);
    let mut last_emit = Instant::now();
    let mut line = String::new();

    // ripgrep emits sequential file events; keep one active file in memory.
    let mut current_file_path: Option<String> = None;
    let mut current_file_result: Option<FileSearchResult> = None;

    loop {
        if current_search_id.load(Ordering::Relaxed) != options.request_id {
            let _ = child.kill();
            let _ = child.wait();
            let _ = app.emit(
                "search://done",
                SearchDoneEvent {
                    request_id: options.request_id,
                    total_matches,
                    total_files,
                    truncated,
                    cancelled: true,
                    telemetry: None,
                },
            );
            return Ok(());
        }

        line.clear();
        let read = reader
            .read_line(&mut line)
            .map_err(|e| RgSearchError::Failed(format!("Failed reading rg output: {e}")))?;
        if read == 0 {
            break;
        }
        let evt = match parse_rg_json_line(&line)? {
            Some(v) => v,
            None => continue,
        };
        let ty = evt.get("type").and_then(Value::as_str).unwrap_or_default();
        let data = match evt.get("data") {
            Some(v) => v,
            None => continue,
        };
        let path_text =
            extract_text_field(data, "path").map(|p| rg_output_path_to_display(&p, &options.root_path));

        match ty {
            "begin" => {
                if let Some(file) = current_file_result.take() {
                    if !file.matches.is_empty() {
                        total_files += 1;
                        batch.push(file);
                    }
                }
                if let Some(path) = path_text {
                    current_file_path = Some(path.clone());
                    current_file_result = Some(FileSearchResult {
                        path,
                        matches: Vec::new(),
                    });
                } else {
                    current_file_path = None;
                    current_file_result = None;
                }
            }
            "match" => {
                let line_text = extract_text_field(data, "lines").unwrap_or_default();
                let line_number = data
                    .get("line_number")
                    .and_then(Value::as_u64)
                    .unwrap_or(1) as usize;
                let submatches = match data.get("submatches").and_then(Value::as_array) {
                    Some(s) => s,
                    None => continue,
                };
                let path = match path_text.or_else(|| current_file_path.clone()) {
                    Some(p) => p,
                    None => continue,
                };
                if current_file_result
                    .as_ref()
                    .map(|f| f.path.as_str())
                    != Some(path.as_str())
                {
                    if let Some(file) = current_file_result.take() {
                        if !file.matches.is_empty() {
                            total_files += 1;
                            batch.push(file);
                        }
                    }
                    current_file_path = Some(path.clone());
                    current_file_result = Some(FileSearchResult {
                        path,
                        matches: Vec::new(),
                    });
                }
                let file = current_file_result.as_mut().expect("current file must exist");

                for sub in submatches {
                    if max_results > 0 && total_matches >= max_results {
                        truncated = true;
                        break;
                    }
                    let start = match sub.get("start").and_then(Value::as_u64) {
                        Some(v) => v as usize,
                        None => continue,
                    };
                    let end = match sub.get("end").and_then(Value::as_u64) {
                        Some(v) => v as usize,
                        None => continue,
                    };
                    let match_text = extract_text_field(sub, "match").unwrap_or_default();
                    if add_match_to_file(file, line_number, line_text.clone(), start, end, match_text)
                    {
                        total_matches += 1;
                    }
                }
                if truncated {
                    let _ = child.kill();
                }
            }
            "end" => {
                if let Some(path) = &path_text {
                    if current_file_result
                        .as_ref()
                        .map(|f| f.path.as_str())
                        == Some(path.as_str())
                    {
                        if let Some(file) = current_file_result.take() {
                            if !file.matches.is_empty() {
                                total_files += 1;
                                batch.push(file);
                            }
                        }
                        current_file_path = None;
                    }
                }
            }
            _ => {}
        }

        if !batch.is_empty() && (batch.len() >= BATCH_SIZE || last_emit.elapsed() >= BATCH_MAX_LATENCY) {
            let _ = app.emit(
                "search://chunk",
                SearchChunkEvent {
                    request_id: options.request_id,
                    files: std::mem::take(&mut batch),
                    total_matches,
                    truncated,
                },
            );
            last_emit = Instant::now();
        }
    }

    if let Some(file) = current_file_result.take() {
        if !file.matches.is_empty() {
            total_files += 1;
            batch.push(file);
        }
    }
    if !batch.is_empty() {
        let _ = app.emit(
            "search://chunk",
            SearchChunkEvent {
                request_id: options.request_id,
                files: batch,
                total_matches,
                truncated,
            },
        );
    }

    let status = child
        .wait()
        .map_err(|e| RgSearchError::Failed(format!("Failed waiting for rg: {e}")))?;
    let code = status.code().unwrap_or(2);
    if code != 0 && code != 1 && !truncated {
        return Err(RgSearchError::Failed(format!(
            "rg exited with non-zero status: {status}"
        )));
    }

    let _ = app.emit(
        "search://done",
        SearchDoneEvent {
            request_id: options.request_id,
            total_matches,
            total_files,
            truncated,
            cancelled: false,
            telemetry: None,
        },
    );

    Ok(())
}

#[allow(dead_code)]
fn rg_find_files(options: &FindFilesOptions) -> Result<Vec<String>, RgSearchError> {
    let mut cmd = Command::new("rg");
    cmd.args(build_rg_files_args(options))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = cmd.output().map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            RgSearchError::NotAvailable("ripgrep binary (rg) was not found in PATH".to_string())
        } else {
            RgSearchError::Failed(format!("Failed to start rg --files: {e}"))
        }
    })?;

    let status_code = output.status.code().unwrap_or(2);
    if status_code != 0 {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(RgSearchError::Failed(format!(
            "rg --files exited with status {}{}",
            status_code,
            if stderr.is_empty() {
                String::new()
            } else {
                format!(": {}", stderr)
            }
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut out: Vec<String> = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        out.push(normalize_relative_path_for_output(trimmed));
    }
    Ok(out)
}

#[allow(dead_code)]
fn legacy_find_files(options: &FindFilesOptions, root_path: &PathBuf) -> Result<Vec<String>, SearchError> {
    let include_globs = build_globset(&options.include_patterns)?;
    let exclude_globs = build_globset(&options.exclude_patterns)?;

    let mut builder = WalkBuilder::new(root_path);
    builder
        .hidden(!options.include_hidden)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true);

    let mut files = Vec::new();
    for entry in builder.build() {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(true) {
            continue;
        }
        let rel = entry.path().strip_prefix(root_path).unwrap_or(entry.path());
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
        files.push(normalize_relative_path_for_output(&rel.to_string_lossy()));
    }
    Ok(files)
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

fn legacy_search_sync(
    options: &SearchOptions,
    pattern: &Regex,
    root_path: &PathBuf,
    current_search_id: Arc<AtomicU64>,
) -> Result<SearchResults, SearchError> {
    let max_results = if options.max_results == 0 {
        10000
    } else {
        options.max_results
    };
    let include_hidden = options.include_hidden;
    let include_patterns = options.include_patterns.clone();
    let exclude_patterns = options.exclude_patterns.clone();
    let request_id = options.request_id;

    let mut results = Vec::new();
    let mut total_matches = 0usize;
    let truncated = Arc::new(AtomicBool::new(false));

    let include_globs = build_globset(&include_patterns)?;
    let exclude_globs = build_globset(&exclude_patterns)?;

    let mut builder = WalkBuilder::new(root_path);
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

        if entry.file_type().map(|ft| ft.is_dir()).unwrap_or(true) {
            continue;
        }

        let path = entry.path().to_path_buf();
        let rel = path.strip_prefix(root_path).unwrap_or(path.as_path());

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
            pattern,
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

        if max_results > 0 && total_matches >= max_results {
            truncated.store(true, Ordering::SeqCst);
            break;
        }
    }

    Ok(SearchResults {
        total_files: results.len(),
        files: results,
        total_matches,
        truncated: truncated.load(Ordering::SeqCst),
        telemetry: None,
    })
}

fn legacy_search_stream(
    app: &AppHandle,
    options: &SearchOptions,
    pattern: &Regex,
    root_path: &PathBuf,
    current_search_id: Arc<AtomicU64>,
) -> Result<(), SearchError> {
    let max_results = if options.max_results == 0 {
        10000
    } else {
        options.max_results
    };
    let include_hidden = options.include_hidden;
    let include_patterns = options.include_patterns.clone();
    let exclude_patterns = options.exclude_patterns.clone();
    let request_id = options.request_id;

    let mut total_matches = 0usize;
    let mut total_files = 0usize;
    let truncated_flag = Arc::new(AtomicBool::new(false));

    let include_globs = build_globset(&include_patterns)?;
    let exclude_globs = build_globset(&exclude_patterns)?;

    let mut builder = WalkBuilder::new(root_path);
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
            let _ = app.emit(
                "search://done",
                SearchDoneEvent {
                    request_id,
                    total_matches,
                    total_files,
                    truncated: truncated_flag.load(Ordering::SeqCst),
                    cancelled: true,
                    telemetry: None,
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
        let rel = path.strip_prefix(root_path).unwrap_or(path.as_path());

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
            pattern,
            max_results,
            &mut total_matches,
            Some(current_search_id.clone()),
            request_id,
        ) {
            Ok(Some(file_result)) => {
                total_files += 1;
                batch.push(file_result);
                if batch.len() >= BATCH_SIZE || last_emit.elapsed() >= BATCH_MAX_LATENCY {
                    let _ = app.emit(
                        "search://chunk",
                        SearchChunkEvent {
                            request_id,
                            files: std::mem::take(&mut batch),
                            total_matches,
                            truncated: truncated_flag.load(Ordering::SeqCst),
                        },
                    );
                    last_emit = Instant::now();
                }
            }
            Ok(None) => {}
            Err(SearchError::Cancelled) => {
                let _ = app.emit(
                    "search://done",
                    SearchDoneEvent {
                        request_id,
                        total_matches,
                        total_files,
                        truncated: truncated_flag.load(Ordering::SeqCst),
                        cancelled: true,
                        telemetry: None,
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
        let _ = app.emit(
            "search://chunk",
            SearchChunkEvent {
                request_id,
                files: batch,
                total_matches,
                truncated: truncated_flag.load(Ordering::SeqCst),
            },
        );
    }

    let _ = app.emit(
        "search://done",
        SearchDoneEvent {
            request_id,
            total_matches,
            total_files,
            truncated: truncated_flag.load(Ordering::SeqCst),
            cancelled: false,
            telemetry: None,
        },
    );

    Ok(())
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
            telemetry: None,
        });
    }

    if options.root_path.is_empty() {
        return Err(SearchError::InvalidPath {
            path: options.root_path,
        });
    }

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

    let current_search_id = state.current_search_id.clone();
    let mode = SearchEngineMode::from_input(options.engine.as_deref());
    let options_for_task = options;

    tokio::task::spawn_blocking(move || {
        let started = Instant::now();
        let requested_engine = search_engine_mode_name(mode).to_string();
        match mode {
            SearchEngineMode::Legacy => {
                let pattern = build_pattern(&options_for_task)?;
                let mut out = legacy_search_sync(
                    &options_for_task,
                    &pattern,
                    &root_path,
                    current_search_id.clone(),
                )?;
                let elapsed_ms = started.elapsed().as_millis() as u64;
                out.telemetry = Some(SearchTelemetry {
                    requested_engine: requested_engine.clone(),
                    engine: "legacy".to_string(),
                    fallback_used: false,
                    fallback_reason: None,
                    elapsed_ms,
                });
                info!(
                    target: "volt.search",
                    mode = requested_engine.as_str(),
                    engine = "legacy",
                    fallback_used = false,
                    request_id = options_for_task.request_id,
                    total_matches = out.total_matches,
                    total_files = out.total_files,
                    elapsed_ms = elapsed_ms
                );
                Ok(out)
            }
            SearchEngineMode::Rg => match rg_search_sync(&options_for_task, current_search_id.clone()) {
                Ok(mut out) => {
                    let elapsed_ms = started.elapsed().as_millis() as u64;
                    out.telemetry = Some(SearchTelemetry {
                        requested_engine: requested_engine.clone(),
                        engine: "rg".to_string(),
                        fallback_used: false,
                        fallback_reason: None,
                        elapsed_ms,
                    });
                    info!(
                        target: "volt.search",
                        mode = requested_engine.as_str(),
                        engine = "rg",
                        fallback_used = false,
                        request_id = options_for_task.request_id,
                        total_matches = out.total_matches,
                        total_files = out.total_files,
                        elapsed_ms = elapsed_ms
                    );
                    Ok(out)
                }
                Err(RgSearchError::Cancelled) => Err(SearchError::Cancelled),
                Err(RgSearchError::NotAvailable(reason)) | Err(RgSearchError::Failed(reason)) => {
                    Err(SearchError::IoError {
                        message: format!("rg mode failed: {reason}"),
                    })
                }
            },
            SearchEngineMode::Auto => match rg_search_sync(&options_for_task, current_search_id.clone()) {
                Ok(mut out) => {
                    let elapsed_ms = started.elapsed().as_millis() as u64;
                    out.telemetry = Some(SearchTelemetry {
                        requested_engine: requested_engine.clone(),
                        engine: "rg".to_string(),
                        fallback_used: false,
                        fallback_reason: None,
                        elapsed_ms,
                    });
                    info!(
                        target: "volt.search",
                        mode = requested_engine.as_str(),
                        engine = "rg",
                        fallback_used = false,
                        request_id = options_for_task.request_id,
                        total_matches = out.total_matches,
                        total_files = out.total_files,
                        elapsed_ms = elapsed_ms
                    );
                    Ok(out)
                }
                Err(RgSearchError::Cancelled) => Err(SearchError::Cancelled),
                Err(err) => {
                    warn!(
                        target: "volt.search",
                        engine = "auto",
                        request_id = options_for_task.request_id,
                        "rg fallback to legacy: {:?}",
                        err
                    );
                    let pattern = build_pattern(&options_for_task)?;
                    let mut out = legacy_search_sync(
                        &options_for_task,
                        &pattern,
                        &root_path,
                        current_search_id.clone(),
                    )?;
                    let elapsed_ms = started.elapsed().as_millis() as u64;
                    out.telemetry = Some(SearchTelemetry {
                        requested_engine: requested_engine.clone(),
                        engine: "legacy".to_string(),
                        fallback_used: true,
                        fallback_reason: Some(format!("{:?}", err)),
                        elapsed_ms,
                    });
                    info!(
                        target: "volt.search",
                        mode = requested_engine.as_str(),
                        engine = "legacy",
                        fallback_used = true,
                        fallback_reason = format!("{:?}", err),
                        request_id = options_for_task.request_id,
                        total_matches = out.total_matches,
                        total_files = out.total_files,
                        elapsed_ms = elapsed_ms
                    );
                    Ok(out)
                }
            },
        }
    })
    .await
    .map_err(|e| SearchError::IoError {
        message: format!("Task join error: {}", e),
    })?
}

#[tauri::command]
#[allow(dead_code)]
pub async fn find_files_by_name(options: FindFilesOptions) -> Result<FindFilesResult, SearchError> {
    if options.query.trim().is_empty() {
        return Ok(FindFilesResult {
            files: Vec::new(),
            total_files: 0,
            truncated: false,
            engine: "none".to_string(),
            fallback_used: false,
            fallback_reason: None,
            elapsed_ms: 0,
        });
    }

    if options.root_path.is_empty() {
        return Err(SearchError::InvalidPath {
            path: options.root_path,
        });
    }

    let root_path = PathBuf::from(&options.root_path);
    if !root_path.exists() {
        return Err(SearchError::InvalidPath {
            path: options.root_path,
        });
    }

    let max_results = if options.max_results == 0 {
        25
    } else {
        options.max_results
    };
    let query_tokens = normalize_query_tokens(&options.query);
    let mode = SearchEngineMode::from_input(options.engine.as_deref());
    let started = Instant::now();

    let mut fallback_used = false;
    let mut fallback_reason: Option<String> = None;

    let (selected_engine, mut files) = match mode {
        SearchEngineMode::Legacy => {
            ("legacy", legacy_find_files(&options, &root_path)?)
        }
        SearchEngineMode::Rg => {
            match rg_find_files(&options) {
                Ok(list) => ("rg", list),
                Err(RgSearchError::NotAvailable(reason)) | Err(RgSearchError::Failed(reason)) => {
                    return Err(SearchError::IoError {
                        message: format!("rg mode failed: {reason}"),
                    });
                }
                Err(RgSearchError::Cancelled) => ("rg", Vec::new()),
            }
        }
        SearchEngineMode::Auto => match rg_find_files(&options) {
            Ok(list) => {
                ("rg", list)
            }
            Err(err) => {
                fallback_used = true;
                fallback_reason = Some(format!("{:?}", err));
                warn!(
                    target: "volt.search",
                    request = "find_files_by_name",
                    mode = "auto",
                    "rg fallback to legacy: {:?}",
                    err
                );
                ("legacy", legacy_find_files(&options, &root_path)?)
            }
        },
    };

    files.retain(|relative| file_matches_query(relative, &query_tokens));
    files.sort_unstable();

    let truncated = files.len() > max_results;
    if truncated {
        files.truncate(max_results);
    }

    let elapsed_ms = started.elapsed().as_millis() as u64;
    info!(
        target: "volt.search",
        request = "find_files_by_name",
        mode = ?mode,
        engine = selected_engine,
        fallback_used = fallback_used,
        fallback_reason = fallback_reason.as_deref().unwrap_or(""),
        query = options.query.as_str(),
        total_files = files.len(),
        truncated = truncated,
        elapsed_ms = elapsed_ms
    );

    Ok(FindFilesResult {
        total_files: files.len(),
        files,
        truncated,
        engine: selected_engine.to_string(),
        fallback_used,
        fallback_reason,
        elapsed_ms,
    })
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
                telemetry: None,
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

    let current_search_id = state.current_search_id.clone();
    let mode = SearchEngineMode::from_input(options.engine.as_deref());
    let app_for_scan = app.clone();
    let options_for_task = options;

    tokio::task::spawn_blocking(move || {
        let started = Instant::now();
        let request_id = options_for_task.request_id;

        let run = (|| -> Result<(), SearchError> {
            match mode {
                SearchEngineMode::Legacy => {
                    let pattern = build_pattern(&options_for_task)?;
                    legacy_search_stream(
                        &app_for_scan,
                        &options_for_task,
                        &pattern,
                        &root_path,
                        current_search_id.clone(),
                    )?;
                    info!(
                        target: "volt.search",
                        engine = "legacy",
                        request_id = request_id,
                        elapsed_ms = started.elapsed().as_millis() as u64
                    );
                    Ok(())
                }
                SearchEngineMode::Rg => match rg_search_stream(
                    &app_for_scan,
                    &options_for_task,
                    current_search_id.clone(),
                ) {
                    Ok(()) => {
                        info!(
                            target: "volt.search",
                            engine = "rg",
                            request_id = request_id,
                            elapsed_ms = started.elapsed().as_millis() as u64
                        );
                        Ok(())
                    }
                    Err(RgSearchError::Cancelled) => Ok(()),
                    Err(RgSearchError::NotAvailable(reason))
                    | Err(RgSearchError::Failed(reason)) => Err(SearchError::IoError {
                        message: format!("rg mode failed: {reason}"),
                    }),
                },
                SearchEngineMode::Auto => match rg_search_stream(
                    &app_for_scan,
                    &options_for_task,
                    current_search_id.clone(),
                ) {
                    Ok(()) => {
                        info!(
                            target: "volt.search",
                            engine = "rg",
                            request_id = request_id,
                            elapsed_ms = started.elapsed().as_millis() as u64
                        );
                        Ok(())
                    }
                    Err(RgSearchError::Cancelled) => Ok(()),
                    Err(err) => {
                        warn!(
                            target: "volt.search",
                            engine = "auto",
                            request_id = request_id,
                            "rg fallback to legacy: {:?}",
                            err
                        );
                        let pattern = build_pattern(&options_for_task)?;
                        legacy_search_stream(
                            &app_for_scan,
                            &options_for_task,
                            &pattern,
                            &root_path,
                            current_search_id.clone(),
                        )?;
                        info!(
                            target: "volt.search",
                            engine = "legacy",
                            request_id = request_id,
                            elapsed_ms = started.elapsed().as_millis() as u64
                        );
                        Ok(())
                    }
                },
            }
        })();

        if let Err(err) = run {
            let _ = app_for_scan.emit(
                "search://error",
                SearchErrorEvent {
                    request_id,
                    error: err,
                },
            );
            let _ = app_for_scan.emit(
                "search://done",
                SearchDoneEvent {
                    request_id,
                    total_matches: 0,
                    total_files: 0,
                    truncated: false,
                    cancelled: false,
                    telemetry: None,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_mode_from_input_defaults_to_auto() {
        let mode = SearchEngineMode::from_input(None);
        assert_eq!(mode, SearchEngineMode::Auto);
    }

    #[test]
    fn engine_mode_from_input_parses_override() {
        assert_eq!(
            SearchEngineMode::from_input(Some("rg")),
            SearchEngineMode::Rg
        );
        assert_eq!(
            SearchEngineMode::from_input(Some("legacy")),
            SearchEngineMode::Legacy
        );
    }

    #[test]
    fn rg_args_literal_uses_fixed_strings() {
        let opts = SearchOptions {
            query: "hello.world".to_string(),
            root_path: ".".to_string(),
            case_sensitive: false,
            use_regex: false,
            whole_word: false,
            include_hidden: false,
            include_patterns: vec![],
            exclude_patterns: vec![],
            max_results: 0,
            request_id: 1,
            engine: None,
        };
        let args = build_rg_args(&opts);
        assert!(args.iter().any(|a| a == "-F"));
        assert!(args.iter().any(|a| a == "hello.world"));
    }

    #[test]
    fn parse_rg_match_event_line() {
        let line = r#"{"type":"match","data":{"path":{"text":"src/main.rs"},"lines":{"text":"let x = 1;\n"},"line_number":10,"submatches":[{"match":{"text":"x"},"start":4,"end":5}]}}"#;
        let evt = parse_rg_json_line(line).expect("parse should succeed");
        assert!(evt.is_some());
        let evt = evt.expect("event");
        assert_eq!(evt.get("type").and_then(Value::as_str), Some("match"));
    }

    #[test]
    fn trim_line_endings_removes_crlf() {
        assert_eq!(trim_line_endings("abc\r\n".to_string()), "abc");
        assert_eq!(trim_line_endings("abc\n".to_string()), "abc");
    }

    #[test]
    fn rg_output_path_relative_is_made_absolute() {
        let out = rg_output_path_to_display("src/main.rs", "C:\\repo");
        assert!(out.ends_with("src\\main.rs") || out.ends_with("src/main.rs"));
    }

    #[test]
    fn rg_output_path_absolute_is_preserved() {
        let out = rg_output_path_to_display("C:\\repo\\src\\main.rs", "C:\\repo");
        assert!(out.ends_with("src\\main.rs") || out.ends_with("src/main.rs"));
    }

    #[test]
    fn utf16_col_checked_rejects_invalid_boundaries() {
        let s = "a😀b";
        assert_eq!(utf16_col_checked(s, 0), Some(0));
        assert_eq!(utf16_col_checked(s, 1), Some(1));
        // Byte offset 2 is inside 😀 (4-byte sequence), must be rejected.
        assert_eq!(utf16_col_checked(s, 2), None);
    }
}
