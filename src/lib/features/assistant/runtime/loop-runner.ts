import type { LoopTerminalOutcome } from './loop-finalizer';

export function resolveIterationLimitAction(params: {
  decision: { action: 'continue' | 'extend' | 'fail'; newMaxIterations?: number };
  iteration: number;
  maxIterations: number;
}):
  | { action: 'continue' }
  | { action: 'extend'; newMaxIterations: number }
  | { action: 'terminal'; terminalOutcome: LoopTerminalOutcome } {
  if (params.decision.action === 'continue') return { action: 'continue' };
  if (params.decision.action === 'extend' && params.decision.newMaxIterations) {
    return { action: 'extend', newMaxIterations: params.decision.newMaxIterations };
  }
  return {
    action: 'terminal',
    terminalOutcome: {
      status: 'failed',
      reason: 'max_iterations_reached',
      assistantMessage: params.maxIterations >= 0 ? undefined : undefined,
      streamState: 'failed',
      streamIssue: 'Reached maximum iterations',
      loopStateMeta: { iteration: params.maxIterations, reason: 'max_iterations_reached' },
      finalizeMeta: { iteration: params.maxIterations },
      toast: { message: 'Tool loop reached maximum iterations', type: 'warning' },
    },
  };
}

export function resolveLoopBudgetAction(params: {
  decision: { action: 'continue' | 'extend' | 'fail'; newMaxLoopDurationMs?: number };
  iteration: number;
  maxLoopDurationMs: number;
  fullContent: string;
}):
  | { action: 'continue' }
  | { action: 'extend'; newMaxLoopDurationMs: number }
  | { action: 'terminal'; terminalOutcome: LoopTerminalOutcome } {
  if (params.decision.action === 'continue') return { action: 'continue' };
  if (params.decision.action === 'extend' && params.decision.newMaxLoopDurationMs) {
    return { action: 'extend', newMaxLoopDurationMs: params.decision.newMaxLoopDurationMs };
  }
  const message = params.fullContent
    ? `${params.fullContent}\n\n⚠️ Stopped: tool loop exceeded time budget (${Math.round(params.maxLoopDurationMs / 60000)} min).`
    : `⚠️ Stopped: tool loop exceeded time budget (${Math.round(params.maxLoopDurationMs / 60000)} min).`;
  return {
    action: 'terminal',
    terminalOutcome: {
      status: 'failed',
      reason: 'time_budget_exceeded',
      assistantMessage: message,
      streamState: 'failed',
      streamIssue: 'Tool loop exceeded time budget',
      loopStateMeta: { iteration: params.iteration, reason: 'time_budget_exceeded' },
      finalizeMeta: { iteration: params.iteration },
      toast: { message: 'Tool loop timed out (time budget exceeded)', type: 'warning' },
    },
  };
}

export function resolveAbortAction(params: {
  decision: { shouldAbort: boolean; reason?: 'abort_signal' };
  iteration: number;
}): { action: 'continue' } | { action: 'terminal'; terminalOutcome: LoopTerminalOutcome } {
  if (!params.decision.shouldAbort || !params.decision.reason) {
    return { action: 'continue' };
  }
  return {
    action: 'terminal',
    terminalOutcome: {
      status: 'cancelled',
      reason: params.decision.reason,
      streamState: 'cancelled',
      streamIssue: 'Streaming cancelled',
      loopStateMeta: { iteration: params.iteration, reason: params.decision.reason },
      finalizeMeta: { iteration: params.iteration },
      outputLog: `Agent: Loop aborted at iteration ${params.iteration}`,
    },
  };
}

export function resolveApprovalAction(params: {
  decision: { shouldAbort: boolean; reason?: string; streamState?: 'failed'; streamIssue?: string };
  iteration: number;
}): { action: 'continue' } | { action: 'terminal'; terminalOutcome: LoopTerminalOutcome } {
  if (!params.decision.shouldAbort || !params.decision.reason) {
    return { action: 'continue' };
  }
  return {
    action: 'terminal',
    terminalOutcome: {
      status: 'failed',
      reason: params.decision.reason,
      streamState: params.decision.streamState ?? 'failed',
      streamIssue: params.decision.streamIssue,
      loopStateMeta: { iteration: params.iteration, reason: params.decision.reason },
      finalizeMeta: { iteration: params.iteration },
    },
  };
}

export function resolveCompletionAction(params: {
  decision: { shouldComplete: boolean; completionToolId?: string; completionText?: string; reason?: 'attempt_completion' | 'natural_completion' };
  iteration: number;
}): { action: 'continue' } | { action: 'terminal'; terminalOutcome: LoopTerminalOutcome } {
  if (!params.decision.shouldComplete || !params.decision.completionToolId) {
    return { action: 'continue' };
  }
  const completionReason = params.decision.reason ?? 'natural_completion';
  return {
    action: 'terminal',
    terminalOutcome: {
      status: 'completed',
      reason: completionReason,
      assistantMessage: params.decision.completionText || undefined,
      streamState: 'completed',
      loopStateMeta: {
        iteration: params.iteration,
        completionToolId: params.decision.completionToolId,
      },
      finalizeMeta: {
        iteration: params.iteration,
        completionToolId: params.decision.completionToolId,
      },
      loopLogLevel: 'info',
      loopLogEvent: 'loop_completed',
      loopLogDetails: {
        reason: completionReason,
        completionToolId: params.decision.completionToolId,
      },
      outputLog: `Agent: Completion accepted at iteration ${params.iteration}.`,
    },
  };
}

export function resolveIterationErrorAction(params: {
  decision: {
    action: 'retry' | 'fail' | 'stalled' | 'cancelled';
    reason: 'stream_stalled' | 'abort_during_iteration' | 'stream_interrupted' | 'iteration_error';
    userMessage: string;
    shouldRetry: boolean;
    retryDelayMs?: number;
    recoveryNotice?: string;
    isInterrupted?: boolean;
  };
  iteration: number;
  rawError: string;
}):
  | { action: 'retry'; retryDelayMs: number; recoveryNotice?: string }
  | { action: 'terminal'; terminalOutcome: LoopTerminalOutcome } {
  if (params.decision.shouldRetry) {
    return {
      action: 'retry',
      retryDelayMs: params.decision.retryDelayMs ?? 1000,
      recoveryNotice: params.decision.recoveryNotice,
    };
  }

  if (params.decision.action === 'stalled') {
    return {
      action: 'terminal',
      terminalOutcome: {
        status: 'failed',
        reason: params.decision.reason,
        streamState: 'failed',
        streamIssue: params.decision.userMessage,
        loopStateMeta: { iteration: params.iteration, reason: params.decision.reason, error: params.decision.userMessage },
        finalizeMeta: { iteration: params.iteration, error: params.decision.userMessage },
        loopLogLevel: 'error',
        loopLogEvent: 'loop_failed',
        loopLogDetails: { reason: params.decision.reason, error: params.decision.userMessage },
        toast: { message: params.decision.userMessage, type: 'warning' },
      },
    };
  }

  return {
    action: 'terminal',
    terminalOutcome: {
      status: params.decision.reason === 'abort_during_iteration' ? 'cancelled' : 'failed',
      reason: params.decision.reason,
      assistantMessage: params.decision.reason === 'abort_during_iteration' ? undefined : params.decision.userMessage,
      streamState:
        params.decision.reason === 'abort_during_iteration'
          ? 'cancelled'
          : params.decision.isInterrupted
            ? 'interrupted'
            : 'failed',
      streamIssue:
        params.decision.reason === 'abort_during_iteration' ? 'Streaming cancelled' : params.rawError,
      loopStateMeta: { iteration: params.iteration, reason: params.decision.reason, error: params.rawError },
      finalizeMeta: { iteration: params.iteration, error: params.rawError },
      loopLogLevel: params.decision.reason === 'abort_during_iteration' ? 'warn' : 'error',
      loopLogEvent:
        params.decision.reason === 'abort_during_iteration' ? 'loop_cancelled' : 'loop_failed',
      loopLogDetails: { reason: params.decision.reason, error: params.rawError },
      toast:
        params.decision.reason === 'abort_during_iteration'
          ? undefined
          : { message: params.rawError, type: 'error' },
    },
  };
}
