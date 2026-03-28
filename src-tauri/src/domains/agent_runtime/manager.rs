use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Runtime};
use uuid::Uuid;

pub const ASSISTANT_RUNTIME_EVENT: &str = "assistant-runtime://event";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssistantRuntimeMessagePatch {
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub content_delta: Option<String>,
    #[serde(default)]
    pub thinking_delta: Option<String>,
    #[serde(default)]
    pub stream_state: Option<String>,
    #[serde(default)]
    pub stream_issue: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssistantRuntimeToolPatch {
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
pub struct AssistantRuntimeEventPayload {
    #[serde(default)]
    pub loop_meta: Option<serde_json::Value>,
    #[serde(default)]
    pub message_patch: Option<AssistantRuntimeMessagePatch>,
    #[serde(default)]
    pub tool_patch: Option<AssistantRuntimeToolPatch>,
    #[serde(default)]
    pub tool_call: Option<serde_json::Value>,
    #[serde(default)]
    pub tool_result: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantRuntimeEvent {
    pub event_id: String,
    pub conversation_id: String,
    pub run_id: String,
    pub timestamp_ms: u64,
    pub kind: String,
    #[serde(default)]
    pub loop_state: Option<String>,
    #[serde(default)]
    pub payload: AssistantRuntimeEventPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssistantRunStartRequest {
    pub conversation_id: String,
    pub mode: String,
    pub model_id: String,
    pub system_prompt: String,
    #[serde(default)]
    pub request_envelope: Option<serde_json::Value>,
    #[serde(default)]
    pub runtime_snapshot: Option<serde_json::Value>,
    #[serde(default)]
    pub auto_approve_all_tools: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantRunSnapshot {
    pub run_id: String,
    pub conversation_id: String,
    pub mode: String,
    pub model_id: String,
    pub loop_state: String,
    pub started_at_ms: u64,
    pub updated_at_ms: u64,
    pub auto_approve_all_tools: bool,
    pub waiting_approval: bool,
    pub cancelled: bool,
    pub event_count: u64,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub request_envelope: Option<serde_json::Value>,
    #[serde(default)]
    pub runtime_snapshot: Option<serde_json::Value>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub last_event: Option<AssistantRuntimeEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantRunStartResponse {
    pub accepted: bool,
    pub run_id: String,
    pub conversation_id: String,
    pub loop_state: String,
    pub snapshot: AssistantRunSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssistantRunActionRequest {
    pub conversation_id: String,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub meta: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantRunActionResponse {
    pub success: bool,
    pub conversation_id: String,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub loop_state: Option<String>,
    #[serde(default)]
    pub snapshot: Option<AssistantRunSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssistantApprovalRegistrationRequest {
    pub conversation_id: String,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub tool_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssistantApprovalUpdateRequest {
    pub conversation_id: String,
    #[serde(default)]
    pub run_id: Option<String>,
    pub tool_call_id: String,
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub review_status: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantApprovalResolutionResponse {
    pub success: bool,
    pub conversation_id: String,
    #[serde(default)]
    pub run_id: Option<String>,
    pub approved_tool_ids: Vec<String>,
    pub denied_tool_ids: Vec<String>,
    pub unresolved_tool_ids: Vec<String>,
    pub waiting_approval: bool,
    #[serde(default)]
    pub snapshot: Option<AssistantRunSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssistantDispatchPlanRequest {
    pub conversation_id: String,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub execution_stages: Vec<String>,
    #[serde(default)]
    pub eager_tool_ids: Vec<String>,
    #[serde(default)]
    pub deferred_tool_ids: Vec<String>,
    #[serde(default)]
    pub file_queue_keys: Vec<String>,
    #[serde(default)]
    pub file_edit_concurrency: Option<u32>,
    #[serde(default)]
    pub pending_approval_tool_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssistantDispatchStepRequest {
    pub conversation_id: String,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub step_id: Option<String>,
    #[serde(default)]
    pub meta: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssistantDispatchStep {
    pub step_id: String,
    pub stage: String,
    pub status: String,
    #[serde(default)]
    pub tool_ids: Vec<String>,
    #[serde(default)]
    pub file_queue_keys: Vec<String>,
    #[serde(default)]
    pub file_edit_concurrency: Option<u32>,
    #[serde(default)]
    pub blocked_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssistantDispatchStepResponse {
    pub success: bool,
    pub conversation_id: String,
    #[serde(default)]
    pub run_id: Option<String>,
    pub waiting_approval: bool,
    pub has_more_steps: bool,
    #[serde(default)]
    pub active_step: Option<AssistantDispatchStep>,
    #[serde(default)]
    pub completed_step: Option<AssistantDispatchStep>,
    #[serde(default)]
    pub snapshot: Option<AssistantRunSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssistantRuntimePublishEventRequest {
    pub conversation_id: String,
    #[serde(default)]
    pub run_id: Option<String>,
    pub kind: String,
    #[serde(default)]
    pub loop_state: Option<String>,
    #[serde(default)]
    pub payload: AssistantRuntimeEventPayload,
}

#[derive(Debug, Clone)]
struct AssistantRunRecord {
    run_id: String,
    conversation_id: String,
    mode: String,
    model_id: String,
    loop_state: String,
    started_at_ms: u64,
    updated_at_ms: u64,
    auto_approve_all_tools: bool,
    waiting_approval: bool,
    cancelled: bool,
    event_count: u64,
    system_prompt: Option<String>,
    request_envelope: Option<serde_json::Value>,
    runtime_snapshot: Option<serde_json::Value>,
    last_error: Option<String>,
    last_event: Option<AssistantRuntimeEvent>,
    pending_approvals: HashMap<String, NativeApprovalRecord>,
    dispatch_steps: Vec<NativeDispatchStepRecord>,
    dispatch_cursor: usize,
    active_dispatch_step_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct NativeApprovalRecord {
    message_id: Option<String>,
    review_status: Option<String>,
    status: Option<String>,
}

#[derive(Debug, Clone)]
struct NativeDispatchStepRecord {
    step_id: String,
    stage: String,
    status: String,
    tool_ids: Vec<String>,
    file_queue_keys: Vec<String>,
    file_edit_concurrency: Option<u32>,
}

impl NativeDispatchStepRecord {
    fn into_public(&self, blocked_reason: Option<String>) -> AssistantDispatchStep {
        AssistantDispatchStep {
            step_id: self.step_id.clone(),
            stage: self.stage.clone(),
            status: self.status.clone(),
            tool_ids: self.tool_ids.clone(),
            file_queue_keys: self.file_queue_keys.clone(),
            file_edit_concurrency: self.file_edit_concurrency,
            blocked_reason,
        }
    }
}

impl AssistantRunRecord {
    fn into_snapshot(&self) -> AssistantRunSnapshot {
        AssistantRunSnapshot {
            run_id: self.run_id.clone(),
            conversation_id: self.conversation_id.clone(),
            mode: self.mode.clone(),
            model_id: self.model_id.clone(),
            loop_state: self.loop_state.clone(),
            started_at_ms: self.started_at_ms,
            updated_at_ms: self.updated_at_ms,
            auto_approve_all_tools: self.auto_approve_all_tools,
            waiting_approval: self.waiting_approval,
            cancelled: self.cancelled,
            event_count: self.event_count,
            system_prompt: self.system_prompt.clone(),
            request_envelope: self.request_envelope.clone(),
            runtime_snapshot: self.runtime_snapshot.clone(),
            last_error: self.last_error.clone(),
            last_event: self.last_event.clone(),
        }
    }

    fn apply_event(&mut self, event: &AssistantRuntimeEvent) {
        self.updated_at_ms = event.timestamp_ms;
        self.event_count = self.event_count.saturating_add(1);
        if let Some(loop_state) = event.loop_state.as_ref() {
            self.loop_state = loop_state.clone();
        }

        match event.kind.as_str() {
            "approval_requested" => {
                self.waiting_approval = true;
                self.cancelled = false;
            }
            "approval_resumed" => {
                self.waiting_approval = false;
                self.cancelled = false;
                self.pending_approvals.clear();
            }
            "run_cancelled" => {
                self.waiting_approval = false;
                self.cancelled = true;
                self.dispatch_steps.clear();
                self.dispatch_cursor = 0;
                self.active_dispatch_step_id = None;
            }
            "run_completed" | "run_failed" => {
                self.waiting_approval = false;
                self.pending_approvals.clear();
                self.dispatch_steps.clear();
                self.dispatch_cursor = 0;
                self.active_dispatch_step_id = None;
            }
            _ => {}
        }

        if let Some(issue) = event
            .payload
            .message_patch
            .as_ref()
            .and_then(|patch| patch.stream_issue.clone())
        {
            self.last_error = Some(issue);
        }
        if let Some(error) = event
            .payload
            .tool_patch
            .as_ref()
            .and_then(|patch| patch.error.clone())
        {
            self.last_error = Some(error);
        }
        if event.kind == "run_failed" {
            if let Some(meta) = event.payload.loop_meta.as_ref() {
                if let Some(error) = meta.get("error").and_then(|value| value.as_str()) {
                    self.last_error = Some(error.to_string());
                }
            }
        }

        self.last_event = Some(event.clone());
    }

    fn approval_resolution(&self) -> (Vec<String>, Vec<String>, Vec<String>) {
        let mut approved = Vec::new();
        let mut denied = Vec::new();
        let mut unresolved = Vec::new();

        for (tool_id, approval) in &self.pending_approvals {
            let review_status = approval.review_status.as_deref();
            let status = approval.status.as_deref();
            if status == Some("cancelled") || review_status == Some("rejected") {
                denied.push(tool_id.clone());
            } else if review_status == Some("accepted") {
                approved.push(tool_id.clone());
            } else {
                unresolved.push(tool_id.clone());
            }
        }

        approved.sort();
        denied.sort();
        unresolved.sort();
        (approved, denied, unresolved)
    }

    fn has_pending_dispatch_steps(&self) -> bool {
        self.dispatch_steps
            .iter()
            .any(|step| step.status != "completed")
    }

    fn current_dispatch_step(&self) -> Option<&NativeDispatchStepRecord> {
        self.active_dispatch_step_id.as_ref().and_then(|step_id| {
            self.dispatch_steps
                .iter()
                .find(|step| &step.step_id == step_id)
        })
    }
}

#[derive(Default)]
pub struct AssistantRuntimeManagerState {
    runs: Mutex<HashMap<String, AssistantRunRecord>>,
}

impl AssistantRuntimeManagerState {
    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::from_secs(0))
            .as_millis() as u64
    }

    fn emit_event<R: Runtime>(&self, app: &AppHandle<R>, event: &AssistantRuntimeEvent) {
        let _ = app.emit(ASSISTANT_RUNTIME_EVENT, event);
    }

    pub fn get_snapshot(
        &self,
        conversation_id: String,
    ) -> Result<Option<AssistantRunSnapshot>, String> {
        let runs = self
            .runs
            .lock()
            .map_err(|err| format!("Failed to acquire assistant runtime lock: {err}"))?;
        Ok(runs
            .get(&conversation_id)
            .map(|record| record.into_snapshot()))
    }

    pub fn start_run<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        request: AssistantRunStartRequest,
    ) -> Result<AssistantRunStartResponse, String> {
        let timestamp = Self::now_ms();
        let run_id = Uuid::new_v4().to_string();
        let event = AssistantRuntimeEvent {
            event_id: Uuid::new_v4().to_string(),
            conversation_id: request.conversation_id.clone(),
            run_id: run_id.clone(),
            timestamp_ms: timestamp,
            kind: "run_started".to_string(),
            loop_state: Some("running".to_string()),
            payload: AssistantRuntimeEventPayload::default(),
        };

        let mut record = AssistantRunRecord {
            run_id: run_id.clone(),
            conversation_id: request.conversation_id.clone(),
            mode: request.mode,
            model_id: request.model_id,
            loop_state: "running".to_string(),
            started_at_ms: timestamp,
            updated_at_ms: timestamp,
            auto_approve_all_tools: request.auto_approve_all_tools,
            waiting_approval: false,
            cancelled: false,
            event_count: 0,
            system_prompt: Some(request.system_prompt),
            request_envelope: request.request_envelope,
            runtime_snapshot: request.runtime_snapshot,
            last_error: None,
            last_event: None,
            pending_approvals: HashMap::new(),
            dispatch_steps: Vec::new(),
            dispatch_cursor: 0,
            active_dispatch_step_id: None,
        };
        record.apply_event(&event);
        let snapshot = record.into_snapshot();

        let mut runs = self
            .runs
            .lock()
            .map_err(|err| format!("Failed to acquire assistant runtime lock: {err}"))?;
        runs.insert(request.conversation_id.clone(), record);
        drop(runs);

        self.emit_event(app, &event);

        Ok(AssistantRunStartResponse {
            accepted: true,
            run_id,
            conversation_id: request.conversation_id,
            loop_state: "running".to_string(),
            snapshot,
        })
    }

    pub fn cancel_run<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        request: AssistantRunActionRequest,
    ) -> Result<AssistantRunActionResponse, String> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|err| format!("Failed to acquire assistant runtime lock: {err}"))?;
        let Some(record) = runs.get_mut(&request.conversation_id) else {
            return Ok(AssistantRunActionResponse {
                success: false,
                conversation_id: request.conversation_id,
                run_id: None,
                loop_state: None,
                snapshot: None,
            });
        };

        if request.run_id.as_deref().is_some()
            && request.run_id.as_deref() != Some(record.run_id.as_str())
        {
            return Ok(AssistantRunActionResponse {
                success: false,
                conversation_id: request.conversation_id,
                run_id: Some(record.run_id.clone()),
                loop_state: Some(record.loop_state.clone()),
                snapshot: Some(record.into_snapshot()),
            });
        }

        let event = AssistantRuntimeEvent {
            event_id: Uuid::new_v4().to_string(),
            conversation_id: request.conversation_id.clone(),
            run_id: record.run_id.clone(),
            timestamp_ms: Self::now_ms(),
            kind: "run_cancelled".to_string(),
            loop_state: Some("cancelled".to_string()),
            payload: AssistantRuntimeEventPayload {
                loop_meta: request.meta.clone().or_else(|| {
                    request
                        .reason
                        .as_ref()
                        .map(|reason| serde_json::json!({ "reason": reason }))
                }),
                ..AssistantRuntimeEventPayload::default()
            },
        };

        record.apply_event(&event);
        let snapshot = record.into_snapshot();
        drop(runs);
        self.emit_event(app, &event);

        Ok(AssistantRunActionResponse {
            success: true,
            conversation_id: request.conversation_id,
            run_id: Some(snapshot.run_id.clone()),
            loop_state: Some(snapshot.loop_state.clone()),
            snapshot: Some(snapshot),
        })
    }

    pub fn resume_approval<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        request: AssistantRunActionRequest,
    ) -> Result<AssistantRunActionResponse, String> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|err| format!("Failed to acquire assistant runtime lock: {err}"))?;
        let Some(record) = runs.get_mut(&request.conversation_id) else {
            return Ok(AssistantRunActionResponse {
                success: false,
                conversation_id: request.conversation_id,
                run_id: None,
                loop_state: None,
                snapshot: None,
            });
        };

        if request.run_id.as_deref().is_some()
            && request.run_id.as_deref() != Some(record.run_id.as_str())
        {
            return Ok(AssistantRunActionResponse {
                success: false,
                conversation_id: request.conversation_id,
                run_id: Some(record.run_id.clone()),
                loop_state: Some(record.loop_state.clone()),
                snapshot: Some(record.into_snapshot()),
            });
        }

        let (_, _, unresolved_tool_ids) = record.approval_resolution();
        if !unresolved_tool_ids.is_empty() {
            record.waiting_approval = true;
            return Ok(AssistantRunActionResponse {
                success: false,
                conversation_id: request.conversation_id,
                run_id: Some(record.run_id.clone()),
                loop_state: Some(record.loop_state.clone()),
                snapshot: Some(record.into_snapshot()),
            });
        }

        let event = AssistantRuntimeEvent {
            event_id: Uuid::new_v4().to_string(),
            conversation_id: request.conversation_id.clone(),
            run_id: record.run_id.clone(),
            timestamp_ms: Self::now_ms(),
            kind: "approval_resumed".to_string(),
            loop_state: Some("running".to_string()),
            payload: AssistantRuntimeEventPayload {
                loop_meta: request.meta.clone().or_else(|| {
                    request
                        .reason
                        .as_ref()
                        .map(|reason| serde_json::json!({ "reason": reason }))
                }),
                ..AssistantRuntimeEventPayload::default()
            },
        };

        record.apply_event(&event);
        let snapshot = record.into_snapshot();
        drop(runs);
        self.emit_event(app, &event);

        Ok(AssistantRunActionResponse {
            success: true,
            conversation_id: request.conversation_id,
            run_id: Some(snapshot.run_id.clone()),
            loop_state: Some(snapshot.loop_state.clone()),
            snapshot: Some(snapshot),
        })
    }

    pub fn register_approvals(
        &self,
        request: AssistantApprovalRegistrationRequest,
    ) -> Result<AssistantApprovalResolutionResponse, String> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|err| format!("Failed to acquire assistant runtime lock: {err}"))?;
        let Some(record) = runs.get_mut(&request.conversation_id) else {
            return Ok(AssistantApprovalResolutionResponse {
                success: false,
                conversation_id: request.conversation_id,
                run_id: None,
                approved_tool_ids: Vec::new(),
                denied_tool_ids: Vec::new(),
                unresolved_tool_ids: Vec::new(),
                waiting_approval: false,
                snapshot: None,
            });
        };

        if request.run_id.as_deref().is_some()
            && request.run_id.as_deref() != Some(record.run_id.as_str())
        {
            return Ok(AssistantApprovalResolutionResponse {
                success: false,
                conversation_id: request.conversation_id,
                run_id: Some(record.run_id.clone()),
                approved_tool_ids: Vec::new(),
                denied_tool_ids: Vec::new(),
                unresolved_tool_ids: Vec::new(),
                waiting_approval: record.waiting_approval,
                snapshot: Some(record.into_snapshot()),
            });
        }

        for tool_id in request.tool_ids {
            record
                .pending_approvals
                .entry(tool_id)
                .and_modify(|approval| {
                    if approval.message_id.is_none() {
                        approval.message_id = request.message_id.clone();
                    }
                })
                .or_insert_with(|| NativeApprovalRecord {
                    message_id: request.message_id.clone(),
                    review_status: Some("pending".to_string()),
                    status: Some("pending".to_string()),
                });
        }
        record.waiting_approval = !record.pending_approvals.is_empty();
        let snapshot = record.into_snapshot();
        let (approved_tool_ids, denied_tool_ids, unresolved_tool_ids) =
            record.approval_resolution();

        Ok(AssistantApprovalResolutionResponse {
            success: true,
            conversation_id: request.conversation_id,
            run_id: Some(snapshot.run_id.clone()),
            approved_tool_ids,
            denied_tool_ids,
            unresolved_tool_ids,
            waiting_approval: snapshot.waiting_approval,
            snapshot: Some(snapshot),
        })
    }

    pub fn update_approval(
        &self,
        request: AssistantApprovalUpdateRequest,
    ) -> Result<AssistantApprovalResolutionResponse, String> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|err| format!("Failed to acquire assistant runtime lock: {err}"))?;
        let Some(record) = runs.get_mut(&request.conversation_id) else {
            return Ok(AssistantApprovalResolutionResponse {
                success: false,
                conversation_id: request.conversation_id,
                run_id: None,
                approved_tool_ids: Vec::new(),
                denied_tool_ids: Vec::new(),
                unresolved_tool_ids: Vec::new(),
                waiting_approval: false,
                snapshot: None,
            });
        };

        if request.run_id.as_deref().is_some()
            && request.run_id.as_deref() != Some(record.run_id.as_str())
        {
            return Ok(AssistantApprovalResolutionResponse {
                success: false,
                conversation_id: request.conversation_id,
                run_id: Some(record.run_id.clone()),
                approved_tool_ids: Vec::new(),
                denied_tool_ids: Vec::new(),
                unresolved_tool_ids: Vec::new(),
                waiting_approval: record.waiting_approval,
                snapshot: Some(record.into_snapshot()),
            });
        }

        let approval = record
            .pending_approvals
            .entry(request.tool_call_id.clone())
            .or_insert_with(NativeApprovalRecord::default);
        if request.message_id.is_some() {
            approval.message_id = request.message_id;
        }
        if request.review_status.is_some() {
            approval.review_status = request.review_status;
        }
        if request.status.is_some() {
            approval.status = request.status;
        }

        let (_, _, unresolved_tool_ids) = record.approval_resolution();
        record.waiting_approval = !unresolved_tool_ids.is_empty();
        let snapshot = record.into_snapshot();
        let (approved_tool_ids, denied_tool_ids, unresolved_tool_ids) =
            record.approval_resolution();

        Ok(AssistantApprovalResolutionResponse {
            success: true,
            conversation_id: request.conversation_id,
            run_id: Some(snapshot.run_id.clone()),
            approved_tool_ids,
            denied_tool_ids,
            unresolved_tool_ids,
            waiting_approval: snapshot.waiting_approval,
            snapshot: Some(snapshot),
        })
    }

    pub fn resolve_approvals(
        &self,
        request: AssistantRunActionRequest,
    ) -> Result<AssistantApprovalResolutionResponse, String> {
        let runs = self
            .runs
            .lock()
            .map_err(|err| format!("Failed to acquire assistant runtime lock: {err}"))?;
        let Some(record) = runs.get(&request.conversation_id) else {
            return Ok(AssistantApprovalResolutionResponse {
                success: false,
                conversation_id: request.conversation_id,
                run_id: None,
                approved_tool_ids: Vec::new(),
                denied_tool_ids: Vec::new(),
                unresolved_tool_ids: Vec::new(),
                waiting_approval: false,
                snapshot: None,
            });
        };

        if request.run_id.as_deref().is_some()
            && request.run_id.as_deref() != Some(record.run_id.as_str())
        {
            return Ok(AssistantApprovalResolutionResponse {
                success: false,
                conversation_id: request.conversation_id,
                run_id: Some(record.run_id.clone()),
                approved_tool_ids: Vec::new(),
                denied_tool_ids: Vec::new(),
                unresolved_tool_ids: Vec::new(),
                waiting_approval: record.waiting_approval,
                snapshot: Some(record.into_snapshot()),
            });
        }

        let snapshot = record.into_snapshot();
        let (approved_tool_ids, denied_tool_ids, unresolved_tool_ids) =
            record.approval_resolution();
        Ok(AssistantApprovalResolutionResponse {
            success: true,
            conversation_id: request.conversation_id,
            run_id: Some(snapshot.run_id.clone()),
            approved_tool_ids,
            denied_tool_ids,
            unresolved_tool_ids,
            waiting_approval: snapshot.waiting_approval,
            snapshot: Some(snapshot),
        })
    }

    pub fn set_dispatch_plan(
        &self,
        request: AssistantDispatchPlanRequest,
    ) -> Result<AssistantDispatchStepResponse, String> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|err| format!("Failed to acquire assistant runtime lock: {err}"))?;
        let Some(record) = runs.get_mut(&request.conversation_id) else {
            return Ok(AssistantDispatchStepResponse {
                success: false,
                conversation_id: request.conversation_id,
                run_id: None,
                waiting_approval: false,
                has_more_steps: false,
                active_step: None,
                completed_step: None,
                snapshot: None,
            });
        };

        if request.run_id.as_deref().is_some()
            && request.run_id.as_deref() != Some(record.run_id.as_str())
        {
            return Ok(AssistantDispatchStepResponse {
                success: false,
                conversation_id: request.conversation_id,
                run_id: Some(record.run_id.clone()),
                waiting_approval: record.waiting_approval,
                has_more_steps: record.has_pending_dispatch_steps(),
                active_step: record
                    .current_dispatch_step()
                    .map(|step| step.into_public(None)),
                completed_step: None,
                snapshot: Some(record.into_snapshot()),
            });
        }

        let mut stages = if request.execution_stages.is_empty() {
            let mut derived = Vec::new();
            if !request.eager_tool_ids.is_empty() {
                derived.push("eager_tools".to_string());
            }
            if !request.file_queue_keys.is_empty() {
                derived.push("file_edits".to_string());
            }
            if !request.deferred_tool_ids.is_empty() {
                derived.push("deferred_tools".to_string());
            }
            if !request.pending_approval_tool_ids.is_empty() {
                derived.push("approvals".to_string());
            }
            derived
        } else {
            request.execution_stages.clone()
        };

        if !request.pending_approval_tool_ids.is_empty()
            && !stages.iter().any(|stage| stage == "approvals")
        {
            stages.push("approvals".to_string());
        }

        let mut dispatch_steps = Vec::new();
        for stage in stages {
            match stage.as_str() {
                "eager_tools" if !request.eager_tool_ids.is_empty() => {
                    dispatch_steps.push(NativeDispatchStepRecord {
                        step_id: Uuid::new_v4().to_string(),
                        stage,
                        status: "pending".to_string(),
                        tool_ids: request.eager_tool_ids.clone(),
                        file_queue_keys: Vec::new(),
                        file_edit_concurrency: None,
                    });
                }
                "file_edits" if !request.file_queue_keys.is_empty() => {
                    dispatch_steps.push(NativeDispatchStepRecord {
                        step_id: Uuid::new_v4().to_string(),
                        stage,
                        status: "pending".to_string(),
                        tool_ids: Vec::new(),
                        file_queue_keys: request.file_queue_keys.clone(),
                        file_edit_concurrency: request.file_edit_concurrency,
                    });
                }
                "deferred_tools" if !request.deferred_tool_ids.is_empty() => {
                    dispatch_steps.push(NativeDispatchStepRecord {
                        step_id: Uuid::new_v4().to_string(),
                        stage,
                        status: "pending".to_string(),
                        tool_ids: request.deferred_tool_ids.clone(),
                        file_queue_keys: Vec::new(),
                        file_edit_concurrency: None,
                    });
                }
                "approvals" if !request.pending_approval_tool_ids.is_empty() => {
                    dispatch_steps.push(NativeDispatchStepRecord {
                        step_id: Uuid::new_v4().to_string(),
                        stage,
                        status: "pending".to_string(),
                        tool_ids: request.pending_approval_tool_ids.clone(),
                        file_queue_keys: Vec::new(),
                        file_edit_concurrency: None,
                    });
                }
                _ => {}
            }
        }

        record.dispatch_steps = dispatch_steps;
        record.dispatch_cursor = 0;
        record.active_dispatch_step_id = None;
        record.updated_at_ms = Self::now_ms();
        let snapshot = record.into_snapshot();

        Ok(AssistantDispatchStepResponse {
            success: true,
            conversation_id: request.conversation_id,
            run_id: Some(snapshot.run_id.clone()),
            waiting_approval: record.waiting_approval,
            has_more_steps: record.has_pending_dispatch_steps(),
            active_step: None,
            completed_step: None,
            snapshot: Some(snapshot),
        })
    }

    pub fn claim_next_dispatch_step(
        &self,
        request: AssistantDispatchStepRequest,
    ) -> Result<AssistantDispatchStepResponse, String> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|err| format!("Failed to acquire assistant runtime lock: {err}"))?;
        let Some(record) = runs.get_mut(&request.conversation_id) else {
            return Ok(AssistantDispatchStepResponse {
                success: false,
                conversation_id: request.conversation_id,
                run_id: None,
                waiting_approval: false,
                has_more_steps: false,
                active_step: None,
                completed_step: None,
                snapshot: None,
            });
        };

        if request.run_id.as_deref().is_some()
            && request.run_id.as_deref() != Some(record.run_id.as_str())
        {
            return Ok(AssistantDispatchStepResponse {
                success: false,
                conversation_id: request.conversation_id,
                run_id: Some(record.run_id.clone()),
                waiting_approval: record.waiting_approval,
                has_more_steps: record.has_pending_dispatch_steps(),
                active_step: record
                    .current_dispatch_step()
                    .map(|step| step.into_public(None)),
                completed_step: None,
                snapshot: Some(record.into_snapshot()),
            });
        }

        if let Some(active_step_id) = record.active_dispatch_step_id.clone() {
            if let Some(step) = record
                .dispatch_steps
                .iter()
                .find(|step| step.step_id == active_step_id)
            {
                let blocked_reason = if step.stage == "approvals" && record.waiting_approval {
                    Some("waiting_for_native_approval_resolution".to_string())
                } else {
                    None
                };
                return Ok(AssistantDispatchStepResponse {
                    success: blocked_reason.is_none(),
                    conversation_id: request.conversation_id,
                    run_id: Some(record.run_id.clone()),
                    waiting_approval: record.waiting_approval,
                    has_more_steps: record.has_pending_dispatch_steps(),
                    active_step: Some(step.into_public(blocked_reason)),
                    completed_step: None,
                    snapshot: Some(record.into_snapshot()),
                });
            }
        }

        while record.dispatch_cursor < record.dispatch_steps.len()
            && record.dispatch_steps[record.dispatch_cursor].status == "completed"
        {
            record.dispatch_cursor += 1;
        }

        let waiting_approval = record.waiting_approval;
        let Some(step) = record.dispatch_steps.get_mut(record.dispatch_cursor) else {
            let snapshot = record.into_snapshot();
            return Ok(AssistantDispatchStepResponse {
                success: true,
                conversation_id: request.conversation_id,
                run_id: Some(snapshot.run_id.clone()),
                waiting_approval: record.waiting_approval,
                has_more_steps: false,
                active_step: None,
                completed_step: None,
                snapshot: Some(snapshot),
            });
        };

        let blocked_reason = if step.stage == "approvals" && waiting_approval {
            Some("waiting_for_native_approval_resolution".to_string())
        } else {
            None
        };
        step.status = "running".to_string();
        record.active_dispatch_step_id = Some(step.step_id.clone());
        record.updated_at_ms = Self::now_ms();
        let public_step = step.into_public(blocked_reason.clone());
        let snapshot = record.into_snapshot();

        Ok(AssistantDispatchStepResponse {
            success: blocked_reason.is_none(),
            conversation_id: request.conversation_id,
            run_id: Some(snapshot.run_id.clone()),
            waiting_approval,
            has_more_steps: true,
            active_step: Some(public_step),
            completed_step: None,
            snapshot: Some(snapshot),
        })
    }

    pub fn complete_dispatch_step(
        &self,
        request: AssistantDispatchStepRequest,
    ) -> Result<AssistantDispatchStepResponse, String> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|err| format!("Failed to acquire assistant runtime lock: {err}"))?;
        let Some(record) = runs.get_mut(&request.conversation_id) else {
            return Ok(AssistantDispatchStepResponse {
                success: false,
                conversation_id: request.conversation_id,
                run_id: None,
                waiting_approval: false,
                has_more_steps: false,
                active_step: None,
                completed_step: None,
                snapshot: None,
            });
        };

        if request.run_id.as_deref().is_some()
            && request.run_id.as_deref() != Some(record.run_id.as_str())
        {
            return Ok(AssistantDispatchStepResponse {
                success: false,
                conversation_id: request.conversation_id,
                run_id: Some(record.run_id.clone()),
                waiting_approval: record.waiting_approval,
                has_more_steps: record.has_pending_dispatch_steps(),
                active_step: record
                    .current_dispatch_step()
                    .map(|step| step.into_public(None)),
                completed_step: None,
                snapshot: Some(record.into_snapshot()),
            });
        }

        let target_step_id = request
            .step_id
            .clone()
            .or_else(|| record.active_dispatch_step_id.clone());
        let Some(target_step_id) = target_step_id else {
            return Ok(AssistantDispatchStepResponse {
                success: false,
                conversation_id: request.conversation_id,
                run_id: Some(record.run_id.clone()),
                waiting_approval: record.waiting_approval,
                has_more_steps: record.has_pending_dispatch_steps(),
                active_step: None,
                completed_step: None,
                snapshot: Some(record.into_snapshot()),
            });
        };

        let mut completed_step = None;
        for step in &mut record.dispatch_steps {
            if step.step_id == target_step_id {
                step.status = "completed".to_string();
                completed_step = Some(step.into_public(None));
                break;
            }
        }

        if completed_step.is_none() {
            return Ok(AssistantDispatchStepResponse {
                success: false,
                conversation_id: request.conversation_id,
                run_id: Some(record.run_id.clone()),
                waiting_approval: record.waiting_approval,
                has_more_steps: record.has_pending_dispatch_steps(),
                active_step: None,
                completed_step: None,
                snapshot: Some(record.into_snapshot()),
            });
        }

        if record.active_dispatch_step_id.as_deref() == Some(target_step_id.as_str()) {
            record.active_dispatch_step_id = None;
        }
        while record.dispatch_cursor < record.dispatch_steps.len()
            && record.dispatch_steps[record.dispatch_cursor].status == "completed"
        {
            record.dispatch_cursor += 1;
        }
        record.updated_at_ms = Self::now_ms();
        let snapshot = record.into_snapshot();

        Ok(AssistantDispatchStepResponse {
            success: true,
            conversation_id: request.conversation_id,
            run_id: Some(snapshot.run_id.clone()),
            waiting_approval: record.waiting_approval,
            has_more_steps: record.has_pending_dispatch_steps(),
            active_step: record
                .current_dispatch_step()
                .map(|step| step.into_public(None)),
            completed_step,
            snapshot: Some(snapshot),
        })
    }

    pub fn publish_event<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        request: AssistantRuntimePublishEventRequest,
    ) -> Result<AssistantRunActionResponse, String> {
        let mut runs = self
            .runs
            .lock()
            .map_err(|err| format!("Failed to acquire assistant runtime lock: {err}"))?;
        let Some(record) = runs.get_mut(&request.conversation_id) else {
            return Ok(AssistantRunActionResponse {
                success: false,
                conversation_id: request.conversation_id,
                run_id: None,
                loop_state: None,
                snapshot: None,
            });
        };

        if request.run_id.as_deref().is_some()
            && request.run_id.as_deref() != Some(record.run_id.as_str())
        {
            return Ok(AssistantRunActionResponse {
                success: false,
                conversation_id: request.conversation_id,
                run_id: Some(record.run_id.clone()),
                loop_state: Some(record.loop_state.clone()),
                snapshot: Some(record.into_snapshot()),
            });
        }

        let event = AssistantRuntimeEvent {
            event_id: Uuid::new_v4().to_string(),
            conversation_id: request.conversation_id.clone(),
            run_id: record.run_id.clone(),
            timestamp_ms: Self::now_ms(),
            kind: request.kind,
            loop_state: request.loop_state,
            payload: request.payload,
        };

        record.apply_event(&event);
        let snapshot = record.into_snapshot();
        drop(runs);
        self.emit_event(app, &event);

        Ok(AssistantRunActionResponse {
            success: true,
            conversation_id: request.conversation_id,
            run_id: Some(snapshot.run_id.clone()),
            loop_state: Some(snapshot.loop_state.clone()),
            snapshot: Some(snapshot),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_record_tracks_approval_and_terminal_events() {
        let mut record = AssistantRunRecord {
            run_id: "run-1".to_string(),
            conversation_id: "conv-1".to_string(),
            mode: "agent".to_string(),
            model_id: "model".to_string(),
            loop_state: "running".to_string(),
            started_at_ms: 1,
            updated_at_ms: 1,
            auto_approve_all_tools: false,
            waiting_approval: false,
            cancelled: false,
            event_count: 0,
            system_prompt: None,
            request_envelope: None,
            runtime_snapshot: None,
            last_error: None,
            last_event: None,
            pending_approvals: HashMap::new(),
            dispatch_steps: Vec::new(),
            dispatch_cursor: 0,
            active_dispatch_step_id: None,
        };

        record.apply_event(&AssistantRuntimeEvent {
            event_id: "evt-1".to_string(),
            conversation_id: "conv-1".to_string(),
            run_id: "run-1".to_string(),
            timestamp_ms: 10,
            kind: "approval_requested".to_string(),
            loop_state: Some("waiting_approval".to_string()),
            payload: AssistantRuntimeEventPayload::default(),
        });
        assert!(record.waiting_approval);
        assert_eq!(record.loop_state, "waiting_approval");

        record.apply_event(&AssistantRuntimeEvent {
            event_id: "evt-2".to_string(),
            conversation_id: "conv-1".to_string(),
            run_id: "run-1".to_string(),
            timestamp_ms: 20,
            kind: "run_cancelled".to_string(),
            loop_state: Some("cancelled".to_string()),
            payload: AssistantRuntimeEventPayload::default(),
        });
        assert!(record.cancelled);
        assert!(!record.waiting_approval);
        assert_eq!(record.loop_state, "cancelled");
        assert_eq!(record.event_count, 2);
    }

    #[test]
    fn approval_resolution_tracks_pending_accept_and_reject() {
        let mut record = AssistantRunRecord {
            run_id: "run-2".to_string(),
            conversation_id: "conv-2".to_string(),
            mode: "agent".to_string(),
            model_id: "model".to_string(),
            loop_state: "waiting_approval".to_string(),
            started_at_ms: 1,
            updated_at_ms: 1,
            auto_approve_all_tools: false,
            waiting_approval: true,
            cancelled: false,
            event_count: 0,
            system_prompt: None,
            request_envelope: None,
            runtime_snapshot: None,
            last_error: None,
            last_event: None,
            pending_approvals: HashMap::from([
                (
                    "approved".to_string(),
                    NativeApprovalRecord {
                        message_id: Some("msg-1".to_string()),
                        review_status: Some("accepted".to_string()),
                        status: Some("pending".to_string()),
                    },
                ),
                (
                    "denied".to_string(),
                    NativeApprovalRecord {
                        message_id: Some("msg-1".to_string()),
                        review_status: Some("rejected".to_string()),
                        status: Some("cancelled".to_string()),
                    },
                ),
                (
                    "waiting".to_string(),
                    NativeApprovalRecord {
                        message_id: Some("msg-1".to_string()),
                        review_status: Some("pending".to_string()),
                        status: Some("pending".to_string()),
                    },
                ),
            ]),
            dispatch_steps: Vec::new(),
            dispatch_cursor: 0,
            active_dispatch_step_id: None,
        };

        let (approved, denied, unresolved) = record.approval_resolution();
        assert_eq!(approved, vec!["approved".to_string()]);
        assert_eq!(denied, vec!["denied".to_string()]);
        assert_eq!(unresolved, vec!["waiting".to_string()]);

        record.apply_event(&AssistantRuntimeEvent {
            event_id: "evt-3".to_string(),
            conversation_id: "conv-2".to_string(),
            run_id: "run-2".to_string(),
            timestamp_ms: 30,
            kind: "approval_resumed".to_string(),
            loop_state: Some("running".to_string()),
            payload: AssistantRuntimeEventPayload::default(),
        });

        assert!(record.pending_approvals.is_empty());
        assert!(!record.waiting_approval);
    }

    #[test]
    fn dispatch_plan_claim_and_complete_tracks_native_cursor() {
        let state = AssistantRuntimeManagerState::default();
        let conversation_id = "conv-dispatch".to_string();

        {
            let mut runs = state.runs.lock().unwrap();
            runs.insert(
                conversation_id.clone(),
                AssistantRunRecord {
                    run_id: "run-dispatch".to_string(),
                    conversation_id: conversation_id.clone(),
                    mode: "agent".to_string(),
                    model_id: "model".to_string(),
                    loop_state: "waiting_tool".to_string(),
                    started_at_ms: 1,
                    updated_at_ms: 1,
                    auto_approve_all_tools: false,
                    waiting_approval: false,
                    cancelled: false,
                    event_count: 0,
                    system_prompt: None,
                    request_envelope: None,
                    runtime_snapshot: None,
                    last_error: None,
                    last_event: None,
                    pending_approvals: HashMap::new(),
                    dispatch_steps: Vec::new(),
                    dispatch_cursor: 0,
                    active_dispatch_step_id: None,
                },
            );
        }

        let planned = state
            .set_dispatch_plan(AssistantDispatchPlanRequest {
                conversation_id: conversation_id.clone(),
                run_id: Some("run-dispatch".to_string()),
                execution_stages: vec![
                    "eager_tools".to_string(),
                    "file_edits".to_string(),
                    "deferred_tools".to_string(),
                ],
                eager_tool_ids: vec!["search".to_string()],
                deferred_tool_ids: vec!["diagnostics".to_string()],
                file_queue_keys: vec!["src/app.ts".to_string()],
                file_edit_concurrency: Some(2),
                pending_approval_tool_ids: Vec::new(),
            })
            .unwrap();
        assert!(planned.success);
        assert!(planned.has_more_steps);

        let first = state
            .claim_next_dispatch_step(AssistantDispatchStepRequest {
                conversation_id: conversation_id.clone(),
                run_id: Some("run-dispatch".to_string()),
                step_id: None,
                meta: None,
            })
            .unwrap();
        assert_eq!(
            first.active_step.as_ref().map(|step| step.stage.as_str()),
            Some("eager_tools")
        );

        let completed_first = state
            .complete_dispatch_step(AssistantDispatchStepRequest {
                conversation_id: conversation_id.clone(),
                run_id: Some("run-dispatch".to_string()),
                step_id: first.active_step.as_ref().map(|step| step.step_id.clone()),
                meta: None,
            })
            .unwrap();
        assert!(completed_first.success);
        assert!(completed_first.has_more_steps);

        let second = state
            .claim_next_dispatch_step(AssistantDispatchStepRequest {
                conversation_id: conversation_id.clone(),
                run_id: Some("run-dispatch".to_string()),
                step_id: None,
                meta: None,
            })
            .unwrap();
        assert_eq!(
            second.active_step.as_ref().map(|step| step.stage.as_str()),
            Some("file_edits")
        );
        assert_eq!(
            second
                .active_step
                .as_ref()
                .and_then(|step| step.file_edit_concurrency),
            Some(2)
        );
    }
}
