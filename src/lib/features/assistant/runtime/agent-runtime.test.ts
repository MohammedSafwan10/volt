import { describe, expect, it } from 'vitest';

import { createAgentRuntime } from './agent-runtime';
import type { ToolResult } from '$core/ai/tools';

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

  it('accepts explicit completion payloads while keeping them out of visible tool rows', () => {
    const runtime = createAgentRuntime();
    const analysis = runtime.analyzeToolPass({
      allToolCalls: [
        { id: '1', name: 'read_file', arguments: { path: 'src/app.ts' } },
        { id: '2', name: 'attempt_completion', arguments: { result: 'done' } },
      ],
      normalizedToolResults: [
        { id: '1', name: 'read_file', result: { success: true, output: 'ok' } as ToolResult },
        { id: '2', name: 'attempt_completion', result: { success: true, output: 'done' } as ToolResult },
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

  it('returns approval resume metadata after approvals complete', () => {
    const runtime = createAgentRuntime();
    const decision = runtime.evaluateApprovalFlow(true);

    expect(decision.shouldAbort).toBe(false);
    expect(decision.resolvedState).toBe('running');
    expect(decision.resumeState).toBe('running');
    expect(decision.resumeMeta).toEqual({ resumedAfterApproval: true });
  });

  it('marks incomplete approvals as failed in the resolved runtime state', () => {
    const runtime = createAgentRuntime();
    const decision = runtime.evaluateApprovalFlow(false);

    expect(decision.shouldAbort).toBe(true);
    expect(decision.resolvedState).toBe('failed');
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

  it('uses native tool scheduling policy when provided by the runtime bridge', () => {
    const runtime = createAgentRuntime();
    const decision = runtime.evaluateToolScheduling({
      pendingApprovalCount: 2,
      hasQueuedFileEdits: true,
      nativeDecision: {
        shouldApply: true,
        operation: 'waiting_tool',
        conversationId: 'conv-1',
        control: {
          toolPolicy: {
            executeInOrder: true,
            deferUntilFileEditsComplete: false,
            approvalRequired: false,
            executionStages: ['eager_tools', 'deferred_tools', 'file_edits'],
            fileEditConcurrency: 2,
            orderedFileQueueKeys: ['src/app.ts', 'src/lib.ts'],
            pendingApprovalToolIds: ['tool-1'],
          },
        },
      },
    });

    expect(decision).toEqual({
      executeInOrder: true,
      deferUntilFileEditsComplete: false,
      approvalRequired: false,
      executionStages: ['eager_tools', 'deferred_tools', 'file_edits'],
      fileEditConcurrency: 2,
      orderedFileQueueKeys: ['src/app.ts', 'src/lib.ts'],
      pendingApprovalToolIds: ['tool-1'],
    });
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

  it('uses native retry policy when provided by the runtime bridge', () => {
    const runtime = createAgentRuntime();
    const decision = runtime.evaluateIterationError({
      message: 'non-standard transient issue',
      iteration: 8,
      maxIterations: 10,
      recoveryRetryCount: 3,
      maxRecoveryRetries: 4,
      stalledAbortReason: null,
      fullContent: '',
      nativeDecision: {
        shouldApply: true,
        operation: 'iteration_error',
        conversationId: 'conv-1',
        control: {
          retry: {
            allowed: true,
            delayMs: 2500,
            maxRetries: 1,
            reason: 'native_runtime_retry',
          },
        },
      },
    });

    expect(decision.action).toBe('retry');
    expect(decision.retryDelayMs).toBe(2500);
  });

  it('surfaces native cancellation decisions during iteration errors', () => {
    const runtime = createAgentRuntime();
    const decision = runtime.evaluateIterationError({
      message: 'still running',
      iteration: 3,
      maxIterations: 10,
      recoveryRetryCount: 0,
      maxRecoveryRetries: 4,
      stalledAbortReason: null,
      fullContent: '',
      nativeDecision: {
        shouldApply: true,
        operation: 'loop_cancelled',
        conversationId: 'conv-1',
        control: {
          cancellation: {
            shouldCancel: true,
            reason: 'cancel_requested',
          },
        },
      },
    });

    expect(decision.action).toBe('cancelled');
    expect(decision.reason).toBe('abort_during_iteration');
    expect(decision.userMessage).toBe('cancel_requested');
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

  it('builds a native runtime bridge request when a snapshot is available', async () => {
    const calls: Array<{
      operation: string;
      conversationId: string;
      payload: Record<string, unknown>;
    }> = [];
    const runtime = createAgentRuntime({
      sendCommand: async (request) => {
        calls.push(request);
        return {
          shouldApply: true,
          operation: request.operation,
          conversationId: request.conversationId,
          loopState: 'running',
          loopMeta: { echoed: true },
        };
      },
    });

    const result = await runtime.buildRuntimeRequest({
      operation: 'iteration_start',
      snapshot: {
        conversationId: 'conv-1',
        mode: 'agent',
        isStreaming: true,
        agentLoopState: 'running',
        agentLoopMeta: { previous: true },
        runUpdatedAt: 123,
        activeMessageId: 'm1',
        activeToolCallId: 't1',
        activeToolCallName: 'read_file',
        activeToolStatus: 'running',
        activeToolRequiresApproval: false,
        pendingApprovalCount: 0,
        runningToolCount: 1,
        messageCount: 2,
      },
      payload: {
        requestedLoopState: 'running',
        requestedLoopMeta: {
          iteration: 2,
        },
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.conversationId).toBe('conv-1');
    expect(calls[0]?.payload.iteration).toBeUndefined();
    expect(calls[0]?.payload.requestedLoopMeta).toEqual({ iteration: 2 });
    expect(calls[0]?.payload.activeToolCallName).toBe('read_file');
    expect(result?.loopState).toBe('running');
    expect(result?.loopMeta).toEqual({ echoed: true });
  });

  it('does not forward empty native tool ordering arrays as scheduling overrides', () => {
    const runtime = createAgentRuntime();
    const decision = runtime.evaluateToolScheduling({
      pendingApprovalCount: 0,
      hasQueuedFileEdits: false,
      defaultExecuteInOrder: true,
      nativeDecision: {
        shouldApply: true,
        operation: 'waiting_tool',
        conversationId: 'conv-1',
        control: {
          toolPolicy: {
            executeInOrder: true,
            deferUntilFileEditsComplete: false,
            approvalRequired: false,
            orderedEagerToolIds: [],
            orderedDeferredToolIds: [],
          },
        },
      },
    });

    expect(decision.orderedEagerToolIds).toBeUndefined();
    expect(decision.orderedDeferredToolIds).toBeUndefined();
  });
});
