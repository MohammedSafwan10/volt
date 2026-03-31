import { describe, expect, it, vi } from 'vitest';

import { processToolsNeedingApproval } from './approval-executor';

type TestToolState = {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  reviewStatus?: 'pending' | 'accepted' | 'rejected';
  error?: string;
  meta?: Record<string, unknown>;
};

type TestMessageState = {
  id: string;
  inlineToolCalls: TestToolState[];
};

describe('processToolsNeedingApproval', () => {
  it('continues executing later approved terminal commands after an earlier terminal command fails', async () => {
    const messageId = 'message-1';
    const messages: TestMessageState[] = [
      {
        id: messageId,
        inlineToolCalls: [
          { id: 'tool-1', status: 'pending', reviewStatus: 'accepted' },
          { id: 'tool-2', status: 'pending', reviewStatus: 'accepted' },
        ],
      },
    ];
    const toolResults: Array<{ id: string; name: string; result: { success: boolean; error?: string; output?: string } }> = [];
    const executeToolCall = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'first failed' })
      .mockResolvedValueOnce({ success: true, output: 'second passed' });

    const updateToolCallInMessage = (
      msgId: string,
      toolId: string,
      patch: Record<string, unknown>,
    ) => {
      const message = messages.find((entry) => entry.id === msgId);
      const tool = message?.inlineToolCalls?.find((entry) => entry.id === toolId);
      if (!tool) return;
      Object.assign(tool, patch);
    };

    const processed = await processToolsNeedingApproval(
      messageId,
      [
        { id: 'tool-1', name: 'run_command', arguments: { command: 'first' } },
        { id: 'tool-2', name: 'run_command', arguments: { command: 'second' } },
      ],
      toolResults,
      {
        isTerminalToolName: () => true,
        getToolCapabilities: () => ({ requiresApproval: true }),
        waitForToolApprovals: vi.fn().mockResolvedValue(true),
        waitForToolCompletion: vi.fn().mockResolvedValue(true),
        getMessages: () => messages,
        updateToolCallInMessage,
        executeToolCall,
        getToolIdempotencyKey: (_scope, id) => `key:${id}`,
        toolRunScope: 'test',
        signal: new AbortController().signal,
        trackToolOutcome: vi.fn(),
        getFailureSignature: vi.fn().mockReturnValue(null),
        onFailureSignature: vi.fn(),
        publishToolPatch: vi.fn(),
        getCurrentToolCallState: (msgId, toolId) =>
          messages
            .find((entry) => entry.id === msgId)
            ?.inlineToolCalls?.find((entry) => entry.id === toolId),
        resolveApprovalAuthority: vi.fn().mockResolvedValue({
          shouldAbort: false,
          approvedToolIds: ['tool-1', 'tool-2'],
          deniedToolIds: [],
          unresolvedToolIds: [],
        }),
      },
    );

    expect(processed).toBe(true);
    expect(executeToolCall).toHaveBeenCalledTimes(2);
    expect(toolResults).toEqual([
      {
        id: 'tool-1',
        name: 'run_command',
        result: { success: false, error: 'first failed' },
      },
      {
        id: 'tool-2',
        name: 'run_command',
        result: { success: true, output: 'second passed' },
      },
    ]);
    expect(messages[0]?.inlineToolCalls?.[1]).toMatchObject({
      status: 'completed',
      output: 'second passed',
    });
  });

  it('clears stale invalid-call errors when an approved terminal command completes successfully', async () => {
    const messageId = 'message-2';
    const messages: TestMessageState[] = [
      {
        id: messageId,
        inlineToolCalls: [
          {
            id: 'tool-clean',
            status: 'pending',
            reviewStatus: 'accepted',
            error: 'Invalid tool call',
            meta: {
              terminalRun: {
                state: 'running',
                commandPreview: 'echo clean',
                terminalId: 'term-clean',
              },
            },
          },
        ],
      },
    ];
    const toolResults: Array<{
      id: string;
      name: string;
      result: { success: boolean; error?: string; output?: string };
    }> = [];

    const updateToolCallInMessage = (
      msgId: string,
      toolId: string,
      patch: Record<string, unknown>,
    ) => {
      const message = messages.find((entry) => entry.id === msgId);
      const tool = message?.inlineToolCalls?.find((entry) => entry.id === toolId);
      if (!tool) return;
      Object.assign(tool, patch);
      if (patch.meta && typeof patch.meta === 'object') {
        tool.meta = {
          ...(tool.meta ?? {}),
          ...(patch.meta as Record<string, unknown>),
        };
      }
    };

    const processed = await processToolsNeedingApproval(
      messageId,
      [{ id: 'tool-clean', name: 'run_command', arguments: { command: 'echo clean' } }],
      toolResults,
      {
        isTerminalToolName: () => true,
        getToolCapabilities: () => ({ requiresApproval: true }),
        waitForToolApprovals: vi.fn().mockResolvedValue(true),
        waitForToolCompletion: vi.fn().mockResolvedValue(true),
        getMessages: () => messages,
        updateToolCallInMessage,
        executeToolCall: vi.fn().mockResolvedValue({
          success: true,
          output: 'clean',
          meta: {
            terminalRun: {
              state: 'completed',
              commandPreview: 'echo clean',
              terminalId: 'term-clean',
            },
          },
        }),
        getToolIdempotencyKey: (_scope, id) => `key:${id}`,
        toolRunScope: 'test',
        signal: new AbortController().signal,
        trackToolOutcome: vi.fn(),
        getFailureSignature: vi.fn().mockReturnValue(null),
        onFailureSignature: vi.fn(),
        publishToolPatch: vi.fn(),
        getCurrentToolCallState: (msgId, toolId) =>
          messages
            .find((entry) => entry.id === msgId)
            ?.inlineToolCalls?.find((entry) => entry.id === toolId),
        resolveApprovalAuthority: vi.fn().mockResolvedValue({
          shouldAbort: false,
          approvedToolIds: ['tool-clean'],
          deniedToolIds: [],
          unresolvedToolIds: [],
        }),
      },
    );

    expect(processed).toBe(true);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      id: 'tool-clean',
      name: 'run_command',
      result: {
        success: true,
        output: 'clean',
      },
    });
    expect(messages[0]?.inlineToolCalls?.[0]).toMatchObject({
      status: 'completed',
      output: 'clean',
      error: undefined,
      meta: {
        terminalRun: {
          state: 'completed',
          commandPreview: 'echo clean',
          terminalId: 'term-clean',
        },
      },
    });
  });
});
