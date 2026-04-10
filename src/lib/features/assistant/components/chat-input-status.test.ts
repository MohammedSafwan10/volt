import { describe, expect, it } from 'vitest';

import {
  formatModelDisplayName,
  getRuntimeActivityLabel,
} from './chat-input-status';

describe('chat-input-status', () => {
  it('omits the static thinking suffix from the selected model label by default', () => {
    expect(formatModelDisplayName('gpt-5.4|thinking')).toBe('GPT 5.4');
    expect(formatModelDisplayName('gpt-5.4|thinking', { showReasoningTag: true })).toBe(
      'GPT 5.4 (Reasoning)',
    );
  });

  it('reports edit execution instead of thinking when a file tool is running', () => {
    expect(
      getRuntimeActivityLabel({
        agentLoopState: 'waiting_tool',
        activeToolCallName: 'write_file',
        activeToolStatus: 'running',
        activeToolRequiresApproval: false,
        pendingApprovalCount: 0,
        runningToolCount: 1,
      }),
    ).toBe('Applying edits');
  });

  it('reports waiting for approval when tools are blocked on approval', () => {
    expect(
      getRuntimeActivityLabel({
        agentLoopState: 'waiting_approval',
        activeToolCallName: 'run_command',
        activeToolStatus: 'pending',
        activeToolRequiresApproval: true,
        pendingApprovalCount: 1,
        runningToolCount: 0,
      }),
    ).toBe('Waiting for approval');
  });
});
