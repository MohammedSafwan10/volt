//! MCP (Model Context Protocol) Client Implementation
//! Pure Rust with async I/O for performance.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio::time::{sleep, Duration};

#[cfg(windows)]
#[allow(unused_imports)]
use std::os::windows::process::CommandExt;

static REQUEST_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub disabled: bool,
    #[serde(default)]
    pub auto_approve: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpTool {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub input_schema: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpServerState {
    pub id: String,
    pub name: String,
    pub status: String,
    pub tools: Vec<McpTool>,
    pub error: Option<String>,
}

struct McpProcess {
    child: Child,
    stdin_tx: mpsc::Sender<String>,
    tools: Vec<McpTool>,
    pending: Arc<RwLock<HashMap<u64, tokio::sync::oneshot::Sender<Value>>>>,
}

pub struct McpState {
    servers: Mutex<HashMap<String, McpProcess>>,
    states: RwLock<HashMap<String, McpServerState>>,
}

impl McpState {
    pub fn new() -> Self {
        Self {
            servers: Mutex::new(HashMap::new()),
            states: RwLock::new(HashMap::new()),
        }
    }
}

impl Default for McpState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Serialize)]
struct JsonRpcRequest {
    jsonrpc: &'static str,
    id: u64,
    method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
}

#[derive(Deserialize)]
struct JsonRpcResponse {
    id: Option<u64>,
    result: Option<Value>,
    error: Option<JsonRpcError>,
}

#[derive(Deserialize)]
struct JsonRpcError {
    code: i64,
    message: String,
}

#[derive(Clone, Serialize)]
struct McpServerEvent {
    server_id: String,
    state: McpServerState,
}

fn log_mcp(server_id: &str, message: &str) {
    eprintln!("[MCP:{}] {}", server_id, message);
}

fn normalize_mcp_command(command: &str) -> String {
    Path::new(command.trim().trim_matches('"').trim_matches('\''))
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command.trim())
        .to_ascii_lowercase()
}

fn is_allowed_mcp_command(command: &str) -> bool {
    matches!(
        normalize_mcp_command(command).as_str(),
        "npx"
            | "npx.cmd"
            | "node"
            | "node.exe"
            | "uvx"
            | "uvx.cmd"
            | "uv"
            | "uv.exe"
            | "python"
            | "python.exe"
            | "python3"
            | "python3.exe"
            | "deno"
            | "deno.exe"
            | "bun"
            | "bun.exe"
            | "bunx"
            | "bunx.cmd"
    )
}

fn validate_mcp_server_id(server_id: &str) -> Result<(), String> {
    let trimmed = server_id.trim();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return Err("Invalid MCP server id length".to_string());
    }

    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(format!("Invalid MCP server id: {}", server_id));
    }

    Ok(())
}

fn validate_mcp_args(args: &[String]) -> Result<(), String> {
    for arg in args {
        if arg.len() > 4096 {
            return Err("MCP argument too long".to_string());
        }
        if arg.chars().any(|c| c == '\0' || c == '\r' || c == '\n') {
            return Err("MCP arguments cannot contain control characters".to_string());
        }
    }
    Ok(())
}

fn validate_mcp_env(env: &HashMap<String, String>) -> Result<(), String> {
    const BLOCKED_ENV_KEYS: &[&str] = &[
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "DYLD_LIBRARY_PATH",
        "NODE_OPTIONS",
        "PYTHONPATH",
        "RUSTC_WRAPPER",
        "COMSPEC",
    ];

    for (key, value) in env {
        let trimmed = key.trim();
        if trimmed.is_empty()
            || trimmed.len() > 64
            || !trimmed
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        {
            return Err(format!("Invalid MCP env key: {}", key));
        }
        if BLOCKED_ENV_KEYS.contains(&trimmed) {
            return Err(format!("Blocked MCP env key: {}", key));
        }
        if value.len() > 8192 || value.chars().any(|c| c == '\0') {
            return Err(format!("Invalid MCP env value for key: {}", key));
        }
    }

    Ok(())
}

fn validate_auto_approve_entries(entries: &[String]) -> Result<(), String> {
    for entry in entries {
        let trimmed = entry.trim();
        if trimmed.is_empty() || trimmed.len() > 128 {
            return Err("Invalid MCP auto-approve entry length".to_string());
        }

        if trimmed != "*"
            && !trimmed
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
        {
            return Err(format!("Invalid MCP auto-approve entry: {}", entry));
        }
    }

    Ok(())
}

fn validate_mcp_config_content(content: &str) -> Result<(), String> {
    let parsed: Value =
        serde_json::from_str(content).map_err(|e| format!("Invalid MCP config JSON: {}", e))?;

    let Some(servers_value) = parsed.get("mcpServers") else {
        return Ok(());
    };

    let servers = servers_value
        .as_object()
        .ok_or_else(|| "mcpServers must be a JSON object".to_string())?;

    for (server_id, server_value) in servers {
        validate_mcp_server_id(server_id)?;
        let config: McpServerConfig = serde_json::from_value(server_value.clone())
            .map_err(|e| format!("Invalid config for MCP server '{}': {}", server_id, e))?;
        if !is_allowed_mcp_command(&config.command) {
            return Err(format!(
                "Blocked MCP command '{}' for server '{}'",
                config.command, server_id
            ));
        }
        validate_mcp_args(&config.args)?;
        validate_mcp_env(&config.env)?;
        validate_auto_approve_entries(&config.auto_approve)?;
    }

    Ok(())
}

fn emit_state(app: &AppHandle, id: &str, state: &McpServerState) {
    let _ = app.emit(
        "mcp://server-state",
        McpServerEvent {
            server_id: id.to_string(),
            state: state.clone(),
        },
    );
}

fn should_retry_managed_start(error: &str) -> bool {
    let normalized = error.trim().to_ascii_lowercase();
    normalized.contains("timed out") || normalized.contains("timeout")
}

async fn set_error(app: &AppHandle, mcp: &McpState, id: &str, err: &str) {
    let mut states = mcp.states.write().await;
    if let Some(s) = states.get_mut(id) {
        s.status = "error".to_string();
        s.error = Some(err.to_string());
        emit_state(app, id, s);
    }
}

async fn send_req(
    tx: &mpsc::Sender<String>,
    pending: &Arc<RwLock<HashMap<u64, tokio::sync::oneshot::Sender<Value>>>>,
    method: &str,
    params: Option<Value>,
    timeout: u64,
) -> Result<Value, String> {
    let id = REQUEST_ID.fetch_add(1, Ordering::SeqCst);
    let req = serde_json::to_string(&JsonRpcRequest {
        jsonrpc: "2.0",
        id,
        method: method.to_string(),
        params,
    })
    .map_err(|e| e.to_string())?;

    let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();
    {
        pending.write().await.insert(id, resp_tx);
    }

    tx.send(req).await.map_err(|e| e.to_string())?;

    match tokio::time::timeout(std::time::Duration::from_secs(timeout), resp_rx).await {
        Ok(Ok(r)) => {
            if let Some(e) = r.get("error") {
                Err(format!(
                    "MCP: {}",
                    e.get("message").and_then(|m| m.as_str()).unwrap_or("error")
                ))
            } else {
                Ok(r)
            }
        }
        Ok(Err(_)) => Err("Channel closed".to_string()),
        Err(_) => {
            pending.write().await.remove(&id);
            Err("Timeout".to_string())
        }
    }
}

async fn send_notif(
    tx: &mpsc::Sender<String>,
    method: &str,
    params: Option<Value>,
) -> Result<(), String> {
    let msg = serde_json::to_string(
        &json!({"jsonrpc": "2.0", "method": method, "params": params.unwrap_or(json!({}))}),
    )
    .map_err(|e| e.to_string())?;
    tx.send(msg).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_mcp_server(
    app: AppHandle,
    server_id: String,
    config: McpServerConfig,
) -> Result<McpServerState, String> {
    let mcp = app.state::<McpState>();
    validate_mcp_server_id(&server_id)?;
    if !is_allowed_mcp_command(&config.command) {
        return Err(format!(
            "Blocked MCP command '{}': only trusted launcher binaries are allowed",
            config.command
        ));
    }
    validate_mcp_args(&config.args)?;
    validate_mcp_env(&config.env)?;
    validate_auto_approve_entries(&config.auto_approve)?;
    log_mcp(
        &server_id,
        &format!("starting '{}' {:?}", config.command, config.args),
    );

    // Stop if running
    if mcp.servers.lock().await.contains_key(&server_id) {
        let _ = stop_mcp_server(app.clone(), server_id.clone()).await;
    }

    // Set connecting
    let init_state = McpServerState {
        id: server_id.clone(),
        name: server_id.clone(),
        status: "connecting".to_string(),
        tools: vec![],
        error: None,
    };
    mcp.states
        .write()
        .await
        .insert(server_id.clone(), init_state.clone());
    emit_state(&app, &server_id, &init_state);

    // Spawn process - handle Windows command resolution
    let cmd_name = if cfg!(windows) {
        // On Windows, resolve .cmd/.bat extensions for npm/npx/yarn etc
        match config.command.as_str() {
            "npx" => "npx.cmd".to_string(),
            "npm" => "npm.cmd".to_string(),
            "yarn" => "yarn.cmd".to_string(),
            "pnpm" => "pnpm.cmd".to_string(),
            "bunx" => "bunx.cmd".to_string(),
            "bun" => "bun.exe".to_string(),
            "deno" => "deno.exe".to_string(),
            "node" => "node.exe".to_string(),
            "python" => "python.exe".to_string(),
            "python3" => "python3.exe".to_string(),
            "uvx" => "uvx.cmd".to_string(),
            "uv" => "uv.exe".to_string(),
            other => other.to_string(),
        }
    } else {
        config.command.clone()
    };

    let mut cmd = Command::new(&cmd_name);
    cmd.args(&config.args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    for (k, v) in &config.env {
        cmd.env(k, v);
    }

    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().map_err(|e| {
        let msg = format!("Spawn failed: {}", e);
        log_mcp(&server_id, &msg);
        msg
    })?;
    let stdin = child.stdin.take().ok_or("No stdin")?;
    let stdout = child.stdout.take().ok_or("No stdout")?;
    let stderr = child.stderr.take();

    let (tx, mut rx) = mpsc::channel::<String>(100);
    let pending: Arc<RwLock<HashMap<u64, tokio::sync::oneshot::Sender<Value>>>> =
        Arc::new(RwLock::new(HashMap::new()));

    // Stdin writer
    tokio::spawn(async move {
        let mut stdin: ChildStdin = stdin;
        while let Some(msg) = rx.recv().await {
            if stdin.write_all(msg.as_bytes()).await.is_err() {
                break;
            }
            if stdin.write_all(b"\n").await.is_err() {
                break;
            }
            let _ = stdin.flush().await;
        }
    });

    // Stderr logger
    if let Some(stderr) = stderr {
        let app2 = app.clone();
        let sid = server_id.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.is_empty() {
                    log_mcp(&sid, &format!("stderr: {}", line));
                    let _ = app2.emit(
                        "mcp://server-log",
                        json!({"server_id": sid, "message": line}),
                    );
                }
            }
        });
    }

    // Stdout reader
    let pending2 = pending.clone();
    let app2 = app.clone();
    let sid = server_id.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<JsonRpcResponse>(&line) {
                Ok(resp) => {
                    if let Some(id) = resp.id {
                        if let Some(sender) = pending2.write().await.remove(&id) {
                            let result = match resp.error {
                                Some(e) => json!({"error": {"code": e.code, "message": e.message}}),
                                None => resp.result.unwrap_or(Value::Null),
                            };
                            let _ = sender.send(result);
                        } else {
                            log_mcp(
                                &sid,
                                &format!("stdout response for unknown id {}: {}", id, line),
                            );
                        }
                    } else {
                        // Server notification or malformed response without id.
                        let _ = app2.emit(
                            "mcp://server-log",
                            json!({"server_id": sid, "message": format!("stdout notification: {}", line)}),
                        );
                    }
                }
                Err(_) => {
                    // Many misconfigured servers log to stdout, which breaks JSON-RPC;
                    // surface this clearly so users can diagnose timeouts.
                    log_mcp(&sid, &format!("non-json stdout: {}", line));
                    let _ = app2.emit(
                        "mcp://server-log",
                        json!({"server_id": sid, "message": format!("non-json stdout: {}", line)}),
                    );
                }
            }
        }
        // Fail all pending RPCs immediately when process stdout closes so callers
        // don't wait for long timeouts after the server has already exited.
        {
            let mut pending_map = pending2.write().await;
            for (_id, sender) in pending_map.drain() {
                let _ = sender.send(json!({
                    "error": {
                        "code": -32000,
                        "message": format!("MCP server '{}' exited before responding", sid)
                    }
                }));
            }
        }
        log_mcp(&sid, "stdout closed; server stopped");
        let _ = app2.emit("mcp://server-stopped", &sid);
    });

    // Store
    mcp.servers.lock().await.insert(
        server_id.clone(),
        McpProcess {
            child,
            stdin_tx: tx.clone(),
            tools: vec![],
            pending: pending.clone(),
        },
    );

    // Initialize - use longer timeout for remote/slow servers
    if let Err(e) = send_req(
        &tx,
        &pending,
        "initialize",
        Some(json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "clientInfo": {"name": "volt", "version": "1.0.0"}
        })),
        300,
    )
    .await
    {
        let error_msg = if e == "Timeout" {
            format!("Server '{}' timed out during initialization (300s). Check network or server status.", server_id)
        } else {
            e
        };
        log_mcp(&server_id, &format!("initialize failed: {}", error_msg));
        set_error(&app, &mcp, &server_id, &error_msg).await;
        let _ = stop_mcp_server(app.clone(), server_id.clone()).await;
        return Err(error_msg);
    }

    let _ = send_notif(&tx, "notifications/initialized", None).await;

    // Get tools - use longer timeout for remote servers
    let tools: Vec<McpTool> = match send_req(&tx, &pending, "tools/list", None, 60).await {
        Ok(r) => r
            .get("tools")
            .and_then(|t| t.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| serde_json::from_value::<McpTool>(t.clone()).ok())
                    .collect()
            })
            .unwrap_or_default(),
        Err(e) => {
            let error_msg = if e == "Timeout" {
                format!(
                    "Server '{}' timed out listing tools (60s). Check network or server status.",
                    server_id
                )
            } else {
                e
            };
            log_mcp(&server_id, &format!("tools/list failed: {}", error_msg));
            set_error(&app, &mcp, &server_id, &error_msg).await;
            return Err(error_msg);
        }
    };

    // Final state
    let final_state = McpServerState {
        id: server_id.clone(),
        name: server_id.clone(),
        status: "connected".to_string(),
        tools: tools.clone(),
        error: None,
    };
    mcp.states
        .write()
        .await
        .insert(server_id.clone(), final_state.clone());
    if let Some(s) = mcp.servers.lock().await.get_mut(&server_id) {
        s.tools = tools;
    }
    emit_state(&app, &server_id, &final_state);
    log_mcp(
        &server_id,
        &format!("connected with {} tools", final_state.tools.len()),
    );

    Ok(final_state)
}

#[tauri::command]
pub async fn start_mcp_server_managed(
    app: AppHandle,
    server_id: String,
    config: McpServerConfig,
    max_retries: Option<u32>,
    retry_delay_ms: Option<u64>,
) -> Result<McpServerState, String> {
    let max_retries = max_retries.unwrap_or(3).max(1);
    let retry_delay_ms = retry_delay_ms.unwrap_or(30_000);
    let mut attempt = 0;

    loop {
        attempt += 1;

        match start_mcp_server(app.clone(), server_id.clone(), config.clone()).await {
            Ok(state) => return Ok(state),
            Err(error) => {
                if attempt >= max_retries || !should_retry_managed_start(&error) {
                    return Err(error);
                }

                log_mcp(
                    &server_id,
                    &format!(
                        "managed retry scheduled in {}ms (attempt {}/{})",
                        retry_delay_ms,
                        attempt + 1,
                        max_retries
                    ),
                );
                sleep(Duration::from_millis(retry_delay_ms)).await;
            }
        }
    }
}

#[tauri::command]
pub async fn start_mcp_servers_managed(
    app: AppHandle,
    servers: HashMap<String, McpServerConfig>,
    max_retries: Option<u32>,
    retry_delay_ms: Option<u64>,
) -> Result<Vec<McpServerState>, String> {
    let mcp = app.state::<McpState>();
    let mut server_ids = servers.keys().cloned().collect::<Vec<_>>();
    server_ids.sort();

    let mut states = Vec::with_capacity(server_ids.len());

    for server_id in server_ids {
        let Some(config) = servers.get(&server_id).cloned() else {
            continue;
        };

        match start_mcp_server_managed(
            app.clone(),
            server_id.clone(),
            config,
            max_retries,
            retry_delay_ms,
        )
        .await
        {
            Ok(state) => states.push(state),
            Err(error) => {
                set_error(&app, &mcp, &server_id, &error).await;
                if let Some(state) = mcp.states.read().await.get(&server_id).cloned() {
                    states.push(state);
                } else {
                    states.push(McpServerState {
                        id: server_id.clone(),
                        name: server_id,
                        status: "error".to_string(),
                        tools: vec![],
                        error: Some(error),
                    });
                }
            }
        }
    }

    Ok(states)
}

#[tauri::command]
pub async fn stop_mcp_server(app: AppHandle, server_id: String) -> Result<(), String> {
    let mcp = app.state::<McpState>();
    log_mcp(&server_id, "stopping");
    if let Some(mut p) = mcp.servers.lock().await.remove(&server_id) {
        let _ = p.child.kill().await;
    }
    if let Some(s) = mcp.states.write().await.get_mut(&server_id) {
        s.status = "stopped".to_string();
        s.error = None;
        emit_state(&app, &server_id, s);
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_all_mcp_servers(app: AppHandle) -> Result<(), String> {
    let mcp = app.state::<McpState>();
    let ids: Vec<String> = {
        let servers = mcp.servers.lock().await;
        let states = mcp.states.read().await;
        servers.keys().chain(states.keys()).cloned().collect()
    };
    for id in ids {
        let _ = stop_mcp_server(app.clone(), id).await;
    }
    mcp.states.write().await.clear();
    Ok(())
}

#[tauri::command]
pub async fn call_mcp_tool(
    app: AppHandle,
    server_id: String,
    tool_name: String,
    arguments: Value,
) -> Result<Value, String> {
    let mcp = app.state::<McpState>();
    let (tx, pending) = {
        let servers = mcp.servers.lock().await;
        let s = servers
            .get(&server_id)
            .ok_or_else(|| format!("Server '{}' not found", server_id))?;
        (s.stdin_tx.clone(), s.pending.clone())
    };
    send_req(
        &tx,
        &pending,
        "tools/call",
        Some(json!({"name": tool_name, "arguments": arguments})),
        120,
    )
    .await
}

#[tauri::command]
pub async fn get_mcp_servers(app: AppHandle) -> Result<Vec<McpServerState>, String> {
    Ok(app
        .state::<McpState>()
        .states
        .read()
        .await
        .values()
        .cloned()
        .collect())
}

#[tauri::command]
pub async fn get_mcp_tools(app: AppHandle) -> Result<Vec<(String, McpTool)>, String> {
    let mcp = app.state::<McpState>();
    let mut all = Vec::new();
    for (id, s) in mcp.servers.lock().await.iter() {
        for t in &s.tools {
            all.push((id.clone(), t.clone()));
        }
    }
    Ok(all)
}

#[tauri::command]
pub fn get_mcp_config_path() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    Ok(home
        .join(".volt/settings/mcp.json")
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
pub fn ensure_mcp_config(default_content: String) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let dir = home.join(".volt/settings");
    let path = dir.join("mcp.json");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    if !path.exists() {
        std::fs::write(&path, &default_content).map_err(|e| e.to_string())?;
    }
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn write_mcp_config(content: String) -> Result<(), String> {
    validate_mcp_config_content(&content)?;
    let home = dirs::home_dir().ok_or("No home dir")?;
    let dir = home.join(".volt/settings");
    let path = dir.join("mcp.json");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, &content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_mcp_config() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let path = home.join(".volt/settings/mcp.json");
    if !path.exists() {
        return Err("Config not found".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}
