import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('$features/assistant/runtime/native-runtime', () => ({
  assistantRunCancel: vi.fn(),
  assistantRunClaimDispatchStep: vi.fn(),
  assistantRunCompleteDispatchStep: vi.fn(),
  assistantRunGetSnapshot: vi.fn(),
  assistantRunResolveApprovals: vi.fn(),
  assistantRunSetDispatchPlan: vi.fn(),
  assistantRunStart: vi.fn(),
  assistantRuntimePublishEvent: vi.fn(),
}));

import { createAssistantPanelNativeRuntimeBridge } from './native-runtime-bridge';

describe('createAssistantPanelNativeRuntimeBridge', () => {
  it('keeps native tool patches audit-only and does not mutate live tool cards', () => {
    const assistantStore = {
      agentLoopState: 'running' as const,
      autoApproveAllTools: false,
      currentConversation: { id: 'conv-1' },
      setAgentLoopState: vi.fn(),
      updateToolCallInMessage: vi.fn(),
      markAssistantMessageStreamState: vi.fn(),
      getRuntimeSnapshot: vi.fn(),
      applyNativeRuntimeSnapshot: vi.fn(),
    };
    const agentTelemetryStore = {
      record: vi.fn(),
    };
    const nativeRunIds = new Map<string, string>();

    const bridge = createAssistantPanelNativeRuntimeBridge({
      assistantStore,
      agentTelemetryStore,
      nativeRunIds,
    });

    bridge.applyNativeRuntimeDecision(
      {
        shouldApply: true,
        operation: 'tool_complete',
        conversationId: 'conv-1',
        loopState: 'completed',
        toolPatch: {
          messageId: 'msg-1',
          toolCallId: 'tool-1',
          status: 'running',
          error: 'stale overwrite',
        },
      },
      'completed',
      { reason: 'done' },
    );

    expect(assistantStore.updateToolCallInMessage).not.toHaveBeenCalled();
    expect(assistantStore.setAgentLoopState).toHaveBeenCalledWith('completed', {
      reason: 'done',
    });
  });
});
