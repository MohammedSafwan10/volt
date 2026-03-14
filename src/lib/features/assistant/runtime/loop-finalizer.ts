export interface LoopTerminalOutcome {
  status: 'completed' | 'failed' | 'cancelled';
  reason: string;
  assistantMessage?: string;
  streamState?: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  streamIssue?: string;
  loopStateMeta?: Record<string, unknown>;
  finalizeMeta?: Record<string, unknown>;
  loopLogLevel?: 'info' | 'warn' | 'error';
  loopLogEvent?: string;
  loopLogDetails?: Record<string, unknown>;
  toast?: { message: string; type: 'warning' | 'error' };
  outputLog?: string;
}

export interface LoopFinalizerAdapter {
  updateAssistantMessage: (messageId: string, content: string, streaming: boolean) => void;
  markAssistantMessageStreamState: (
    messageId: string,
    state: 'completed' | 'failed' | 'cancelled' | 'interrupted',
    issue?: string,
  ) => void;
  setAgentLoopState: (state: any, meta?: Record<string, unknown>) => void;
  finalizeOutcome: (
    status: 'completed' | 'failed' | 'cancelled',
    reason: string,
    meta?: Record<string, unknown>,
  ) => void;
  loopLog: (
    level: 'info' | 'warn' | 'error',
    event: string,
    details?: Record<string, unknown>,
  ) => void;
  showToast: (toast: { message: string; type: 'warning' | 'error' }) => void;
  logOutput?: (message: string) => void;
}

export function applyLoopTerminalOutcome(
  messageId: string,
  outcome: LoopTerminalOutcome,
  adapter: LoopFinalizerAdapter,
): void {
  if (outcome.assistantMessage !== undefined) {
    adapter.updateAssistantMessage(messageId, outcome.assistantMessage, false);
  }
  if (outcome.streamState) {
    adapter.markAssistantMessageStreamState(messageId, outcome.streamState, outcome.streamIssue);
  }
  adapter.setAgentLoopState(outcome.status, {
    reason: outcome.reason,
    ...(outcome.loopStateMeta ?? {}),
  });
  adapter.finalizeOutcome(outcome.status, outcome.reason, outcome.finalizeMeta);
  if (outcome.loopLogLevel && outcome.loopLogEvent) {
    adapter.loopLog(outcome.loopLogLevel, outcome.loopLogEvent, outcome.loopLogDetails);
  }
  if (outcome.outputLog && adapter.logOutput) {
    adapter.logOutput(outcome.outputLog);
  }
  if (outcome.toast) {
    adapter.showToast(outcome.toast);
  }
}
