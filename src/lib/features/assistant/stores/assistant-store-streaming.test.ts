import { describe, expect, it, vi } from 'vitest';

vi.mock('$features/editor/stores/editor.svelte', () => ({
  editorStore: {
    currentFile: null,
  },
}));

vi.mock('$core/services/file-service', () => ({
  fileService: {
    subscribeAll: () => () => undefined,
  },
}));

vi.mock('$features/terminal/stores/terminal.svelte', () => ({
  terminalStore: {
    sessions: [],
  },
}));

vi.mock('$shared/stores/project.svelte', () => ({
  projectStore: {
    rootPath: null,
    tree: [],
  },
}));

vi.mock('./chat-history.svelte', () => ({
  chatHistoryStore: {
    activeConversationId: null,
    setActiveConversationDeletedHandler: () => undefined,
  },
}));

vi.mock('./agent-telemetry.svelte', () => ({
  agentTelemetryStore: {
    record: () => undefined,
  },
}));

import { createAssistantStoreForTest } from './assistant.svelte';

describe('assistant store streaming reconciliation', () => {
  it('does not rewind streamed content when a stale active content patch arrives', () => {
    const store = createAssistantStoreForTest();
    store.newConversation();
    const conversationId = store.currentConversation?.id;
    expect(conversationId).toBeTruthy();

    const messageId = store.addAssistantMessage('', true);

    store.appendTextToMessage(messageId, 'Hello world', true, false);

    store.applyNativeRuntimeEvent({
      eventId: 'evt-1',
      conversationId: conversationId!,
      runId: 'run-1',
      timestampMs: Date.now(),
      kind: 'message_delta',
      loopState: 'running',
      payload: {
        messagePatch: {
          messageId,
          content: 'Hello',
          streamState: 'active',
        },
      },
    });

    const message = store.messages.find((entry) => entry.id === messageId);
    expect(message?.content).toBe('Hello world');
    expect(message?.contentParts?.find((part) => part.type === 'text')).toEqual({
      type: 'text',
      text: 'Hello world',
    });
  });

  it('clears active stream state when replacing content with a non-streaming update', () => {
    const store = createAssistantStoreForTest();
    store.newConversation();
    const conversationId = store.currentConversation?.id;
    expect(conversationId).toBeTruthy();

    const messageId = store.addAssistantMessage('', true);
    store.appendTextToMessage(messageId, 'Partial output', true, false);

    store.setMessageContent(messageId, 'Final output', false);

    const message = store.messages.find((entry) => entry.id === messageId);
    expect(message?.isStreaming).toBe(false);
    expect(message?.streamState).toBe('completed');
    expect(message?.content).toBe('Final output');
  });

  it('ignores audit-only native tool patches so completed tools do not regress to running', () => {
    const store = createAssistantStoreForTest();
    store.newConversation();
    const conversationId = store.currentConversation?.id;
    expect(conversationId).toBeTruthy();

    const messageId = store.addAssistantMessage('', true);
    store.addToolCallToMessage(
      messageId,
      {
        id: 'tool-1',
        name: 'run_command',
        arguments: { command: 'echo hi' },
        status: 'completed',
        output: 'done',
        meta: {
          terminalRun: {
            state: 'completed',
            commandPreview: 'echo hi',
          },
        },
      },
      false,
    );

    store.applyNativeRuntimeEvent({
      eventId: 'evt-tool-stale',
      conversationId: conversationId!,
      runId: 'run-1',
      timestampMs: Date.now(),
      kind: 'tool_call_updated',
      loopState: 'running',
      payload: {
        toolPatch: {
          messageId,
          toolCallId: 'tool-1',
          status: 'running',
          error: 'Invalid tool call',
          meta: {
            terminalRun: {
              state: 'running',
              commandPreview: 'echo hi',
            },
          },
        },
      },
    });

    const message = store.messages.find((entry) => entry.id === messageId);
    const toolCall = message?.inlineToolCalls?.find((entry) => entry.id === 'tool-1');
    expect(toolCall).toMatchObject({
      status: 'completed',
      output: 'done',
      meta: {
        terminalRun: {
          state: 'completed',
          commandPreview: 'echo hi',
        },
      },
    });
    expect(toolCall?.error).toBeUndefined();
  });

  it('rejects local status regressions from final states back to running', () => {
    const store = createAssistantStoreForTest();
    store.newConversation();

    const messageId = store.addAssistantMessage('', true);
    store.addToolCallToMessage(
      messageId,
      {
        id: 'tool-2',
        name: 'run_command',
        arguments: { command: 'echo hi' },
        status: 'completed',
        output: 'done',
      },
      false,
    );

    store.updateToolCallInMessage(
      messageId,
      'tool-2',
      {
        status: 'running',
        error: 'stale running overwrite',
        meta: {
          terminalRun: {
            state: 'running',
          },
        },
      },
      false,
    );

    const message = store.messages.find((entry) => entry.id === messageId);
    const toolCall = message?.inlineToolCalls?.find((entry) => entry.id === 'tool-2');
    expect(toolCall).toMatchObject({
      status: 'completed',
      output: 'done',
    });
    expect(toolCall?.error).toBeUndefined();
    expect((toolCall?.meta as Record<string, unknown> | undefined)?.terminalRun).toBeUndefined();
  });

  it('applies the same monotonic guard to file tools', () => {
    const store = createAssistantStoreForTest();
    store.newConversation();

    const messageId = store.addAssistantMessage('', true);
    store.addToolCallToMessage(
      messageId,
      {
        id: 'tool-file',
        name: 'apply_patch',
        arguments: { path: 'src/app.ts' },
        status: 'failed',
        error: 'Patch apply failed',
      },
      false,
    );

    store.updateToolCallInMessage(
      messageId,
      'tool-file',
      {
        status: 'running',
        error: undefined,
      },
      false,
    );

    const message = store.messages.find((entry) => entry.id === messageId);
    const toolCall = message?.inlineToolCalls?.find((entry) => entry.id === 'tool-file');
    expect(toolCall).toMatchObject({
      status: 'failed',
      error: 'Patch apply failed',
    });
  });
});
