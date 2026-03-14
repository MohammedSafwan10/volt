export interface NoToolOutcomeState {
  consecutiveEmptyResponses: number;
  justProcessedToolResults: boolean;
  planModeViolationNudgeCount: number;
  fullContent: string;
  repeatedFailureHint?: string | null;
}

export interface NoToolOutcomeInput {
  iteration: number;
  iterationThinking: string;
  iterationContent: string;
  hadPlanModeViolationThisIteration: boolean;
  maxEmptyResponses: number;
  state: NoToolOutcomeState;
  logOutput: (message: string) => void;
  addToolMessage: (payload: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    status: 'completed';
    output: string;
  }) => void;
  updateAssistantMessage: (content: string) => void;
}

export type NoToolOutcomeDecision = 'continue' | 'return' | 'complete';

function normalizeForDedupe(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupeRepeatedTail(existing: string, incoming: string): string {
  const trimmedIncoming = incoming.trim();
  if (!trimmedIncoming) return "";
  const normalizedExisting = normalizeForDedupe(existing);
  const normalizedIncoming = normalizeForDedupe(trimmedIncoming);
  if (!normalizedExisting || !normalizedIncoming) return trimmedIncoming;

  // If the new segment is already the tail of what we have, don't append it again.
  if (normalizedExisting.endsWith(normalizedIncoming)) {
    return "";
  }

  // If incoming is composed of repeated lines, collapse contiguous duplicates.
  const lines = trimmedIncoming
    .split(/\n{2,}/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= 1) return trimmedIncoming;

  const dedupedLines: string[] = [];
  for (const line of lines) {
    const previous = dedupedLines[dedupedLines.length - 1];
    if (previous && normalizeForDedupe(previous) === normalizeForDedupe(line)) {
      continue;
    }
    dedupedLines.push(line);
  }
  return dedupedLines.join("\n\n");
}

function looksLikeIncompleteAction(iterationContent: string): boolean {
  const incompleteActionPatterns = [
    /\b(i'll|i will|let me|first,?\s*i'll|first,?\s*i will)\s+(update|edit|modify|change|fix|add|create|search|find|read|write|replace)/i,
    /\bfirst,?\s*(i'll|i will|let me)\b/i,
    /\b(updating|editing|modifying|searching|reading)\s+the\s+/i,
  ];
  return incompleteActionPatterns.some((pattern) => pattern.test(iterationContent));
}

export function handleNoToolOutcome(
  input: NoToolOutcomeInput,
): { decision: NoToolOutcomeDecision; state: NoToolOutcomeState } {
  const next: NoToolOutcomeState = { ...input.state };

  if (input.iterationThinking && !input.iterationContent.trim()) {
    next.consecutiveEmptyResponses++;
    input.logOutput(
      `Agent: Model produced thinking but no response (${next.consecutiveEmptyResponses}/${input.maxEmptyResponses}), prompting continuation...`,
    );

    if (next.consecutiveEmptyResponses >= input.maxEmptyResponses) {
      input.logOutput('Agent: Too many empty responses, stopping.');
      input.updateAssistantMessage(
        next.fullContent ||
        'I apologize, but I am having trouble generating a response. Please try rephrasing your request.',
      );
      return { decision: 'return', state: next };
    }

    input.addToolMessage({
      id: `thinking_continue_${Date.now()}`,
      name: '_system_continuation',
      arguments: {},
      status: 'completed',
      output:
        "You completed your reasoning but did not provide a response or take action. Based on your thinking, please now either: (1) call the appropriate tool to execute your plan, or (2) provide a text response to the user. Do NOT remain silent after thinking.",
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

  if (input.hadPlanModeViolationThisIteration) {
    if (next.planModeViolationNudgeCount < 3) {
      next.planModeViolationNudgeCount++;
      input.addToolMessage({
        id: `plan_mode_guard_${Date.now()}`,
        name: '_system_plan_mode_guard',
        arguments: {},
        status: 'completed',
        output:
          'You are in PLAN mode. Do NOT call write/edit/terminal tools. Use read/search tools to understand code, then either (a) provide a plan in chat, or (b) call "write_plan_file" once with the final plan.',
      });
      return { decision: 'continue', state: next };
    }
  }

  const incomplete = looksLikeIncompleteAction(input.iterationContent);
  if (incomplete && input.iterationContent.trim()) {
    next.consecutiveEmptyResponses++;
    input.logOutput(
      `Agent: Model said it would act but stopped without tool call (${next.consecutiveEmptyResponses}/${input.maxEmptyResponses}), prompting continuation...`,
    );

    if (next.consecutiveEmptyResponses >= input.maxEmptyResponses) {
      input.logOutput('Agent: Too many incomplete actions, stopping.');
      input.updateAssistantMessage(
        `${next.fullContent + input.iterationContent}\n\n(Stream ended unexpectedly. Please try again.)`,
      );
      return { decision: 'return', state: next };
    }

    input.addToolMessage({
      id: `incomplete_action_${Date.now()}`,
      name: '_system_continuation',
      arguments: {},
      status: 'completed',
      output:
        'You said you would take an action but the stream ended before you called any tools. Please NOW call the tool you mentioned. Do not describe what you will do - actually call the tool using function calling.',
    });
    return { decision: 'continue', state: next };
  }

  if (next.justProcessedToolResults && !input.iterationContent.trim()) {
    next.consecutiveEmptyResponses++;
    input.logOutput(
      `Agent: Model did not respond after tool results (${next.consecutiveEmptyResponses}/${input.maxEmptyResponses}), prompting continuation...`,
    );

    if (next.consecutiveEmptyResponses >= input.maxEmptyResponses) {
      input.logOutput('Agent: Too many empty responses after tools, stopping.');
      input.updateAssistantMessage(
        next.fullContent ||
        'The tools completed but I could not generate a summary. Please check the tool results above.',
      );
      return { decision: 'return', state: next };
    }

    input.addToolMessage({
      id: `continue_${Date.now()}`,
      name: '_system_continuation',
      arguments: {},
      status: 'completed',
      output:
        'The tool execution has completed. You MUST now provide a response to the user explaining what happened. If the task succeeded, summarize the result. If it failed, explain why and suggest next steps. Do NOT remain silent.',
    });
    next.justProcessedToolResults = false;
    return { decision: 'continue', state: next };
  }

  const appendSegment = dedupeRepeatedTail(next.fullContent, input.iterationContent);
  next.fullContent += appendSegment;
  input.logOutput(`Agent: Task completed successfully after ${input.iteration} iterations.`);
  input.updateAssistantMessage(next.fullContent);
  return { decision: 'complete', state: next };
}
