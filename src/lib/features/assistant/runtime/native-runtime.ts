import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type { AIMode } from '$features/assistant/stores/ai.svelte';
import type { AgentLoopState } from '$features/assistant/stores/assistant/loop-state';

export interface AssistantRuntimeMessagePatch {
  messageId?: string | null;
  content?: string;
  contentDelta?: string;
  thinkingDelta?: string;
  streamState?: 'active' | 'completed' | 'interrupted' | 'cancelled' | 'failed' | string;
  streamIssue?: string;
}

export interface AssistantRuntimeToolPatch {
  messageId?: string | null;
  toolCallId?: string | null;
  status?: string | null;
  error?: string;
  output?: string;
  // Audit-only payload. Live tool-card state is owned by the local assistant store.
  meta?: Record<string, unknown> | null;
}

export interface AssistantRuntimeEventPayload {
  loopMeta?: Record<string, unknown> | null;
  messagePatch?: AssistantRuntimeMessagePatch | null;
  toolPatch?: AssistantRuntimeToolPatch | null;
  toolCall?: Record<string, unknown> | null;
  toolResult?: Record<string, unknown> | null;
}

export interface AssistantRuntimeEvent {
  eventId: string;
  conversationId: string;
  runId: string;
  timestampMs: number;
  kind: string;
  loopState?: AgentLoopState | string;
  payload: AssistantRuntimeEventPayload;
}

export interface AssistantRunSnapshot {
  runId: string;
  conversationId: string;
  mode: AIMode | string;
  modelId: string;
  loopState: AgentLoopState | string;
  startedAtMs: number;
  updatedAtMs: number;
  autoApproveAllTools: boolean;
  waitingApproval: boolean;
  cancelled: boolean;
  eventCount: number;
  systemPrompt?: string | null;
  requestEnvelope?: Record<string, unknown> | null;
  runtimeSnapshot?: Record<string, unknown> | null;
  lastError?: string | null;
  lastEvent?: AssistantRuntimeEvent | null;
}

export interface AssistantRunStartRequest {
  conversationId: string;
  mode: AIMode;
  modelId: string;
  systemPrompt: string;
  requestEnvelope?: Record<string, unknown>;
  runtimeSnapshot?: Record<string, unknown>;
  autoApproveAllTools?: boolean;
}

export interface AssistantRunStartResponse {
  accepted: boolean;
  runId: string;
  conversationId: string;
  loopState: AgentLoopState | string;
  snapshot: AssistantRunSnapshot;
}

export interface AssistantRunActionRequest {
  conversationId: string;
  runId?: string;
  reason?: string;
  meta?: Record<string, unknown>;
}

export interface AssistantRunActionResponse {
  success: boolean;
  conversationId: string;
  runId?: string | null;
  loopState?: AgentLoopState | string | null;
  snapshot?: AssistantRunSnapshot | null;
}

export interface AssistantApprovalRegistrationRequest {
  conversationId: string;
  runId?: string;
  messageId?: string;
  toolIds: string[];
}

export interface AssistantApprovalUpdateRequest {
  conversationId: string;
  runId?: string;
  toolCallId: string;
  messageId?: string;
  reviewStatus?: string;
  status?: string;
}

export interface AssistantApprovalResolutionResponse {
  success: boolean;
  conversationId: string;
  runId?: string | null;
  approvedToolIds: string[];
  deniedToolIds: string[];
  unresolvedToolIds: string[];
  waitingApproval: boolean;
  snapshot?: AssistantRunSnapshot | null;
}

export interface AssistantDispatchPlanRequest {
  conversationId: string;
  runId?: string;
  executionStages?: string[];
  eagerToolIds?: string[];
  deferredToolIds?: string[];
  fileQueueKeys?: string[];
  fileEditConcurrency?: number;
  pendingApprovalToolIds?: string[];
}

export interface AssistantDispatchStepRequest {
  conversationId: string;
  runId?: string;
  stepId?: string;
  meta?: Record<string, unknown>;
}

export interface AssistantDispatchStep {
  stepId: string;
  stage: string;
  status: string;
  toolIds: string[];
  fileQueueKeys: string[];
  fileEditConcurrency?: number | null;
  blockedReason?: string | null;
}

export interface AssistantDispatchStepResponse {
  success: boolean;
  conversationId: string;
  runId?: string | null;
  waitingApproval: boolean;
  hasMoreSteps: boolean;
  activeStep?: AssistantDispatchStep | null;
  completedStep?: AssistantDispatchStep | null;
  snapshot?: AssistantRunSnapshot | null;
}

export interface AssistantRuntimePublishEventRequest {
  conversationId: string;
  runId?: string;
  kind: string;
  loopState?: AgentLoopState | string;
  payload?: AssistantRuntimeEventPayload;
}

export async function assistantRunStart(
  request: AssistantRunStartRequest,
): Promise<AssistantRunStartResponse> {
  return invoke<AssistantRunStartResponse>('assistant_run_start', { request });
}

export async function assistantRunCancel(
  request: AssistantRunActionRequest,
): Promise<AssistantRunActionResponse> {
  return invoke<AssistantRunActionResponse>('assistant_run_cancel', { request });
}

export async function assistantRunResumeApproval(
  request: AssistantRunActionRequest,
): Promise<AssistantRunActionResponse> {
  return invoke<AssistantRunActionResponse>('assistant_run_resume_approval', { request });
}

export async function assistantRunRegisterApprovals(
  request: AssistantApprovalRegistrationRequest,
): Promise<AssistantApprovalResolutionResponse> {
  return invoke<AssistantApprovalResolutionResponse>('assistant_run_register_approvals', {
    request,
  });
}

export async function assistantRunUpdateApproval(
  request: AssistantApprovalUpdateRequest,
): Promise<AssistantApprovalResolutionResponse> {
  return invoke<AssistantApprovalResolutionResponse>('assistant_run_update_approval', {
    request,
  });
}

export async function assistantRunResolveApprovals(
  request: AssistantRunActionRequest,
): Promise<AssistantApprovalResolutionResponse> {
  return invoke<AssistantApprovalResolutionResponse>('assistant_run_resolve_approvals', {
    request,
  });
}

export async function assistantRunSetDispatchPlan(
  request: AssistantDispatchPlanRequest,
): Promise<AssistantDispatchStepResponse> {
  return invoke<AssistantDispatchStepResponse>('assistant_run_set_dispatch_plan', {
    request,
  });
}

export async function assistantRunClaimDispatchStep(
  request: AssistantDispatchStepRequest,
): Promise<AssistantDispatchStepResponse> {
  return invoke<AssistantDispatchStepResponse>('assistant_run_claim_dispatch_step', {
    request,
  });
}

export async function assistantRunCompleteDispatchStep(
  request: AssistantDispatchStepRequest,
): Promise<AssistantDispatchStepResponse> {
  return invoke<AssistantDispatchStepResponse>('assistant_run_complete_dispatch_step', {
    request,
  });
}

export async function assistantRunGetSnapshot(
  conversationId: string,
): Promise<AssistantRunSnapshot | null> {
  return invoke<AssistantRunSnapshot | null>('assistant_run_get_snapshot', { conversationId });
}

export async function assistantRuntimePublishEvent(
  request: AssistantRuntimePublishEventRequest,
): Promise<AssistantRunActionResponse> {
  return invoke<AssistantRunActionResponse>('assistant_runtime_publish_event', { request });
}

export async function listenToAssistantRuntimeEvents(
  onEvent: (event: AssistantRuntimeEvent) => void,
): Promise<UnlistenFn> {
  return listen<AssistantRuntimeEvent>('assistant-runtime://event', ({ payload }) => {
    onEvent(payload);
  });
}
