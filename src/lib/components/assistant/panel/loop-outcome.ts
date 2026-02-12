export type VerificationGateStatus = 'idle' | 'required' | 'verified';

export interface NoToolOutcomeState {
  consecutiveEmptyResponses: number;
  justProcessedToolResults: boolean;
  planModeViolationNudgeCount: number;
  verificationNudgeCount: number;
  reportNudgeCount: number;
  fullContent: string;
  verificationGateStatus: VerificationGateStatus;
  verificationGateMessage: string;
}

export interface NoToolOutcomeInput {
  iteration: number;
  iterationThinking: string;
  iterationContent: string;
  hadPlanModeViolationThisIteration: boolean;
  hadMutatingEdits: boolean;
  lastMutationIteration: number;
  lastVerificationIteration: number;
  terminalVerificationRequired: boolean;
  lastTerminalVerificationIteration: number;
  verificationCommandGuidance: string;
  maxEmptyResponses: number;
  state: NoToolOutcomeState;
  hasStructuredCompletionReport: (content: string) => boolean;
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

  const pendingVerification =
    input.hadMutatingEdits &&
    input.lastMutationIteration > 0 &&
    (input.lastVerificationIteration < input.lastMutationIteration ||
      (input.terminalVerificationRequired &&
        input.lastTerminalVerificationIteration < input.lastMutationIteration));
  if (pendingVerification) {
    next.verificationGateStatus = 'required';
    next.verificationGateMessage = 'Waiting for diagnostics/tests/runtime checks';
    if (next.verificationNudgeCount < 3) {
      next.verificationNudgeCount++;
      input.addToolMessage({
        id: `verification_required_${Date.now()}`,
        name: '_system_verification_required',
        arguments: {},
        status: 'completed',
        output:
          `Before finalizing, you MUST verify your edits. Run: (1) get_diagnostics, (2) terminal verification: ${input.verificationCommandGuidance}, and (3) browser runtime checks for frontend changes (browser_get_errors/browser_get_summary). Then report results.`,
      });
      return { decision: 'continue', state: next };
    }
    input.updateAssistantMessage(
      `${next.fullContent}\n\nVerification gate not satisfied: edits were made but required verification steps did not complete.`,
    );
    return { decision: 'return', state: next };
  }

  if (
    input.hadMutatingEdits &&
    !input.hasStructuredCompletionReport(next.fullContent) &&
    next.reportNudgeCount < 2
  ) {
    next.reportNudgeCount++;
    input.addToolMessage({
      id: `report_required_${Date.now()}`,
      name: '_system_report_required',
      arguments: {},
      status: 'completed',
      output:
        'Provide a structured completion report with exactly these sections: What changed, Verification run, Remaining risks.',
    });
    return { decision: 'continue', state: next };
  }

  next.fullContent += input.iterationContent;
  if (input.hadMutatingEdits) {
    next.verificationGateStatus = 'verified';
    next.verificationGateMessage = 'Verification passed';
  } else {
    next.verificationGateStatus = 'idle';
    next.verificationGateMessage = 'No verification gate';
  }
  input.logOutput(`Agent: Task completed successfully after ${input.iteration} iterations.`);
  input.updateAssistantMessage(next.fullContent);
  return { decision: 'complete', state: next };
}
