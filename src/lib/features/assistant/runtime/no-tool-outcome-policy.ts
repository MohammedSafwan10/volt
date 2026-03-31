import type { LoopTerminalOutcome } from './loop-finalizer';

export interface NoToolOutcomeState {
  consecutiveEmptyResponses: number;
  justProcessedToolResults: boolean;
  planModeViolationNudgeCount: number;
  fullContent: string;
  repeatedFailureHint?: string | null;
}

interface NoToolOutcomeInput {
  iteration: number;
  iterationThinking: string;
  iterationContent: string;
  hadPlanModeViolationThisIteration: boolean;
  maxEmptyResponses: number;
  state: NoToolOutcomeState;
  isAgentMode: boolean;
  completionNudgeCount: number;
  maxCompletionNudges: number;
  provider: string;
  modelId: string;
  logOutput: (message: string) => void;
  addToolMessage: (payload: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    status: 'completed';
    output: string;
  }) => void;
  updateAssistantMessage: (content: string) => void;
  setMessageContent: (content: string) => void;
}

export interface NoToolOutcomeResolution {
  state: NoToolOutcomeState;
  completionNudgeCount: number;
  action: 'continue' | 'terminal';
  terminalOutcome?: LoopTerminalOutcome;
}

type Decision = 'continue' | 'return' | 'complete';

function normalizeForDedupe(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function dedupeRepeatedTail(existing: string, incoming: string): string {
  const trimmedIncoming = incoming.trim();
  if (!trimmedIncoming) return '';
  const normalizedExisting = normalizeForDedupe(existing);
  const normalizedIncoming = normalizeForDedupe(trimmedIncoming);
  if (!normalizedExisting || !normalizedIncoming) return trimmedIncoming;
  if (normalizedExisting.endsWith(normalizedIncoming)) return '';
  const lines = trimmedIncoming.split(/\n{2,}/).map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) return trimmedIncoming;
  const dedupedLines: string[] = [];
  for (const line of lines) {
    const previous = dedupedLines[dedupedLines.length - 1];
    if (previous && normalizeForDedupe(previous) === normalizeForDedupe(line)) continue;
    dedupedLines.push(line);
  }
  return dedupedLines.join('\n\n');
}

function collapseRepeatedBlocks(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;

  const blocks = trimmed
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length <= 1) return trimmed;

  const deduped: string[] = [];
  for (const block of blocks) {
    const normalized = normalizeForDedupe(block);
    if (deduped.some((existing) => normalizeForDedupe(existing) === normalized)) {
      continue;
    }
    deduped.push(block);
  }

  return deduped.join('\n\n');
}

function looksLikeIncompleteAction(iterationContent: string): boolean {
  const trimmed = iterationContent.trim();
  if (!trimmed) return false;

  const metaCommentaryPatterns = [
    /^\*\*[^\n]{0,120}\*\*/i,
    /\bclarifying protocol issue\b/i,
    /\bchecking workspace status\b/i,
    /\bprotocol mistake\b/i,
    /\btool result\b/i,
    /\bi should provide\b/i,
    /\bnow i need to respond\b/i,
  ];

  if (metaCommentaryPatterns.some((pattern) => pattern.test(trimmed))) {
    return false;
  }

  const incompleteActionPatterns = [
    /\b(i'll|i will|let me|first,?\s*i'll|first,?\s*i will)\s+(update|edit|modify|change|fix|add|create|search|find|read|write|replace)/i,
    /\bfirst,?\s*(i'll|i will|let me)\b/i,
    /\b(updating|editing|modifying|searching|reading)\s+the\s+/i,
  ];
  return incompleteActionPatterns.some((pattern) => pattern.test(iterationContent));
}

function looksLikeCompletionIntent(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const completionPatterns = [
    /\bfinalizing (the )?response\b/i,
    /\bensuring task completion\b/i,
    /\bdeclare(?:ing)? completion\b/i,
    /\bverify(?:ing)? before declaring completion\b/i,
    /\bwrap(?:ping)? up\b/i,
    /\bfinish(?:ing)? up\b/i,
  ];

  return completionPatterns.some((pattern) => pattern.test(trimmed));
}

function handleNoToolOutcome(input: NoToolOutcomeInput): { decision: Decision; state: NoToolOutcomeState } {
  const next: NoToolOutcomeState = { ...input.state };

  if (input.isAgentMode && !input.iterationContent.trim() && looksLikeCompletionIntent(input.iterationThinking)) {
    const nextCompletionNudgeCount = input.completionNudgeCount + 1;
    input.logOutput(
      `Agent: Model is looping in completion-intent thinking without acting (${nextCompletionNudgeCount}/${input.maxCompletionNudges}).`,
    );

    if (nextCompletionNudgeCount >= input.maxCompletionNudges) {
      input.logOutput('Agent: Completion-intent loop exceeded budget, stopping.');
      input.updateAssistantMessage(
        next.fullContent ||
          'The run got stuck while finalizing completion. Review the latest edits and retry the task.',
      );
      return { decision: 'return', state: next };
    }

    input.addToolMessage({
      id: `completion_reminder_${Date.now()}`,
      name: '_system_completion_reminder',
      arguments: {},
      status: 'completed',
      output:
        'You are at the end of the task. Stop narrating your internal completion steps. Provide the final user-facing response NOW. If you are genuinely blocked, provide a brief blocker explanation. Do not continue thinking without taking one of those actions.',
    });
    return { decision: 'continue', state: next };
  }

  if (input.iterationThinking && !input.iterationContent.trim()) {
    next.consecutiveEmptyResponses++;
    input.logOutput(`Agent: Model produced thinking but no response (${next.consecutiveEmptyResponses}/${input.maxEmptyResponses}), prompting continuation...`);
    if (next.consecutiveEmptyResponses >= input.maxEmptyResponses) {
      input.logOutput('Agent: Too many empty responses, stopping.');
      input.updateAssistantMessage(next.fullContent || 'I apologize, but I am having trouble generating a response. Please try rephrasing your request.');
      return { decision: 'return', state: next };
    }
    input.addToolMessage({
      id: `thinking_continue_${Date.now()}`,
      name: '_system_continuation',
      arguments: {},
      status: 'completed',
      output: 'You completed your reasoning but did not provide a response or take action. Based on your thinking, please now either: (1) call the appropriate tool to execute your plan, or (2) provide a text response to the user. Do NOT remain silent after thinking.',
    });
    return { decision: 'continue', state: next };
  }

  if (next.repeatedFailureHint) {
    input.addToolMessage({
      id: `recovery_hint_${Date.now()}`,
      name: '_system_recovery_hint',
      arguments: {},
      status: 'completed',
      output: next.repeatedFailureHint,
    });
    next.repeatedFailureHint = null;
    return { decision: 'continue', state: next };
  }

  if (input.hadPlanModeViolationThisIteration && next.planModeViolationNudgeCount < 3) {
    next.planModeViolationNudgeCount++;
    input.addToolMessage({
      id: `plan_mode_guard_${Date.now()}`,
      name: '_system_plan_mode_guard',
      arguments: {},
      status: 'completed',
      output: 'You are in PLAN mode. Do NOT call write/edit/terminal tools. Use read/search tools to understand code, then either (a) provide a plan in chat, or (b) call "write_plan_file" once with the final plan.',
    });
    return { decision: 'continue', state: next };
  }

  const incomplete = looksLikeIncompleteAction(input.iterationContent);
  if (incomplete && input.iterationContent.trim()) {
    next.consecutiveEmptyResponses++;
    input.logOutput(`Agent: Model said it would act but stopped without tool call (${next.consecutiveEmptyResponses}/${input.maxEmptyResponses}), prompting continuation...`);
    if (next.consecutiveEmptyResponses >= input.maxEmptyResponses) {
      input.logOutput('Agent: Too many incomplete actions, stopping.');
      input.updateAssistantMessage(`${next.fullContent + input.iterationContent}\n\n(Stream ended unexpectedly. Please try again.)`);
      return { decision: 'return', state: next };
    }
    input.addToolMessage({
      id: `incomplete_action_${Date.now()}`,
      name: '_system_continuation',
      arguments: {},
      status: 'completed',
      output: 'You said you would take an action but the stream ended before you called any tools. Please NOW call the tool you mentioned. Do not describe what you will do - actually call the tool using function calling.',
    });
    return { decision: 'continue', state: next };
  }

  if (next.justProcessedToolResults && !input.iterationContent.trim()) {
    next.consecutiveEmptyResponses++;
    input.logOutput(`Agent: Model did not respond after tool results (${next.consecutiveEmptyResponses}/${input.maxEmptyResponses}), prompting continuation...`);
    if (next.consecutiveEmptyResponses >= input.maxEmptyResponses) {
      input.logOutput('Agent: Too many empty responses after tools, stopping.');
      input.updateAssistantMessage(next.fullContent || 'The tools completed but I could not generate a summary. Please check the tool results above.');
      return { decision: 'return', state: next };
    }
    input.addToolMessage({
      id: `continue_${Date.now()}`,
      name: '_system_continuation',
      arguments: {},
      status: 'completed',
      output: 'The tool execution has completed. You MUST now provide a response to the user explaining what happened. If the task succeeded, summarize the result. If it failed, explain why and suggest next steps. Do NOT remain silent.',
    });
    next.justProcessedToolResults = false;
    return { decision: 'continue', state: next };
  }

  const appendSegment = dedupeRepeatedTail(next.fullContent, input.iterationContent);
  next.fullContent = collapseRepeatedBlocks(next.fullContent + appendSegment);
  input.logOutput(`Agent: Task completed successfully after ${input.iteration} iterations.`);
  input.updateAssistantMessage(next.fullContent);
  return { decision: 'complete', state: next };
}

export function resolveNoToolOutcome(input: NoToolOutcomeInput): NoToolOutcomeResolution {
  const handled = handleNoToolOutcome(input);
  const next = handled.state;

  if (handled.decision === 'continue') {
    return {
      action: 'continue',
      state: next,
      completionNudgeCount:
        input.isAgentMode && !input.iterationContent.trim() && looksLikeCompletionIntent(input.iterationThinking)
          ? input.completionNudgeCount + 1
          : input.completionNudgeCount,
    };
  }

  if (
    handled.decision === 'complete' &&
    input.isAgentMode &&
    next.fullContent.trim().length > 0
  ) {
    return {
      action: 'terminal',
      state: next,
      completionNudgeCount: input.completionNudgeCount,
      terminalOutcome: {
        status: 'completed',
        reason: 'implicit_content_completion',
        streamState: 'completed',
        loopStateMeta: { iteration: input.iteration, reason: 'implicit_content_completion', provider: input.provider },
        finalizeMeta: { iteration: input.iteration, provider: input.provider, modelId: input.modelId },
        loopLogLevel: 'info',
        loopLogEvent: 'loop_completed',
        loopLogDetails: { reason: 'implicit_content_completion', provider: input.provider },
      },
    };
  }

  if (handled.decision === 'complete') {
    return {
      action: 'terminal',
      state: next,
      completionNudgeCount: input.completionNudgeCount,
      terminalOutcome: {
        status: 'completed',
        reason: 'content_only_completion',
        streamState: 'completed',
        loopStateMeta: { iteration: input.iteration, reason: 'content_only_completion' },
        finalizeMeta: { iteration: input.iteration },
        loopLogLevel: 'info',
        loopLogEvent: 'loop_completed',
        loopLogDetails: { reason: 'content_only_completion' },
      },
    };
  }

  return {
    action: 'terminal',
    state: next,
    completionNudgeCount: input.completionNudgeCount,
    terminalOutcome: {
      status: 'failed',
      reason: 'no_tool_outcome_return',
      streamState: 'failed',
      streamIssue: 'No tool outcome requested loop return',
      loopStateMeta: { iteration: input.iteration, reason: 'no_tool_outcome_return' },
      finalizeMeta: { iteration: input.iteration },
      loopLogLevel: 'error',
      loopLogEvent: 'loop_failed',
      loopLogDetails: { reason: 'no_tool_outcome_return' },
    },
  };
}
