import { describe, expect, it } from 'vitest';

import {
  inferTerminalCommandFailure,
  normalizeCommandForTerminalShell,
} from './terminal-command-safety';

describe('terminal command safety', () => {
  it('quotes cmd /c chains for PowerShell terminals', () => {
    const normalized = normalizeCommandForTerminalShell(
      'cmd /c echo terminal-tool-ok && cd',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );

    expect(normalized).toBe('cmd /d /s /c "echo terminal-tool-ok && cd"');
  });

  it('keeps already-quoted cmd /c invocations unchanged', () => {
    const normalized = normalizeCommandForTerminalShell(
      'cmd /c "echo terminal-tool-ok && cd"',
      'pwsh.exe',
    );

    expect(normalized).toBe('cmd /c "echo terminal-tool-ok && cd"');
  });

  it('detects PowerShell parser errors even when the shell reports exit code 0', () => {
    const failure = inferTerminalCommandFailure({
      shell: 'powershell.exe',
      command: 'cmd /c echo terminal-tool-ok && cd',
      exitCode: 0,
      timedOut: false,
      output: [
        'At line:1 char:30',
        '+ cmd /c echo terminal-tool-ok && cd',
        '+                              ~~',
        "The token '&&' is not a valid statement separator in this version.",
        '    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException',
      ].join('\n'),
    });

    expect(failure).toEqual({
      exitCode: 1,
      reason: "PowerShell parser error: The token '&&' is not a valid statement separator in this version.",
    });
  });
});
