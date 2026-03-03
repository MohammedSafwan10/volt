import { describe, expect, it } from 'vitest';

import { selectAutoVerificationAction } from './auto-verification';

describe('selectAutoVerificationAction', () => {
  it('returns null when no file edits succeeded', () => {
    const result = selectAutoVerificationAction({
      fileEditsSucceeded: false,
      explicitVerificationCalled: false,
      profiles: [],
      cwd: 'C:\\repo',
    });
    expect(result).toBeNull();
  });

  it('returns null when verification already called explicitly', () => {
    const result = selectAutoVerificationAction({
      fileEditsSucceeded: true,
      explicitVerificationCalled: true,
      profiles: [],
      cwd: 'C:\\repo',
    });
    expect(result).toBeNull();
  });

  it('selects run_command for concrete profile', () => {
    const result = selectAutoVerificationAction({
      fileEditsSucceeded: true,
      explicitVerificationCalled: false,
      profiles: [
        {
          id: 'rust',
          label: 'Rust',
          commandPattern: /\bcargo\s+(check|test)\b/i,
          suggestedCommands: ['cargo check', 'cargo test'],
          requiresTerminalVerification: true,
        },
      ],
      cwd: 'C:\\repo',
    });
    expect(result?.toolName).toBe('run_command');
    expect(result?.args.command).toBe('cargo check');
  });

  it('falls back to diagnostics for generic profile', () => {
    const result = selectAutoVerificationAction({
      fileEditsSucceeded: true,
      explicitVerificationCalled: false,
      profiles: [
        {
          id: 'generic',
          label: 'Generic',
          commandPattern: /\btest\b/i,
          suggestedCommands: ['run project checks/tests'],
          requiresTerminalVerification: false,
        },
      ],
      cwd: 'C:\\repo',
    });
    expect(result?.toolName).toBe('get_diagnostics');
  });
});

