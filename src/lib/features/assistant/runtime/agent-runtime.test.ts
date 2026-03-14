import { describe, expect, it } from 'vitest';

import { createAgentRuntime } from './agent-runtime';

describe('agent runtime', () => {
  it('attaches structural verification guidance when completion is blocked', () => {
    const runtime = createAgentRuntime();
    const result = runtime.evaluateCompletion({
      errorCount: 0,
      freshness: { status: 'fresh' },
      structuralMutationPaths: ['src/renamed.ts'],
    });

    expect(result.shouldBlock).toBe(true);
    expect(result.verificationPlan?.requiresFollowUp).toBe(true);
  });

  it('analyzes a full tool pass and hides attempt_completion from visible results', () => {
    const runtime = createAgentRuntime();
    const analysis = runtime.analyzeToolPass({
      allToolCalls: [
        { id: '1', name: 'read_file', arguments: { path: 'src/app.ts' } },
        { id: '2', name: 'attempt_completion', arguments: { result: 'done' } },
      ],
      normalizedToolResults: [
        { id: '1', name: 'read_file', result: { success: true, output: 'ok' } as any },
        { id: '2', name: 'attempt_completion', result: { success: true, output: 'done' } as any },
      ],
      isFileMutatingTool: () => false,
    });

    expect(analysis.completionResult?.id).toBe('2');
    expect(analysis.visibleToolCalls.map((entry) => entry.id)).toEqual(['1']);
    expect(analysis.visibleToolResults.map((entry) => entry.id)).toEqual(['1']);

    const completion = runtime.evaluateCompletionAcceptance({
      completionResult: analysis.completionResult,
      allToolCalls: [
        { id: '1', name: 'read_file', arguments: { path: 'src/app.ts' } },
        { id: '2', name: 'attempt_completion', arguments: { result: 'done' } },
      ],
    });

    expect(completion.shouldComplete).toBe(true);
    expect(completion.completionText).toBe('done');
  });

  it('accepts natural completion when real work happened without attempt_completion', () => {
    const runtime = createAgentRuntime();
    const completion = runtime.evaluateCompletionAcceptance({
      allToolCalls: [
        { id: '1', name: 'read_file', arguments: { path: 'src/app.ts' } },
      ],
      fullContent: 'I inspected the file and found the issue.',
    });

    expect(completion.shouldComplete).toBe(true);
    expect(completion.reason).toBe('natural_completion');
    expect(completion.completionText).toBe('I inspected the file and found the issue.');
  });

  it('treats incomplete approval flow as abort-worthy', () => {
    const runtime = createAgentRuntime();
    const decision = runtime.evaluateApprovalFlow(false);

    expect(decision.shouldAbort).toBe(true);
    expect(decision.reason).toBe('approval_flow_incomplete');
  });

  it('extends loop budget when recent progress allows it', () => {
    const runtime = createAgentRuntime();
    const decision = runtime.evaluateLoopBudget({
      elapsedMs: 70_000,
      maxLoopDurationMs: 60_000,
      canExtendBudget: true,
      hardMaxLoopDurationMs: 300_000,
    });

    expect(decision.action).toBe('extend');
    expect(decision.newMaxLoopDurationMs).toBe(300_000);
  });

  it('extends iteration limit when recent progress allows it', () => {
    const runtime = createAgentRuntime();
    const decision = runtime.evaluateIterationLimit({
      iteration: 120,
      maxIterations: 120,
      canExtendBudget: true,
      hardMaxIterations: 140,
    });

    expect(decision.action).toBe('extend');
    expect(decision.newMaxIterations).toBe(140);
  });

  it('marks stalled aborts distinctly from normal iteration errors', () => {
    const runtime = createAgentRuntime();
    const decision = runtime.evaluateIterationError({
      message: 'Streaming cancelled',
      iteration: 3,
      maxIterations: 10,
      recoveryRetryCount: 0,
      maxRecoveryRetries: 4,
      stalledAbortReason: 'Stream stalled for too long',
      fullContent: 'partial',
    });

    expect(decision.action).toBe('stalled');
    expect(decision.reason).toBe('stream_stalled');
  });

  it('retries transient iteration errors when retry budget remains', () => {
    const runtime = createAgentRuntime();
    const decision = runtime.evaluateIterationError({
      message: 'network timeout',
      iteration: 2,
      maxIterations: 10,
      recoveryRetryCount: 0,
      maxRecoveryRetries: 4,
      stalledAbortReason: null,
      fullContent: '',
    });

    expect(decision.action).toBe('retry');
    expect(decision.shouldRetry).toBe(true);
    expect(decision.retryDelayMs).toBe(1000);
  });

  it('keeps session-like evaluations independent across repeated runtime instances', () => {
    const runtimeA = createAgentRuntime();
    const runtimeB = createAgentRuntime();

    const a = runtimeA.evaluateIterationLimit({
      iteration: 120,
      maxIterations: 120,
      canExtendBudget: true,
      hardMaxIterations: 140,
    });
    const b = runtimeB.evaluateIterationLimit({
      iteration: 5,
      maxIterations: 120,
      canExtendBudget: false,
      hardMaxIterations: 140,
    });

    expect(a.action).toBe('extend');
    expect(b.action).not.toBe('extend');
  });

  it('does not share approval flow decisions between runtime instances', () => {
    const runtimeA = createAgentRuntime();
    const runtimeB = createAgentRuntime();

    const denied = runtimeA.evaluateApprovalFlow(false);
    const approved = runtimeB.evaluateApprovalFlow(true);

    expect(denied.shouldAbort).toBe(true);
    expect(denied.reason).toBe('approval_flow_incomplete');
    expect(approved.shouldAbort).toBe(false);
  });
});
