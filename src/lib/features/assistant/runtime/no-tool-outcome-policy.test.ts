import { describe, expect, it, vi } from 'vitest';

import { resolveNoToolOutcome } from './no-tool-outcome-policy';

describe('no-tool outcome policy', () => {
  it('completes natural agent responses without explicit completion contract', () => {
    const result = resolveNoToolOutcome({
      iteration: 1,
      iterationThinking: '',
      iterationContent: 'Done with the task.',
      hadPlanModeViolationThisIteration: false,
      maxEmptyResponses: 6,
      state: {
        consecutiveEmptyResponses: 0,
        justProcessedToolResults: false,
        planModeViolationNudgeCount: 0,
        fullContent: '',
        repeatedFailureHint: null,
      },
      isAgentMode: true,
      conversationOnlyTurn: false,
      completionNudgeCount: 0,
      maxCompletionNudges: 3,
      provider: 'openai',
      modelId: 'gpt',
      logOutput: vi.fn(),
      addToolMessage: vi.fn(),
      updateAssistantMessage: vi.fn(),
      setMessageContent: vi.fn(),
    });

    expect(result.action).toBe('terminal');
    expect(result.terminalOutcome?.reason).toBe('implicit_content_completion');
  });

  it('completes conversation-only turns without requiring attempt_completion', () => {
    const result = resolveNoToolOutcome({
      iteration: 2,
      iterationThinking: '',
      iterationContent: 'Here is the answer.',
      hadPlanModeViolationThisIteration: false,
      maxEmptyResponses: 6,
      state: {
        consecutiveEmptyResponses: 0,
        justProcessedToolResults: false,
        planModeViolationNudgeCount: 0,
        fullContent: '',
        repeatedFailureHint: null,
      },
      isAgentMode: true,
      conversationOnlyTurn: true,
      completionNudgeCount: 0,
      maxCompletionNudges: 3,
      provider: 'openai',
      modelId: 'gpt',
      logOutput: vi.fn(),
      addToolMessage: vi.fn(),
      updateAssistantMessage: vi.fn(),
      setMessageContent: vi.fn(),
    });

    expect(result.action).toBe('terminal');
    expect(result.terminalOutcome?.reason).toBe('conversation_only_completion');
  });
});
