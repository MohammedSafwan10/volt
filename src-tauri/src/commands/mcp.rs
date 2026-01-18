//! MCP (Model Context Protocol) Client Implementation
//! Pure Rust with async I/O for performance.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, Mutex, RwLock};

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
    fn default() -> Self { Self::new() }
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

fn emit_state(app: &AppHandle, id: &str, state: &McpServerState) {
    let _ = app.emit("mcp://server-state", McpServerEvent {
        server_id: id.to_string(),
        state: state.clone(),
    });
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
        jsonrpc: "2.0", id, method: method.to_string(), params
    }).map_err(|e| e.to_string())?;

    let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();
    { pending.write().await.insert(id, resp_tx); }

    tx.send(req).await.map_err(|e| e.to_string())?;

    match tokio::time::timeout(std::time::Duration::from_secs(timeout), resp_rx).await {
        Ok(Ok(r)) => {
            if let Some(e) = r.get("error") {
                Err(format!("MCP: {}", e.get("message").and_then(|m| m.as_str()).unwrap_or("error")))
            } else { Ok(r) }
        }
        Ok(Err(_)) => Err("Channel closed".to_string()),
        Err(_) => { pending.write().await.remove(&id); Err("Timeout".to_string()) }
    }
}

async fn send_notif(tx: &mpsc::Sender<String>, method: &str, params: Option<Value>) -> Result<(), String> {
    let msg = serde_json::to_string(&json!({"jsonrpc": "2.0", "method": method, "params": params.unwrap_or(json!({}))}))
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
    
    // Stop if running
    if mcp.servers.lock().await.contains_key(&server_id) {
        let _ = stop_mcp_server(app.clone(), server_id.clone()).await;
    }

    // Set connecting
    let init_state = McpServerState {
        id: server_id.clone(), name: server_id.clone(),
        status: "connecting".to_string(), tools: vec![], error: None,
    };
    mcp.states.write().await.insert(server_id.clone(), init_state.clone());
    emit_state(&app, &server_id, &init_state);

    // Spawn process - handle Windows command resolution
    let cmd_name = if cfg!(windows) {
        // On Windows, resolve .cmd/.bat extensions for npm/npx/yarn etc
        match config.command.as_str() {
            "npx" => "npx.cmd".to_string(),
            "npm" => "npm.cmd".to_string(),
            "yarn" => "yarn.cmd".to_string(),
            "pnpm" => "pnpm.cmd".to_string(),
            "node" => "node.exe".to_string(),
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
    
    for (k, v) in &config.env { cmd.env(k, v); }

    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().map_err(|e| format!("Spawn failed: {}", e))?;
    let stdin = child.stdin.take().ok_or("No stdin")?;
    let stdout = child.stdout.take().ok_or("No stdout")?;
    let stderr = child.stderr.take();

    let (tx, mut rx) = mpsc::channel::<String>(100);
    let pending: Arc<RwLock<HashMap<u64, tokio::sync::oneshot::Sender<Value>>>> = Arc::new(RwLock::new(HashMap::new()));

    // Stdin writer
    tokio::spawn(async move {
        let mut stdin: ChildStdin = stdin;
        while let Some(msg) = rx.recv().await {
            if stdin.write_all(msg.as_bytes()).await.is_err() { break; }
            if stdin.write_all(b"\n").await.is_err() { break; }
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
                    let _ = app2.emit("mcp://server-log", json!({"server_id": sid, "message": line}));
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
            if line.is_empty() { continue; }
            if let Ok(resp) = serde_json::from_str::<JsonRpcResponse>(&line) {
                if let Some(id) = resp.id {
                    if let Some(sender) = pending2.write().await.remove(&id) {
                        let result = match resp.error {
                            Some(e) => json!({"error": {"code": e.code, "message": e.message}}),
                            None => resp.result.unwrap_or(Value::Null),
                        };
                        let _ = sender.send(result);
                    }
                }
            }
        }
        let _ = app2.emit("mcp://server-stopped", &sid);
    });

    // Store
    mcp.servers.lock().await.insert(server_id.clone(), McpProcess {
        child, stdin_tx: tx.clone(), tools: vec![], pending: pending.clone(),
    });

    // Initialize
    if let Err(e) = send_req(&tx, &pending, "initialize", Some(json!({
        "protocolVersion": "2024-11-05",
        "capabilities": {"tools": {}},
        "clientInfo": {"name": "volt", "version": "1.0.0"}
    })), 60).await {
        set_error(&app, &mcp, &server_id, &e).await;
        let _ = stop_mcp_server(app.clone(), server_id.clone()).await;
        return Err(e);
    }

    let _ = send_notif(&tx, "notifications/initialized", None).await;

    // Get tools
    let tools: Vec<McpTool> = match send_req(&tx, &pending, "tools/list", None, 30).await {
        Ok(r) => r.get("tools").and_then(|t| t.as_array())
            .map(|arr| arr.iter().filter_map(|t| serde_json::from_value::<McpTool>(t.clone()).ok()).collect())
            .unwrap_or_default(),
        Err(e) => { set_error(&app, &mcp, &server_id, &e).await; return Err(e); }
    };

    // Final state
    let final_state = McpServerState {
        id: server_id.clone(), name: server_id.clone(),
        status: "connected".to_string(), tools: tools.clone(), error: None,
    };
    mcp.states.write().await.insert(server_id.clone(), final_state.clone());
    if let Some(s) = mcp.servers.lock().await.get_mut(&server_id) { s.tools = tools; }
    emit_state(&app, &server_id, &final_state);

    Ok(final_state)
}

#[tauri::command]
pub async fn stop_mcp_server(app: AppHandle, server_id: String) -> Result<(), String> {
    let mcp = app.state::<McpState>();
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
    for id in ids { let _ = stop_mcp_server(app.clone(), id).await; }
    mcp.states.write().await.clear();
    Ok(())
}

#[tauri::command]
pub async fn call_mcp_tool(app: AppHandle, server_id: String, tool_name: String, arguments: Value) -> Result<Value, String> {
    let mcp = app.state::<McpState>();
    let (tx, pending) = {
        let servers = mcp.servers.lock().await;
        let s = servers.get(&server_id).ok_or_else(|| format!("Server '{}' not found", server_id))?;
        (s.stdin_tx.clone(), s.pending.clone())
    };
    send_req(&tx, &pending, "tools/call", Some(json!({"name": tool_name, "arguments": arguments})), 30).await
}

#[tauri::command]
pub async fn get_mcp_servers(app: AppHandle) -> Result<Vec<McpServerState>, String> {
    Ok(app.state::<McpState>().states.read().await.values().cloned().collect())
}

#[tauri::command]
pub async fn get_mcp_tools(app: AppHandle) -> Result<Vec<(String, McpTool)>, String> {
    let mcp = app.state::<McpState>();
    let mut all = Vec::new();
    for (id, s) in mcp.servers.lock().await.iter() {
        for t in &s.tools { all.push((id.clone(), t.clone())); }
    }
    Ok(all)
}

#[tauri::command]
pub fn get_mcp_config_path() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    Ok(home.join(".volt/settings/mcp.json").to_string_lossy().to_string())
}

#[tauri::command]
pub fn ensure_mcp_config(default_content: String) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let dir = home.join(".volt/settings");
    let path = dir.join("mcp.json");
    if !dir.exists() { std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?; }
    if !path.exists() { std::fs::write(&path, &default_content).map_err(|e| e.to_string())?; }
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn write_mcp_config(content: String) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let dir = home.join(".volt/settings");
    let path = dir.join("mcp.json");
    if !dir.exists() { std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?; }
    std::fs::write(&path, &content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_mcp_config() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("No home dir")?;
    let path = home.join(".volt/settings/mcp.json");
    if !path.exists() { return Err("Config not found".to_string()); }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}
