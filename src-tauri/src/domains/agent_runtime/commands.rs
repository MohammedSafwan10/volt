use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Runtime, State};

use super::manager::{
    AssistantApprovalRegistrationRequest, AssistantApprovalResolutionResponse,
    AssistantApprovalUpdateRequest, AssistantDispatchPlanRequest, AssistantDispatchStepRequest,
    AssistantDispatchStepResponse, AssistantRunActionRequest, AssistantRunActionResponse,
    AssistantRunSnapshot, AssistantRunStartRequest, AssistantRunStartResponse,
    AssistantRuntimeManagerState, AssistantRuntimePublishEventRequest,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeCommandRequest {
    pub operation: String,
    pub conversation_id: String,
    #[serde(default)]
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeMessagePatch {
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub stream_state: Option<String>,
    #[serde(default)]
    pub stream_issue: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeToolPatch {
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub meta: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeCommandResponse {
    pub should_apply: bool,
    pub operation: String,
    pub conversation_id: String,
    #[serde(default)]
    pub loop_state: Option<String>,
    #[serde(default)]
    pub loop_meta: Option<serde_json::Value>,
    #[serde(default)]
    pub message_patch: Option<AgentRuntimeMessagePatch>,
    #[serde(default)]
    pub tool_patch: Option<AgentRuntimeToolPatch>,
    #[serde(default)]
    pub control: Option<AgentRuntimeControlDecision>,
    #[serde(default)]
    pub audit_entry: Option<AgentRuntimeAuditEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeControlDecision {
    #[serde(default)]
    pub retry: Option<AgentRuntimeRetryDecision>,
    #[serde(default)]
    pub cancellation: Option<AgentRuntimeCancellationDecision>,
    #[serde(default)]
    pub timeout: Option<AgentRuntimeTimeoutDecision>,
    #[serde(default)]
    pub tool_policy: Option<AgentRuntimeToolPolicyDecision>,
    #[serde(default)]
    pub approval: Option<AgentRuntimeApprovalDecision>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeRetryDecision {
    pub allowed: bool,
    #[serde(default)]
    pub delay_ms: Option<u64>,
    #[serde(default)]
    pub max_retries: Option<u32>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeCancellationDecision {
    pub should_cancel: bool,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeTimeoutDecision {
    pub should_timeout: bool,
    #[serde(default)]
    pub max_duration_ms: Option<u64>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeToolPolicyDecision {
    #[serde(default)]
    pub execute_in_order: Option<bool>,
    #[serde(default)]
    pub defer_until_file_edits_complete: Option<bool>,
    #[serde(default)]
    pub approval_required: Option<bool>,
    #[serde(default)]
    pub execution_stages: Option<Vec<String>>,
    #[serde(default)]
    pub file_edit_concurrency: Option<u32>,
    #[serde(default)]
    pub ordered_file_queue_keys: Option<Vec<String>>,
    #[serde(default)]
    pub ordered_eager_tool_ids: Option<Vec<String>>,
    #[serde(default)]
    pub ordered_deferred_tool_ids: Option<Vec<String>>,
    #[serde(default)]
    pub pending_approval_tool_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeApprovalDecision {
    pub should_abort: bool,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub resume_state: Option<String>,
    #[serde(default)]
    pub approved_tool_ids: Option<Vec<String>>,
    #[serde(default)]
    pub denied_tool_ids: Option<Vec<String>>,
    #[serde(default)]
    pub unresolved_tool_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeAuditEntry {
    pub timestamp_ms: u64,
    pub conversation_id: String,
    pub operation: String,
    #[serde(default)]
    pub loop_state: Option<String>,
    #[serde(default)]
    pub meta: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default)]
struct AgentRuntimeSessionState {
    iteration: u64,
    retry_counts: HashMap<String, u32>,
    cancelled: bool,
    started_at_ms: Option<u64>,
    max_duration_ms: Option<u64>,
    pending_approval_count: u64,
}

#[derive(Debug, Clone)]
struct RuntimeToolDescriptor {
    id: String,
    name: String,
}

#[derive(Debug, Clone)]
struct RuntimeApprovalToolState {
    id: String,
    status: String,
    review_status: Option<String>,
}

#[derive(Debug, Clone)]
struct RuntimeFileQueueDescriptor {
    key: String,
}

fn runtime_sessions() -> &'static Mutex<HashMap<String, AgentRuntimeSessionState>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, AgentRuntimeSessionState>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_secs(0))
        .as_millis() as u64
}

fn read_u64(payload: &serde_json::Value, key: &str) -> Option<u64> {
    payload.get(key).and_then(|value| value.as_u64())
}

fn read_str<'a>(payload: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    payload.get(key).and_then(|value| value.as_str())
}

fn read_bool(payload: &serde_json::Value, key: &str) -> Option<bool> {
    payload.get(key).and_then(|value| value.as_bool())
}

fn read_requested_loop_meta_iteration(payload: &serde_json::Value) -> Option<u64> {
    payload
        .get("requestedLoopMeta")
        .and_then(|value| value.get("iteration"))
        .and_then(|value| value.as_u64())
}

fn read_requested_loop_meta_u64(payload: &serde_json::Value, key: &str) -> Option<u64> {
    payload
        .get("requestedLoopMeta")
        .and_then(|value| value.get(key))
        .and_then(|value| value.as_u64())
}

fn resolve_max_duration_ms(payload: &serde_json::Value) -> Option<u64> {
    read_u64(payload, "maxLoopDurationMs")
        .or_else(|| read_requested_loop_meta_u64(payload, "maxLoopDurationMs"))
}

fn read_requested_loop_meta_array<'a>(
    payload: &'a serde_json::Value,
    key: &str,
) -> Option<&'a Vec<serde_json::Value>> {
    payload
        .get("requestedLoopMeta")
        .and_then(|value| value.get(key))
        .and_then(|value| value.as_array())
}

fn read_requested_loop_meta_string_array(payload: &serde_json::Value, key: &str) -> Vec<String> {
    read_requested_loop_meta_array(payload, key)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(|value| value.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn read_requested_tool_descriptors(
    payload: &serde_json::Value,
    key: &str,
) -> Vec<RuntimeToolDescriptor> {
    read_requested_loop_meta_array(payload, key)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item.get("id")?.as_str()?.trim();
                    let name = item.get("name")?.as_str()?.trim();
                    if id.is_empty() || name.is_empty() {
                        return None;
                    }
                    Some(RuntimeToolDescriptor {
                        id: id.to_string(),
                        name: name.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn read_requested_approval_states(payload: &serde_json::Value) -> Vec<RuntimeApprovalToolState> {
    read_requested_loop_meta_array(payload, "toolStates")
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item.get("id")?.as_str()?.trim();
                    let status = item.get("status")?.as_str()?.trim();
                    if id.is_empty() || status.is_empty() {
                        return None;
                    }
                    Some(RuntimeApprovalToolState {
                        id: id.to_string(),
                        status: status.to_string(),
                        review_status: item
                            .get("reviewStatus")
                            .and_then(|value| value.as_str())
                            .map(|value| value.to_string()),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn planning_phase_rank(tool_name: &str) -> u8 {
    match tool_name {
        "workspace_search" | "find_files" => 0,
        "read_file" | "read_files" | "read_code" | "file_outline" | "get_file_tree"
        | "list_dir" | "get_file_info" | "get_active_file" | "get_selection" | "get_open_files" => {
            1
        }
        "get_diagnostics" => 3,
        _ if tool_name.starts_with("lsp_") => 3,
        _ => 2,
    }
}

fn sort_runtime_tools(tools: &mut [RuntimeToolDescriptor]) {
    tools.sort_by(|left, right| {
        planning_phase_rank(&left.name)
            .cmp(&planning_phase_rank(&right.name))
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.id.cmp(&right.id))
    });
}

fn read_requested_file_queue_descriptors(
    payload: &serde_json::Value,
) -> Vec<RuntimeFileQueueDescriptor> {
    read_requested_loop_meta_array(payload, "fileEditQueues")
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let key = item.get("queueKey")?.as_str()?.trim();
                    if key.is_empty() {
                        return None;
                    }
                    Some(RuntimeFileQueueDescriptor {
                        key: key.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn determine_file_edit_concurrency(queue_count: usize) -> u32 {
    if queue_count >= 12 {
        2
    } else if queue_count >= 6 {
        3
    } else {
        4
    }
}

fn build_execution_stages(
    eager_tool_count: usize,
    deferred_tool_count: usize,
    file_queue_count: usize,
    execute_in_order: bool,
    defer_until_file_edits_complete: bool,
) -> Vec<String> {
    let mut stages = Vec::new();

    if eager_tool_count > 0 {
        stages.push("eager_tools".to_string());
    }

    if deferred_tool_count > 0 && !defer_until_file_edits_complete {
        stages.push("deferred_tools".to_string());
    }

    if file_queue_count > 0 {
        stages.push("file_edits".to_string());
    }

    if deferred_tool_count > 0 && (defer_until_file_edits_complete || execute_in_order) {
        if !stages.iter().any(|stage| stage == "deferred_tools") {
            stages.push("deferred_tools".to_string());
        }
    }

    stages
}

fn tool_key(payload: &serde_json::Value) -> Option<String> {
    let tool_name = read_str(payload, "toolName")
        .or_else(|| read_str(payload, "activeToolCallName"))?
        .trim();
    if tool_name.is_empty() {
        return None;
    }
    let tool_call_id = read_str(payload, "toolCallId")
        .or_else(|| read_str(payload, "activeToolCallId"))
        .unwrap_or("unknown");
    Some(format!("{tool_name}:{tool_call_id}"))
}

fn map_operation_to_loop_state(operation: &str) -> Option<String> {
    match operation {
        "loop_start" | "iteration_start" | "approval_resumed" => Some("running".to_string()),
        "waiting_tool" => Some("waiting_tool".to_string()),
        "waiting_approval" => Some("waiting_approval".to_string()),
        "approval_finalize" => Some("running".to_string()),
        "completion_pending" => Some("completing".to_string()),
        "loop_completed" => Some("completed".to_string()),
        "loop_cancelled" => Some("cancelled".to_string()),
        "loop_failed" | "loop_timeout" | "loop_iteration_limit_reached" | "approval_incomplete" => {
            Some("failed".to_string())
        }
        _ => None,
    }
}

fn is_terminal_operation(operation: &str) -> bool {
    matches!(
        operation,
        "loop_completed"
            | "loop_failed"
            | "loop_cancelled"
            | "loop_timeout"
            | "loop_iteration_limit_reached"
            | "approval_incomplete"
    )
}

fn build_control_decision(
    operation: &str,
    payload: &serde_json::Value,
    session: &mut AgentRuntimeSessionState,
) -> AgentRuntimeControlDecision {
    let mut control = AgentRuntimeControlDecision::default();

    if let Some(iteration) = read_requested_loop_meta_iteration(payload) {
        session.iteration = iteration;
    }

    if let Some(max_duration_ms) = resolve_max_duration_ms(payload) {
        session.max_duration_ms = Some(max_duration_ms);
    }

    if operation == "loop_start" {
        session.cancelled = false;
        session.retry_counts.clear();
        session.pending_approval_count = 0;
        session.started_at_ms = Some(
            read_u64(payload, "startedAt")
                .or_else(|| {
                    payload
                        .get("requestedLoopMeta")
                        .and_then(|value| value.get("startedAt"))
                        .and_then(|value| value.as_u64())
                })
                .unwrap_or_else(now_ms),
        );
    }

    if operation == "waiting_approval" {
        session.pending_approval_count = payload
            .get("requestedLoopMeta")
            .and_then(|value| value.get("pendingApprovals"))
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
    }

    if operation == "approval_resumed" {
        session.pending_approval_count = 0;
    }

    if operation == "loop_cancelled" {
        session.cancelled = true;
    }

    if operation == "loop_timeout" {
        control.timeout = Some(AgentRuntimeTimeoutDecision {
            should_timeout: true,
            max_duration_ms: session
                .max_duration_ms
                .or_else(|| resolve_max_duration_ms(payload)),
            reason: Some("time_budget_exceeded".to_string()),
        });
    } else if let (Some(started_at_ms), Some(max_duration_ms)) = (
        session.started_at_ms,
        session
            .max_duration_ms
            .or_else(|| resolve_max_duration_ms(payload)),
    ) {
        let elapsed = now_ms().saturating_sub(started_at_ms);
        if elapsed > max_duration_ms {
            control.timeout = Some(AgentRuntimeTimeoutDecision {
                should_timeout: true,
                max_duration_ms: Some(max_duration_ms),
                reason: Some("native_runtime_timeout_exceeded".to_string()),
            });
        }
    }

    if operation == "loop_cancelled" || read_bool(payload, "cancelRequested").unwrap_or(false) {
        control.cancellation = Some(AgentRuntimeCancellationDecision {
            should_cancel: true,
            reason: Some("cancel_requested".to_string()),
        });
    } else if session.cancelled {
        control.cancellation = Some(AgentRuntimeCancellationDecision {
            should_cancel: true,
            reason: Some("session_already_cancelled".to_string()),
        });
    }

    if operation == "iteration_error" || operation == "loop_failed" {
        if let Some(key) = tool_key(payload) {
            let attempts = session.retry_counts.entry(key).or_insert(0);
            let max_retries = 1;
            let retryable = read_bool(payload, "retryable").unwrap_or(false)
                || read_str(payload, "error")
                    .map(|error| {
                        let normalized = error.to_ascii_lowercase();
                        normalized.contains("timeout")
                            || normalized.contains("network")
                            || normalized.contains("connection")
                            || normalized.contains("interrupted")
                    })
                    .unwrap_or(false);
            if retryable && *attempts < max_retries {
                *attempts += 1;
                control.retry = Some(AgentRuntimeRetryDecision {
                    allowed: true,
                    delay_ms: Some(read_u64(payload, "retryDelayMs").unwrap_or(1000)),
                    max_retries: Some(max_retries),
                    reason: Some("native_runtime_retry".to_string()),
                });
            } else {
                control.retry = Some(AgentRuntimeRetryDecision {
                    allowed: false,
                    delay_ms: None,
                    max_retries: Some(max_retries),
                    reason: Some(if retryable {
                        "retry_budget_exhausted".to_string()
                    } else {
                        "non_retryable_error".to_string()
                    }),
                });
            }
        }
    }

    if operation == "waiting_tool" {
        let mut eager_tools = read_requested_tool_descriptors(payload, "eagerTools");
        let mut deferred_tools = read_requested_tool_descriptors(payload, "deferredTools");
        let file_queues = read_requested_file_queue_descriptors(payload);
        sort_runtime_tools(&mut eager_tools);
        sort_runtime_tools(&mut deferred_tools);
        let pending_approval_tool_ids =
            read_requested_loop_meta_string_array(payload, "pendingToolIds");
        let execute_in_order = read_bool(payload, "executeInOrder").unwrap_or(false);
        let defer_until_file_edits_complete = payload
            .get("requestedLoopMeta")
            .and_then(|value| value.get("fileQueues"))
            .and_then(|value| value.as_u64())
            .map(|count| count > 0);
        let resolved_defer_until_file_edits_complete =
            defer_until_file_edits_complete.unwrap_or(!file_queues.is_empty());
        let execution_stages = build_execution_stages(
            eager_tools.len(),
            deferred_tools.len(),
            file_queues.len(),
            execute_in_order,
            resolved_defer_until_file_edits_complete,
        );
        control.tool_policy = Some(AgentRuntimeToolPolicyDecision {
            execute_in_order: Some(execute_in_order),
            defer_until_file_edits_complete: Some(resolved_defer_until_file_edits_complete),
            approval_required: Some(
                !pending_approval_tool_ids.is_empty() || session.pending_approval_count > 0,
            ),
            execution_stages: Some(execution_stages),
            file_edit_concurrency: Some(determine_file_edit_concurrency(file_queues.len())),
            ordered_file_queue_keys: Some(file_queues.into_iter().map(|queue| queue.key).collect()),
            ordered_eager_tool_ids: Some(eager_tools.into_iter().map(|tool| tool.id).collect()),
            ordered_deferred_tool_ids: Some(
                deferred_tools.into_iter().map(|tool| tool.id).collect(),
            ),
            pending_approval_tool_ids: Some(pending_approval_tool_ids),
        });
    } else if operation == "waiting_approval" {
        control.tool_policy = Some(AgentRuntimeToolPolicyDecision {
            execute_in_order: Some(true),
            defer_until_file_edits_complete: None,
            approval_required: Some(true),
            execution_stages: Some(vec!["approvals".to_string()]),
            ordered_eager_tool_ids: None,
            ordered_deferred_tool_ids: None,
            pending_approval_tool_ids: Some(read_requested_loop_meta_string_array(
                payload, "toolIds",
            )),
            file_edit_concurrency: None,
            ordered_file_queue_keys: None,
        });
    } else if operation == "approval_finalize" {
        let tool_states = read_requested_approval_states(payload);
        let mut approved_tool_ids = Vec::new();
        let mut denied_tool_ids = Vec::new();
        let mut unresolved_tool_ids = Vec::new();

        for tool_state in tool_states {
            let review_status = tool_state.review_status.as_deref();
            let status = tool_state.status.as_str();
            let is_denied = status == "cancelled" || review_status == Some("rejected");
            let is_unresolved = status == "pending"
                && review_status != Some("accepted")
                && review_status != Some("rejected");

            if is_denied {
                denied_tool_ids.push(tool_state.id);
            } else if is_unresolved {
                unresolved_tool_ids.push(tool_state.id);
            } else {
                approved_tool_ids.push(tool_state.id);
            }
        }

        let should_abort = !unresolved_tool_ids.is_empty();
        session.pending_approval_count = unresolved_tool_ids.len() as u64;
        control.approval = Some(AgentRuntimeApprovalDecision {
            should_abort,
            reason: should_abort.then(|| "approval_flow_incomplete".to_string()),
            resume_state: (!should_abort).then(|| "running".to_string()),
            approved_tool_ids: Some(approved_tool_ids),
            denied_tool_ids: Some(denied_tool_ids),
            unresolved_tool_ids: Some(unresolved_tool_ids),
        });
    }

    control
}

fn apply_agent_runtime_command(
    request: AgentRuntimeCommandRequest,
) -> Result<AgentRuntimeCommandResponse, String> {
    let mut sessions = runtime_sessions()
        .lock()
        .map_err(|_| "failed to lock agent runtime sessions".to_string())?;
    let session = sessions
        .entry(request.conversation_id.clone())
        .or_insert_with(AgentRuntimeSessionState::default);

    let loop_state = request
        .payload
        .get("requestedLoopState")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .or_else(|| map_operation_to_loop_state(&request.operation));

    let loop_meta = request
        .payload
        .get("requestedLoopMeta")
        .cloned()
        .or_else(|| Some(request.payload.clone()));

    let control = build_control_decision(&request.operation, &request.payload, session);
    let audit_entry = Some(AgentRuntimeAuditEntry {
        timestamp_ms: now_ms(),
        conversation_id: request.conversation_id.clone(),
        operation: request.operation.clone(),
        loop_state: loop_state.clone(),
        meta: loop_meta.clone(),
    });

    let response = AgentRuntimeCommandResponse {
        should_apply: true,
        operation: request.operation.clone(),
        conversation_id: request.conversation_id.clone(),
        loop_state,
        loop_meta,
        message_patch: None,
        tool_patch: None,
        control: Some(control),
        audit_entry,
    };

    if is_terminal_operation(&request.operation) {
        sessions.remove(&request.conversation_id);
    }

    Ok(response)
}

#[tauri::command]
pub async fn agent_runtime_apply(
    request: AgentRuntimeCommandRequest,
) -> Result<AgentRuntimeCommandResponse, String> {
    apply_agent_runtime_command(request)
}

#[tauri::command]
pub fn assistant_run_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AssistantRuntimeManagerState>,
    request: AssistantRunStartRequest,
) -> Result<AssistantRunStartResponse, String> {
    state.start_run(&app, request)
}

#[tauri::command]
pub fn assistant_run_cancel<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AssistantRuntimeManagerState>,
    request: AssistantRunActionRequest,
) -> Result<AssistantRunActionResponse, String> {
    state.cancel_run(&app, request)
}

#[tauri::command]
pub fn assistant_run_resume_approval<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AssistantRuntimeManagerState>,
    request: AssistantRunActionRequest,
) -> Result<AssistantRunActionResponse, String> {
    state.resume_approval(&app, request)
}

#[tauri::command]
pub fn assistant_run_register_approvals<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, AssistantRuntimeManagerState>,
    request: AssistantApprovalRegistrationRequest,
) -> Result<AssistantApprovalResolutionResponse, String> {
    state.register_approvals(request)
}

#[tauri::command]
pub fn assistant_run_update_approval<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, AssistantRuntimeManagerState>,
    request: AssistantApprovalUpdateRequest,
) -> Result<AssistantApprovalResolutionResponse, String> {
    state.update_approval(request)
}

#[tauri::command]
pub fn assistant_run_resolve_approvals<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, AssistantRuntimeManagerState>,
    request: AssistantRunActionRequest,
) -> Result<AssistantApprovalResolutionResponse, String> {
    state.resolve_approvals(request)
}

#[tauri::command]
pub fn assistant_run_set_dispatch_plan<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, AssistantRuntimeManagerState>,
    request: AssistantDispatchPlanRequest,
) -> Result<AssistantDispatchStepResponse, String> {
    state.set_dispatch_plan(request)
}

#[tauri::command]
pub fn assistant_run_claim_dispatch_step<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, AssistantRuntimeManagerState>,
    request: AssistantDispatchStepRequest,
) -> Result<AssistantDispatchStepResponse, String> {
    state.claim_next_dispatch_step(request)
}

#[tauri::command]
pub fn assistant_run_complete_dispatch_step<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, AssistantRuntimeManagerState>,
    request: AssistantDispatchStepRequest,
) -> Result<AssistantDispatchStepResponse, String> {
    state.complete_dispatch_step(request)
}

#[tauri::command]
pub fn assistant_run_get_snapshot<R: Runtime>(
    _app: AppHandle<R>,
    state: State<'_, AssistantRuntimeManagerState>,
    conversation_id: String,
) -> Result<Option<AssistantRunSnapshot>, String> {
    state.get_snapshot(conversation_id)
}

#[tauri::command]
pub fn assistant_runtime_publish_event<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AssistantRuntimeManagerState>,
    request: AssistantRuntimePublishEventRequest,
) -> Result<AssistantRunActionResponse, String> {
    state.publish_event(&app, request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn reset_sessions() {
        runtime_sessions().lock().unwrap().clear();
    }

    #[test]
    fn runtime_updates_session_budget_from_requested_loop_meta() {
        reset_sessions();

        let start = apply_agent_runtime_command(AgentRuntimeCommandRequest {
            operation: "loop_start".to_string(),
            conversation_id: "conv-1".to_string(),
            payload: json!({
                "requestedLoopState": "running",
                "requestedLoopMeta": {
                    "iteration": 0,
                    "startedAt": now_ms() - 5_000,
                    "maxLoopDurationMs": 1_000
                }
            }),
        })
        .unwrap();

        assert_eq!(
            start
                .control
                .as_ref()
                .and_then(|control| control.timeout.as_ref())
                .map(|timeout| timeout.should_timeout),
            Some(true)
        );

        let extended = apply_agent_runtime_command(AgentRuntimeCommandRequest {
            operation: "iteration_start".to_string(),
            conversation_id: "conv-1".to_string(),
            payload: json!({
                "requestedLoopState": "running",
                "requestedLoopMeta": {
                    "iteration": 1,
                    "maxLoopDurationMs": 10_000
                }
            }),
        })
        .unwrap();

        assert!(extended
            .control
            .as_ref()
            .and_then(|control| control.timeout.as_ref())
            .is_none());
    }

    #[test]
    fn terminal_operations_clear_native_runtime_session() {
        reset_sessions();

        apply_agent_runtime_command(AgentRuntimeCommandRequest {
            operation: "loop_start".to_string(),
            conversation_id: "conv-terminal".to_string(),
            payload: json!({
                "requestedLoopState": "running",
                "requestedLoopMeta": {
                    "iteration": 0,
                    "startedAt": now_ms(),
                    "maxLoopDurationMs": 30_000
                }
            }),
        })
        .unwrap();

        assert!(runtime_sessions()
            .lock()
            .unwrap()
            .contains_key("conv-terminal"));

        apply_agent_runtime_command(AgentRuntimeCommandRequest {
            operation: "loop_completed".to_string(),
            conversation_id: "conv-terminal".to_string(),
            payload: json!({
                "requestedLoopState": "completed",
                "requestedLoopMeta": {
                    "iteration": 1
                }
            }),
        })
        .unwrap();

        assert!(!runtime_sessions()
            .lock()
            .unwrap()
            .contains_key("conv-terminal"));
    }

    #[test]
    fn waiting_tool_returns_native_execution_order() {
        reset_sessions();

        let response = apply_agent_runtime_command(AgentRuntimeCommandRequest {
            operation: "waiting_tool".to_string(),
            conversation_id: "conv-plan".to_string(),
            payload: json!({
                "requestedLoopState": "waiting_tool",
                "requestedLoopMeta": {
                    "fileQueues": 1,
                    "fileEditQueues": [
                        { "queueKey": "src/app.ts" }
                    ],
                    "pendingToolIds": ["approve-1"],
                    "eagerTools": [
                        { "id": "verify", "name": "get_diagnostics" },
                        { "id": "read", "name": "read_file" },
                        { "id": "search", "name": "workspace_search" }
                    ],
                    "deferredTools": [
                        { "id": "lsp", "name": "lsp_hover" },
                        { "id": "other", "name": "run_command" }
                    ]
                }
            }),
        })
        .unwrap();

        let tool_policy = response
            .control
            .and_then(|control| control.tool_policy)
            .expect("expected tool policy");

        assert_eq!(
            tool_policy.ordered_eager_tool_ids,
            Some(vec![
                "search".to_string(),
                "read".to_string(),
                "verify".to_string()
            ])
        );
        assert_eq!(
            tool_policy.ordered_deferred_tool_ids,
            Some(vec!["other".to_string(), "lsp".to_string()])
        );
        assert_eq!(
            tool_policy.pending_approval_tool_ids,
            Some(vec!["approve-1".to_string()])
        );
        assert_eq!(
            tool_policy.execution_stages,
            Some(vec![
                "eager_tools".to_string(),
                "file_edits".to_string(),
                "deferred_tools".to_string()
            ])
        );
        assert_eq!(tool_policy.file_edit_concurrency, Some(4));
        assert_eq!(tool_policy.approval_required, Some(true));
    }

    #[test]
    fn approval_finalize_returns_authoritative_tool_sets() {
        reset_sessions();

        let response = apply_agent_runtime_command(AgentRuntimeCommandRequest {
            operation: "approval_finalize".to_string(),
            conversation_id: "conv-approval".to_string(),
            payload: json!({
                "requestedLoopState": "running",
                "requestedLoopMeta": {
                    "toolStates": [
                        { "id": "approved", "status": "pending", "reviewStatus": "accepted" },
                        { "id": "denied", "status": "cancelled", "reviewStatus": "rejected" },
                        { "id": "waiting", "status": "pending", "reviewStatus": "pending" }
                    ]
                }
            }),
        })
        .unwrap();

        let approval = response
            .control
            .and_then(|control| control.approval)
            .expect("expected approval decision");

        assert!(approval.should_abort);
        assert_eq!(approval.reason.as_deref(), Some("approval_flow_incomplete"));
        assert_eq!(
            approval.approved_tool_ids,
            Some(vec!["approved".to_string()])
        );
        assert_eq!(approval.denied_tool_ids, Some(vec!["denied".to_string()]));
        assert_eq!(
            approval.unresolved_tool_ids,
            Some(vec!["waiting".to_string()])
        );
    }
}
