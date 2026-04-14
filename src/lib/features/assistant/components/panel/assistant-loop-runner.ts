import { invoke } from "@tauri-apps/api/core";
import { streamChat } from "$core/ai";
import {
  executeToolCall,
  getAllToolsForMode,
  getToolCapabilities,
  isFileMutatingTool,
  isTerminalTool as isTerminalToolName,
  normalizeToolName,
  validateToolCall as validateTool,
  type ToolResult,
} from "$core/ai/tools";
import { resolvePath } from "$core/ai/tools/utils";
import { showToast } from "$shared/stores/toast.svelte";
import { assistantStore, type ToolCall } from "$features/assistant/stores/assistant.svelte";
import { aiSettingsStore, type AIMode } from "$features/assistant/stores/ai.svelte";
import { agentTelemetryStore } from "$features/assistant/stores/agent-telemetry.svelte";
import { logOutput } from "$features/terminal/stores/output.svelte";
import {
  assistantRunRegisterApprovals,
  assistantRunResumeApproval,
  assistantRunUpdateApproval,
  type AssistantRunSnapshot,
  type AssistantRuntimeEventPayload,
} from "$features/assistant/runtime/native-runtime";
import { applyLoopTerminalOutcome } from "$features/assistant/runtime/loop-finalizer";
import { resolveNoToolOutcome } from "$features/assistant/runtime/no-tool-outcome-policy";
import {
  createAgentRuntime,
  type NativeRuntimeCommandResult as NativeAgentRuntimeCommandResult,
} from "$features/assistant/runtime/agent-runtime";
import type { AgentLoopState } from "$features/assistant/stores/assistant/loop-state";
import { SvelteMap, SvelteSet } from "svelte/reactivity";
import {
  buildRecoveryHint,
  classifyRecoveryIssue,
  getFailureSignature,
  getToolIdempotencyKey,
  mapWithConcurrency,
  normalizeQueueKey,
  stableStringify,
} from "./utils";
import { classifyPlanningPhase, shouldRunAfterFileEdits } from "./verification-profiles";
import { createStreamGuards } from "./stream-guards";
import { createStreamingTextBuffer } from "./streaming-text-buffer";
import { addToolResultsToConversation, waitForToolCompletion } from "./tool-loop-support";
import {
  executeFileEditQueues,
  executeQueuedNonFileTools,
  type QueuedFileEditTool,
  type QueuedNonFileTool,
} from "./loop-executor";
import { ToolRepetitionDetector } from "./tool-repetition";
import { createToolTrackingState } from "./tool-tracking";
import { executeNativeDispatchPlan, type NativeDispatchAuthority } from "./native-dispatch-plan";
import { processToolsNeedingApproval } from "./approval-executor";
import { compileProviderMessages } from "./compile-provider-messages";
import { buildPartialToolCallPreview } from "./tool-call-previews";
interface NativeApprovalAuthority {
  shouldAbort: boolean;
  reason?: string;
  approvedToolIds: string[];
  deniedToolIds: string[];
  unresolvedToolIds: string[];
}
interface AssistantLoopRunnerDeps {
  normalizeToolArgumentsForWorkspace: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Record<string, unknown>;
  buildNativeRuntimeDecision: (
    operation: string,
    conversationId: string,
    payload: Record<string, unknown>,
  ) => Promise<NativeAgentRuntimeCommandResult | null>;
  applyNativeRuntimeDecision: (
    decision: NativeAgentRuntimeCommandResult | null,
    fallbackState?: AgentLoopState,
    fallbackMeta?: Record<string, unknown>,
  ) => void;
  startNativeAssistantRun: (params: {
    conversationId: string;
    mode: AIMode;
    modelId: string;
    systemPrompt: string;
  }) => Promise<string | null>;
  publishNativeAssistantEvent: (
    conversationId: string,
    kind: string,
    loopState?: AgentLoopState,
    payload?: AssistantRuntimeEventPayload,
  ) => Promise<void>;
  publishNativeToolPatch: (
    conversationId: string,
    messageId: string,
    toolCallId: string,
    patch: Record<string, unknown>,
  ) => Promise<void>;
  createNativeDispatchAuthority: (conversationId: string) => NativeDispatchAuthority;
  resolveNativeApprovalAuthority: (
    conversationId: string,
    toolIds?: string[],
  ) => Promise<NativeApprovalAuthority | null>;
  waitForNativeToolApprovals: (
    messageId: string,
    toolIds: string[],
    signal: AbortSignal,
    getMessages: () => Array<{ id: string }>,
    updateToolCallInMessage: (
      msgId: string,
      toolId: string,
      patch: { status: "failed"; error: string; endTime: number },
    ) => void,
    maxWaitMs?: number,
  ) => Promise<boolean>;
  cancelNativeAssistantRun: (
    conversationId: string,
    reason: string,
    meta?: Record<string, unknown>,
  ) => Promise<void>;
  getNativeRunId: (conversationId: string) => string | undefined;
  syncNativeSnapshot: (
    conversationId: string,
    snapshot: AssistantRunSnapshot | null | undefined,
  ) => void;
}
function isAssistantDebugEnabled(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      window.localStorage.getItem("volt.assistant.debug") === "true"
    );
  } catch {
    return false;
  }
}
export function createAssistantLoopRunner(deps: AssistantLoopRunnerDeps) {
  async function runToolLoop(
    conversationId: string,
    systemPrompt: string,
    modelId: string,
    tools: ReturnType<typeof getAllToolsForMode>,
    controller: AbortController,
    maxIterations = 60,
  ): Promise<void> {
    const msgId = assistantStore.addAssistantMessage("", true);
    const isPlanMode = assistantStore.currentMode === "plan";
    const isAgentMode = assistantStore.currentMode === "agent";
    const failureNudgedSignatures = new SvelteSet<string>();
    const repetitionDetector = new ToolRepetitionDetector(3);
    let planModeViolationNudgeCount = 0;

    let fullContent = "";
    let iteration = 0;
    const toolRunScope = crypto.randomUUID();
    const loopStartedAt = Date.now();
    let maxLoopDurationMs = 20 * 60 * 1000;
    const HARD_MAX_ITERATIONS = 120;
    const HARD_MAX_LOOP_DURATION_MS = 35 * 60 * 1000;
    const PROGRESS_WINDOW_MS = 90 * 1000;
    const STREAM_STALL_TIMEOUT_MS = (() => {
      // Free/community models on OpenRouter can have long first-token latency.
      // Thinking models can also pause for extended reasoning gaps between chunks.
      const isOpenRouter = aiSettingsStore.selectedProvider === "openrouter";
      const model = modelId.toLowerCase();
      const isThinkingModel = model.includes("|thinking");
      const isFreeTierLike =
        model.includes(":free") || model.includes("/free") || model.includes("flash");
      if (isThinkingModel && isOpenRouter && isFreeTierLike) return 180 * 1000;
      if (isThinkingModel) return 180 * 1000;
      if (isOpenRouter && isFreeTierLike) return 120 * 1000;
      if (isOpenRouter) return 90 * 1000;
      return 60 * 1000;
    })();
    const MAX_BUDGET_EXTENSIONS = 3;
    let budgetExtensions = 0;
    let lastProgressAt = Date.now();

    // Track consecutive empty responses to detect stuck model
    let consecutiveEmptyResponses = 0;
    const MAX_EMPTY_RESPONSES = 6;
    let recoveryRetryCount = 0;
    const MAX_RECOVERY_RETRIES = 4;
    const failureSignatureCounts = new SvelteMap<string, number>();
    let repeatedFailureHint: string | null = null;
    const trackingState = createToolTrackingState({
      isFileMutatingTool,
      normalizeQueueKey,
      resolvePath,
      classifyRecoveryIssue,
      getFileInfo: (path: string) => invoke("get_file_info", { path }),
    });
    const touchedFilePaths = trackingState.touchedFilePaths;
    const structuralMutationPaths = trackingState.structuralMutationPaths;
    const pendingVerificationState = trackingState.pendingVerificationState;
    const trackToolOutcome = trackingState.trackToolOutcome;
    const agentRuntime = createAgentRuntime({
      sendCommand: async (request) =>
        (await deps.buildNativeRuntimeDecision(
          request.operation,
          request.conversationId,
          request.payload,
        )) ?? {
          shouldApply: false,
          operation: request.operation,
          conversationId: request.conversationId,
        },
    });
    await deps.startNativeAssistantRun({
      conversationId,
      mode: assistantStore.currentMode,
      modelId,
      systemPrompt,
    });

    // Streaming safety guards
    const streamGuards = createStreamGuards();
    // Log start of agent loop
    logOutput("Volt", `Agent: Starting tool loop (max ${maxIterations} iterations)`);
    const loopLog = (
      level: "info" | "warn" | "error",
      event: string,
      details: Record<string, unknown> = {},
    ): void => {
      const payload = {
        event,
        mode: assistantStore.currentMode,
        modelId,
        conversationId,
        iteration,
        ...details,
      };
      if (!isAssistantDebugEnabled()) return;
      if (level === "error") {
        console.error("[AssistantLoop]", payload);
      } else if (level === "warn") {
        console.warn("[AssistantLoop]", payload);
      } else {
        console.info("[AssistantLoop]", payload);
      }
    };
    loopLog("info", "loop_start", { maxIterations });
    await deps.publishNativeAssistantEvent(conversationId, "loop_state_changed", "running", {
      loopMeta: {
        iteration: 0,
        maxIterations,
        startedAt: loopStartedAt,
      },
    });
    deps.applyNativeRuntimeDecision(
      await agentRuntime.buildRuntimeRequest({
        operation: "loop_start",
        snapshot: assistantStore.getRuntimeSnapshot(conversationId),
        payload: {
          requestedLoopState: "running",
          requestedLoopMeta: {
            iteration: 0,
            maxIterations,
            startedAt: loopStartedAt,
            maxLoopDurationMs,
          },
        },
      }),
      "running",
      {
        iteration: 0,
        maxIterations,
        startedAt: loopStartedAt,
      },
    );

    // Track if we just processed tool results - used to detect when model doesn't respond
    let justProcessedToolResults = false;
    let completionNudgeCount = 0;
    const MAX_COMPLETION_NUDGES = 3;
    let pruneNotified = false;
    const finalizeOutcome = (
      outcome: "completed" | "failed" | "cancelled",
      reason: string,
      meta: Record<string, unknown> = {},
    ): void => {
      agentTelemetryStore.record({
        type: "agent.completion.outcome",
        timestamp: Date.now(),
        outcome,
        reason,
        meta,
      });
    };

    while (true) {
      const canExtendBudget =
        Date.now() - lastProgressAt <= PROGRESS_WINDOW_MS &&
        budgetExtensions < MAX_BUDGET_EXTENSIONS;

      const iterationLimitDecision = agentRuntime.evaluateIterationLimit({
        iteration,
        maxIterations,
        canExtendBudget,
        hardMaxIterations: HARD_MAX_ITERATIONS,
      });
      if (iterationLimitDecision.action !== "continue") {
        if (iterationLimitDecision.action === "extend" && iterationLimitDecision.newMaxIterations) {
          const previous = maxIterations;
          maxIterations = iterationLimitDecision.newMaxIterations;
          budgetExtensions++;
          logOutput(
            "Volt",
            `Agent: Extended iteration budget ${previous} -> ${maxIterations} due to recent progress.`,
          );
        } else {
          assistantStore.updateAssistantMessage(msgId, fullContent, false);
          assistantStore.markAssistantMessageStreamState(
            msgId,
            "failed",
            "Reached maximum iterations",
          );
          deps.applyNativeRuntimeDecision(
            await agentRuntime.buildRuntimeRequest({
              operation: "loop_iteration_limit_reached",
              snapshot: assistantStore.getRuntimeSnapshot(conversationId),
              payload: {
                requestedLoopState: "failed",
                requestedLoopMeta: {
                  iteration: maxIterations,
                  reason: "max_iterations_reached",
                },
              },
            }),
            "failed",
            {
              iteration: maxIterations,
              reason: "max_iterations_reached",
            },
          );
          await deps.publishNativeAssistantEvent(conversationId, "run_failed", "failed", {
            loopMeta: {
              iteration: maxIterations,
              reason: "max_iterations_reached",
            },
            messagePatch: {
              messageId: msgId,
              streamState: "failed",
              streamIssue: "Reached maximum iterations",
            },
          });
          finalizeOutcome("failed", "max_iterations_reached", {
            iteration: maxIterations,
          });
          showToast({
            message: "Tool loop reached maximum iterations",
            type: "warning",
          });
          return;
        }
      }

      iteration++;
      loopLog("info", "iteration_start", {
        maxIterations,
        elapsedMs: Date.now() - loopStartedAt,
      });
      await deps.publishNativeAssistantEvent(conversationId, "loop_state_changed", "running", {
        loopMeta: {
          iteration,
          maxIterations,
          maxLoopDurationMs,
        },
      });
      deps.applyNativeRuntimeDecision(
        await agentRuntime.buildRuntimeRequest({
          operation: "iteration_start",
          snapshot: assistantStore.getRuntimeSnapshot(conversationId),
          payload: {
            requestedLoopState: "running",
            requestedLoopMeta: {
              iteration,
              maxIterations,
              maxLoopDurationMs,
            },
          },
        }),
        "running",
        {
          iteration,
          maxIterations,
        },
      );

      const budgetDecision = agentRuntime.evaluateLoopBudget({
        elapsedMs: Date.now() - loopStartedAt,
        maxLoopDurationMs,
        canExtendBudget,
        hardMaxLoopDurationMs: HARD_MAX_LOOP_DURATION_MS,
      });
      if (budgetDecision.action !== "continue") {
        if (budgetDecision.action === "extend" && budgetDecision.newMaxLoopDurationMs) {
          const previous = maxLoopDurationMs;
          maxLoopDurationMs = budgetDecision.newMaxLoopDurationMs;
          budgetExtensions++;
          logOutput(
            "Volt",
            `Agent: Extended time budget ${Math.round(previous / 60000)} -> ${Math.round(maxLoopDurationMs / 60000)} min due to recent progress.`,
          );
        } else {
          deps.applyNativeRuntimeDecision(
            await agentRuntime.buildRuntimeRequest({
              operation: "loop_timeout",
              snapshot: assistantStore.getRuntimeSnapshot(conversationId),
              payload: {
                requestedLoopState: "failed",
                requestedLoopMeta: {
                  reason: "time_budget_exceeded",
                  iteration,
                },
              },
            }),
            "failed",
            {
              reason: "time_budget_exceeded",
              iteration,
            },
          );
          await deps.publishNativeAssistantEvent(conversationId, "run_failed", "failed", {
            loopMeta: {
              reason: "time_budget_exceeded",
              iteration,
            },
            messagePatch: {
              messageId: msgId,
              streamState: "failed",
              streamIssue: "Tool loop exceeded time budget",
            },
          });
          assistantStore.markAssistantMessageStreamState(
            msgId,
            "failed",
            "Tool loop exceeded time budget",
          );
          finalizeOutcome("failed", "time_budget_exceeded", { iteration });
          assistantStore.updateAssistantMessage(
            msgId,
            fullContent
              ? `${fullContent}\n\n⚠️ Stopped: tool loop exceeded time budget (${Math.round(maxLoopDurationMs / 60000)} min).`
              : `⚠️ Stopped: tool loop exceeded time budget (${Math.round(maxLoopDurationMs / 60000)} min).`,
            false,
          );
          showToast({
            message: "Tool loop timed out (time budget exceeded)",
            type: "warning",
          });
          return;
        }
      }

      const abortDecision = agentRuntime.evaluateAbortSignal(controller.signal.aborted);
      if (abortDecision.shouldAbort && abortDecision.reason) {
        await deps.cancelNativeAssistantRun(conversationId, abortDecision.reason, {
          iteration,
        });
        deps.applyNativeRuntimeDecision(
          await agentRuntime.buildRuntimeRequest({
            operation: "loop_cancelled",
            snapshot: assistantStore.getRuntimeSnapshot(conversationId),
            payload: {
              requestedLoopState: "cancelled",
              requestedLoopMeta: {
                reason: abortDecision.reason,
                iteration,
              },
            },
          }),
          "cancelled",
          {
            reason: abortDecision.reason,
            iteration,
          },
        );
        assistantStore.markAssistantMessageStreamState(msgId, "cancelled", "Streaming cancelled");
        finalizeOutcome("cancelled", abortDecision.reason, { iteration });
        logOutput("Volt", `Agent: Loop aborted at iteration ${iteration}`);
        return;
      }

      const compiledMessages = compileProviderMessages(
        assistantStore.getConversationMessages(conversationId),
        modelId,
      );
      const providerMessages = compiledMessages.messages;
      if (compiledMessages.didPrune && !pruneNotified) {
        pruneNotified = true;
        logOutput(
          "Volt",
          `Agent: Context pruned to stay under token budget (${compiledMessages.estimatedTokens}/${compiledMessages.budgetTokens}).`,
        );
      }

      let iterationContent = "";
      let iterationThinking = "";
      const allToolCalls: Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown>;
        thoughtSignature?: string;
      }> = [];
      const pendingToolCalls: Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown>;
        thoughtSignature?: string;
      }> = [];
      const queuedNonFileTools: QueuedNonFileTool[] = [];
      // Queue for sequential file edits - edits to the same file run one after another
      const fileEditQueues = new SvelteMap<string, QueuedFileEditTool[]>();
      // If the model emits an invalid tool call (e.g. missing required args/meta),
      // we must NOT leave it in a pending state (can deadlock approvals).
      const immediateResults: Array<{
        id: string;
        name: string;
        result: ToolResult;
      }> = [];
      const toolIdCounts = new SvelteMap<string, number>();
      const streamedToolIds = new SvelteMap<string, string>();
      let hadPlanModeViolationThisIteration = false;
      let toolCallSeenThisIteration = false;
      let contentAfterToolCallSeen = false;
      let stalledAbortReason: string | null = null;
      let fileModifyFailed = false;

      try {
        // Reduce hallucinations: use conservative temperature defaults per mode.
        const temperature =
          assistantStore.currentMode === "plan"
            ? 0.1
            : assistantStore.currentMode === "ask"
              ? 0.2
              : 0.15;

        let warnedAboutLooping = false;
        const toNovelStreamDelta = (existing: string, incoming: string): string => {
          if (!incoming) return "";
          if (!existing) return incoming;
          if (existing.endsWith(incoming)) return "";
          if (incoming.startsWith(existing)) {
            return incoming.slice(existing.length);
          }

          const maxOverlap = Math.min(existing.length, incoming.length);
          for (let overlap = maxOverlap; overlap >= 16; overlap--) {
            if (existing.slice(-overlap) === incoming.slice(0, overlap)) {
              return incoming.slice(overlap);
            }
          }
          return incoming;
        };
        const mergeIterationIntoFullContent = (existing: string, incoming: string): string => {
          if (!incoming.trim()) return existing;
          if (!existing) return incoming;
          if (existing === incoming || existing.endsWith(incoming)) {
            return existing;
          }
          if (incoming.startsWith(existing)) {
            return incoming;
          }

          const novel = toNovelStreamDelta(existing, incoming);
          if (!novel) return existing;
          return existing + novel;
        };
        const textBuffer = createStreamingTextBuffer({
          intervalMs: 45,
          sliceChars: 120,
          onFlush: (text) => {
            assistantStore.appendTextToMessage(msgId, text, true);
            void deps.publishNativeAssistantEvent(conversationId, "message_delta", "running", {
              messagePatch: {
                messageId: msgId,
                contentDelta: text,
                streamState: "active",
              },
            });
          },
        });
        // REMOVED: visibleCharBudget - show full responses
        const stallWatchdog = setInterval(() => {
          if (controller.signal.aborted) return;
          const idleFor = Date.now() - lastProgressAt;
          if (idleFor < STREAM_STALL_TIMEOUT_MS) return;
          stalledAbortReason = `Stream stalled: no chunks for ${Math.round(STREAM_STALL_TIMEOUT_MS / 1000)}s.`;
          controller.abort();
        }, 1000);
        let hasQueuedFileEdits = false;
        let immediateNonFileTools: QueuedNonFileTool[] = [];
        let deferredNonFileTools: QueuedNonFileTool[] = [];
        let orderedImmediateNonFileTools: QueuedNonFileTool[] = [];
        let finalizedAtToolBoundary = false;
        let schedulingDecision = agentRuntime.evaluateToolScheduling({
          pendingApprovalCount: 0,
          hasQueuedFileEdits: false,
          defaultExecuteInOrder: false,
        });

        try {
          for await (const chunk of streamChat(
            {
              messages: providerMessages,
              systemPrompt,
              tools,
              stream: true,
              temperature,
            },
            assistantStore.currentMode,
            controller.signal,
          )) {
            if (controller.signal.aborted) return;

            const hasNarrativePayload =
              (chunk.type === "content" && Boolean(chunk.content)) ||
              (chunk.type === "thinking" && Boolean(chunk.thinking));
            if (toolCallSeenThisIteration && hasNarrativePayload) {
              contentAfterToolCallSeen = true;
              finalizedAtToolBoundary = true;
              loopLog("info", "tool_boundary_stream_finalize", {
                iteration,
                chunkType: chunk.type,
              });
              break;
            }

            if (chunk.type === "content" && chunk.content) {
              if (streamGuards.shouldAbortForLeak(chunk.content)) {
                controller.abort();
                showToast({
                  message:
                    "Assistant output contained internal context markers; generation stopped.",
                  type: "warning",
                });
                assistantStore.updateAssistantMessage(msgId, fullContent + iterationContent, false);
                return;
              }

              if (streamGuards.isDegenerateRepeat(chunk.content)) {
                if (!warnedAboutLooping) {
                  warnedAboutLooping = true;
                  showToast({
                    message:
                      "Assistant output started repeating. Repeated chunks are being skipped.",
                    type: "warning",
                  });
                }
                continue;
              }

              if (streamGuards.isDegenerateLineRepeat(iterationContent + chunk.content)) {
                if (!warnedAboutLooping) {
                  warnedAboutLooping = true;
                  showToast({
                    message: "Assistant output started looping. Repeated chunks are being skipped.",
                    type: "warning",
                  });
                }
                continue;
              }

              const novelChunk = toNovelStreamDelta(iterationContent, chunk.content);
              if (!novelChunk) {
                continue;
              }

              // End any active thinking part before adding text
              assistantStore.endThinkingPart(msgId);

              iterationContent += novelChunk;
              lastProgressAt = Date.now();
              textBuffer.append(novelChunk);
            }

            // Handle thinking chunks - display INLINE (Cursor-style)
            if (chunk.type === "thinking" && chunk.thinking) {
              iterationThinking += chunk.thinking;
              lastProgressAt = Date.now();
              // Append thinking inline to contentParts (creates new thinking block if needed)
              assistantStore.appendThinkingToMessage(msgId, chunk.thinking);
              void deps.publishNativeAssistantEvent(conversationId, "thinking_delta", "running", {
                messagePatch: {
                  messageId: msgId,
                  thinkingDelta: chunk.thinking,
                  streamState: "active",
                },
              });
            }

            if (chunk.type === "tool_call" && chunk.toolCall) {
              lastProgressAt = Date.now();
              const toolCallName = normalizeToolName(chunk.toolCall.name);
              const toolCallArgs = deps.normalizeToolArgumentsForWorkspace(
                toolCallName,
                chunk.toolCall.arguments,
              );
              const rawToolCallId =
                (chunk.toolCall.id && chunk.toolCall.id.trim()) ||
                `tool_${crypto.randomUUID().slice(0, 8)}`;
              const existingStreamedId = streamedToolIds.get(rawToolCallId);
              let toolCallId = existingStreamedId;
              if (!toolCallId) {
                const seenCount = toolIdCounts.get(rawToolCallId) ?? 0;
                toolIdCounts.set(rawToolCallId, seenCount + 1);
                toolCallId = seenCount === 0 ? rawToolCallId : `${rawToolCallId}__${seenCount + 1}`;
                streamedToolIds.set(rawToolCallId, toolCallId);
              }
              const toolCallThoughtSignature = chunk.toolCall.thoughtSignature;
              const existingInlineToolCall = assistantStore.messages
                .find((msg) => msg.id === msgId)
                ?.inlineToolCalls?.find((tc) => tc.id === toolCallId);
              const isPartialToolCall = Boolean(chunk.partial);
              const isInternalCompletionTool = toolCallName === "attempt_completion";
              if (isPartialToolCall) {
                // End thinking as soon as the first tool call delta arrives
                if (!toolCallSeenThisIteration) {
                  await textBuffer.flushNow();
                  assistantStore.endThinkingPart(msgId);
                  toolCallSeenThisIteration = true;
                }
                if (!isInternalCompletionTool) {
                  const partialPreview = buildPartialToolCallPreview({
                    toolCallId,
                    toolName: toolCallName,
                    toolArgs: toolCallArgs,
                    existingToolCall: existingInlineToolCall,
                  });
                  if (existingInlineToolCall) {
                    assistantStore.updateToolCallInMessage(msgId, toolCallId, partialPreview, false);
                  } else {
                    assistantStore.addToolCallToMessage(msgId, partialPreview, false);
                  }
                }
                continue;
              }
              await textBuffer.flushNow();
              // End any active thinking part before adding tool call
              assistantStore.endThinkingPart(msgId);
              toolCallSeenThisIteration = true;
              // Keep already-streamed text visible when tools begin.
              // Tool cards are shown inline without retracting prior narration.

              // DEDUPLICATION: Check if we already have this exact tool call in this iteration
              // This prevents the AI from running the same command twice in one response
              const callArgsSignature = stableStringify(toolCallArgs);
              const isDuplicate = allToolCalls.some(
                (tc) =>
                  tc.name === toolCallName && stableStringify(tc.arguments) === callArgsSignature,
              );

              if (isDuplicate) {
                console.log("[Agent] Skipping duplicate tool call:", toolCallName, toolCallArgs);
                // Still need to add to allToolCalls for Gemini history, but mark as skipped
                const skipResult = {
                  id: toolCallId,
                  name: toolCallName,
                  result: {
                    success: true,
                    output: "[Duplicate tool call skipped - already executed in this response]",
                  },
                };
                immediateResults.push(skipResult);
                allToolCalls.push({
                  id: toolCallId,
                  name: toolCallName,
                  arguments: toolCallArgs,
                  thoughtSignature: toolCallThoughtSignature,
                });
                // Show in UI as completed (skipped)
                const skippedToolCall: ToolCall = {
                  id: toolCallId,
                  name: toolCallName,
                  arguments: toolCallArgs,
                  status: "completed",
                  output: "[Duplicate - skipped]",
                  endTime: Date.now(),
                };
                if (toolCallName !== "attempt_completion") {
                  if (existingInlineToolCall) {
                    assistantStore.updateToolCallInMessage(msgId, toolCallId, skippedToolCall);
                  } else {
                    assistantStore.addToolCallToMessage(msgId, skippedToolCall);
                  }
                  await deps.publishNativeToolPatch(conversationId, msgId, toolCallId, {
                    status: skippedToolCall.status,
                    output: skippedToolCall.output,
                  });
                }
                continue;
              }

              const validation = validateTool(
                toolCallName,
                toolCallArgs,
                assistantStore.currentMode,
              );
              const capabilities = getToolCapabilities(toolCallName);
              const isPlanModeViolation =
                isPlanMode &&
                (isTerminalToolName(toolCallName) ||
                  (capabilities.isMutating && toolCallName !== "write_plan_file"));
              const effectiveValidationError = isPlanModeViolation
                ? `Tool "${toolCallName}" is not allowed in plan mode. In plan mode, use READ tools and optionally "write_plan_file" only.`
                : (validation.error ?? "Invalid tool call");
              const status: ToolCall["status"] =
                validation.valid && !isPlanModeViolation ? "pending" : "failed";
              const isAutoApproved =
                validation.valid &&
                !isPlanModeViolation &&
                validation.requiresApproval &&
                assistantStore.autoApproveAllTools;
              const toolCall: ToolCall = {
                id: toolCallId,
                name: toolCallName,
                arguments: toolCallArgs,
                status,
                requiresApproval: validation.requiresApproval,
                reviewStatus: isAutoApproved
                  ? "accepted"
                  : validation.requiresApproval
                    ? "pending"
                    : undefined,
                meta: {
                  ...(isAutoApproved ? { autoApproved: true } : {}),
                  partialToolCall: false,
                },
                thoughtSignature: toolCallThoughtSignature,
                error:
                  validation.valid && !isPlanModeViolation
                    ? undefined
                    : effectiveValidationError,
                endTime: validation.valid && !isPlanModeViolation ? undefined : Date.now(),
              };

              if (!isInternalCompletionTool && !existingInlineToolCall) {
                assistantStore.addToolCallToMessage(msgId, toolCall);
                await deps.publishNativeAssistantEvent(
                  conversationId,
                  "tool_call_added",
                  undefined,
                  {
                    toolCall: {
                      messageId: msgId,
                      ...(toolCall as unknown as Record<string, unknown>),
                    },
                  },
                );
              } else if (!isInternalCompletionTool && existingInlineToolCall) {
                assistantStore.updateToolCallInMessage(msgId, toolCallId, toolCall);
                await deps.publishNativeToolPatch(conversationId, msgId, toolCallId, {
                  status: toolCall.status,
                  error: toolCall.error,
                  meta: (toolCall.meta as Record<string, unknown> | undefined) ?? undefined,
                });
              }

              // Track every tool call (valid or invalid) so we can always attach a tool result
              // back to the model and keep Gemini's function-calling history consistent.
              allToolCalls.push({
                id: toolCallId,
                name: toolCallName,
                arguments: toolCallArgs,
                thoughtSignature: toolCallThoughtSignature,
              });

              if (!validation.valid || isPlanModeViolation) {
                loopLog("warn", "tool_blocked_or_invalid", {
                  toolName: toolCallName,
                  toolCallId,
                  isPlanModeViolation,
                  validationError: validation.error ?? null,
                  effectiveValidationError,
                });
                if (isPlanModeViolation) {
                  hadPlanModeViolationThisIteration = true;
                }
                // Feed an error tool result back to the model so the conversation stays consistent.
                immediateResults.push({
                  id: toolCallId,
                  name: toolCallName,
                  result: {
                    success: false,
                    error: effectiveValidationError ?? "Invalid tool call",
                  },
                });
                if (!isInternalCompletionTool) {
                  await deps.publishNativeToolPatch(conversationId, msgId, toolCallId, {
                    status: "failed",
                    error: effectiveValidationError ?? "Invalid tool call",
                  });
                }

                // CRITICAL: If a file-modifying tool fails validation, mark it so we can skip
                // running subsequent tools that might depend on it (like eslint after write_file)
                const isFileModifyingTool = isFileMutatingTool(toolCallName);

                if (isFileModifyingTool) {
                  // Set a flag to skip running other tools in this batch
                  // This prevents running eslint when write_file failed
                  fileModifyFailed = true;
                }

                continue;
              }

              const repetitionCheck = repetitionDetector.recordAndShouldBlock(
                toolCallName,
                toolCallArgs,
              );
              if (repetitionCheck.blocked) {
                immediateResults.push({
                  id: toolCallId,
                  name: toolCallName,
                  result: {
                    success: false,
                    error: `Blocked repetitive tool call signature after ${repetitionCheck.count} attempts in this turn.`,
                    warnings: ["repetition_blocked"],
                    meta: {
                      signature: repetitionCheck.signature,
                      threshold: repetitionCheck.threshold,
                      count: repetitionCheck.count,
                      code: "REPETITION_BLOCKED",
                    },
                  },
                });
                assistantStore.updateToolCallInMessage(msgId, toolCallId, {
                  status: "failed",
                  error: `Blocked repetitive call (${repetitionCheck.count} > ${repetitionCheck.threshold}).`,
                  endTime: Date.now(),
                });
                await deps.publishNativeToolPatch(conversationId, msgId, toolCallId, {
                  status: "failed",
                  error: `Blocked repetitive call (${repetitionCheck.count} > ${repetitionCheck.threshold}).`,
                });
                assistantStore.addToolMessage({
                  id: `repetition_block_${Date.now()}`,
                  name: "_system_strategy_switch",
                  arguments: {},
                  status: "completed",
                  output:
                    "Repeated tool signature detected and blocked. Choose a different strategy (different tool or different arguments).",
                });
                agentTelemetryStore.record({
                  type: "agent.tool.failure_signature",
                  timestamp: Date.now(),
                  toolName: toolCallName,
                  signature: repetitionCheck.signature,
                });
                continue;
              }

              pendingToolCalls.push({
                id: toolCallId,
                name: toolCallName,
                arguments: toolCallArgs,
                thoughtSignature: toolCallThoughtSignature,
              });

              // Check if a file-modifying tool already failed - if so, skip running this tool
              // and add it to immediate results with a skip message
              if (fileModifyFailed) {
                assistantStore.updateToolCallInMessage(msgId, toolCallId, {
                  status: "failed",
                  error:
                    "Skipped: A previous file operation failed. Fix that first before running this tool.",
                  endTime: Date.now(),
                });
                await deps.publishNativeToolPatch(conversationId, msgId, toolCallId, {
                  status: "failed",
                  error:
                    "Skipped: A previous file operation failed. Fix that first before running this tool.",
                });
                immediateResults.push({
                  id: toolCallId,
                  name: toolCallName,
                  result: {
                    success: false,
                    error:
                      "Skipped: A previous file operation failed. Fix that first before running this tool.",
                  },
                });
                continue;
              }

              if (!validation.requiresApproval && validation.valid) {
                const capabilities = getToolCapabilities(toolCallName);
                const isFileEdit = isFileMutatingTool(toolCallName);
                const isTerminalCommand =
                  isTerminalToolName(toolCallName) && capabilities.requiresApproval;
                const rawFilePath = isFileEdit ? String(toolCallArgs.path || "") : "";
                const filePath =
                  isFileEdit && rawFilePath
                    ? toolCallName === "delete_file"
                      ? "__delete_file_serial__"
                      : normalizeQueueKey(rawFilePath)
                    : null;

                // Group file edits by path for sequential execution
                if (isFileEdit && filePath) {
                  if (!fileEditQueues.has(filePath)) {
                    fileEditQueues.set(filePath, []);
                  }
                  const queue = fileEditQueues.get(filePath)!;
                  const queueIndex = queue.length + 1;
                  queue.push({
                    id: toolCallId,
                    name: toolCallName,
                    args: toolCallArgs,
                    queueIndex,
                  });
                  assistantStore.updateToolCallInMessage(msgId, toolCallId, {
                    meta: {
                      editPhase: "queued",
                      queueIndex,
                      planningPhase: "edit",
                    },
                  });
                  await deps.publishNativeToolPatch(conversationId, msgId, toolCallId, {
                    meta: {
                      editPhase: "queued",
                      queueIndex,
                      planningPhase: "edit",
                    },
                  });
                } else if (isTerminalCommand) {
                  // Terminal commands are handled by the approval flow (toolsNeedingApproval)
                  // Don't add them to fileEditQueues to avoid duplicate execution
                  // They will be processed sequentially in the approval section below
                } else {
                  // Non-file-edit, non-terminal tools are queued and executed in phases.
                  // Diagnostics/LSP tools are deferred until file edits complete.
                  const runAfterFileEdits = shouldRunAfterFileEdits(toolCallName);

                  queuedNonFileTools.push({
                    id: toolCallId,
                    name: toolCallName,
                    args: toolCallArgs,
                    runAfterFileEdits,
                  });

                  if (runAfterFileEdits) {
                    assistantStore.updateToolCallInMessage(msgId, toolCallId, {
                      meta: {
                        executionPhase: "after_file_edits",
                        planningPhase: "verify",
                      },
                    });
                    await deps.publishNativeToolPatch(conversationId, msgId, toolCallId, {
                      meta: {
                        executionPhase: "after_file_edits",
                        planningPhase: "verify",
                      },
                    });
                  } else {
                    assistantStore.updateToolCallInMessage(msgId, toolCallId, {
                      meta: {
                        executionPhase: "immediate",
                        planningPhase: classifyPlanningPhase(toolCallName),
                      },
                    });
                    await deps.publishNativeToolPatch(conversationId, msgId, toolCallId, {
                      meta: {
                        executionPhase: "immediate",
                        planningPhase: classifyPlanningPhase(toolCallName),
                      },
                    });
                  }
                }
              }
            }

            if (chunk.type === "error") {
              await textBuffer.flushNow();
              throw new Error(chunk.error || "Unknown streaming error");
            }
          }

          if (finalizedAtToolBoundary) {
            await textBuffer.flushNow();
          }

          await textBuffer.close();

          // Finalize thinking state when streaming ends
          // End any active inline thinking part
          assistantStore.finalizeThinking(msgId);
          if (iterationThinking) {
            // Also update legacy thinking field for backward compatibility
            assistantStore.updateAssistantThinking(msgId, iterationThinking, false);
          }

          // Reset repetition guard per iteration boundary so we don't over-trigger
          // on unrelated chunks in later iterations.
          streamGuards.resetIteration();

          hasQueuedFileEdits = fileEditQueues.size > 0;
          loopLog("info", "tool_stream_pass_complete", {
            totalToolCalls: allToolCalls.length,
            pendingToolCalls: pendingToolCalls.length,
            immediateResultCount: immediateResults.length,
            fileEditQueueCount: fileEditQueues.size,
            nonFileQueueCount: queuedNonFileTools.length,
          });
          immediateNonFileTools = hasQueuedFileEdits
            ? queuedNonFileTools.filter((t) => !t.runAfterFileEdits)
            : queuedNonFileTools;
          deferredNonFileTools = hasQueuedFileEdits
            ? queuedNonFileTools.filter((t) => t.runAfterFileEdits)
            : [];
          const fallbackPlanningPhaseRank = (toolName: string): number => {
            const phase = classifyPlanningPhase(toolName);
            if (phase === "discover") return 0;
            if (phase === "read") return 1;
            if (phase === "other") return 2;
            if (phase === "verify") return 3;
            return 4;
          };
          orderedImmediateNonFileTools = [...immediateNonFileTools].sort(
            (a, b) => fallbackPlanningPhaseRank(a.name) - fallbackPlanningPhaseRank(b.name),
          );
          schedulingDecision = agentRuntime.evaluateToolScheduling({
            pendingApprovalCount: pendingToolCalls.length,
            hasQueuedFileEdits,
            defaultExecuteInOrder: false,
          });

          if (
            pendingToolCalls.length > 0 ||
            immediateNonFileTools.length > 0 ||
            deferredNonFileTools.length > 0 ||
            hasQueuedFileEdits
          ) {
            const waitingToolDecision = await agentRuntime.buildRuntimeRequest({
              operation: "waiting_tool",
              snapshot: assistantStore.getRuntimeSnapshot(conversationId),
              payload: {
                requestedLoopState: "waiting_tool",
                requestedLoopMeta: {
                  iteration,
                  pendingToolCalls: pendingToolCalls.length,
                  pendingToolIds: pendingToolCalls.map((toolCall) => toolCall.id),
                  eagerToolCount: immediateNonFileTools.length,
                  deferredToolCount: deferredNonFileTools.length,
                  eagerTools: immediateNonFileTools.map((tool) => ({
                    id: tool.id,
                    name: tool.name,
                  })),
                  deferredTools: deferredNonFileTools.map((tool) => ({
                    id: tool.id,
                    name: tool.name,
                  })),
                  fileQueues: fileEditQueues.size,
                  fileEditQueues: Array.from(fileEditQueues.entries()).map(([queueKey, queue]) => ({
                    queueKey,
                    toolIds: queue.map((tool) => tool.id),
                  })),
                },
              },
            });
            schedulingDecision = agentRuntime.evaluateToolScheduling({
              pendingApprovalCount: pendingToolCalls.length,
              hasQueuedFileEdits,
              defaultExecuteInOrder: false,
              nativeDecision: waitingToolDecision,
            });
            deps.applyNativeRuntimeDecision(waitingToolDecision, "waiting_tool", {
              iteration,
              pendingToolCalls: pendingToolCalls.length,
              eagerTools: immediateNonFileTools.length,
              deferredTools: deferredNonFileTools.length,
              fileQueues: fileEditQueues.size,
              executeInOrder: schedulingDecision.executeInOrder,
              deferUntilFileEditsComplete: schedulingDecision.deferUntilFileEditsComplete,
              approvalRequired: schedulingDecision.approvalRequired,
            });
            await deps.publishNativeAssistantEvent(
              conversationId,
              "loop_state_changed",
              "waiting_tool",
              {
                loopMeta: {
                  iteration,
                  pendingToolCalls: pendingToolCalls.length,
                  eagerTools: immediateNonFileTools.length,
                  deferredTools: deferredNonFileTools.length,
                  fileQueues: fileEditQueues.size,
                  executeInOrder: schedulingDecision.executeInOrder,
                  deferUntilFileEditsComplete: schedulingDecision.deferUntilFileEditsComplete,
                  approvalRequired: schedulingDecision.approvalRequired,
                },
              },
            );
          }
        } finally {
          clearInterval(stallWatchdog);
        }

        if (stalledAbortReason) {
          throw new Error(stalledAbortReason);
        }

        const runQueuedNonFileStage = (
          toolsToRun: QueuedNonFileTool[],
        ): Promise<Array<{ id: string; name: string; result: ToolResult }>> =>
          executeQueuedNonFileTools(toolsToRun, {
            executeToolCall,
            signal: controller.signal,
            toolRunScope,
            getToolIdempotencyKey,
            updateToolCallInMessage: assistantStore.updateToolCallInMessage.bind(assistantStore),
            messageId: msgId,
            getFailureSignature,
            trackToolOutcome,
            onFailureSignature: (signature) => {
              const count = (failureSignatureCounts.get(signature) ?? 0) + 1;
              failureSignatureCounts.set(signature, count);
            },
            publishToolPatch: (toolId, patch) =>
              deps.publishNativeToolPatch(conversationId, msgId, toolId, patch),
            getCurrentToolCallState: (messageId, toolId) =>
              assistantStore
                .getConversationMessages(conversationId)
                .find((message) => message.id === messageId)
                ?.inlineToolCalls?.find((toolCall) => toolCall.id === toolId),
          });
        const fileEditTasks = Array.from(fileEditQueues.entries());
        const stageResults = await executeNativeDispatchPlan({
          schedulingDecision,
          eagerTools: orderedImmediateNonFileTools,
          deferredTools: deferredNonFileTools,
          fileEditTasks,
          authority: deps.createNativeDispatchAuthority(conversationId),
          runQueuedNonFileStage,
          runFileEditStage: (queuedFileEditTasks, concurrency) =>
            executeFileEditQueues(queuedFileEditTasks, concurrency, {
              executeToolCall,
              signal: controller.signal,
              toolRunScope,
              getToolIdempotencyKey,
              updateToolCallInMessage: assistantStore.updateToolCallInMessage.bind(assistantStore),
              messageId: msgId,
              getFailureSignature,
              trackToolOutcome,
              onFailureSignature: (signature) => {
                const count = (failureSignatureCounts.get(signature) ?? 0) + 1;
                failureSignatureCounts.set(signature, count);
              },
              publishToolPatch: (toolId, patch) =>
                deps.publishNativeToolPatch(conversationId, msgId, toolId, patch),
              mapWithConcurrency,
            }),
        });
        const fileEditResults = stageResults.filter((entry) =>
          fileEditTasks.some(([, tools]) => tools.some((tool) => tool.id === entry.id)),
        );
        const malformedPatchFailure = fileEditResults.find((entry) => {
          const errorText = String(entry.result.error ?? entry.result.output ?? "").toLowerCase();
          return !entry.result.success && errorText.includes("malformed patch");
        });
        if (malformedPatchFailure) {
          assistantStore.addToolMessage({
            id: `patch_contract_${Date.now()}`,
            name: "_system_patch_contract",
            arguments: {},
            status: "completed",
            output:
              'A file edit failed because the patch format was invalid. Rebuild the next patch using Codex grammar: "*** Begin Patch", one "*** Update File" or "*** Add File" header, an "@@" line before the first patch body lines, and only " ", "-", "+" line prefixes.',
          });
        }

        // Combine all native-dispatched tool results in the order chosen by the runtime.
        const allEagerResults = [...stageResults];

        if (
          pendingToolCalls.length === 0 &&
          allEagerResults.length === 0 &&
          immediateResults.length === 0
        ) {
          fullContent = mergeIterationIntoFullContent(fullContent, iterationContent);
          const noToolOutcome = resolveNoToolOutcome({
            iteration,
            iterationThinking,
            iterationContent,
            hadPlanModeViolationThisIteration,
            maxEmptyResponses: MAX_EMPTY_RESPONSES,
            state: {
              consecutiveEmptyResponses,
              justProcessedToolResults,
              planModeViolationNudgeCount,
              fullContent,
              repeatedFailureHint,
            },
            isAgentMode,
            completionNudgeCount,
            maxCompletionNudges: MAX_COMPLETION_NUDGES,
            provider: aiSettingsStore.selectedProvider,
            modelId,
            logOutput: (message: string) => logOutput("Volt", message),
            addToolMessage: (payload) => assistantStore.addToolMessage(payload),
            updateAssistantMessage: (content: string) =>
              assistantStore.updateAssistantMessage(msgId, content, false),
            setMessageContent: (content: string) =>
              assistantStore.setMessageContent(msgId, content, true),
          });

          consecutiveEmptyResponses = noToolOutcome.state.consecutiveEmptyResponses;
          justProcessedToolResults = noToolOutcome.state.justProcessedToolResults;
          planModeViolationNudgeCount = noToolOutcome.state.planModeViolationNudgeCount;
          fullContent = noToolOutcome.state.fullContent;
          repeatedFailureHint = noToolOutcome.state.repeatedFailureHint ?? null;
          completionNudgeCount = noToolOutcome.completionNudgeCount;

          if (noToolOutcome.action === "continue") {
            loopLog("info", "no_tool_outcome_continue", {
              reason: "handler_requested_continue",
            });
            continue;
          }
          if (noToolOutcome.terminalOutcome) {
            applyLoopTerminalOutcome(msgId, noToolOutcome.terminalOutcome, {
              updateAssistantMessage: assistantStore.updateAssistantMessage.bind(assistantStore),
              markAssistantMessageStreamState:
                assistantStore.markAssistantMessageStreamState.bind(assistantStore),
              setAgentLoopState: assistantStore.setAgentLoopState.bind(assistantStore),
              finalizeOutcome,
              loopLog,
              showToast,
            });
            await deps.publishNativeAssistantEvent(
              conversationId,
              noToolOutcome.terminalOutcome.status === "completed"
                ? "run_completed"
                : noToolOutcome.terminalOutcome.status === "cancelled"
                  ? "run_cancelled"
                  : "run_failed",
              noToolOutcome.terminalOutcome.status,
              {
                loopMeta: {
                  reason: noToolOutcome.terminalOutcome.reason,
                  ...(noToolOutcome.terminalOutcome.loopStateMeta ?? {}),
                },
                messagePatch: {
                  messageId: msgId,
                  content: noToolOutcome.terminalOutcome.assistantMessage,
                  streamState: noToolOutcome.terminalOutcome.streamState,
                  streamIssue: noToolOutcome.terminalOutcome.streamIssue,
                },
              },
            );
          }
          return;
        }

        // Reset counters since we have tool calls to process
        justProcessedToolResults = false;
        consecutiveEmptyResponses = 0; // Reset on successful tool calls
        recoveryRetryCount = 0;

        const toolResults: Array<{
          id: string;
          name: string;
          result: ToolResult;
        }> = [...allEagerResults, ...immediateResults];
        if (toolResults.length > 0) {
          lastProgressAt = Date.now();
        }

        const uniqueResults = new SvelteMap<
          string,
          {
            id: string;
            name: string;
            result: ToolResult;
          }
        >();
        for (const entry of toolResults) {
          uniqueResults.set(entry.id, entry);
        }

        for (const toolCall of allToolCalls) {
          if (uniqueResults.has(toolCall.id)) continue;
          uniqueResults.set(toolCall.id, {
            id: toolCall.id,
            name: toolCall.name,
            result: {
              success: false,
              error: "Tool call did not produce a response (contract violation).",
              warnings: ["synthetic_response"],
              meta: {
                code: "TOOL_RESPONSE_MISSING",
              },
            },
          });
        }

        const normalizedToolResults = allToolCalls
          .map((toolCall) => uniqueResults.get(toolCall.id))
          .filter(
            (
              entry,
            ): entry is {
              id: string;
              name: string;
              result: ToolResult;
            } => Boolean(entry),
          );
        loopLog("info", "tool_results_normalized", {
          allToolCalls: allToolCalls.length,
          normalizedResults: normalizedToolResults.length,
        });

        const completionCandidate = normalizedToolResults.find(
          (entry) => entry.name === "attempt_completion" && entry.result.success,
        );
        if (
          completionCandidate &&
          (touchedFilePaths.size > 0 || structuralMutationPaths.size > 0)
        ) {
          const touchedPaths = Array.from(
            new Set([...touchedFilePaths, ...structuralMutationPaths]),
          );
          try {
            const diagnosticsGateResult = await executeToolCall(
              "get_diagnostics",
              { paths: touchedPaths },
              {
                signal: controller.signal,
                idempotencyKey: getToolIdempotencyKey(
                  toolRunScope,
                  `completion_gate_${completionCandidate.id}`,
                  "get_diagnostics",
                  { paths: touchedPaths },
                ),
              },
            );
            const diagMeta = (diagnosticsGateResult.meta ?? {}) as Record<string, unknown>;
            const errorCount = Number(diagMeta.errorCount ?? 0);
            const freshness = (diagMeta.freshness ?? {}) as {
              status?: string;
              staleSources?: string[];
              isUpdating?: boolean;
            };
            const structuralMutationSummary = Array.from(structuralMutationPaths);
            const gateDecision = agentRuntime.evaluateCompletion({
              errorCount,
              freshness,
              structuralMutationPaths: structuralMutationSummary,
              touchedPaths,
            });
            const gateCode =
              typeof gateDecision.meta?.code === "string" ? gateDecision.meta.code : undefined;
            if (gateDecision.shouldBlock && gateDecision.message && gateCode) {
              const gateMessage = gateDecision.message;
              trackingState.lastFailureClass = "diagnostics_blocked";
              trackingState.openBlocker = gateMessage;
              pendingVerificationState.add("diagnostics");
              completionCandidate.result = {
                ...completionCandidate.result,
                success: false,
                error: gateMessage,
                meta: {
                  ...(completionCandidate.result.meta ?? {}),
                  code: gateCode,
                  errorCount,
                  touchedPaths,
                  structuralMutationPaths: structuralMutationSummary,
                  freshness,
                },
              };
              assistantStore.updateToolCallInMessage(msgId, completionCandidate.id, {
                status: "failed",
                error: gateMessage,
                endTime: Date.now(),
                meta: gateDecision.meta,
              });
              assistantStore.addToolMessage({
                id: `completion_gate_${Date.now()}`,
                name: "_system_completion_gate",
                arguments: {},
                status: "completed",
                output: (
                  gateDecision.meta?.verificationPlan as
                    | { requiresFollowUp?: boolean; recommendedTools?: string[] }
                    | undefined
                )?.requiresFollowUp
                  ? `${gateDecision.output ?? gateMessage}\n\nRecommended follow-up: ${((gateDecision.meta?.verificationPlan as { recommendedTools?: string[] } | undefined)?.recommendedTools ?? []).join(", ")}`
                  : (gateDecision.output ?? gateMessage),
              });
            }
          } catch {
            // If diagnostics collection fails, keep current completion behavior.
          }
        }
        const toolPassAnalysis = agentRuntime.analyzeToolPass({
          allToolCalls,
          normalizedToolResults,
          isFileMutatingTool,
        });
        const nextFullContent = mergeIterationIntoFullContent(fullContent, iterationContent);

        if (completionCandidate) {
          if (
            toolPassAnalysis.editFailureDecision.shouldBlock &&
            toolPassAnalysis.editFailureDecision.message
          ) {
            const gateMessage = toolPassAnalysis.editFailureDecision.message;
            completionCandidate.result = {
              ...completionCandidate.result,
              success: false,
              error: gateMessage,
              meta: {
                ...(completionCandidate.result.meta ?? {}),
                ...(toolPassAnalysis.editFailureDecision.meta ?? {}),
              },
            };
            assistantStore.updateToolCallInMessage(msgId, completionCandidate.id, {
              status: "failed",
              error: gateMessage,
              endTime: Date.now(),
              meta: toolPassAnalysis.editFailureDecision.meta,
            });
            assistantStore.addToolMessage({
              id: `completion_edit_gate_${Date.now()}`,
              name: "_system_completion_gate",
              arguments: {},
              status: "completed",
              output: toolPassAnalysis.editFailureDecision.output ?? gateMessage,
            });
          }
        }

        const eagerIds = new Set(allEagerResults.map((r) => r.id));
        const nativePendingApprovalToolIds = new Set(
          schedulingDecision.pendingApprovalToolIds ??
            pendingToolCalls.map((toolCall) => toolCall.id),
        );
        const toolsNeedingApproval = pendingToolCalls.filter(
          (tc) => nativePendingApprovalToolIds.has(tc.id) && !eagerIds.has(tc.id),
        );

        if (toolsNeedingApproval.length > 0) {
          await assistantRunRegisterApprovals({
            conversationId,
            runId: deps.getNativeRunId(conversationId),
            messageId: msgId,
            toolIds: toolsNeedingApproval.map((toolCall) => toolCall.id),
          })
            .then((response) => {
              deps.syncNativeSnapshot(conversationId, response.snapshot);
            })
            .catch((error) => {
              console.warn("[AssistantPanel] Failed to register native approvals", {
                conversationId,
                error,
              });
            });
          if (assistantStore.autoApproveAllTools) {
            const approvalUpdates = await Promise.allSettled(
              toolsNeedingApproval.map((toolCall) =>
                assistantRunUpdateApproval({
                  conversationId,
                  runId: deps.getNativeRunId(conversationId),
                  messageId: msgId,
                  toolCallId: toolCall.id,
                  reviewStatus: "accepted",
                  status: "pending",
                }),
              ),
            );
            for (const update of approvalUpdates) {
              if (update.status === "fulfilled") {
                deps.syncNativeSnapshot(conversationId, update.value.snapshot);
                continue;
              }
              console.warn("[AssistantPanel] Failed to auto-approve native tool", {
                conversationId,
                error: update.reason,
              });
            }
          }
          if (!assistantStore.autoApproveAllTools) {
            await deps.publishNativeAssistantEvent(
              conversationId,
              "approval_requested",
              "waiting_approval",
              {
                loopMeta: {
                  iteration,
                  pendingApprovals: toolsNeedingApproval.length,
                },
              },
            );
            deps.applyNativeRuntimeDecision(
              await agentRuntime.buildRuntimeRequest({
                operation: "waiting_approval",
                snapshot: assistantStore.getRuntimeSnapshot(conversationId),
                payload: {
                  requestedLoopState: "waiting_approval",
                  requestedLoopMeta: {
                    iteration,
                    pendingApprovals: toolsNeedingApproval.length,
                  },
                },
              }),
              "waiting_approval",
              {
                iteration,
                pendingApprovals: toolsNeedingApproval.length,
              },
            );
          }

          const approvalsProcessed = await processToolsNeedingApproval(
            msgId,
            toolsNeedingApproval,
            normalizedToolResults,
            {
              isTerminalToolName,
              getToolCapabilities,
              waitForToolApprovals: deps.waitForNativeToolApprovals,
              waitForToolCompletion,
              applyNativeDecision: (decision) =>
                deps.applyNativeRuntimeDecision(decision as NativeAgentRuntimeCommandResult | null),
              buildNativeDecision: async ({ operation, payload }) =>
                agentRuntime.buildRuntimeRequest({
                  operation,
                  snapshot: assistantStore.getRuntimeSnapshot(conversationId),
                  payload,
                }),
              getMessages: () => assistantStore.getConversationMessages(conversationId),
              updateToolCallInMessage: assistantStore.updateToolCallInMessage.bind(assistantStore),
              executeToolCall,
              getToolIdempotencyKey,
              toolRunScope,
              signal: controller.signal,
              getFailureSignature,
              trackToolOutcome,
              onFailureSignature: (signature) => {
                const count = (failureSignatureCounts.get(signature) ?? 0) + 1;
                failureSignatureCounts.set(signature, count);
              },
              publishToolPatch: (toolId, patch) =>
                deps.publishNativeToolPatch(conversationId, msgId, toolId, patch),
              resolveApprovalAuthority: (_messageId, toolIds) =>
                deps.resolveNativeApprovalAuthority(conversationId, toolIds),
              getCurrentToolCallState: (messageId, toolId) =>
                assistantStore
                  .getConversationMessages(conversationId)
                  .find((message) => message.id === messageId)
                  ?.inlineToolCalls?.find((toolCall) => toolCall.id === toolId),
            },
          );
          const nativeApprovalAuthority = await deps.resolveNativeApprovalAuthority(
            conversationId,
            toolsNeedingApproval.map((toolCall) => toolCall.id),
          );
          const approvalDecision = nativeApprovalAuthority
            ? nativeApprovalAuthority.shouldAbort
              ? {
                  shouldAbort: true,
                  reason: nativeApprovalAuthority.reason ?? "approval_flow_incomplete",
                  streamState: "failed" as const,
                  streamIssue: "Approval flow incomplete",
                  resolvedState: "failed" as const,
                }
              : {
                  shouldAbort: false,
                  resumeState: "running" as const,
                  resolvedState: "running" as const,
                  resumeMeta: {
                    resumedAfterApproval: true,
                    approvedToolIds: nativeApprovalAuthority.approvedToolIds,
                    deniedToolIds: nativeApprovalAuthority.deniedToolIds,
                  },
                }
            : agentRuntime.evaluateApprovalFlow(approvalsProcessed);
          if (approvalDecision.shouldAbort && approvalDecision.reason) {
            assistantStore.markAssistantMessageStreamState(
              msgId,
              approvalDecision.streamState ?? "failed",
              approvalDecision.streamIssue ?? "Approval flow incomplete",
            );
            deps.applyNativeRuntimeDecision(
              await agentRuntime.buildRuntimeRequest({
                operation: "approval_incomplete",
                snapshot: assistantStore.getRuntimeSnapshot(conversationId),
                payload: {
                  requestedLoopState: "failed",
                  requestedLoopMeta: {
                    iteration,
                    reason: approvalDecision.reason,
                  },
                },
              }),
              "failed",
              {
                iteration,
                reason: approvalDecision.reason,
              },
            );
            finalizeOutcome("failed", approvalDecision.reason, {
              iteration,
            });
            await deps.publishNativeAssistantEvent(conversationId, "run_failed", "failed", {
              loopMeta: {
                iteration,
                reason: approvalDecision.reason,
              },
              messagePatch: {
                messageId: msgId,
                streamState: approvalDecision.streamState ?? "failed",
                streamIssue: approvalDecision.streamIssue ?? "Approval flow incomplete",
              },
            });
            return;
          }
          await assistantRunResumeApproval({
            conversationId,
            runId: deps.getNativeRunId(conversationId),
            reason: "approval_resumed",
            meta: {
              iteration,
              ...(approvalDecision.resumeMeta ?? {}),
            },
          })
            .then((response) => {
              deps.syncNativeSnapshot(conversationId, response.snapshot);
            })
            .catch((error) => {
              console.warn("[AssistantPanel] Native assistant approval resume failed", {
                conversationId,
                error,
              });
            });
          deps.applyNativeRuntimeDecision(
            await agentRuntime.buildRuntimeRequest({
              operation: "approval_resumed",
              snapshot: assistantStore.getRuntimeSnapshot(conversationId),
              payload: {
                requestedLoopState: approvalDecision.resumeState ?? "running",
                requestedLoopMeta: {
                  iteration,
                  ...(approvalDecision.resumeMeta ?? {}),
                },
              },
            }),
            approvalDecision.resumeState ?? "running",
            {
              iteration,
              ...(approvalDecision.resumeMeta ?? {}),
            },
          );
        }

        const completionResult = toolPassAnalysis.completionResult;
        const visibleToolCalls = toolPassAnalysis.visibleToolCalls;
        const visibleToolResults = toolPassAnalysis.visibleToolResults;

        // Add ALL results to conversation as special tool messages
        addToolResultsToConversation(
          visibleToolCalls,
          visibleToolResults,
          assistantStore.addToolMessage.bind(assistantStore),
        );

        for (const [signature, count] of failureSignatureCounts.entries()) {
          if (count < 3 || failureNudgedSignatures.has(signature)) continue;
          failureNudgedSignatures.add(signature);
          const [toolName = "", maybePath = ""] = signature.split(":", 3);
          const classified = classifyRecoveryIssue(toolName, maybePath ? { path: maybePath } : {}, {
            success: false,
            error: signature,
          });
          repeatedFailureHint = buildRecoveryHint(classified ?? "generic", {
            toolName,
            path: maybePath || undefined,
          });
          assistantStore.addToolMessage({
            id: `strategy_switch_${Date.now()}`,
            name: "_system_strategy_switch",
            arguments: {},
            status: "completed",
            output:
              "The same failure repeated multiple times. Stop repeating the same call. Inspect current outputs/files, choose a different strategy, then retry.",
          });
        }

        const completionDecision = agentRuntime.evaluateCompletionAcceptance({
          completionResult,
          allToolCalls,
          fullContent: nextFullContent,
          allowNaturalCompletion: !toolCallSeenThisIteration || contentAfterToolCallSeen,
        });
        loopLog("info", "completion_decision_evaluated", {
          hasCompletionTool: Boolean(completionDecision.completionToolId),
          shouldComplete: completionDecision.shouldComplete,
          reason: completionDecision.reason ?? null,
          toolCallSeenThisIteration,
          contentAfterToolCallSeen,
          nextFullContentLength: nextFullContent.length,
          iterationContentLength: iterationContent.length,
        });
        if (completionDecision.shouldComplete && completionDecision.completionToolId) {
          await deps.publishNativeAssistantEvent(
            conversationId,
            "loop_state_changed",
            "completing",
            {
              loopMeta: {
                iteration,
                completionToolId: completionDecision.completionToolId,
              },
            },
          );
          deps.applyNativeRuntimeDecision(
            await agentRuntime.buildRuntimeRequest({
              operation: "completion_pending",
              snapshot: assistantStore.getRuntimeSnapshot(conversationId),
              payload: {
                requestedLoopState: "completing",
                requestedLoopMeta: {
                  iteration,
                  completionToolId: completionDecision.completionToolId,
                },
              },
            }),
            "completing",
            {
              iteration,
              completionToolId: completionDecision.completionToolId,
            },
          );
          const completionText = completionDecision.completionText ?? "";
          if (completionText) {
            fullContent = completionText;
            assistantStore.updateAssistantMessage(msgId, fullContent, false);
          }
          assistantStore.markAssistantMessageStreamState(msgId, "completed");
          deps.applyNativeRuntimeDecision(
            await agentRuntime.buildRuntimeRequest({
              operation: "loop_completed",
              snapshot: assistantStore.getRuntimeSnapshot(conversationId),
              payload: {
                requestedLoopState: "completed",
                requestedLoopMeta: {
                  iteration,
                  completionToolId: completionDecision.completionToolId,
                },
              },
            }),
            "completed",
            {
              iteration,
              completionToolId: completionDecision.completionToolId,
            },
          );
          await deps.publishNativeAssistantEvent(conversationId, "run_completed", "completed", {
            loopMeta: {
              iteration,
              completionToolId: completionDecision.completionToolId,
            },
            messagePatch: {
              messageId: msgId,
              content: completionText || fullContent,
              streamState: "completed",
            },
          });
          finalizeOutcome("completed", completionDecision.reason ?? "natural_completion", {
            iteration,
            completionToolId: completionDecision.completionToolId,
          });
          loopLog("info", "loop_completed", {
            reason: completionDecision.reason ?? "natural_completion",
            completionToolId: completionDecision.completionToolId,
          });
          logOutput(
            "Volt",
            `Agent: Completion accepted at iteration ${iteration}.`,
          );
          return;
        }
        if (
          completionDecision.shouldComplete &&
          completionDecision.reason === "natural_completion"
        ) {
          fullContent = nextFullContent;
          assistantStore.updateAssistantMessage(msgId, fullContent, false);
          assistantStore.markAssistantMessageStreamState(msgId, "completed");
          deps.applyNativeRuntimeDecision(
            await agentRuntime.buildRuntimeRequest({
              operation: "loop_completed",
              snapshot: assistantStore.getRuntimeSnapshot(conversationId),
              payload: {
                requestedLoopState: "completed",
                requestedLoopMeta: {
                  iteration,
                  reason: "natural_completion",
                },
              },
            }),
            "completed",
            {
              iteration,
              reason: "natural_completion",
            },
          );
          await deps.publishNativeAssistantEvent(conversationId, "run_completed", "completed", {
            loopMeta: {
              iteration,
              reason: "natural_completion",
            },
            messagePatch: {
              messageId: msgId,
              content: fullContent,
              streamState: "completed",
            },
          });
          finalizeOutcome("completed", "natural_completion", {
            iteration,
          });
          loopLog("info", "loop_completed", {
            reason: "natural_completion",
          });
          logOutput(
            "Volt",
            `Agent: Completion accepted via natural completion at iteration ${iteration}.`,
          );
          return;
        }

        if (toolCallSeenThisIteration && !contentAfterToolCallSeen && nextFullContent.trim()) {
          loopLog("info", "natural_completion_blocked_pretool_only_text", {
            reason: "pre_tool_text_only",
            nextFullContentLength: nextFullContent.length,
            iterationContentLength: iterationContent.length,
          });
        }

        // Mark that we just processed tool results - if model doesn't respond next iteration,
        // we'll prompt it to continue
        fullContent = nextFullContent;
        justProcessedToolResults = true;
      } catch (err) {
        if (controller.signal.aborted) {
          const abortIterationDecision = agentRuntime.evaluateIterationError({
            message: stalledAbortReason ?? "Streaming cancelled",
            iteration,
            maxIterations,
            recoveryRetryCount,
            maxRecoveryRetries: MAX_RECOVERY_RETRIES,
            stalledAbortReason,
            fullContent,
          });
          if (abortIterationDecision.action === "stalled") {
            assistantStore.markAssistantMessageStreamState(
              msgId,
              "failed",
              abortIterationDecision.userMessage,
            );
            deps.applyNativeRuntimeDecision(
              await agentRuntime.buildRuntimeRequest({
                operation: "loop_failed",
                snapshot: assistantStore.getRuntimeSnapshot(conversationId),
                payload: {
                  requestedLoopState: "failed",
                  requestedLoopMeta: {
                    iteration,
                    reason: abortIterationDecision.reason,
                    error: abortIterationDecision.userMessage,
                  },
                },
              }),
              "failed",
              {
                iteration,
                reason: abortIterationDecision.reason,
                error: abortIterationDecision.userMessage,
              },
            );
            finalizeOutcome("failed", abortIterationDecision.reason, {
              iteration,
              error: abortIterationDecision.userMessage,
            });
            await deps.publishNativeAssistantEvent(conversationId, "run_failed", "failed", {
              loopMeta: {
                iteration,
                reason: abortIterationDecision.reason,
                error: abortIterationDecision.userMessage,
              },
              messagePatch: {
                messageId: msgId,
                streamState: "failed",
                streamIssue: abortIterationDecision.userMessage,
              },
            });
            loopLog("error", "loop_failed", {
              reason: abortIterationDecision.reason,
              error: abortIterationDecision.userMessage,
            });
            showToast({ message: abortIterationDecision.userMessage, type: "warning" });
            return;
          }
          assistantStore.markAssistantMessageStreamState(msgId, "cancelled", "Streaming cancelled");
          deps.applyNativeRuntimeDecision(
            await agentRuntime.buildRuntimeRequest({
              operation: "loop_cancelled",
              snapshot: assistantStore.getRuntimeSnapshot(conversationId),
              payload: {
                requestedLoopState: "cancelled",
                requestedLoopMeta: {
                  iteration,
                  reason: "abort_during_iteration",
                },
              },
            }),
            "cancelled",
            {
              iteration,
              reason: "abort_during_iteration",
            },
          );
          finalizeOutcome("cancelled", "abort_during_iteration", {
            iteration,
          });
          await deps.publishNativeAssistantEvent(conversationId, "run_cancelled", "cancelled", {
            loopMeta: {
              iteration,
              reason: "abort_during_iteration",
            },
            messagePatch: {
              messageId: msgId,
              streamState: "cancelled",
              streamIssue: "Streaming cancelled",
            },
          });
          loopLog("warn", "loop_cancelled", {
            reason: "abort_during_iteration",
          });
          return;
        }
        const msg = err instanceof Error ? err.message : "Unknown error";
        loopLog("error", "iteration_exception", {
          error: msg,
        });
        const iterationErrorDecision = agentRuntime.evaluateIterationError({
          message: msg,
          iteration,
          maxIterations,
          recoveryRetryCount,
          maxRecoveryRetries: MAX_RECOVERY_RETRIES,
          stalledAbortReason: null,
          fullContent,
        });

        logOutput("Volt", `Agent Loop Error (iteration ${iteration}): ${msg}`);

        if (iterationErrorDecision.shouldRetry) {
          recoveryRetryCount++;
          logOutput(
            "Volt",
            `Retryable error detected, attempting to continue... (${recoveryRetryCount}/${MAX_RECOVERY_RETRIES})`,
          );

          // Add a system message to help model recover
          assistantStore.addToolMessage({
            id: `error_recovery_${Date.now()}`,
            name: "_system_error_recovery",
            arguments: {},
            status: "completed",
            output:
              iterationErrorDecision.recoveryNotice ??
              `A temporary error occurred: ${msg}. Please continue with your task. If you were in the middle of something, resume from where you left off.`,
          });

          // Small delay before retry
          await new Promise((resolve) =>
            setTimeout(resolve, iterationErrorDecision.retryDelayMs ?? 1000),
          );
          continue; // Continue to next iteration
        }

        // Non-retryable or exhausted retries
        assistantStore.updateAssistantMessage(msgId, iterationErrorDecision.userMessage, false);
        assistantStore.markAssistantMessageStreamState(
          msgId,
          iterationErrorDecision.isInterrupted ? "interrupted" : "failed",
          msg,
        );
        deps.applyNativeRuntimeDecision(
          await agentRuntime.buildRuntimeRequest({
            operation: "loop_failed",
            snapshot: assistantStore.getRuntimeSnapshot(conversationId),
            payload: {
              requestedLoopState: "failed",
              requestedLoopMeta: {
                iteration,
                reason: iterationErrorDecision.reason,
                error: msg,
              },
            },
          }),
          "failed",
          {
            iteration,
            reason: iterationErrorDecision.reason,
            error: msg,
          },
        );
        finalizeOutcome("failed", iterationErrorDecision.reason, {
          iteration,
          error: msg,
        });
        await deps.publishNativeAssistantEvent(conversationId, "run_failed", "failed", {
          loopMeta: {
            iteration,
            reason: iterationErrorDecision.reason,
            error: msg,
          },
          messagePatch: {
            messageId: msgId,
            streamState: iterationErrorDecision.isInterrupted ? "interrupted" : "failed",
            streamIssue: msg,
          },
        });
        showToast({ message: msg, type: "error" });
        return;
      }
    }
  }

  return {
    runToolLoop,
  };
}
