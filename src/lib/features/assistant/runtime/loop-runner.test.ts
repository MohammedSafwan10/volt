import { describe, expect, it } from 'vitest';

import {
  resolveAbortAction,
  resolveApprovalAction,
  resolveCompletionAction,
  resolveIterationErrorAction,
  resolveIterationLimitAction,
  resolveLoopBudgetAction,
} from './loop-runner';

describe('loop runner helpers', () => {
  it('maps iteration limit failure into a terminal outcome', () => {
    const result = resolveIterationLimitAction({
      decision: { action: 'fail' },
      iteration: 20,
      maxIterations: 20,
    });

    expect(result.action).toBe('terminal');
    if (result.action === 'terminal') {
      expect(result.terminalOutcome.reason).toBe('max_iterations_reached');
    }
  });

  it('maps loop budget failure into a terminal outcome', () => {
    const result = resolveLoopBudgetAction({
      decision: { action: 'fail' },
      iteration: 3,
      maxLoopDurationMs: 60000,
      fullContent: 'partial',
    });

    expect(result.action).toBe('terminal');
  });

  it('maps approval failure into a terminal outcome', () => {
    const result = resolveApprovalAction({
      decision: { shouldAbort: true, reason: 'approval_flow_incomplete', streamState: 'failed', streamIssue: 'Approval flow incomplete' },
      iteration: 2,
    });

    expect(result.action).toBe('terminal');
  });

  it('maps completion acceptance into a completed terminal outcome', () => {
    const result = resolveCompletionAction({
      decision: { shouldComplete: true, completionToolId: 'abc', completionText: 'done', reason: 'attempt_completion' },
      iteration: 4,
    });

    expect(result.action).toBe('terminal');
  });

  it('maps retryable errors into retry actions', () => {
    const result = resolveIterationErrorAction({
      decision: {
        action: 'retry',
        reason: 'iteration_error',
        userMessage: 'network timeout',
        shouldRetry: true,
        retryDelayMs: 1000,
        recoveryNotice: 'try again',
      },
      iteration: 2,
      rawError: 'network timeout',
    });

    expect(result.action).toBe('retry');
  });

  it('maps abort signal decisions into cancelled terminal outcomes', () => {
    const result = resolveAbortAction({
      decision: { shouldAbort: true, reason: 'abort_signal' },
      iteration: 6,
    });

    expect(result.action).toBe('terminal');
  });
});
