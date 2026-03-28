import { describe, expect, it } from 'vitest';

import { executeFileEditQueues, executeQueuedNonFileTools } from './loop-executor';

describe('loop-executor retry policy', () => {
  it('retries exact-match failures once and succeeds when second attempt passes', async () => {
    let calls = 0;
    const results = await executeFileEditQueues(
      [
        [
          'src/a.ts',
          [{ id: 't1', name: 'str_replace', args: { path: 'src/a.ts' }, queueIndex: 1 }],
        ],
      ],
      1,
      {
        executeToolCall: async () => {
          calls++;
          if (calls === 1) return { success: false, error: 'No match for oldStr' };
          return { success: true, output: 'ok', meta: {} };
        },
        signal: new AbortController().signal,
        toolRunScope: 'scope',
        getToolIdempotencyKey: () => 'id',
        updateToolCallInMessage: () => undefined,
        messageId: 'm1',
        trackToolOutcome: () => undefined,
        getFailureSignature: () => null,
        onFailureSignature: () => undefined,
        mapWithConcurrency: async (items, _, worker) => Promise.all(items.map(worker)),
      },
    );

    expect(calls).toBe(2);
    expect(results[0].result.success).toBe(true);
    expect((results[0].result.meta as Record<string, unknown>)?.autoRetrySucceeded).toBe(true);
  });

  it('marks retry exhausted after second failure', async () => {
    const results = await executeFileEditQueues(
      [
        [
          'src/a.ts',
          [{ id: 't1', name: 'str_replace', args: { path: 'src/a.ts' }, queueIndex: 1 }],
        ],
      ],
      1,
      {
        executeToolCall: async () => ({ success: false, error: 'Content changed on disk; refresh file state if needed and retry.' }),
        signal: new AbortController().signal,
        toolRunScope: 'scope',
        getToolIdempotencyKey: () => 'id',
        updateToolCallInMessage: () => undefined,
        messageId: 'm1',
        trackToolOutcome: () => undefined,
        getFailureSignature: () => null,
        onFailureSignature: () => undefined,
        mapWithConcurrency: async (items, _, worker) => Promise.all(items.map(worker)),
      },
    );

    expect(results[0].result.success).toBe(false);
    expect(String(results[0].result.error)).toContain('Retry exhausted');
    expect((results[0].result.meta as Record<string, unknown>)?.code).toBe('EDIT_RETRY_EXHAUSTED');
  });

  it('publishes live tool patches for non-file tools', async () => {
    const publishedPatches: Array<{ toolId: string; patch: Record<string, unknown> }> = [];

    const results = await executeQueuedNonFileTools(
      [{ id: 't1', name: 'read_file', args: { path: 'src/a.ts' }, runAfterFileEdits: false }],
      {
        executeToolCall: async (_name, _args, options) => {
          options.runtime?.onUpdate?.({
            liveStatus: 'Reading file...',
            meta: { phase: 'read' },
          });
          return { success: true, output: 'ok', meta: { bytes: 12 } };
        },
        signal: new AbortController().signal,
        toolRunScope: 'scope',
        getToolIdempotencyKey: () => 'id',
        updateToolCallInMessage: () => undefined,
        messageId: 'm1',
        trackToolOutcome: () => undefined,
        getFailureSignature: () => null,
        onFailureSignature: () => undefined,
        publishToolPatch: (toolId, patch) => {
          publishedPatches.push({ toolId, patch });
        },
      },
    );

    expect(results[0].result.success).toBe(true);
    expect(publishedPatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolId: 't1',
          patch: expect.objectContaining({
            status: 'running',
          }),
        }),
        expect.objectContaining({
          toolId: 't1',
          patch: expect.objectContaining({
            meta: expect.objectContaining({
              liveStatus: 'Reading file...',
              phase: 'read',
            }),
          }),
        }),
        expect.objectContaining({
          toolId: 't1',
          patch: expect.objectContaining({
            status: 'completed',
            output: 'ok',
            meta: expect.objectContaining({
              bytes: 12,
            }),
          }),
        }),
      ]),
    );
  });

  it('does not reactivate a tool call that is already failed before execution starts', async () => {
    const patches: Array<Record<string, unknown>> = [];

    const results = await executeQueuedNonFileTools(
      [{ id: 't-invalid', name: 'run_command', args: { command: 'echo hi' }, runAfterFileEdits: false }],
      {
        executeToolCall: async () => ({ success: true, output: 'should not run' }),
        signal: new AbortController().signal,
        toolRunScope: 'scope',
        getToolIdempotencyKey: () => 'id',
        updateToolCallInMessage: (_messageId, _toolId, patch) => {
          patches.push(patch);
        },
        messageId: 'm1',
        trackToolOutcome: () => undefined,
        getFailureSignature: () => null,
        onFailureSignature: () => undefined,
        publishToolPatch: () => undefined,
      },
    );

    expect(results[0].result.success).toBe(true);
    expect(patches[0]).toMatchObject({
      status: 'running',
    });
  });
});
