use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use globset::{Glob, GlobSetBuilder};
use ignore::WalkBuilder;
use once_cell::sync::OnceCell;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

#[derive(Clone, Default)]
pub struct SemanticIndexState {
    lock: Arc<Mutex<()>>,
    runtime_meta: Arc<Mutex<SemanticRuntimeMeta>>,
}

#[derive(Clone, Debug)]
struct SemanticRuntimeMeta {
    backend: String,
    model_path: Option<String>,
    model_load_ms: Option<u64>,
    last_error: Option<String>,
}

impl Default for SemanticRuntimeMeta {
    fn default() -> Self {
        Self {
            backend: "local-onnx-fallback".to_string(),
            model_path: None,
            model_load_ms: None,
            last_error: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticUpsertArgs {
    pub root_path: String,
    #[serde(default)]
    pub paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticRemoveArgs {
    #[serde(default)]
    pub root_path: Option<String>,
    pub paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticQueryArgs {
    pub query: String,
    pub root_path: String,
    #[serde(default = "default_top_k")]
    pub top_k: usize,
    #[serde(default = "default_lane_cap")]
    pub lane_cap: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticStatusArgs {
    pub root_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticRebuildArgs {
    pub root_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticCompactArgs {
    pub root_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticSnippetCandidate {
    pub snippet_id: String,
    pub path: String,
    pub relative_path: String,
    pub start_line: usize,
    pub end_line: usize,
    pub text: String,
    pub text_hash: String,
    pub semantic_score: f32,
    pub lexical_score: f32,
    pub combined_score: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticQueryResult {
    pub candidates: Vec<SemanticSnippetCandidate>,
    pub total_candidates: usize,
    pub top_k: usize,
    pub lane_cap: usize,
    pub semantic_enabled: bool,
    pub backend: String,
    pub query_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticIndexStatus {
    pub root_path: String,
    pub semantic_enabled: bool,
    pub backend: String,
    pub file_count: usize,
    pub snippet_count: usize,
    pub vector_count: usize,
    pub last_indexed_at: Option<u64>,
    pub stale_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_load_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticMutationResult {
    pub processed_files: usize,
    pub processed_paths: Vec<String>,
    pub semantic_enabled: bool,
    pub backend: String,
}

#[derive(Debug, Clone)]
struct Chunk {
    start_line: usize,
    end_line: usize,
    text: String,
}

const EMBED_DIM: usize = 128;
const MODEL_DIR_NAME: &str = "all-MiniLM-L6-v2";
const MAX_FILE_BYTES: usize = 512 * 1024;
const CHUNK_LINES: usize = 48;
const CHUNK_OVERLAP: usize = 12;
const MAX_CHUNK_CHARS: usize = 3200;
const DEFAULT_EMBEDDING_BATCH: usize = 16;
const DEFAULT_MODEL_LOAD_TIMEOUT_MS: u64 = 8_000;

static EMBEDDER: OnceCell<Arc<Mutex<TextEmbedding>>> = OnceCell::new();

fn default_top_k() -> usize {
    24
}

fn default_lane_cap() -> usize {
    8
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn semantic_enabled() -> bool {
    match std::env::var("VOLT_SEMANTIC_INDEX") {
        Ok(value) => {
            value.eq_ignore_ascii_case("on") || value == "1" || value.eq_ignore_ascii_case("true")
        }
        Err(_) => true,
    }
}

fn semantic_backend_name() -> String {
    "local-onnx-fallback".to_string()
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
}

fn strip_long_prefix(path: String) -> String {
    #[cfg(windows)]
    {
        path.strip_prefix("\\\\?\\").unwrap_or(&path).to_string()
    }
    #[cfg(not(windows))]
    {
        path
    }
}

fn to_relative(path: &str, root: &str) -> String {
    let p = normalize_path(path);
    let r = normalize_path(root).trim_end_matches('/').to_string();
    let p_lower = p.to_lowercase();
    let r_lower = r.to_lowercase();
    if p_lower == r_lower {
        return ".".to_string();
    }
    if p_lower.starts_with(&(r_lower.clone() + "/")) {
        return p[r.len() + 1..].to_string();
    }
    p
}

fn hash_str(value: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn db_key_for_root(root_path: &str) -> String {
    hash_str(&normalize_path(root_path).to_lowercase())
}

fn db_path(app: &tauri::AppHandle, root_path: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve app cache dir: {e}"))?
        .join("semantic-index");
    fs::create_dir_all(&base)
        .map_err(|e| format!("Failed to create semantic index cache dir: {e}"))?;
    Ok(base.join(format!("semantic_{}.db", db_key_for_root(root_path))))
}

fn open_db(app: &tauri::AppHandle, root_path: &str) -> Result<Connection, String> {
    let path = db_path(app, root_path)?;
    let conn = Connection::open(path).map_err(|e| format!("Failed to open semantic DB: {e}"))?;
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS files (
            path TEXT PRIMARY KEY,
            mtime INTEGER,
            hash TEXT,
            language TEXT,
            indexed_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS snippets (
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL,
            start_line INTEGER NOT NULL,
            end_line INTEGER NOT NULL,
            text TEXT NOT NULL,
            text_hash TEXT NOT NULL,
            token_estimate INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS snippet_fts USING fts5(snippet_id UNINDEXED, text);
        CREATE TABLE IF NOT EXISTS snippet_vectors (
            snippet_id TEXT PRIMARY KEY,
            dim INTEGER NOT NULL,
            vector_blob BLOB NOT NULL,
            norm REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_snippets_path ON snippets(path);
        CREATE INDEX IF NOT EXISTS idx_files_indexed_at ON files(indexed_at);
        ",
    )
    .map_err(|e| format!("Failed to initialize semantic DB schema: {e}"))?;
    Ok(conn)
}

fn should_index_path(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    let binary_ext = [
        "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "pdf", "zip", "7z", "rar", "exe",
        "dll", "so", "dylib", "woff", "woff2", "ttf", "otf", "mp3", "wav", "ogg", "flac", "aac",
        "m4a", "mp4", "mov", "avi", "webm", "class", "jar", "bin", "wasm", "lock", "sqlite", "db",
    ];
    !binary_ext.contains(&ext.as_str())
}

fn detect_language(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("txt")
        .to_ascii_lowercase()
}

fn read_text_limited(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|e| format!("metadata failed: {e}"))?;
    if !metadata.is_file() {
        return Err("not a file".to_string());
    }
    if metadata.len() as usize > MAX_FILE_BYTES {
        return Err("file too large".to_string());
    }

    let mut file = fs::File::open(path).map_err(|e| format!("open failed: {e}"))?;
    let mut buf = Vec::with_capacity(metadata.len() as usize + 16);
    file.read_to_end(&mut buf)
        .map_err(|e| format!("read failed: {e}"))?;

    let text = String::from_utf8_lossy(&buf).to_string();
    if text.contains('\u{0}') {
        return Err("binary content".to_string());
    }
    Ok(text)
}

fn split_chunks(text: &str) -> Vec<Chunk> {
    let normalized = text.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    if lines.is_empty() {
        return Vec::new();
    }

    let mut out = Vec::new();
    let mut start = 1usize;

    while start <= lines.len() {
        let end = usize::min(lines.len(), start + CHUNK_LINES - 1);
        let mut chunk_text = lines[start - 1..end].join("\n");
        if chunk_text.len() > MAX_CHUNK_CHARS {
            chunk_text.truncate(MAX_CHUNK_CHARS);
        }
        if !chunk_text.trim().is_empty() {
            out.push(Chunk {
                start_line: start,
                end_line: end,
                text: chunk_text,
            });
        }

        if end == lines.len() {
            break;
        }
        start = end.saturating_sub(CHUNK_OVERLAP) + 1;
    }

    out
}

fn tokenize(value: &str) -> impl Iterator<Item = String> + '_ {
    value
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|t| !t.is_empty())
        .map(|t| t.to_ascii_lowercase())
}

fn embed_text_fallback(text: &str) -> Vec<f32> {
    let mut vec = vec![0.0f32; EMBED_DIM];
    for token in tokenize(text) {
        let h = hash_str(&token);
        let idx = usize::from_str_radix(&h[0..4], 16).unwrap_or(0) % EMBED_DIM;
        vec[idx] += 1.0;
    }

    let norm = vec.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 0.0 {
        for v in &mut vec {
            *v /= norm;
        }
    }
    vec
}

fn update_runtime_meta(state: &SemanticIndexState, patch: impl FnOnce(&mut SemanticRuntimeMeta)) {
    if let Ok(mut meta) = state.runtime_meta.lock() {
        patch(&mut meta);
    }
}

fn resolve_model_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(override_path) = std::env::var("VOLT_SEMANTIC_ONNX_MODEL") {
        let p = PathBuf::from(override_path);
        if p.exists() {
            return Some(p);
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("models").join(MODEL_DIR_NAME);
        if bundled.exists() {
            return Some(bundled);
        }
    }

    None
}

fn create_text_embedding(
    app: &tauri::AppHandle,
) -> Result<(TextEmbedding, Option<String>, u64), String> {
    let started = now_ms();
    let mut options = InitOptions::new(EmbeddingModel::AllMiniLML6V2)
        .with_show_download_progress(false)
        .with_execution_providers(Default::default());

    let mut model_path: Option<String> = None;
    if let Some(model_dir) = resolve_model_dir(app) {
        model_path = Some(normalize_path(&strip_long_prefix(
            model_dir.to_string_lossy().to_string(),
        )));
        options = options.with_cache_dir(model_dir);
    }

    let model = TextEmbedding::try_new(options)
        .map_err(|e| format!("Failed to initialize ONNX embedder: {e}"))?;
    let load_ms = now_ms().saturating_sub(started);
    if load_ms > DEFAULT_MODEL_LOAD_TIMEOUT_MS {
        tracing::warn!("Semantic ONNX model load took {}ms", load_ms);
    }
    Ok((model, model_path, load_ms))
}

fn get_embedder(
    app: &tauri::AppHandle,
    state: &SemanticIndexState,
) -> Result<Arc<Mutex<TextEmbedding>>, String> {
    if let Some(existing) = EMBEDDER.get() {
        return Ok(existing.clone());
    }

    let (embedder, model_path, model_load_ms) = create_text_embedding(app)?;
    let arc = Arc::new(Mutex::new(embedder));
    match EMBEDDER.set(arc.clone()) {
        Ok(()) => {
            update_runtime_meta(state, |meta| {
                meta.backend = "local-onnx".to_string();
                meta.model_path = model_path;
                meta.model_load_ms = Some(model_load_ms);
                meta.last_error = None;
            });
            Ok(arc)
        }
        Err(existing) => Ok(existing),
    }
}

fn embed_text(app: &tauri::AppHandle, state: &SemanticIndexState, text: &str) -> Vec<f32> {
    let embedder = match get_embedder(app, state) {
        Ok(e) => e,
        Err(err) => {
            update_runtime_meta(state, |meta| {
                meta.backend = "local-onnx-fallback".to_string();
                meta.last_error = Some(err);
            });
            return embed_text_fallback(text);
        }
    };

    let embedding = {
        let guard = match embedder.lock() {
            Ok(g) => g,
            Err(_) => {
                update_runtime_meta(state, |meta| {
                    meta.backend = "local-onnx-fallback".to_string();
                    meta.last_error = Some("Embedder lock poisoned".to_string());
                });
                return embed_text_fallback(text);
            }
        };
        guard.embed(vec![text], Some(DEFAULT_EMBEDDING_BATCH))
    };

    match embedding {
        Ok(vectors) if !vectors.is_empty() => {
            let mut v = vectors[0].clone();
            let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            if norm > 0.0 {
                for x in &mut v {
                    *x /= norm;
                }
            }
            update_runtime_meta(state, |meta| {
                meta.backend = "local-onnx".to_string();
                if meta.last_error.is_some() {
                    meta.last_error = None;
                }
            });
            v
        }
        Ok(_) => {
            update_runtime_meta(state, |meta| {
                meta.backend = "local-onnx-fallback".to_string();
                meta.last_error = Some("ONNX returned empty embedding".to_string());
            });
            embed_text_fallback(text)
        }
        Err(err) => {
            update_runtime_meta(state, |meta| {
                meta.backend = "local-onnx-fallback".to_string();
                meta.last_error = Some(format!("ONNX inference failed: {err}"));
            });
            embed_text_fallback(text)
        }
    }
}

fn vector_to_blob(vec: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(vec.len() * 4);
    for v in vec {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

fn blob_to_vector(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.is_empty() || b.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

fn lexical_score(text: &str, query: &str) -> f32 {
    let lower = text.to_ascii_lowercase();
    let mut score = 0.0f32;
    for token in tokenize(query) {
        if lower.contains(&token) {
            score += 1.0;
        }
    }
    score
}

fn delete_path_rows(conn: &mut Connection, path: &str) -> Result<(), String> {
    let ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM snippets WHERE path = ?1")
            .map_err(|e| format!("prepare snippet ids failed: {e}"))?;
        let rows = stmt
            .query_map(params![path], |row| row.get::<_, String>(0))
            .map_err(|e| format!("query snippet ids failed: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("read snippet id failed: {e}"))?);
        }
        out
    };

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("tx failed: {e}"))?;
    for id in &ids {
        tx.execute("DELETE FROM snippet_fts WHERE snippet_id = ?1", params![id])
            .map_err(|e| format!("delete fts failed: {e}"))?;
        tx.execute(
            "DELETE FROM snippet_vectors WHERE snippet_id = ?1",
            params![id],
        )
        .map_err(|e| format!("delete vector failed: {e}"))?;
    }
    tx.execute("DELETE FROM snippets WHERE path = ?1", params![path])
        .map_err(|e| format!("delete snippets failed: {e}"))?;
    tx.execute("DELETE FROM files WHERE path = ?1", params![path])
        .map_err(|e| format!("delete file row failed: {e}"))?;
    tx.commit().map_err(|e| format!("tx commit failed: {e}"))?;
    Ok(())
}

fn upsert_file(
    app: &tauri::AppHandle,
    state: &SemanticIndexState,
    conn: &mut Connection,
    root_path: &str,
    abs_path: &Path,
) -> Result<(), String> {
    if !should_index_path(abs_path) {
        return Ok(());
    }

    let full = strip_long_prefix(abs_path.to_string_lossy().to_string());
    let relative = to_relative(&full, root_path);
    let text = match read_text_limited(abs_path) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };

    delete_path_rows(conn, &relative)?;

    let text_hash = hash_str(&text);
    let metadata = fs::metadata(abs_path).map_err(|e| format!("metadata failed: {e}"))?;
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    conn.execute(
        "INSERT OR REPLACE INTO files(path, mtime, hash, language, indexed_at) VALUES(?1, ?2, ?3, ?4, ?5)",
        params![relative, mtime as i64, text_hash, detect_language(abs_path), now_ms() as i64],
    )
    .map_err(|e| format!("upsert file row failed: {e}"))?;

    let chunks = split_chunks(&text);
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("tx begin failed: {e}"))?;
    for chunk in chunks {
        let chunk_text = chunk.text;
        let chunk_hash = hash_str(&chunk_text);
        let snippet_id = hash_str(&format!(
            "{}:{}:{}:{}",
            relative, chunk.start_line, chunk.end_line, chunk_hash
        ));
        let token_estimate = tokenize(&chunk_text).count() as i64;
        let vec = embed_text(app, state, &chunk_text);
        let norm = vec.iter().map(|v| v * v).sum::<f32>().sqrt();
        let blob = vector_to_blob(&vec);
        let dim = vec.len() as i64;

        tx.execute(
            "INSERT OR REPLACE INTO snippets(id, path, start_line, end_line, text, text_hash, token_estimate) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![&snippet_id, &relative, chunk.start_line as i64, chunk.end_line as i64, &chunk_text, &chunk_hash, token_estimate],
        )
        .map_err(|e| format!("insert snippet failed: {e}"))?;

        tx.execute(
            "INSERT OR REPLACE INTO snippet_fts(snippet_id, text) VALUES(?1, ?2)",
            params![&snippet_id, &chunk_text],
        )
        .map_err(|e| format!("insert fts failed: {e}"))?;

        tx.execute(
            "INSERT OR REPLACE INTO snippet_vectors(snippet_id, dim, vector_blob, norm) VALUES(?1, ?2, ?3, ?4)",
            params![&snippet_id, dim, blob, norm],
        )
        .map_err(|e| format!("insert vector failed: {e}"))?;
    }
    tx.commit().map_err(|e| format!("tx commit failed: {e}"))?;

    Ok(())
}

fn collect_paths(root_path: &str, requested: &[String]) -> Result<Vec<PathBuf>, String> {
    if !requested.is_empty() {
        let mut out = Vec::new();
        for p in requested {
            let path = PathBuf::from(p);
            if path.is_absolute() {
                out.push(path);
            } else {
                out.push(Path::new(root_path).join(path));
            }
        }
        return Ok(out);
    }

    let root = PathBuf::from(root_path);
    if !root.exists() {
        return Err(format!("Root path does not exist: {root_path}"));
    }

    let mut include_builder = GlobSetBuilder::new();
    include_builder.add(Glob::new("**/*").map_err(|e| format!("glob build failed: {e}"))?);
    let include_set = include_builder
        .build()
        .map_err(|e| format!("glob set failed: {e}"))?;

    let walker = WalkBuilder::new(root_path)
        .hidden(false)
        .ignore(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .build();

    let mut out = Vec::new();
    for entry in walker {
        let e = match entry {
            Ok(v) => v,
            Err(_) => continue,
        };
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let rel = match p.strip_prefix(root_path) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if include_set.is_match(rel) {
            out.push(p.to_path_buf());
        }
    }

    Ok(out)
}

#[tauri::command]
pub fn semantic_index_upsert_files(
    app: tauri::AppHandle,
    state: tauri::State<'_, SemanticIndexState>,
    args: SemanticUpsertArgs,
) -> Result<SemanticMutationResult, String> {
    let enabled = semantic_enabled();
    let backend = state
        .runtime_meta
        .lock()
        .ok()
        .map(|m| m.backend.clone())
        .unwrap_or_else(semantic_backend_name);
    if !enabled {
        return Ok(SemanticMutationResult {
            processed_files: 0,
            processed_paths: Vec::new(),
            semantic_enabled: false,
            backend,
        });
    }

    let _guard = state
        .lock
        .lock()
        .map_err(|_| "Semantic index lock poisoned".to_string())?;
    let mut conn = open_db(&app, &args.root_path)?;
    let paths = collect_paths(&args.root_path, &args.paths)?;
    let mut processed = Vec::new();

    for abs in paths {
        if upsert_file(&app, &state, &mut conn, &args.root_path, &abs).is_ok() {
            processed.push(to_relative(
                &strip_long_prefix(abs.to_string_lossy().to_string()),
                &args.root_path,
            ));
        }
    }

    Ok(SemanticMutationResult {
        processed_files: processed.len(),
        processed_paths: processed,
        semantic_enabled: true,
        backend,
    })
}

#[tauri::command]
pub fn semantic_index_remove_paths(
    app: tauri::AppHandle,
    state: tauri::State<'_, SemanticIndexState>,
    args: SemanticRemoveArgs,
) -> Result<SemanticMutationResult, String> {
    let enabled = semantic_enabled();
    let backend = state
        .runtime_meta
        .lock()
        .ok()
        .map(|m| m.backend.clone())
        .unwrap_or_else(semantic_backend_name);
    if !enabled {
        return Ok(SemanticMutationResult {
            processed_files: 0,
            processed_paths: Vec::new(),
            semantic_enabled: false,
            backend,
        });
    }

    if args.paths.is_empty() {
        return Ok(SemanticMutationResult {
            processed_files: 0,
            processed_paths: Vec::new(),
            semantic_enabled: true,
            backend,
        });
    }

    let _guard = state
        .lock
        .lock()
        .map_err(|_| "Semantic index lock poisoned".to_string())?;

    let normalized_paths: Vec<String> =
        args.paths.into_iter().map(|p| normalize_path(&p)).collect();
    let mut removed: Vec<String> = Vec::new();

    if let Some(root) = args.root_path.as_deref() {
        let root_norm = normalize_path(root);
        let mut conn = open_db(&app, &root_norm)?;
        for p in &normalized_paths {
            let rel = to_relative(p, &root_norm);
            if delete_path_rows(&mut conn, &rel).is_ok() {
                removed.push(rel);
            }
        }
    } else {
        // Fallback path for callers that do not provide rootPath.
        let cache_dir = app
            .path()
            .app_cache_dir()
            .map_err(|e| format!("Failed to resolve app cache dir: {e}"))?
            .join("semantic-index");
        if cache_dir.exists() {
            for entry in fs::read_dir(cache_dir)
                .map_err(|e| format!("Read semantic cache dir failed: {e}"))?
            {
                let entry = entry.map_err(|e| format!("Read cache dir entry failed: {e}"))?;
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("db") {
                    continue;
                }
                let mut conn =
                    Connection::open(&path).map_err(|e| format!("Open semantic DB failed: {e}"))?;
                for p in &normalized_paths {
                    if delete_path_rows(&mut conn, p).is_ok() {
                        removed.push(p.clone());
                    }
                }
            }
        }
    }

    Ok(SemanticMutationResult {
        processed_files: removed.len(),
        processed_paths: removed,
        semantic_enabled: true,
        backend,
    })
}

#[tauri::command]
pub fn semantic_index_query(
    app: tauri::AppHandle,
    state: tauri::State<'_, SemanticIndexState>,
    args: SemanticQueryArgs,
) -> Result<SemanticQueryResult, String> {
    let enabled = semantic_enabled();
    let backend = state
        .runtime_meta
        .lock()
        .ok()
        .map(|m| m.backend.clone())
        .unwrap_or_else(semantic_backend_name);
    if !enabled {
        return Ok(SemanticQueryResult {
            candidates: Vec::new(),
            total_candidates: 0,
            top_k: args.top_k,
            lane_cap: args.lane_cap,
            semantic_enabled: false,
            backend,
            query_ms: 0,
        });
    }

    let query = args.query.trim();
    if query.is_empty() {
        return Ok(SemanticQueryResult {
            candidates: Vec::new(),
            total_candidates: 0,
            top_k: args.top_k,
            lane_cap: args.lane_cap,
            semantic_enabled: true,
            backend,
            query_ms: 0,
        });
    }

    let started = now_ms();
    let _guard = state
        .lock
        .lock()
        .map_err(|_| "Semantic index lock poisoned".to_string())?;
    let conn = open_db(&app, &args.root_path)?;

    let q_embed = embed_text(&app, &state, query);

    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.path, s.start_line, s.end_line, s.text, s.text_hash, v.dim, v.vector_blob
             FROM snippets s
             JOIN snippet_vectors v ON v.snippet_id = s.id
             ORDER BY s.rowid DESC
             LIMIT 600",
        )
        .map_err(|e| format!("prepare semantic query failed: {e}"))?;

    let mut rows = stmt
        .query([])
        .map_err(|e| format!("execute semantic query failed: {e}"))?;

    let mut out: Vec<SemanticSnippetCandidate> = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| format!("read semantic row failed: {e}"))?
    {
        let snippet_id: String = row
            .get(0)
            .map_err(|e| format!("read snippet id failed: {e}"))?;
        let path: String = row.get(1).map_err(|e| format!("read path failed: {e}"))?;
        let start_line: i64 = row
            .get(2)
            .map_err(|e| format!("read start line failed: {e}"))?;
        let end_line: i64 = row
            .get(3)
            .map_err(|e| format!("read end line failed: {e}"))?;
        let text: String = row.get(4).map_err(|e| format!("read text failed: {e}"))?;
        let text_hash: String = row
            .get(5)
            .map_err(|e| format!("read text hash failed: {e}"))?;
        let dim: i64 = row
            .get(6)
            .map_err(|e| format!("read vector dim failed: {e}"))?;
        let blob: Vec<u8> = row
            .get(7)
            .map_err(|e| format!("read vector blob failed: {e}"))?;

        let vector_dim = usize::try_from(dim).unwrap_or(0);
        if vector_dim == 0 || vector_dim != q_embed.len() {
            continue;
        }

        let emb = blob_to_vector(&blob);
        let sem = cosine_similarity(&q_embed, &emb);
        if sem <= 0.0 {
            continue;
        }
        let lex = lexical_score(&text, query);
        let combined = sem * 0.7 + lex * 0.3;

        out.push(SemanticSnippetCandidate {
            snippet_id,
            path: path.clone(),
            relative_path: path,
            start_line: usize::try_from(start_line).unwrap_or(1),
            end_line: usize::try_from(end_line).unwrap_or(1),
            text,
            text_hash,
            semantic_score: sem,
            lexical_score: lex,
            combined_score: combined,
        });
    }

    out.sort_by(|a, b| {
        b.combined_score
            .partial_cmp(&a.combined_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let lane_cap = args.lane_cap.max(1);
    let top_k = args.top_k.max(1);
    let limited = out
        .into_iter()
        .take(top_k.max(lane_cap))
        .collect::<Vec<_>>();
    let total = limited.len();
    let final_candidates = limited.into_iter().take(top_k).collect::<Vec<_>>();

    Ok(SemanticQueryResult {
        candidates: final_candidates,
        total_candidates: total,
        top_k,
        lane_cap,
        semantic_enabled: true,
        backend,
        query_ms: now_ms().saturating_sub(started),
    })
}

#[tauri::command]
pub fn semantic_index_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, SemanticIndexState>,
    args: SemanticStatusArgs,
) -> Result<SemanticIndexStatus, String> {
    let enabled = semantic_enabled();
    let runtime_meta = state
        .runtime_meta
        .lock()
        .ok()
        .map(|m| m.clone())
        .unwrap_or_default();
    let backend = runtime_meta.backend.clone();
    if !enabled {
        return Ok(SemanticIndexStatus {
            root_path: args.root_path,
            semantic_enabled: false,
            backend,
            file_count: 0,
            snippet_count: 0,
            vector_count: 0,
            last_indexed_at: None,
            stale_ms: None,
            model_path: runtime_meta.model_path,
            model_load_ms: runtime_meta.model_load_ms,
            last_error: runtime_meta.last_error,
        });
    }

    let _guard = state
        .lock
        .lock()
        .map_err(|_| "Semantic index lock poisoned".to_string())?;
    let conn = open_db(&app, &args.root_path)?;

    let file_count: usize = conn
        .query_row("SELECT COUNT(*) FROM files", [], |row| row.get::<_, i64>(0))
        .map(|v| usize::try_from(v).unwrap_or(0))
        .unwrap_or(0);
    let snippet_count: usize = conn
        .query_row("SELECT COUNT(*) FROM snippets", [], |row| {
            row.get::<_, i64>(0)
        })
        .map(|v| usize::try_from(v).unwrap_or(0))
        .unwrap_or(0);
    let vector_count: usize = conn
        .query_row("SELECT COUNT(*) FROM snippet_vectors", [], |row| {
            row.get::<_, i64>(0)
        })
        .map(|v| usize::try_from(v).unwrap_or(0))
        .unwrap_or(0);

    let last_indexed_at: Option<u64> = conn
        .query_row("SELECT MAX(indexed_at) FROM files", [], |row| {
            row.get::<_, Option<i64>>(0)
        })
        .ok()
        .flatten()
        .and_then(|v| u64::try_from(v).ok());

    let stale_ms = last_indexed_at.map(|t| now_ms().saturating_sub(t));

    Ok(SemanticIndexStatus {
        root_path: args.root_path,
        semantic_enabled: true,
        backend,
        file_count,
        snippet_count,
        vector_count,
        last_indexed_at,
        stale_ms,
        model_path: runtime_meta.model_path,
        model_load_ms: runtime_meta.model_load_ms,
        last_error: runtime_meta.last_error,
    })
}

#[tauri::command]
pub fn semantic_index_rebuild(
    app: tauri::AppHandle,
    state: tauri::State<'_, SemanticIndexState>,
    args: SemanticRebuildArgs,
) -> Result<SemanticMutationResult, String> {
    let enabled = semantic_enabled();
    let backend = state
        .runtime_meta
        .lock()
        .ok()
        .map(|m| m.backend.clone())
        .unwrap_or_else(semantic_backend_name);
    if !enabled {
        return Ok(SemanticMutationResult {
            processed_files: 0,
            processed_paths: Vec::new(),
            semantic_enabled: false,
            backend,
        });
    }

    let _guard = state
        .lock
        .lock()
        .map_err(|_| "Semantic index lock poisoned".to_string())?;
    let mut conn = open_db(&app, &args.root_path)?;
    conn.execute("DELETE FROM snippet_fts", [])
        .map_err(|e| format!("clear snippet_fts failed: {e}"))?;
    conn.execute("DELETE FROM snippet_vectors", [])
        .map_err(|e| format!("clear snippet_vectors failed: {e}"))?;
    conn.execute("DELETE FROM snippets", [])
        .map_err(|e| format!("clear snippets failed: {e}"))?;
    conn.execute("DELETE FROM files", [])
        .map_err(|e| format!("clear files failed: {e}"))?;

    let paths = collect_paths(&args.root_path, &[])?;
    let mut processed = Vec::new();
    for abs in paths {
        if upsert_file(&app, &state, &mut conn, &args.root_path, &abs).is_ok() {
            processed.push(to_relative(
                &strip_long_prefix(abs.to_string_lossy().to_string()),
                &args.root_path,
            ));
        }
    }

    Ok(SemanticMutationResult {
        processed_files: processed.len(),
        processed_paths: processed,
        semantic_enabled: true,
        backend,
    })
}

#[tauri::command]
pub fn semantic_index_compact(
    app: tauri::AppHandle,
    state: tauri::State<'_, SemanticIndexState>,
    args: SemanticCompactArgs,
) -> Result<SemanticMutationResult, String> {
    let enabled = semantic_enabled();
    let backend = state
        .runtime_meta
        .lock()
        .ok()
        .map(|m| m.backend.clone())
        .unwrap_or_else(semantic_backend_name);
    if !enabled {
        return Ok(SemanticMutationResult {
            processed_files: 0,
            processed_paths: Vec::new(),
            semantic_enabled: false,
            backend,
        });
    }

    let _guard = state
        .lock
        .lock()
        .map_err(|_| "Semantic index lock poisoned".to_string())?;
    let conn = open_db(&app, &args.root_path)?;
    conn.execute_batch("INSERT INTO snippet_fts(snippet_fts) VALUES('optimize'); VACUUM;")
        .map_err(|e| format!("semantic compact failed: {e}"))?;

    Ok(SemanticMutationResult {
        processed_files: 0,
        processed_paths: Vec::new(),
        semantic_enabled: true,
        backend,
    })
}
