<script lang="ts">
  /**
   * AssistantPanel - Main AI assistant interface
   *
   * Docs consulted:
   * - Gemini API: function calling format with functionDeclarations
   * - Tauri v2: path security and canonicalization
   * - Security best practices for approval gates
   */
  import { UIIcon } from "$lib/components/ui";
  import {
    assistantStore,
    type ToolCall,
    type ImageAttachment,
    type ElementAttachment,
    IMAGE_LIMITS,
  } from "$lib/stores/assistant.svelte";
  import { editorStore } from "$lib/stores/editor.svelte";
  import { projectStore } from "$lib/stores/project.svelte";
  import { showToast } from "$lib/stores/toast.svelte";
  import { aiSettingsStore, type AIMode } from "$lib/stores/ai.svelte";
  import { sendChat, streamChat } from "$lib/services/ai";
  import { getSystemPrompt } from "$lib/services/ai/prompts-v4";
  import {
    getSmartContext,
    formatSmartContext,
  } from "$lib/services/ai/context";
  import {
    getAllToolsForMode,
    validateToolCall as validateTool,
    executeToolCall,
    getToolCapabilities,
    isFileMutatingTool,
    isTerminalTool as isTerminalToolName,
    type ToolResult,
  } from "$lib/services/ai/tools";
  import { resolvePath } from "$lib/services/ai/tools/utils";
  import {
    getAdaptiveFileEditConcurrency,
    getFailureSignature,
    getToolIdempotencyKey,
    mapWithConcurrency,
    normalizeQueueKey,
    stableStringify,
  } from "./panel/utils";
  import { buildSummaryInput } from "./panel/summary-utils";
  import { shouldRunAfterFileEdits } from "./panel/verification-profiles";
  import { createStreamGuards } from "./panel/stream-guards";
  import { toProviderMessages } from "./panel/provider-messages";
  import {
    addToolResultsToConversation,
    waitForToolApprovals,
    waitForToolCompletion,
  } from "./panel/tool-loop-support";
  import { getImageDimensions, readFileAsBase64 } from "./panel/image-utils";
  import { saveConversationToHistory as persistConversationToHistory } from "./panel/conversation-persistence";
  import { getMcpToolsInfo } from "./panel/mcp-tools";
  import {
    executeFileEditQueues,
    executeQueuedNonFileTools,
    type QueuedFileEditTool,
    type QueuedNonFileTool,
  } from "./panel/loop-executor";
  import { processToolsNeedingApproval } from "./panel/approval-executor";
  import { executeToolWithUpdates } from "./panel/tool-execution";
  import { handleNoToolOutcome } from "./panel/loop-outcome";
  import MessageList from "./MessageList.svelte";
  import ChatHistorySidebar from "./ChatHistorySidebar.svelte";
  import ChatInputBar from "./ChatInputBar.svelte";
  import RevertConfirmationModal from "./RevertConfirmationModal.svelte";
  import { open } from "@tauri-apps/plugin-dialog";
  import { readTextFile } from "@tauri-apps/plugin-fs";
  import { invoke } from "@tauri-apps/api/core";
  import { getEditorSelection } from "$lib/services/monaco-models";
  import { chatHistoryStore } from "$lib/stores/chat-history.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { logOutput } from "$lib/stores/output.svelte";

  // Revert confirmation state
  let confirmRevertOpen = $state(false);
  let revertMetadata = $state<any[]>([]);
  let pendingRevertId = $state<string | null>(null);
  let selectedImage = $state<{
    data: string;
    label: string;
    mimeType: "image/png" | "image/jpeg" | "image/webp";
  } | null>(null);
  let inputRef: HTMLTextAreaElement | undefined = $state();

  const CONTEXT_WARN_PCT = 80;
  const CONTEXT_SUMMARY_PCT = 90;
  const SUMMARY_KEEP_MESSAGES = 12;
  const SUMMARY_MAX_TOKENS = 1200;
  const SUMMARY_TEMPERATURE = 0.2;

  let hasContextWarned = $state(false);
  let isAutoSummarizing = $state(false);
  let lastConversationId: string | null = null;

  $effect(() => {
    const currentId = assistantStore.currentConversation?.id ?? null;
    if (currentId && currentId !== lastConversationId) {
      hasContextWarned = false;
      lastConversationId = currentId;
    }
  });
  async function autoSummarizeIfNeeded(
    selectedModel: string,
    controller: AbortController,
  ): Promise<void> {
    if (isAutoSummarizing) return;

    const usage = assistantStore.getContextUsage(selectedModel);

    if (
      usage.percentage >= CONTEXT_WARN_PCT &&
      usage.percentage < CONTEXT_SUMMARY_PCT
    ) {
      if (!hasContextWarned) {
        hasContextWarned = true;
        showToast({
          message: "Context nearing limit — auto-summary will run soon.",
          type: "warning",
        });
      }
      return;
    }

    if (usage.percentage < CONTEXT_SUMMARY_PCT) return;

    const summaryMsg = assistantStore.messages.find(
      (m) => m.role === "system" && m.isSummary,
    );

    const nonSystem = assistantStore.messages.filter(
      (m) => m.role !== "system",
    );
    if (nonSystem.length <= SUMMARY_KEEP_MESSAGES) return;

    const toSummarize = nonSystem.slice(0, -SUMMARY_KEEP_MESSAGES);
    if (toSummarize.length < 4) return;

    isAutoSummarizing = true;
    showToast({ message: "Compressing older context…", type: "info" });

    try {
      const summaryInput = buildSummaryInput(toSummarize, summaryMsg?.content);

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
        showToast({
          message: "Auto-summary failed (empty result).",
          type: "error",
        });
        return;
      }

      assistantStore.summarizeConversation(summaryText, SUMMARY_KEEP_MESSAGES);
      showToast({ message: "Summary updated.", type: "success" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast({ message: `Auto-summary failed: ${msg}`, type: "error" });
    } finally {
      isAutoSummarizing = false;
    }
  }

  $effect(() => {
    if (assistantStore.panelOpen && inputRef) {
      setTimeout(() => inputRef?.focus(), 50);
    }
  });

  function hasToolResultMessage(toolCallId: string): boolean {
    return assistantStore.messages.some(
      (msg) =>
        msg.role === "tool" &&
        msg.toolCalls?.some((tc) => tc.id === toolCallId),
    );
  }

  function handleOpenPromptLibrary(): void {
    uiStore.setActiveSidebarPanel("prompts");
  }

  $effect(() => {
    const onAssistantSend = () => {
      void handleSend();
    };
    window.addEventListener("volt:assistant-send", onAssistantSend);
    return () =>
      window.removeEventListener("volt:assistant-send", onAssistantSend);
  });

  function recordToolResult(toolCall: ToolCall, result: ToolResult): void {
    if (hasToolResultMessage(toolCall.id)) return;
    assistantStore.addToolMessage({
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
      status: result.success ? "completed" : "failed",
      output: result.output,
      error: result.error,
      meta: result.meta,
      data: result.data,
    });
  }
  async function handleSend(): Promise<void> {
    // Use inputRef value as fallback in case store value is out of sync
    const content = (assistantStore.inputValue || inputRef?.value || "").trim();
    if (!content && assistantStore.pendingAttachments.length === 0) return;

    // Add to input history for Up/Down arrow navigation
    assistantStore.addToHistory(content, [
      ...assistantStore.pendingAttachments,
    ]);

    // Cancel any existing stream (cancel-by-default policy)
    if (assistantStore.isStreaming) {
      assistantStore.stopStreaming();
    }

    // Add user message with attached context (deferred until smart context is ready)
    const context = [...assistantStore.attachedContext];
    // assistantStore.addUserMessage(content, context); // REMOVED: Redundant, called later with smart context

    // Clear input and context - also clear the textarea directly
    assistantStore.setInputValue("");
    if (inputRef) inputRef.value = "";
    assistantStore.clearContext();

    const controller = assistantStore.startStreaming();

    // Use centralized system prompt from prompts module
    // Get the selected model for the current mode from AI settings
    const selectedModel =
      aiSettingsStore.modelPerMode[assistantStore.currentMode];

    // Get MCP tools info for system prompt
    const mcpToolsInfo = await getMcpToolsInfo();

    let systemPrompt = getSystemPrompt({
      mode: assistantStore.currentMode,
      provider: aiSettingsStore.selectedProvider,
      model: selectedModel,
      workspaceRoot: projectStore.rootPath ?? undefined,
      mcpTools: mcpToolsInfo.length > 0 ? mcpToolsInfo : undefined,
    });

    // Gather smart context (Active file, open tabs, terminal, etc.)
    // This provides background context - AI will use tools for additional searching
    const smartContext = await getSmartContext(content);
    const contextBlock = formatSmartContext(smartContext);

    // Add user message with content AND smart context as reference
    assistantStore.addUserMessage(content, context, contextBlock);

    // Get tools for current mode (includes MCP tools in agent mode)
    const tools = getAllToolsForMode(assistantStore.currentMode);

    // Auto-summary check (warn at 80%, summarize at 90%)
    await autoSummarizeIfNeeded(selectedModel, controller);

    // Tool loop: keep streaming until model finishes without tool calls
    try {
      await runToolLoop(systemPrompt, tools, controller);
    } finally {
      // Always reset streaming state when done
      assistantStore.isStreaming = false;
      assistantStore.abortController = null;

      // Auto-save: Persist conversation to chat history
      await saveConversationToHistory();
    }
  }

  /**
   * Save the current conversation to persistent storage
   */
  async function saveConversationToHistory(): Promise<void> {
    await persistConversationToHistory(
      chatHistoryStore,
      assistantStore.currentConversation,
      assistantStore.currentMode,
    );
  }

  /**
   * Run the tool loop - stream model response, execute tools, send results back
   * Continues until model finishes without requesting tool calls
   * Kiro-style: robust error recovery, continuation prompts, high iteration limit
   */
  async function runToolLoop(
    systemPrompt: string,
    tools: ReturnType<typeof getAllToolsForMode>,
    controller: AbortController,
    maxIterations = 30, // Increased from 20 to handle complex tasks like Kiro
  ): Promise<void> {
    const msgId = assistantStore.addAssistantMessage("", true);
    const isPlanMode = assistantStore.currentMode === "plan";
    const isAgentMode = assistantStore.currentMode === "agent";
    const failureNudgedSignatures = new Set<string>();
    let planModeViolationNudgeCount = 0;

    let fullContent = "";
    let iteration = 0;
    let hasToolsInConversation = false;
    const toolRunScope = crypto.randomUUID();
    const loopStartedAt = Date.now();
    const MAX_LOOP_DURATION_MS = 8 * 60 * 1000;

    // Kiro-style: Track consecutive empty responses to detect stuck model
    let consecutiveEmptyResponses = 0;
    const MAX_EMPTY_RESPONSES = 3;
    let recoveryRetryCount = 0;
    const MAX_RECOVERY_RETRIES = 2;
    const failureSignatureCounts = new Map<string, number>();

    // Streaming safety guards
    const streamGuards = createStreamGuards();
    const strictDelayTextForTools = false;

    // Log start of agent loop
    logOutput(
      "Volt",
      `Agent: Starting tool loop (max ${maxIterations} iterations)`,
    );

    // Track if we just processed tool results - used to detect when model doesn't respond
    let justProcessedToolResults = false;

    while (iteration < maxIterations) {
      iteration++;

      if (Date.now() - loopStartedAt > MAX_LOOP_DURATION_MS) {
        assistantStore.updateAssistantMessage(
          msgId,
          fullContent
            ? `${fullContent}\n\n⚠️ Stopped: tool loop exceeded time budget (${Math.round(MAX_LOOP_DURATION_MS / 60000)} min).`
            : `⚠️ Stopped: tool loop exceeded time budget (${Math.round(MAX_LOOP_DURATION_MS / 60000)} min).`,
          false,
        );
        showToast({
          message: "Tool loop timed out (time budget exceeded)",
          type: "warning",
        });
        return;
      }

      if (controller.signal.aborted) {
        logOutput("Volt", `Agent: Loop aborted at iteration ${iteration}`);
        return;
      }

      const providerMessages = toProviderMessages(assistantStore.messages);

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
      const fileEditQueues = new Map<string, QueuedFileEditTool[]>();
      // If the model emits an invalid tool call (e.g. missing required args/meta),
      // we must NOT leave it in a pending state (can deadlock approvals).
      const immediateResults: Array<{
        id: string;
        name: string;
        result: ToolResult;
      }> = [];
      let hadPlanModeViolationThisIteration = false;

      try {
        // Reduce hallucinations: use conservative temperature defaults per mode.
        const temperature =
          assistantStore.currentMode === "plan"
            ? 0.1
            : assistantStore.currentMode === "ask"
              ? 0.2
              : 0.15;

        // REMOVED: sawToolCallInThisTurn suppression - let text flow naturally after tool calls
        let suppressFurtherTextInThisTurn = false;
        let toolCallSeenThisIteration = false;
        let warnedAboutLooping = false;
        // REMOVED: visibleCharBudget - show full responses like Kiro

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

          if (chunk.type === "content" && chunk.content) {
            // REMOVED: sawToolCallInThisTurn check - allow text after tool calls
            if (suppressFurtherTextInThisTurn) {
              continue;
            }
            if (streamGuards.shouldAbortForLeak(chunk.content)) {
              controller.abort();
              showToast({
                message:
                  "Assistant output contained internal context markers; generation stopped.",
                type: "warning",
              });
              assistantStore.updateAssistantMessage(
                msgId,
                fullContent + iterationContent,
                false,
              );
              return;
            }

            if (streamGuards.isDegenerateRepeat(chunk.content)) {
              if (!warnedAboutLooping) {
                warnedAboutLooping = true;
                showToast({
                  message:
                    "Assistant output started repeating, so I suppressed further assistant text for this turn to prevent spam. Tool calls/results (if any) will still run.",
                  type: "warning",
                });
              }
              suppressFurtherTextInThisTurn = true;
              continue;
            }

            if (
              streamGuards.isDegenerateLineRepeat(
                iterationContent + chunk.content,
              )
            ) {
              if (!warnedAboutLooping) {
                warnedAboutLooping = true;
                showToast({
                  message:
                    "Assistant output started looping, so I suppressed further assistant text for this turn to prevent spam. Tool calls/results (if any) will still run.",
                  type: "warning",
                });
              }
              suppressFurtherTextInThisTurn = true;
              continue;
            }

            // End any active thinking part before adding text
            assistantStore.endThinkingPart(msgId);

            iterationContent += chunk.content;
            // In Agent mode, keep text buffered until iteration completes.
            // This enforces tool-first UX (avoid premature "done" summaries).
            if (!isAgentMode) {
              assistantStore.appendTextToMessage(msgId, chunk.content, true);
            }
          }

          // Handle thinking chunks - display INLINE (Cursor-style)
          if (chunk.type === "thinking" && chunk.thinking) {
            iterationThinking += chunk.thinking;
            // Append thinking inline to contentParts (creates new thinking block if needed)
            assistantStore.appendThinkingToMessage(msgId, chunk.thinking);
          }

          if (chunk.type === "tool_call" && chunk.toolCall) {
            // End any active thinking part before adding tool call
            assistantStore.endThinkingPart(msgId);
            toolCallSeenThisIteration = true;
            hasToolsInConversation = true;
            const toolCallArgs = chunk.toolCall.arguments;
            const toolCallName = chunk.toolCall.name;
            const toolCallId = chunk.toolCall.id;
            const toolCallThoughtSignature = chunk.toolCall.thoughtSignature;

            // DEDUPLICATION: Check if we already have this exact tool call in this iteration
            // This prevents the AI from running the same command twice in one response
            const callArgsSignature = stableStringify(toolCallArgs);
            const isDuplicate = allToolCalls.some(
              (tc) =>
                tc.name === toolCallName &&
                stableStringify(tc.arguments) === callArgsSignature,
            );

            if (isDuplicate) {
              console.log(
                "[Agent] Skipping duplicate tool call:",
                toolCallName,
                toolCallArgs,
              );
              // Still need to add to allToolCalls for Gemini history, but mark as skipped
              const skipResult = {
                id: toolCallId,
                name: toolCallName,
                result: {
                  success: true,
                  output:
                    "[Duplicate tool call skipped - already executed in this response]",
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
              assistantStore.addToolCallToMessage(msgId, skippedToolCall);
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
                (capabilities.isMutating &&
                  toolCallName !== "write_plan_file"));
            const resolvedValidationError = validation.valid
              ? undefined
              : isPlanModeViolation
                ? `Tool "${toolCallName}" is not allowed in plan mode. In plan mode, use READ tools and optionally "write_plan_file" only.`
                : (validation.error ?? "Invalid tool call");
            const status: ToolCall["status"] = validation.valid
              ? "pending"
              : "failed";
            const toolCall: ToolCall = {
              id: toolCallId,
              name: toolCallName,
              arguments: toolCallArgs,
              status,
              requiresApproval: validation.requiresApproval,
              thoughtSignature: toolCallThoughtSignature,
              error: resolvedValidationError,
              endTime: validation.valid ? undefined : Date.now(),
            };

            assistantStore.addToolCallToMessage(msgId, toolCall);

            // Track every tool call (valid or invalid) so we can always attach a tool result
            // back to the model and keep Gemini's function-calling history consistent.
            allToolCalls.push({
              id: toolCallId,
              name: toolCallName,
              arguments: toolCallArgs,
              thoughtSignature: toolCallThoughtSignature,
            });

            if (!validation.valid) {
              if (isPlanModeViolation) {
                hadPlanModeViolationThisIteration = true;
              }
              // Feed an error tool result back to the model so the conversation stays consistent.
              immediateResults.push({
                id: toolCallId,
                name: toolCallName,
                result: {
                  success: false,
                  error: resolvedValidationError ?? "Invalid tool call",
                },
              });

              // CRITICAL: If a file-modifying tool fails validation, mark it so we can skip
              // running subsequent tools that might depend on it (like eslint after write_file)
              const isFileModifyingTool = isFileMutatingTool(toolCallName);

              if (isFileModifyingTool) {
                // Set a flag to skip running other tools in this batch
                // This prevents running eslint when write_file failed
                (immediateResults as any).__fileModifyFailed = true;
              }

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
            if ((immediateResults as any).__fileModifyFailed) {
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
                isTerminalToolName(toolCallName) &&
                capabilities.requiresApproval;
              const rawFilePath = isFileEdit
                ? String(toolCallArgs.path || "")
                : "";
              const filePath =
                isFileEdit && rawFilePath
                  ? normalizeQueueKey(rawFilePath)
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
                  meta: { editPhase: "queued", queueIndex },
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
                    meta: { executionPhase: "after_file_edits" },
                  });
                }
              }
            }
          }

          if (chunk.type === "error") {
            throw new Error(chunk.error || "Unknown streaming error");
          }
        }

        // Finalize thinking state when streaming ends
        // End any active inline thinking part
        assistantStore.finalizeThinking(msgId);
        if (iterationThinking) {
          // Also update legacy thinking field for backward compatibility
          assistantStore.updateAssistantThinking(
            msgId,
            iterationThinking,
            false,
          );
        }

        if (
          isAgentMode &&
          toolCallSeenThisIteration &&
          iterationContent.trim()
        ) {
          // Drop pre-tool narration for cleaner, trustworthy execution flow.
          iterationContent = "";
        }

        // Reset repetition guard per iteration boundary so we don't over-trigger
        // on unrelated chunks in later iterations.
        streamGuards.resetIteration();

        const hasQueuedFileEdits = fileEditQueues.size > 0;
        const immediateNonFileTools = hasQueuedFileEdits
          ? queuedNonFileTools.filter((t) => !t.runAfterFileEdits)
          : queuedNonFileTools;
        const deferredNonFileTools = hasQueuedFileEdits
          ? queuedNonFileTools.filter((t) => t.runAfterFileEdits)
          : [];

        // Run non-file tools that don't depend on fresh edits.
        const eagerResults = await executeQueuedNonFileTools(
          immediateNonFileTools,
          {
            executeToolCall,
            signal: controller.signal,
            toolRunScope,
            getToolIdempotencyKey,
            updateToolCallInMessage:
              assistantStore.updateToolCallInMessage.bind(assistantStore),
            messageId: msgId,
            getFailureSignature,
            trackToolOutcome: () => {},
            onFailureSignature: (signature) => {
              const count = (failureSignatureCounts.get(signature) ?? 0) + 1;
              failureSignatureCounts.set(signature, count);
            },
          },
        );

        // Execute file edits SEQUENTIALLY per file path
        // This prevents race conditions where multiple str_replace calls to the same file
        // fail because the file content changed between reads
        const fileEditTasks = Array.from(fileEditQueues.entries());
        const fileEditConcurrency = getAdaptiveFileEditConcurrency(
          fileEditTasks.length,
        );
        const fileEditResults = await executeFileEditQueues(
          fileEditTasks,
          fileEditConcurrency,
          {
            executeToolCall,
            signal: controller.signal,
            toolRunScope,
            getToolIdempotencyKey,
            updateToolCallInMessage:
              assistantStore.updateToolCallInMessage.bind(assistantStore),
            messageId: msgId,
            getFailureSignature,
            trackToolOutcome: () => {},
            onFailureSignature: (signature) => {
              const count = (failureSignatureCounts.get(signature) ?? 0) + 1;
              failureSignatureCounts.set(signature, count);
            },
            mapWithConcurrency,
          },
        );

        // Run diagnostics/LSP tools after file edits so they see latest state.
        const deferredResults = await executeQueuedNonFileTools(
          deferredNonFileTools,
          {
            executeToolCall,
            signal: controller.signal,
            toolRunScope,
            getToolIdempotencyKey,
            updateToolCallInMessage:
              assistantStore.updateToolCallInMessage.bind(assistantStore),
            messageId: msgId,
            getFailureSignature,
            trackToolOutcome: () => {},
            onFailureSignature: (signature) => {
              const count = (failureSignatureCounts.get(signature) ?? 0) + 1;
              failureSignatureCounts.set(signature, count);
            },
          },
        );

        // Combine all results
        const allEagerResults = [
          ...eagerResults,
          ...fileEditResults,
          ...deferredResults,
        ];

        if (
          pendingToolCalls.length === 0 &&
          allEagerResults.length === 0 &&
          immediateResults.length === 0
        ) {
          const noToolOutcome = handleNoToolOutcome({
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
            },
            logOutput: (message) => logOutput("Volt", message),
            addToolMessage: (payload) => assistantStore.addToolMessage(payload),
            updateAssistantMessage: (content) =>
              assistantStore.updateAssistantMessage(msgId, content, false),
          });

          consecutiveEmptyResponses =
            noToolOutcome.state.consecutiveEmptyResponses;
          justProcessedToolResults =
            noToolOutcome.state.justProcessedToolResults;
          planModeViolationNudgeCount =
            noToolOutcome.state.planModeViolationNudgeCount;
          fullContent = noToolOutcome.state.fullContent;

          if (noToolOutcome.decision === "continue") {
            continue;
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

        const eagerIds = new Set(allEagerResults.map((r) => r.id));
        const toolsNeedingApproval = pendingToolCalls.filter(
          (tc) => !eagerIds.has(tc.id),
        );

        if (toolsNeedingApproval.length > 0) {
          assistantStore.messages = assistantStore.messages.map((msg) =>
            msg.id === msgId ? { ...msg, isStreaming: false } : msg,
          );

          const approvalsProcessed = await processToolsNeedingApproval(
            msgId,
            toolsNeedingApproval,
            toolResults,
            {
              isTerminalToolName,
              getToolCapabilities,
              waitForToolApprovals,
              waitForToolCompletion,
              getMessages: () => assistantStore.messages,
              updateToolCallInMessage:
                assistantStore.updateToolCallInMessage.bind(assistantStore),
              executeToolCall,
              getToolIdempotencyKey,
              toolRunScope,
              signal: controller.signal,
              getFailureSignature,
              trackToolOutcome: () => {},
              onFailureSignature: (signature) => {
                const count = (failureSignatureCounts.get(signature) ?? 0) + 1;
                failureSignatureCounts.set(signature, count);
              },
            },
          );
          if (!approvalsProcessed) return;
        }

        // Add ALL results to conversation as special tool messages
        addToolResultsToConversation(
          allToolCalls,
          toolResults,
          assistantStore.addToolMessage.bind(assistantStore),
        );

        for (const [signature, count] of failureSignatureCounts.entries()) {
          if (count < 3 || failureNudgedSignatures.has(signature)) continue;
          failureNudgedSignatures.add(signature);
          assistantStore.addToolMessage({
            id: `strategy_switch_${Date.now()}`,
            name: "_system_strategy_switch",
            arguments: {},
            status: "completed",
            output:
              "The same failure repeated multiple times. Stop repeating the same call. Inspect current outputs/files, choose a different strategy, then retry.",
          });
        }

        // Mark that we just processed tool results - if model doesn't respond next iteration,
        // we'll prompt it to continue
        justProcessedToolResults = true;
      } catch (err) {
        if (controller.signal.aborted) return;
        const msg = err instanceof Error ? err.message : "Unknown error";

        // Kiro-style: Check if this is a retryable error
        const isRetryable =
          /network|timeout|connection|interrupted|503|502|504|429/i.test(msg);

        logOutput("Volt", `Agent Loop Error (iteration ${iteration}): ${msg}`);

        // If retryable and we have content, try to continue
        if (
          isRetryable &&
          iteration < maxIterations - 1 &&
          recoveryRetryCount < MAX_RECOVERY_RETRIES
        ) {
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
            output: `A temporary error occurred: ${msg}. Please continue with your task. If you were in the middle of something, resume from where you left off.`,
          });

          // Small delay before retry
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue; // Continue to next iteration
        }

        // Non-retryable or exhausted retries
        assistantStore.updateAssistantMessage(
          msgId,
          fullContent
            ? `${fullContent}\n\n⚠️ Error: ${msg}`
            : `⚠️ Error: ${msg}`,
          false,
        );
        showToast({ message: msg, type: "error" });
        return;
      }
    }

    assistantStore.updateAssistantMessage(msgId, fullContent, false);
    showToast({
      message: "Tool loop reached maximum iterations",
      type: "warning",
    });
  }

  /**
   * Execute a tool call and update its status
   * Supports streaming progress for file write operations
   */
  async function executeToolAndUpdate(
    toolCall: ToolCall,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    return executeToolWithUpdates({
      toolCall,
      signal,
      idScope: assistantStore.currentConversation?.id ?? "ad-hoc",
      executeToolCall,
      getToolIdempotencyKey,
      updateToolCall: (toolCallId, patch) => {
        assistantStore.updateToolCall(toolCallId, patch);
      },
    });
  }

  function handleStop(): void {
    assistantStore.stopStreaming();
  }

  function handleModeChange(mode: AIMode): void {
    assistantStore.setMode(mode);
  }

  function handleAttachCurrentFile(): void {
    const activeFile = editorStore.activeFile;
    if (!activeFile) {
      showToast({ message: "No file is currently open", type: "warning" });
      return;
    }

    // Use new attachment model
    const result = assistantStore.attachFile(
      activeFile.path,
      activeFile.content,
    );
    if (!result.success) {
      showToast({
        message: result.error ?? "Failed to attach file",
        type: "warning",
      });
    }

    // Also add to legacy context for backward compatibility
    assistantStore.attachContext({
      type: "file",
      path: activeFile.path,
      content: activeFile.content,
      label: activeFile.path.split("/").pop() ?? activeFile.path,
    });
  }

  function handleAttachSelection(): void {
    const selection = getEditorSelection();
    if (selection && selection.text) {
      // Use new attachment model with range
      const result = assistantStore.attachSelection(
        selection.text,
        selection.path ?? undefined,
        selection.range
          ? {
              startLine: selection.range.startLineNumber,
              startCol: selection.range.startColumn,
              endLine: selection.range.endLineNumber,
              endCol: selection.range.endColumn,
            }
          : undefined,
      );

      if (!result.success) {
        showToast({
          message: result.error ?? "Failed to attach selection",
          type: "warning",
        });
        return;
      }

      // Also add to legacy context
      assistantStore.attachContext({
        type: "selection",
        path: selection.path ?? undefined,
        content: selection.text,
        label: `Selection from ${selection.path?.split("/").pop() ?? "editor"}`,
      });
      return;
    }

    showToast({ message: "No text selected in editor", type: "warning" });
  }

  /**
   * Handle image attachment from file (drag & drop or paste)
   */
  async function handleAttachImage(file: File): Promise<void> {
    // Validate mime type
    const mimeType =
      file.type as (typeof IMAGE_LIMITS.allowedMimeTypes)[number];
    if (!IMAGE_LIMITS.allowedMimeTypes.includes(mimeType)) {
      showToast({
        message: `Unsupported image type: ${file.type}. Use PNG, JPEG, or WebP.`,
        type: "warning",
      });
      return;
    }

    // Check file size
    if (file.size > IMAGE_LIMITS.maxImageBytes) {
      const maxMB = IMAGE_LIMITS.maxImageBytes / (1024 * 1024);
      showToast({
        message: `Image too large (${(file.size / (1024 * 1024)).toFixed(1)}MB). Maximum: ${maxMB}MB`,
        type: "warning",
      });
      return;
    }

    try {
      // Read file as base64
      const base64Data = await readFileAsBase64(file);

      // Get image dimensions
      const dimensions = await getImageDimensions(base64Data, mimeType);

      // Add to attachments
      const result = assistantStore.attachImage(
        file.name,
        mimeType,
        base64Data,
        dimensions,
      );

      if (!result.success) {
        showToast({
          message: result.error ?? "Failed to attach image",
          type: "warning",
        });
      }
    } catch (err) {
      showToast({ message: "Failed to read image file", type: "error" });
    }
  }

  /**
   * Open file picker for images
   */
  async function handleAttachImageFromPicker(): Promise<void> {
    try {
      const selected = await open({
        multiple: true,
        filters: [
          {
            name: "Images",
            extensions: ["png", "jpg", "jpeg", "webp"],
          },
        ],
      });

      if (!selected) return;

      const paths = Array.isArray(selected) ? selected : [selected];

      for (const path of paths) {
        // Read file using Tauri fs
        const { readFile } = await import("@tauri-apps/plugin-fs");
        const bytes = await readFile(path);

        // Convert to base64
        const base64Data = btoa(
          bytes.reduce(
            (data: string, byte: number) => data + String.fromCharCode(byte),
            "",
          ),
        );

        // Determine mime type from extension
        const ext = path.split(".").pop()?.toLowerCase();
        let mimeType: "image/png" | "image/jpeg" | "image/webp" = "image/png";
        if (ext === "jpg" || ext === "jpeg") mimeType = "image/jpeg";
        else if (ext === "webp") mimeType = "image/webp";

        // Get filename
        const filename = path.split(/[/\\]/).pop() ?? "image";

        // Get dimensions
        const dimensions = await getImageDimensions(base64Data, mimeType);

        // Add to attachments
        const result = assistantStore.attachImage(
          filename,
          mimeType,
          base64Data,
          dimensions,
        );
        if (!result.success) {
          showToast({
            message: result.error ?? "Failed to attach image",
            type: "warning",
          });
        }
      }
    } catch (err) {
      showToast({ message: "Failed to open image picker", type: "error" });
    }
  }

  function handleRemoveContext(index: number): void {
    assistantStore.removeContext(index);
  }

  function handleRemoveAttachment(id: string): void {
    assistantStore.removeAttachment(id);
  }

  async function handleClearConversation(): Promise<void> {
    // Save current conversation BEFORE creating new one
    await saveConversationToHistory();

    // Reload conversations list to show the saved one
    await chatHistoryStore.loadConversations();

    // Now create fresh conversation
    assistantStore.newConversation();
    chatHistoryStore.activeConversationId =
      assistantStore.currentConversation?.id ?? null;
  }

  async function handleToolApprove(toolCall: ToolCall): Promise<void> {
    // Validate tool call against current mode (use router validation to avoid drift)
    const validation = validateTool(
      toolCall.name,
      toolCall.arguments,
      assistantStore.currentMode,
    );
    if (!validation.valid) {
      showToast({
        message: validation.error ?? "Tool call is not allowed",
        type: "warning",
      });
      assistantStore.updateToolCall(toolCall.id, {
        status: "cancelled",
        error: validation.error,
        endTime: Date.now(),
      });
      return;
    }

    // Execute the approved tool
    const result = await executeToolAndUpdate(
      toolCall,
      assistantStore.abortController?.signal,
    );
    recordToolResult(toolCall, result);
  }

  function handleToolDeny(toolCall: ToolCall): void {
    assistantStore.updateToolCall(toolCall.id, {
      status: "cancelled",
      endTime: Date.now(),
    });
  }

  async function handleRevertRequested(messageId: string): Promise<void> {
    pendingRevertId = messageId;
    // Show loading toast while gathering metadata
    const metadata = await assistantStore.getRevertMetadata(messageId);
    if (metadata.length === 0) {
      // No file changes to revert, just revert the history
      await assistantStore.revertToMessage(messageId);
      return;
    }
    revertMetadata = metadata;
    confirmRevertOpen = true;
  }

  async function confirmRevert(): Promise<void> {
    if (pendingRevertId) {
      await assistantStore.revertToMessage(pendingRevertId);
    }
    cancelRevert();
  }

  function cancelRevert(): void {
    confirmRevertOpen = false;
    pendingRevertId = null;
    revertMetadata = [];
  }

  /**
   * Handle tool approval from inline display in message
   * Supports streaming progress for file write operations
   * OPTIMIZED: Execute immediately on approval instead of waiting for tool loop
   */
  async function handleToolApproveInMessage(
    messageId: string,
    toolCall: ToolCall,
  ): Promise<void> {
    const validation = validateTool(
      toolCall.name,
      toolCall.arguments,
      assistantStore.currentMode,
    );
    if (!validation.valid) {
      showToast({
        message: validation.error ?? "Tool call is not allowed",
        type: "warning",
      });
      assistantStore.updateToolCallInMessage(messageId, toolCall.id, {
        status: "cancelled",
        error: validation.error,
        endTime: Date.now(),
      });
      return;
    }

    const result = await executeToolWithUpdates({
      toolCall,
      signal: assistantStore.abortController?.signal,
      idScope: assistantStore.currentConversation?.id ?? "ad-hoc",
      executeToolCall,
      getToolIdempotencyKey,
      updateToolCall: (toolCallId, patch) => {
        assistantStore.updateToolCallInMessage(messageId, toolCallId, patch);
      },
    });

    recordToolResult(toolCall, result);
  }

  /**
   * Handle tool denial from inline display in message
   */
  function handleToolDenyInMessage(
    messageId: string,
    toolCall: ToolCall,
  ): void {
    assistantStore.updateToolCallInMessage(messageId, toolCall.id, {
      status: "cancelled",
      endTime: Date.now(),
    });
  }

  /**
   * Handle "Start Implementation" button click from Plan mode
   * Switches to Agent mode and executes using attached plan file context
   */
  async function handleStartImplementation(plan: {
    filename: string;
    content: string;
    relativePath?: string;
    absolutePath?: string;
  }): Promise<void> {
    // Switch to Agent mode
    assistantStore.setMode("agent");

    const guessedRelativePath =
      plan.relativePath ||
      `.volt/plans/${plan.filename.endsWith(".md") ? plan.filename : `${plan.filename}.md`}`;
    const attachmentPath = plan.absolutePath || guessedRelativePath;
    const resolvedPlanPath =
      plan.absolutePath || resolvePath(guessedRelativePath);
    let latestPlanContent = plan.content;

    // Prefer current on-disk plan so Agent executes the latest edited version.
    try {
      const diskContent = await readTextFile(resolvedPlanPath);
      if (diskContent && diskContent.trim().length > 0) {
        latestPlanContent = diskContent;
      }
    } catch {
      // Fallback to tool-captured content from chat history.
    }

    const attachResult = assistantStore.attachFile(
      attachmentPath,
      latestPlanContent,
      plan.filename,
    );

    if (!attachResult.success) {
      showToast({
        message: attachResult.error ?? "Failed to attach plan file",
        type: "warning",
      });
    }

    const implementationPrompt =
      `Implement the attached plan file (${guessedRelativePath}) step by step.\n` +
      `Rules:\n` +
      `1. Read the attached plan first, then execute exactly one step at a time.\n` +
      `2. Keep changes incremental and verify each step before moving to the next.\n` +
      `3. Update the same plan markdown file as you progress:\n` +
      `   - mark completed steps ([x])\n` +
      `   - add/update an "Execution Progress" section with what was done and verification results.\n` +
      `4. If blocked, stop and report blocker + next action needed.`;

    // Set the input and trigger send
    assistantStore.setInputValue(implementationPrompt);
    if (inputRef) {
      inputRef.value = implementationPrompt;
    }

    // Trigger send after a brief delay to ensure UI updates
    setTimeout(() => {
      void handleSend();
    }, 100);
  }

  // Get attachment previews for display
  const attachmentPreviews = $derived(assistantStore.getAttachmentPreviews());

  // Derive current chat title to avoid inline .find() re-running on every update
  const currentChatTitle = $derived.by(() => {
    const activeId = chatHistoryStore.activeConversationId;
    if (!activeId) return "New Chat";
    const conv = chatHistoryStore.conversations.find((c) => c.id === activeId);
    return conv?.title || "New Chat";
  });
</script>

<aside class="assistant-panel" aria-label="AI Assistant">
  <!-- Header -->
  <header class="panel-header">
    <div class="header-left">
      <div class="header-icon">
        <UIIcon name="comment" size={14} />
      </div>
      <span class="header-title" title={currentChatTitle}>
        {currentChatTitle}
      </span>
    </div>
    <div class="header-actions">
      <button
        class="header-btn"
        onclick={handleOpenPromptLibrary}
        title="Prompt library"
        aria-label="Prompt library"
        type="button"
      >
        <UIIcon name="code" size={14} />
      </button>
      <button
        class="header-btn"
        onclick={() => chatHistoryStore.toggleSidebar()}
        title="Chat history"
        aria-label="Chat history"
        type="button"
      >
        <UIIcon name="history" size={14} />
      </button>
      <button
        class="header-btn"
        onclick={handleClearConversation}
        title="New chat"
        aria-label="New chat"
        type="button"
      >
        <UIIcon name="plus" size={14} />
      </button>
      <button
        class="header-btn"
        onclick={() => assistantStore.closePanel()}
        title="Close (Ctrl+L)"
        aria-label="Close assistant panel"
        type="button"
      >
        <UIIcon name="close" size={14} />
      </button>
    </div>
  </header>

  <!-- Messages Area -->
  <div class="messages-area">
    <MessageList
      messages={assistantStore.messages}
      currentMode={assistantStore.currentMode}
      isStreaming={assistantStore.isStreaming}
      onToolApprove={handleToolApproveInMessage}
      onToolDeny={handleToolDenyInMessage}
      onStartImplementation={handleStartImplementation}
      onRevert={handleRevertRequested}
    />
  </div>

  <!-- Input Area (Bottom) -->
  <div class="input-area">
    <!-- Attachment Previews (new model) -->
    {#if attachmentPreviews.length > 0}
      <div
        class="attachment-previews"
        role="list"
        aria-label="Attachments to send"
      >
        {#each attachmentPreviews as preview (preview.id)}
          <div
            class="attachment-preview"
            class:is-image={preview.isImage}
            role="listitem"
          >
            {#if preview.isImage && preview.thumbnailData}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
              <img
                src="data:{preview.mimeType ??
                  'image/png'};base64,{preview.thumbnailData}"
                alt={preview.label}
                class="attachment-thumbnail"
                onclick={() =>
                  (selectedImage = {
                    data: preview.thumbnailData!,
                    label: preview.label,
                    mimeType: preview.mimeType ?? "image/png",
                  })}
                style="cursor: pointer;"
              />
            {:else}
              <UIIcon
                name={preview.type === "file"
                  ? "file"
                  : preview.type === "selection"
                    ? "code"
                    : preview.type === "folder"
                      ? "folder"
                      : preview.type === "element"
                        ? "target"
                        : "image"}
                size={14}
              />
            {/if}
            <div class="attachment-info">
              <span class="attachment-label">{preview.label}</span>
              {#if preview.size || preview.dimensions}
                <span class="attachment-meta">
                  {preview.dimensions ?? ""}{preview.dimensions && preview.size
                    ? " · "
                    : ""}{preview.size ?? ""}
                </span>
              {/if}
            </div>
            <button
              class="attachment-remove"
              onclick={() => handleRemoveAttachment(preview.id)}
              title="Remove"
              aria-label="Remove {preview.label}"
              type="button"
            >
              <UIIcon name="close" size={10} />
            </button>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Legacy Attached Context Chips (for backward compatibility) -->
    {#if assistantStore.attachedContext.length > 0 && attachmentPreviews.length === 0}
      <div class="attached-context" role="list" aria-label="Attached context">
        {#each assistantStore.attachedContext as ctx, i (i)}
          <div class="context-chip" role="listitem">
            <UIIcon name={ctx.type === "file" ? "file" : "code"} size={12} />
            <span class="context-label">{ctx.label}</span>
            <button
              class="context-remove"
              onclick={() => handleRemoveContext(i)}
              title="Remove"
              aria-label="Remove {ctx.label}"
              type="button"
            >
              <UIIcon name="close" size={10} />
            </button>
          </div>
        {/each}
      </div>
    {/if}

    <ChatInputBar
      bind:inputRef
      value={assistantStore.inputValue}
      isStreaming={assistantStore.isStreaming}
      currentMode={assistantStore.currentMode}
      onInput={(v, source, attachments) => {
        assistantStore.setInputValue(v, source);
        if (attachments) {
          assistantStore.setPendingAttachments(attachments);
        }
      }}
      onSend={handleSend}
      onStop={handleStop}
      onModeChange={handleModeChange}
      onAttachFile={handleAttachCurrentFile}
      onAttachSelection={handleAttachSelection}
      onAttachImage={handleAttachImage}
      onAttachImageFromPicker={handleAttachImageFromPicker}
      onOpenPromptLibrary={handleOpenPromptLibrary}
    />
  </div>
</aside>

<!-- Chat History Sidebar -->
<ChatHistorySidebar />

<!-- Revert Confirmation Modal -->
<RevertConfirmationModal
  open={confirmRevertOpen}
  files={revertMetadata}
  onConfirm={confirmRevert}
  onCancel={cancelRevert}
/>

<!-- Image Preview Modal -->
{#if selectedImage}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="image-modal"
    onclick={() => (selectedImage = null)}
    role="dialog"
    aria-modal="true"
    tabindex="0"
  >
    <div
      class="image-modal-content"
      onclick={(e) => e.stopPropagation()}
      role="document"
    >
      <button class="image-modal-close" onclick={() => (selectedImage = null)}>
        <UIIcon name="close" size={20} />
      </button>
      <img
        src="data:{selectedImage.mimeType};base64,{selectedImage.data}"
        alt={selectedImage.label}
        class="image-modal-img"
      />
      <span class="image-modal-label">{selectedImage.label}</span>
    </div>
  </div>
{/if}

<style>
  .assistant-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-bg-panel);
    border-left: 1px solid var(--color-border);
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: var(--color-bg-header);
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
    min-height: 36px;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .header-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-secondary);
  }

  .header-title {
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--color-text);
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .header-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 4px;
    color: var(--color-text-secondary);
    transition: all 0.15s ease;
  }

  .header-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .header-btn:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
  }

  .messages-area {
    flex: 1;
    overflow: hidden;
    min-height: 0;
  }

  .input-area {
    background: transparent;
    flex-shrink: 0;
  }

  .attached-context {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 12px 0;
  }

  .context-chip {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 6px 3px 8px;
    background: var(--color-surface0);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    font-size: 11px;
    color: var(--color-text-secondary);
  }

  .context-label {
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .context-remove {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border-radius: 2px;
    color: var(--color-text-secondary);
    opacity: 0.7;
    transition: all 0.15s ease;
  }

  .context-remove:hover {
    opacity: 1;
    background: var(--color-hover);
    color: var(--color-text);
  }

  /* Attachment previews (new model) */
  .attachment-previews {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 12px 0;
  }

  .attachment-preview {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px 4px 8px;
    background: var(--color-surface0);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    font-size: 11px;
    color: var(--color-text-secondary);
    max-width: 200px;
  }

  .attachment-preview.is-image {
    padding: 4px;
  }

  .attachment-thumbnail {
    width: 32px;
    height: 32px;
    object-fit: cover;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .attachment-info {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }

  .attachment-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text);
  }

  .attachment-meta {
    font-size: 10px;
    color: var(--color-text-disabled);
  }

  .attachment-remove {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 3px;
    color: var(--color-text-secondary);
    opacity: 0.7;
    transition: all 0.15s ease;
    flex-shrink: 0;
  }

  .attachment-remove:hover {
    opacity: 1;
    background: var(--color-hover);
    color: var(--color-text);
  }
  /* Image Preview Modal */
  .image-modal {
    position: fixed;
    inset: 0;
    z-index: 9999;
    background: rgba(0, 0, 0, 0.85);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: fadeIn 0.2s ease;
  }

  .image-modal-content {
    position: relative;
    max-width: 90vw;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }

  .image-modal-img {
    max-width: 100%;
    max-height: 85vh;
    object-fit: contain;
    border-radius: 8px;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
  }

  .image-modal-close {
    position: absolute;
    top: -40px;
    right: 0;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.1);
    color: white;
    transition: all 0.2s ease;
  }

  .image-modal-close:hover {
    background: rgba(255, 255, 255, 0.2);
    transform: scale(1.1);
  }

  .image-modal-label {
    color: white;
    font-size: 13px;
    background: rgba(0, 0, 0, 0.5);
    padding: 4px 12px;
    border-radius: 20px;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
</style>
