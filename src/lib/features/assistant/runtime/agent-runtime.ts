import type { ToolResult } from '$core/ai/tools';
import type { CompletionGateFreshness } from '$features/assistant/components/panel/completion-gate';
import type { ToolCallStatus } from '$features/assistant/types/tool-call';
import type { AIMode } from '$features/assistant/stores/ai.svelte';
import type { AgentLoopState } from '$features/assistant/stores/assistant/loop-state';
import { evaluateCompletionGate } from '$features/assistant/components/panel/completion-gate';
import {
  buildStructuralVerificationPlan,
  type StructuralVerificationPlan,
} from './verification-engine';
import type { AssistantRuntimeSnapshot } from '$features/assistant/stores/assistant.svelte';

export interface ToolCallLike {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultLike {
  id: string;
  name: string;
  result: ToolResult;
}

interface CompletionEvaluation {
  shouldBlock: boolean;
  code?: string;
  message?: string;
  output?: string;
  meta?: Record<string, unknown>;
  verificationPlan?: StructuralVerificationPlan;
}

interface ApprovalFlowDecision {
  shouldAbort: boolean;
  reason?: string;
  streamState?: 'failed';
  streamIssue?: string;
  resumeState?: AgentLoopState;
  resumeMeta?: Record<string, unknown>;
  resolvedState?: 'running' | 'completed' | 'failed' | 'cancelled';
}

interface NativeRuntimeCommandRequest {
  operation: string;
  conversationId: string;
  payload: Record<string, unknown>;
}

export interface NativeRuntimeCommandResult {
  shouldApply: boolean;
  operation: string;
  conversationId: string;
  loopState?: AgentLoopState;
  loopMeta?: Record<string, unknown>;
  messagePatch?: {
    messageId?: string | null;
    streamState?: 'failed' | 'cancelled' | 'completed' | 'interrupted';
    streamIssue?: string;
  };
  toolPatch?: {
    messageId?: string | null;
    toolCallId?: string | null;
    status?: ToolCallStatus | null;
    error?: string;
    output?: string;
    meta?: Record<string, unknown>;
  };
  control?: {
    retry?: {
      allowed: boolean;
      delayMs?: number;
      maxRetries?: number;
      reason?: string;
    };
    cancellation?: {
      shouldCancel: boolean;
      reason?: string;
    };
    timeout?: {
      shouldTimeout: boolean;
      maxDurationMs?: number;
      reason?: string;
    };
    toolPolicy?: {
      executeInOrder?: boolean;
      deferUntilFileEditsComplete?: boolean;
      approvalRequired?: boolean;
      executionStages?: string[];
      fileEditConcurrency?: number;
      orderedFileQueueKeys?: string[];
      orderedEagerToolIds?: string[];
      orderedDeferredToolIds?: string[];
      pendingApprovalToolIds?: string[];
    };
    approval?: {
      shouldAbort: boolean;
      reason?: string;
      resumeState?: AgentLoopState;
      approvedToolIds?: string[];
      deniedToolIds?: string[];
      unresolvedToolIds?: string[];
    };
  };
  auditEntry?: {
    timestampMs: number;
    conversationId: string;
    operation: string;
    loopState?: string;
    meta?: Record<string, unknown>;
  };
}

interface CompletionAcceptance {
  shouldComplete: boolean;
  completionToolId?: string;
  completionText?: string;
  reason?: 'attempt_completion' | 'natural_completion';
}

interface LoopBudgetDecision {
  action: 'continue' | 'extend' | 'fail';
  newMaxLoopDurationMs?: number;
}

interface IterationLimitDecision {
  action: 'continue' | 'extend' | 'fail';
  newMaxIterations?: number;
}

interface AbortSignalDecision {
  shouldAbort: boolean;
  reason?: 'abort_signal';
}

interface IterationErrorDecision {
  action: 'retry' | 'fail' | 'stalled' | 'cancelled';
  reason: 'stream_stalled' | 'abort_during_iteration' | 'stream_interrupted' | 'iteration_error';
  userMessage: string;
  shouldRetry: boolean;
  retryDelayMs?: number;
  recoveryNotice?: string;
  isInterrupted?: boolean;
  auditMeta?: Record<string, unknown>;
}

interface ToolSchedulingDecision {
  executeInOrder: boolean;
  deferUntilFileEditsComplete: boolean;
  approvalRequired: boolean;
  executionStages?: string[];
  fileEditConcurrency?: number;
  orderedFileQueueKeys?: string[];
  orderedEagerToolIds?: string[];
  orderedDeferredToolIds?: string[];
  pendingApprovalToolIds?: string[];
}

export interface AgentRuntimeNativeBridge {
  sendCommand: (
    request: NativeRuntimeCommandRequest,
  ) => Promise<NativeRuntimeCommandResult>;
}

const AGENT_LOOP_STATES: readonly AgentLoopState[] = [
  'running',
  'waiting_approval',
  'waiting_tool',
  'completing',
  'completed',
  'failed',
  'cancelled',
] as const;

function normalizeLoopState(value: unknown): AgentLoopState | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return AGENT_LOOP_STATES.includes(normalized as AgentLoopState)
    ? (normalized as AgentLoopState)
    : undefined;
}

function isAgentLoopState(value: string): value is AgentLoopState {
  return (
    value === 'running' ||
    value === 'waiting_approval' ||
    value === 'waiting_tool' ||
    value === 'completing' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  );
}

export function createAgentRuntime(nativeBridge?: AgentRuntimeNativeBridge) {
  const applyNativeDecision = async (params: {
    operation: string;
    snapshot: AssistantRuntimeSnapshot | null;
    payload: Record<string, unknown>;
  }): Promise<NativeRuntimeCommandResult | null> => {
    if (!nativeBridge || !params.snapshot) return null;

    const requestPayload = {
      mode: params.snapshot.mode as AIMode,
      isStreaming: params.snapshot.isStreaming,
      agentLoopState: params.snapshot.agentLoopState,
      agentLoopMeta: params.snapshot.agentLoopMeta,
      runUpdatedAt: params.snapshot.runUpdatedAt,
      activeMessageId: params.snapshot.activeMessageId,
      activeToolCallId: params.snapshot.activeToolCallId,
      activeToolCallName: params.snapshot.activeToolCallName,
      activeToolStatus: params.snapshot.activeToolStatus,
      activeToolRequiresApproval: params.snapshot.activeToolRequiresApproval,
      pendingApprovalCount: params.snapshot.pendingApprovalCount,
      runningToolCount: params.snapshot.runningToolCount,
      messageCount: params.snapshot.messageCount,
      ...params.payload,
    };

    try {
      return await nativeBridge.sendCommand({
        operation: params.operation,
        conversationId: params.snapshot.conversationId,
        payload: requestPayload,
      });
    } catch {
      return null;
    }
  };

  const buildRuntimeRequest = async (params: {
    operation: string;
    snapshot: AssistantRuntimeSnapshot | null;
    payload: Record<string, unknown>;
  }): Promise<NativeRuntimeCommandResult | null> => {
    const result = await applyNativeDecision(params);
    if (!result || !result.shouldApply) return null;
    return {
      ...result,
        loopState: (() => {
          const normalized = normalizeLoopState(result.loopState);
          return normalized && isAgentLoopState(normalized) ? normalized : undefined;
        })(),
    };
  };

  const evaluateCompletion = (params: {
      errorCount: number;
      freshness: CompletionGateFreshness;
      structuralMutationPaths: string[];
      touchedPaths?: string[];
    }): CompletionEvaluation => {
      const decision = evaluateCompletionGate(params);
      const verificationPlan = buildStructuralVerificationPlan(params.structuralMutationPaths);

      return {
        shouldBlock: decision.shouldBlock,
        code: decision.code,
        message: decision.message,
        output: decision.output,
        verificationPlan,
        meta: decision.code
          ? {
              code: decision.code,
              errorCount: params.errorCount,
              touchedPaths: params.touchedPaths ?? [],
              structuralMutationPaths: params.structuralMutationPaths,
              freshness: params.freshness,
              verificationPlan,
            }
          : undefined,
      };
    };

  const evaluateEditFailures = (params: {
      allToolCalls: ToolCallLike[];
      normalizedToolResults: ToolResultLike[];
      isFileMutatingTool: (name: string) => boolean;
    }): {
      shouldBlock: boolean;
      message?: string;
      output?: string;
      meta?: Record<string, unknown>;
    } => {
      const unresolvedEditFailures = new Map<
        string,
        { toolName: string; error: string }
      >();

      for (const toolCall of params.allToolCalls) {
        const toolResult = params.normalizedToolResults.find(
          (entry) => entry.id === toolCall.id,
        );
        if (!toolResult || !params.isFileMutatingTool(toolCall.name)) continue;

        const rawPath =
          typeof toolCall.arguments?.path === 'string'
            ? String(toolCall.arguments.path).trim()
            : typeof toolCall.arguments?.oldPath === 'string'
              ? String(toolCall.arguments.oldPath).trim()
              : '';
        const pathKey = rawPath || `__tool:${toolCall.name}`;

        if (toolResult.result.success) {
          unresolvedEditFailures.delete(pathKey);
          continue;
        }
        unresolvedEditFailures.set(pathKey, {
          toolName: toolCall.name,
          error: String(
            toolResult.result.error ?? toolResult.result.output ?? 'Edit tool failed',
          ),
        });
      }

      if (unresolvedEditFailures.size === 0) {
        return { shouldBlock: false };
      }

      const entries = Array.from(unresolvedEditFailures.entries()).map(([path, info]) => ({
        path,
        toolName: info.toolName,
        error: info.error,
      }));
      const firstPath = entries[0]?.path ?? 'unknown-path';

      return {
        shouldBlock: true,
        message:
          'Completion blocked: unresolved edit failures remain. Fix failed edit tool calls before completing.',
        output: `Completion blocked because an edit failed (${firstPath}). Re-read the file and apply a corrected patch before calling attempt_completion again.`,
        meta: {
          code: 'COMPLETION_BLOCKED_BY_EDIT_FAILURES',
          unresolvedEditFailures: entries,
        },
      };
    };

  const analyzeToolPass = (params: {
      allToolCalls: ToolCallLike[];
      normalizedToolResults: ToolResultLike[];
      isFileMutatingTool: (name: string) => boolean;
    }): {
      completionResult?: ToolResultLike;
      visibleToolCalls: ToolCallLike[];
      visibleToolResults: ToolResultLike[];
      editFailureDecision: ReturnType<typeof evaluateEditFailures>;
    } => {
      const completionResult = params.normalizedToolResults.find(
        (entry) => entry.name === 'attempt_completion' && entry.result.success,
      );
      const visibleToolCalls = completionResult
        ? params.allToolCalls.filter((entry) => entry.name !== 'attempt_completion')
        : params.allToolCalls;
      const visibleToolResults = completionResult
        ? params.normalizedToolResults.filter((entry) => entry.name !== 'attempt_completion')
        : params.normalizedToolResults;

      return {
        completionResult,
        visibleToolCalls,
        visibleToolResults,
        editFailureDecision: evaluateEditFailures(params),
      };
    };

  const evaluateApprovalFlow = (approvalsProcessed: boolean): ApprovalFlowDecision => {
    if (approvalsProcessed) {
      return {
        shouldAbort: false,
        resumeState: 'running',
        resolvedState: 'running',
        resumeMeta: {
          resumedAfterApproval: true,
        },
      };
    }

    return {
      shouldAbort: true,
      reason: 'approval_flow_incomplete',
      streamState: 'failed',
      streamIssue: 'Approval flow incomplete',
      resolvedState: 'failed',
    };
  };

  const evaluateToolScheduling = (params: {
    pendingApprovalCount: number;
    hasQueuedFileEdits: boolean;
    defaultExecuteInOrder?: boolean;
    nativeDecision?: NativeRuntimeCommandResult | null;
  }): ToolSchedulingDecision => {
    const nativePolicy = params.nativeDecision?.control?.toolPolicy;
    return {
      executeInOrder: nativePolicy?.executeInOrder ?? params.defaultExecuteInOrder ?? false,
      deferUntilFileEditsComplete:
        nativePolicy?.deferUntilFileEditsComplete ?? params.hasQueuedFileEdits,
      approvalRequired:
        nativePolicy?.approvalRequired ?? params.pendingApprovalCount > 0,
      executionStages: nativePolicy?.executionStages,
      fileEditConcurrency: nativePolicy?.fileEditConcurrency,
      orderedFileQueueKeys: nativePolicy?.orderedFileQueueKeys,
      orderedEagerToolIds: nativePolicy?.orderedEagerToolIds,
      orderedDeferredToolIds: nativePolicy?.orderedDeferredToolIds,
      pendingApprovalToolIds: nativePolicy?.pendingApprovalToolIds,
    };
  };

  const evaluateCompletionAcceptance = (params: {
    completionResult?: ToolResultLike;
    allToolCalls: ToolCallLike[];
    fullContent?: string;
    allowNaturalCompletion?: boolean;
    nativeDecision?: NativeRuntimeCommandResult | null;
  }): CompletionAcceptance => {
    if (params.nativeDecision?.control?.cancellation?.shouldCancel) {
      return { shouldComplete: false };
    }
    if (!params.completionResult) {
      const naturalText = params.fullContent?.trim() ?? '';
      if (!naturalText) {
        return { shouldComplete: false };
      }

      if (params.allowNaturalCompletion === false) {
        return { shouldComplete: false };
      }

      const hasRealWork = params.allToolCalls.some((entry) => entry.name !== 'attempt_completion');
      return hasRealWork
        ? {
            shouldComplete: true,
            completionText: naturalText,
            reason: 'natural_completion',
          }
        : { shouldComplete: false };
    }

    const completionCall = params.allToolCalls.find(
      (entry) => entry.id === params.completionResult?.id,
    );
    const completionText =
      typeof completionCall?.arguments?.result === 'string'
        ? completionCall.arguments.result.trim()
        : '';

    return {
      shouldComplete: true,
      completionToolId: params.completionResult.id,
      completionText,
      reason: 'attempt_completion',
    };
  };

  const evaluateLoopBudget = (params: {
    elapsedMs: number;
    maxLoopDurationMs: number;
    canExtendBudget: boolean;
    hardMaxLoopDurationMs: number;
  }): LoopBudgetDecision => {
    if (params.elapsedMs <= params.maxLoopDurationMs) {
      return { action: 'continue' };
    }

    if (params.canExtendBudget) {
      return {
        action: 'extend',
        newMaxLoopDurationMs: Math.min(
          params.maxLoopDurationMs + 4 * 60 * 1000,
          params.hardMaxLoopDurationMs,
        ),
      };
    }

    return { action: 'fail' };
  };

  const evaluateIterationLimit = (params: {
    iteration: number;
    maxIterations: number;
    canExtendBudget: boolean;
    hardMaxIterations: number;
  }): IterationLimitDecision => {
    if (params.iteration < params.maxIterations) {
      return { action: 'continue' };
    }

    if (params.canExtendBudget) {
      return {
        action: 'extend',
        newMaxIterations: Math.min(params.maxIterations + 20, params.hardMaxIterations),
      };
    }

    return { action: 'fail' };
  };

  const evaluateAbortSignal = (aborted: boolean): AbortSignalDecision => {
    return aborted ? { shouldAbort: true, reason: 'abort_signal' } : { shouldAbort: false };
  };

  const evaluateIterationError = (params: {
    message: string;
    iteration: number;
    maxIterations: number;
    recoveryRetryCount: number;
    maxRecoveryRetries: number;
    stalledAbortReason: string | null;
    fullContent: string;
    nativeDecision?: NativeRuntimeCommandResult | null;
  }): IterationErrorDecision => {
    const nativeCancellation = params.nativeDecision?.control?.cancellation;
    if (nativeCancellation?.shouldCancel) {
      return {
        action: 'cancelled',
        reason: 'abort_during_iteration',
        userMessage: nativeCancellation.reason ?? 'Streaming cancelled',
        shouldRetry: false,
        auditMeta: params.nativeDecision?.auditEntry?.meta,
      };
    }

    if (params.stalledAbortReason) {
      return {
        action: 'stalled',
        reason: 'stream_stalled',
        userMessage: params.stalledAbortReason,
        shouldRetry: false,
        auditMeta: params.nativeDecision?.auditEntry?.meta,
      };
    }

    const isInterrupted =
      /interrupted|idle timeout|stream.*ended|before completion|cancelled/i.test(
        params.message,
      );
    const isRetryable = /network|timeout|connection|interrupted|503|502|504|429/i.test(
      params.message,
    );

    const nativeRetry = params.nativeDecision?.control?.retry;
    const allowRetry =
      nativeRetry?.allowed ??
      (isRetryable &&
        params.iteration < params.maxIterations - 1 &&
        params.recoveryRetryCount < params.maxRecoveryRetries);

    if (allowRetry) {
      return {
        action: 'retry',
        reason: isInterrupted ? 'stream_interrupted' : 'iteration_error',
        userMessage: params.message,
        shouldRetry: true,
        retryDelayMs: nativeRetry?.delayMs ?? 1000,
        recoveryNotice: `A temporary error occurred: ${params.message}. Please continue with your task. If you were in the middle of something, resume from where you left off.`,
        isInterrupted,
        auditMeta: params.nativeDecision?.auditEntry?.meta,
      };
    }

    const assistantMessage = params.fullContent
      ? isInterrupted
        ? `${params.fullContent}\n\n⚠️ Stream interrupted before completion. Partial response kept.`
        : `${params.fullContent}\n\n⚠️ Error: ${params.message}`
      : isInterrupted
        ? '⚠️ Stream interrupted before completion. Partial response kept.'
        : `⚠️ Error: ${params.message}`;

    return {
      action: 'fail',
      reason: isInterrupted ? 'stream_interrupted' : 'iteration_error',
      userMessage: assistantMessage,
      shouldRetry: false,
      isInterrupted,
      auditMeta: params.nativeDecision?.auditEntry?.meta,
    };
  };

  return {
    buildRuntimeRequest,
    evaluateCompletion,
    evaluateEditFailures,
    analyzeToolPass,
    evaluateApprovalFlow,
    evaluateToolScheduling,
    evaluateCompletionAcceptance,
    evaluateIterationLimit,
    evaluateLoopBudget,
    evaluateAbortSignal,
    evaluateIterationError,
  };
}
