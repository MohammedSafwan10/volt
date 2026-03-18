import { describe, expect, it } from 'vitest';

import { executeFileEditQueues } from './loop-executor';

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
});
