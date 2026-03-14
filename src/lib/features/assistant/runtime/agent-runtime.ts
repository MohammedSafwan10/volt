import type { ToolResult } from '$core/ai/tools';
import type { CompletionGateFreshness } from '$features/assistant/components/panel/completion-gate';
import { evaluateCompletionGate } from '$features/assistant/components/panel/completion-gate';
import {
  buildStructuralVerificationPlan,
  type StructuralVerificationPlan,
} from './verification-engine';

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
}

export function createAgentRuntime() {
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
      return { shouldAbort: false };
    }

    return {
      shouldAbort: true,
      reason: 'approval_flow_incomplete',
      streamState: 'failed',
      streamIssue: 'Approval flow incomplete',
    };
  };

  const evaluateCompletionAcceptance = (params: {
    completionResult?: ToolResultLike;
    allToolCalls: ToolCallLike[];
    fullContent?: string;
  }): CompletionAcceptance => {
    if (!params.completionResult) {
      const naturalText = params.fullContent?.trim() ?? '';
      if (!naturalText) {
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
  }): IterationErrorDecision => {
    if (params.stalledAbortReason) {
      return {
        action: 'stalled',
        reason: 'stream_stalled',
        userMessage: params.stalledAbortReason,
        shouldRetry: false,
      };
    }

    const isInterrupted =
      /interrupted|idle timeout|stream.*ended|before completion|cancelled/i.test(
        params.message,
      );
    const isRetryable = /network|timeout|connection|interrupted|503|502|504|429/i.test(
      params.message,
    );

    if (
      isRetryable &&
      params.iteration < params.maxIterations - 1 &&
      params.recoveryRetryCount < params.maxRecoveryRetries
    ) {
      return {
        action: 'retry',
        reason: isInterrupted ? 'stream_interrupted' : 'iteration_error',
        userMessage: params.message,
        shouldRetry: true,
        retryDelayMs: 1000,
        recoveryNotice: `A temporary error occurred: ${params.message}. Please continue with your task. If you were in the middle of something, resume from where you left off.`,
        isInterrupted,
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
    };
  };

  return {
    evaluateCompletion,
    evaluateEditFailures,
    analyzeToolPass,
    evaluateApprovalFlow,
    evaluateCompletionAcceptance,
    evaluateIterationLimit,
    evaluateLoopBudget,
    evaluateAbortSignal,
    evaluateIterationError,
  };
}
