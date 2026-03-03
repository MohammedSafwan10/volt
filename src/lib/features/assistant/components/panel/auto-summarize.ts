import { sendChat } from "$core/ai";
import { buildSummaryInput } from "./summary-utils";

const CONTEXT_WARN_PCT = 80;
const CONTEXT_SUMMARY_PCT = 90;
const SUMMARY_KEEP_MESSAGES = 12;
const SUMMARY_MAX_TOKENS = 1200;
const SUMMARY_TEMPERATURE = 0.2;

export interface AutoSummarizeState {
  hasContextWarned: boolean;
  isAutoSummarizing: boolean;
}

export interface AutoSummarizeOptions {
  selectedModel: string;
  controller: AbortController;
  state: AutoSummarizeState;
  assistantStore: {
    getContextUsage: (model: string) => { percentage: number };
    messages: Array<{ role: string; isSummary?: boolean; content: string }>;
    summarizeConversation: (summaryText: string, keepMessages: number) => void;
    currentMode: "ask" | "plan" | "agent";
  };
  notify: (payload: { message: string; type: "warning" | "info" | "error" | "success" }) => void;
}

export async function autoSummarizeIfNeeded(
  options: AutoSummarizeOptions,
): Promise<AutoSummarizeState> {
  const { selectedModel, controller, assistantStore, notify } = options;
  let { hasContextWarned, isAutoSummarizing } = options.state;

  if (isAutoSummarizing) {
    return { hasContextWarned, isAutoSummarizing };
  }

  const usage = assistantStore.getContextUsage(selectedModel);
  if (usage.percentage >= CONTEXT_WARN_PCT && usage.percentage < CONTEXT_SUMMARY_PCT) {
    if (!hasContextWarned) {
      hasContextWarned = true;
      notify({
        message: "Context nearing limit — auto-summary will run soon.",
        type: "warning",
      });
    }
    return { hasContextWarned, isAutoSummarizing };
  }

  if (usage.percentage < CONTEXT_SUMMARY_PCT) {
    return { hasContextWarned, isAutoSummarizing };
  }

  const summaryMsg = assistantStore.messages.find(
    (m) => m.role === "system" && m.isSummary,
  );
  const nonSystem = assistantStore.messages.filter((m) => m.role !== "system");
  if (nonSystem.length <= SUMMARY_KEEP_MESSAGES) {
    return { hasContextWarned, isAutoSummarizing };
  }

  const toSummarize = nonSystem.slice(0, -SUMMARY_KEEP_MESSAGES);
  if (toSummarize.length < 4) {
    return { hasContextWarned, isAutoSummarizing };
  }

  isAutoSummarizing = true;
  notify({ message: "Compressing older context…", type: "info" });

  try {
    const summaryInput = buildSummaryInput(
      toSummarize as Parameters<typeof buildSummaryInput>[0],
      summaryMsg?.content,
    );

    const response = await sendChat(
      {
        messages: [{ role: "user", content: summaryInput }],
        temperature: SUMMARY_TEMPERATURE,
        maxTokens: SUMMARY_MAX_TOKENS,
      },
      assistantStore.currentMode,
      controller.signal,
    );

    const summaryText = response.content?.trim();
    if (!summaryText) {
      notify({ message: "Auto-summary failed (empty result).", type: "error" });
      return { hasContextWarned, isAutoSummarizing: false };
    }

    assistantStore.summarizeConversation(summaryText, SUMMARY_KEEP_MESSAGES);
    notify({ message: "Summary updated.", type: "success" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notify({ message: `Auto-summary failed: ${msg}`, type: "error" });
  }

  return {
    hasContextWarned,
    isAutoSummarizing: false,
  };
}
