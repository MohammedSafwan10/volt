import { describe, expect, it } from 'vitest';

import { isUnresolvedTerminalToolCall } from './assistant-message-row-helpers';

describe('isUnresolvedTerminalToolCall', () => {
  it('treats running and approved-pending terminal tools as unresolved', () => {
    expect(
      isUnresolvedTerminalToolCall({
        name: 'run_command',
        status: 'running',
        requiresApproval: true,
      }),
    ).toBe(true);

    expect(
      isUnresolvedTerminalToolCall({
        name: 'run_command',
        status: 'pending',
        reviewStatus: 'accepted',
        requiresApproval: true,
      }),
    ).toBe(true);
  });

  it('does not treat completed terminal tools as unresolved', () => {
    expect(
      isUnresolvedTerminalToolCall({
        name: 'run_command',
        status: 'completed',
        requiresApproval: true,
      }),
    ).toBe(false);
  });
});
