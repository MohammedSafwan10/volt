export interface TerminalCommandFailureInput {
  shell?: string;
  command: string;
  exitCode: number;
  timedOut: boolean;
  output: string;
}

export interface TerminalCommandFailure {
  exitCode: number;
  reason: string;
}

function isPowerShell(shell?: string): boolean {
  return Boolean(shell && /powershell|pwsh/i.test(shell));
}

export function normalizeCommandForTerminalShell(
  command: string,
  shell?: string,
): string {
  const trimmed = command.trim();
  if (!trimmed || !isPowerShell(shell)) return trimmed;

  const cmdMatch = trimmed.match(/^cmd(?:\.exe)?\s+\/c\s+(.+)$/i);
  if (!cmdMatch) return trimmed;

  const remainder = cmdMatch[1]?.trim() ?? '';
  if (!remainder) return trimmed;
  if (/^".*"$/.test(remainder)) return trimmed;
  if (!/(?:&&|\|\|)/.test(remainder)) return trimmed;
  if (/["'`]/.test(remainder)) return trimmed;

  return `cmd /d /s /c "${remainder}"`;
}

function extractPowerShellParserReason(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const tokenLine = lines.find((line) =>
    /The token '.+' is not a valid statement separator/i.test(line),
  );
  if (tokenLine) {
    return `PowerShell parser error: ${tokenLine}`;
  }

  const parserLine = lines.find((line) => /ParserError/i.test(line));
  if (parserLine) {
    return `PowerShell parser error: ${parserLine}`;
  }

  const invalidLine = lines.find((line) => /FullyQualifiedErrorId\s*:\s*Invalid/i.test(line));
  if (invalidLine) {
    return `PowerShell parser error: ${invalidLine}`;
  }

  return null;
}

export function inferTerminalCommandFailure(
  input: TerminalCommandFailureInput,
): TerminalCommandFailure | null {
  if (input.timedOut) {
    return {
      exitCode: -1,
      reason: 'Command timed out',
    };
  }

  if (input.exitCode !== 0) {
    return {
      exitCode: input.exitCode,
      reason: `Command failed with exit code ${input.exitCode}`,
    };
  }

  if (isPowerShell(input.shell)) {
    const parserReason = extractPowerShellParserReason(input.output);
    if (parserReason) {
      return {
        exitCode: 1,
        reason: parserReason,
      };
    }
  }

  return null;
}
