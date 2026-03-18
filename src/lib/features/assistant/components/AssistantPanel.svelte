<script lang="ts">
  /**
   * AssistantPanel - Main AI assistant interface
   *
   * Docs consulted:
   * - Gemini API: function calling format with functionDeclarations
   * - Tauri v2: path security and canonicalization
   * - Security best practices for approval gates
   */
  import { UIIcon } from "$shared/components/ui";
  import {
    assistantStore,
    type ToolCall,
    type ImageAttachment,
    type ElementAttachment,
    IMAGE_LIMITS,
  } from "$features/assistant/stores/assistant.svelte";
  import { editorStore } from "$features/editor/stores/editor.svelte";
  import { projectStore } from "$shared/stores/project.svelte";
  import { showToast } from "$shared/stores/toast.svelte";
  import { aiSettingsStore, type AIMode } from "$features/assistant/stores/ai.svelte";
  import { streamChat } from "$core/ai";
  import { getSystemPrompt } from "$core/ai/prompts/prompts-v4";
  import {
    buildContextV2,
    buildMinimalContextFallback,
    formatContextV2,
  } from "$core/ai/context/context-v2";
  import {
    getAllToolsForMode,
    validateToolCall as validateTool,
    executeToolCall,
    normalizeToolName,
    getToolCapabilities,
    isFileMutatingTool,
    isTerminalTool as isTerminalToolName,
    type ToolResult,
  } from "$core/ai/tools";
  import { resolvePath } from "$core/ai/tools/utils";
  import {
    buildCompactWorkingSetSummary,
    buildRecoveryHint,
    classifyRecoveryIssue,
    getAdaptiveFileEditConcurrency,
    getFailureSignature,
    getToolIdempotencyKey,
    isVerificationTool,
    mapWithConcurrency,
    normalizeQueueKey,
    stableStringify,
  } from "./panel/utils";
  import { autoSummarizeIfNeeded } from "./panel/auto-summarize";
  import {
    classifyPlanningPhase,
    getVerificationProfiles,
    shouldRunAfterFileEdits,
  } from "./panel/verification-profiles";
  import { selectAutoVerificationAction } from "./panel/auto-verification";
  import { createStreamGuards } from "./panel/stream-guards";
  import { createStreamingTextBuffer } from "./panel/streaming-text-buffer";
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
  import { filterToolsForChat } from "./panel/tool-gating";
  import { compileProviderMessages } from "./panel/compile-provider-messages";
  import { applyLoopTerminalOutcome } from "$features/assistant/runtime/loop-finalizer";
  import { resolveNoToolOutcome } from "$features/assistant/runtime/no-tool-outcome-policy";
  import {
    resolveAbortAction,
    resolveApprovalAction,
    resolveCompletionAction,
    resolveIterationErrorAction,
    resolveIterationLimitAction,
    resolveLoopBudgetAction,
  } from "$features/assistant/runtime/loop-runner";
  import MessageList from "./MessageList.svelte";
  import ChatHistorySidebar from "./ChatHistorySidebar.svelte";
  import ChatInputBar from "./ChatInputBar.svelte";
  import RevertConfirmationModal from "./RevertConfirmationModal.svelte";
  import { open } from "@tauri-apps/plugin-dialog";
  import { invoke } from "@tauri-apps/api/core";
  import { readBinaryFileBase64, readFileQuiet } from "$core/services/file-system";
  import { getEditorSelection } from "$core/services/monaco-models";
  import { chatHistoryStore } from "$features/assistant/stores/chat-history.svelte";
  import { uiStore } from "$shared/stores/ui.svelte";
  import { logOutput } from "$features/terminal/stores/output.svelte";
  import { terminalStore } from "$features/terminal/stores/terminal.svelte";
  import { gitStore } from "$features/git/stores/git.svelte";
  import { agentTelemetryStore } from "$features/assistant/stores/agent-telemetry.svelte";
  import { buildRuntimeContextBlock } from "$core/ai/context/runtime-context";
  import { ToolRepetitionDetector } from "./panel/tool-repetition";
  import { createToolTrackingState } from "./panel/tool-tracking";
  import { createAgentRuntime } from "$features/assistant/runtime/agent-runtime";
  import './AssistantPanel.css';

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

  let hasContextWarned = $state(false);
  let isAutoSummarizing = $state(false);
  let lastConversationId: string | null = null;
  let conversationTabsScrollRef: HTMLDivElement | undefined = $state();

  function debugPanelSession(event: string, details: Record<string, unknown> = {}): void {
    console.info('[AssistantPanelSession]', { event, ...details, at: Date.now() });
  }

  $effect(() => {
    const currentId = assistantStore.currentConversation?.id ?? null;
    if (currentId && currentId !== lastConversationId) {
      hasContextWarned = false;
      lastConversationId = currentId;
    }
  });
  $effect(() => {
    if (assistantStore.panelOpen && inputRef) {
      setTimeout(() => inputRef?.focus(), 50);
    }
  });

  const isAssistantBusy = $derived.by(() => {
    const currentConversationId = assistantStore.currentConversation?.id ?? null;
    if (!currentConversationId) {
      return assistantStore.isStreaming;
    }

    const currentRunState = assistantStore.getOpenConversationTabs().find(
      (tab) => tab.id === currentConversationId,
    );

    if (currentRunState?.isRunning) return true;
    if (assistantStore.isStreaming) return true;
    return (
      assistantStore.agentLoopState === "running" ||
      assistantStore.agentLoopState === "waiting_tool" ||
      assistantStore.agentLoopState === "waiting_approval" ||
      assistantStore.agentLoopState === "completing"
    );
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

  function isAssistantDebugEnabled(): boolean {
    try {
      return typeof window !== "undefined" && window.localStorage.getItem("volt.assistant.debug") === "true";
    } catch {
      return false;
    }
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
    const conversationId = assistantStore.currentConversation?.id;
    if (!conversationId) return;
    debugPanelSession('handle_send_start', { conversationId });

    // Use inputRef value as fallback in case store value is out of sync
    const content = (assistantStore.inputValue || inputRef?.value || "").trim();
    if (!content && assistantStore.pendingAttachments.length === 0) return;

    // Add to input history for Up/Down arrow navigation
    assistantStore.addToHistory(content, [
      ...assistantStore.pendingAttachments,
    ]);

    // Cancel any existing stream (cancel-by-default policy)
    if (isAssistantBusy) {
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

    const runtimeContextBlock = buildRuntimeContextBlock({
      workspaceRoot: projectStore.rootPath,
      terminals: terminalStore.sessions.map((session) => ({
        id: session.id,
        cwd: session.cwd || session.info.cwd,
        label: terminalStore.getSessionLabel(session.id),
      })),
      git: {
        isRepo: gitStore.isRepo,
        branch: gitStore.status?.branch ?? null,
        staged: gitStore.status?.staged.length ?? 0,
        unstaged: gitStore.status?.unstaged.length ?? 0,
        untracked: gitStore.status?.untracked.length ?? 0,
        conflicted: gitStore.status?.conflicted.length ?? 0,
      },
    });
    systemPrompt = `${systemPrompt}\n\n---\n\n${runtimeContextBlock}`;

    const initialWorkingSetSummary = buildCompactWorkingSetSummary({
      goal: content,
      touchedFiles: [],
      lastMeaningfulAction: null,
      failureClass: null,
      pendingVerification: [],
      openBlocker: null,
    });

    let contextBlock = "";
    try {
      const contextV2 = await buildContextV2({
        query: content,
        modelId: selectedModel,
        workingSetSummary: initialWorkingSetSummary,
      });
      contextBlock = formatContextV2(contextV2);
      agentTelemetryStore.record({
        type: "agent.context.build",
        timestamp: Date.now(),
        estimatedTokensUsed: contextV2.stats.estimatedTokensUsed,
        snippetsSelected: contextV2.stats.snippetsSelected,
        droppedCandidates: contextV2.stats.droppedCandidates,
        staleVsFreshRatio:
          contextV2.stats.freshSnippetCount > 0
            ? Number(
                (
                  contextV2.stats.staleSnippetCount /
                  contextV2.stats.freshSnippetCount
                ).toFixed(2),
              )
            : contextV2.stats.staleSnippetCount > 0
              ? 1
              : 0,
        buildLatencyMs: contextV2.stats.buildLatencyMs,
        fallbackUsed: false,
        semanticCandidates: contextV2.stats.semanticCandidates,
        semanticSelected: contextV2.stats.semanticSelected,
        hybridDropped: contextV2.stats.hybridDropped,
        semanticQueryMs: contextV2.stats.semanticQueryMs,
        semanticIndexStalenessMs: contextV2.stats.semanticIndexStalenessMs,
        semanticBackend: contextV2.stats.semanticBackend,
        semanticModelLoadMs: contextV2.stats.semanticModelLoadMs,
        semanticLastError: contextV2.stats.semanticLastError,
      });
    } catch (error) {
      console.warn("[AssistantPanel] Context V2 build failed, using minimal fallback:", error);
      contextBlock = buildMinimalContextFallback(content);
      agentTelemetryStore.record({
        type: "agent.context.build",
        timestamp: Date.now(),
        estimatedTokensUsed: 0,
        snippetsSelected: 0,
        droppedCandidates: 0,
        staleVsFreshRatio: 0,
        buildLatencyMs: 0,
        fallbackUsed: true,
      });
    }

    // Add user message with content AND smart context as reference
    assistantStore.addUserMessage(content, context, contextBlock);

    // Get tools for current mode (includes MCP tools in agent mode)
    const tools = filterToolsForChat(
      getAllToolsForMode(assistantStore.currentMode),
      assistantStore.browserToolsEnabled,
      content,
    );

    const nextSummaryState = await autoSummarizeIfNeeded({
      selectedModel,
      controller,
      state: {
        hasContextWarned,
        isAutoSummarizing,
      },
      assistantStore,
      notify: showToast,
    });
    hasContextWarned = nextSummaryState.hasContextWarned;
    isAutoSummarizing = nextSummaryState.isAutoSummarizing;

    // Tool loop: keep streaming until model finishes without tool calls
    try {
      await runToolLoop(
        conversationId,
        systemPrompt,
        selectedModel,
        tools,
        controller,
        30,
      );
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
   * Robust error recovery, continuation prompts, high iteration limit
   */
  async function runToolLoop(
    conversationId: string,
    systemPrompt: string,
    modelId: string,
    tools: ReturnType<typeof getAllToolsForMode>,
    controller: AbortController,
    maxIterations = 60,
  ): Promise<void> {
    const msgId = assistantStore.addAssistantMessage("", true);
    const goal = assistantStore.getConversationMessages(conversationId)
      .slice()
      .reverse()
      .find((message) => message.role === "user")?.content?.trim() || "Continue current task";
    const isPlanMode = assistantStore.currentMode === "plan";
    const isAgentMode = assistantStore.currentMode === "agent";
    const failureNudgedSignatures = new Set<string>();
    const repetitionDetector = new ToolRepetitionDetector(3);
    let planModeViolationNudgeCount = 0;

    let fullContent = "";
    let iteration = 0;
    let hasToolsInConversation = false;
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
        model.includes(":free") ||
        model.includes("/free") ||
        model.includes("flash");
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
    const failureSignatureCounts = new Map<string, number>();
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
    const agentRuntime = createAgentRuntime();

    // Streaming safety guards
    const streamGuards = createStreamGuards();
    const strictDelayTextForTools = false;

    const getCompactWorkingSetSummary = (): string =>
      buildCompactWorkingSetSummary({
        goal,
        touchedFiles: Array.from(touchedFilePaths),
        lastMeaningfulAction: trackingState.lastMeaningfulAction,
        failureClass: trackingState.lastFailureClass,
        pendingVerification: Array.from(pendingVerificationState),
        openBlocker: trackingState.openBlocker,
      });

    // Log start of agent loop
    logOutput(
      "Volt",
      `Agent: Starting tool loop (max ${maxIterations} iterations)`,
    );
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
    assistantStore.setAgentLoopState("running", {
      iteration: 0,
      maxIterations,
      startedAt: loopStartedAt,
    });

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
        if (
          iterationLimitDecision.action === "extend" &&
          iterationLimitDecision.newMaxIterations
        ) {
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
          assistantStore.setAgentLoopState("failed", {
            iteration: maxIterations,
            reason: "max_iterations_reached",
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
      assistantStore.setAgentLoopState("running", {
        iteration,
        maxIterations,
      });

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
          assistantStore.setAgentLoopState("failed", {
            reason: "time_budget_exceeded",
            iteration,
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
        assistantStore.setAgentLoopState("cancelled", {
          reason: abortDecision.reason,
          iteration,
        });
        assistantStore.markAssistantMessageStreamState(
          msgId,
          "cancelled",
          "Streaming cancelled",
        );
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
      const fileEditQueues = new Map<string, QueuedFileEditTool[]>();
      // If the model emits an invalid tool call (e.g. missing required args/meta),
      // we must NOT leave it in a pending state (can deadlock approvals).
      const immediateResults: Array<{
        id: string;
        name: string;
        result: ToolResult;
      }> = [];
      const toolIdCounts = new Map<string, number>();
      const streamedToolIds = new Map<string, string>();
      let hadPlanModeViolationThisIteration = false;
      let warnedBrowserToolsDisabled = false;
      let toolCallSeenThisIteration = false;
      let stalledAbortReason: string | null = null;

      try {
        // Reduce hallucinations: use conservative temperature defaults per mode.
        const temperature =
          assistantStore.currentMode === "plan"
            ? 0.1
            : assistantStore.currentMode === "ask"
              ? 0.2
              : 0.15;

      let warnedAboutLooping = false;
      const toNovelStreamDelta = (
        existing: string,
        incoming: string,
      ): string => {
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
      const mergeIterationIntoFullContent = (
        existing: string,
        incoming: string,
      ): string => {
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
        onFlush: (text) => assistantStore.appendTextToMessage(msgId, text, true),
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

          if (chunk.type === "content" && chunk.content) {
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
                    "Assistant output started repeating. Repeated chunks are being skipped.",
                  type: "warning",
                });
              }
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
                    "Assistant output started looping. Repeated chunks are being skipped.",
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
          }

          if (chunk.type === "tool_call" && chunk.toolCall) {
            lastProgressAt = Date.now();
            const toolCallArgs = chunk.toolCall.arguments;
            const toolCallName = normalizeToolName(chunk.toolCall.name);
            const rawToolCallId =
              (chunk.toolCall.id && chunk.toolCall.id.trim()) ||
              `tool_${crypto.randomUUID().slice(0, 8)}`;
            const existingStreamedId = streamedToolIds.get(rawToolCallId);
            let toolCallId = existingStreamedId;
            if (!toolCallId) {
              const seenCount = toolIdCounts.get(rawToolCallId) ?? 0;
              toolIdCounts.set(rawToolCallId, seenCount + 1);
              toolCallId =
                seenCount === 0 ? rawToolCallId : `${rawToolCallId}__${seenCount + 1}`;
              streamedToolIds.set(rawToolCallId, toolCallId);
            }
            const toolCallThoughtSignature = chunk.toolCall.thoughtSignature;
            const isPartialToolCall = Boolean(chunk.partial);
            if (isPartialToolCall) {
              continue;
            }
            await textBuffer.flushNow();
            // End any active thinking part before adding tool call
            assistantStore.endThinkingPart(msgId);
            toolCallSeenThisIteration = true;
            // Keep already-streamed text visible when tools begin.
            // Tool cards are shown inline without retracting prior narration.
            hasToolsInConversation = true;
            const existingInlineToolCall = assistantStore.messages
              .find((msg) => msg.id === msgId)
              ?.inlineToolCalls?.find((tc) => tc.id === toolCallId);

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
              if (toolCallName !== "attempt_completion") {
                if (existingInlineToolCall) {
                  assistantStore.updateToolCallInMessage(
                    msgId,
                    toolCallId,
                    skippedToolCall,
                  );
                } else {
                  assistantStore.addToolCallToMessage(msgId, skippedToolCall);
                }
              }
              continue;
            }

            const validation = validateTool(
              toolCallName,
              toolCallArgs,
              assistantStore.currentMode,
            );
            const isInternalCompletionTool = toolCallName === "attempt_completion";
            const capabilities = getToolCapabilities(toolCallName);
            const isPlanModeViolation =
              isPlanMode &&
              (isTerminalToolName(toolCallName) ||
                (capabilities.isMutating &&
                  toolCallName !== "write_plan_file"));
            const effectiveValidationError = isPlanModeViolation
              ? `Tool "${toolCallName}" is not allowed in plan mode. In plan mode, use READ tools and optionally "write_plan_file" only.`
              : (validation.error ?? "Invalid tool call");
            const status: ToolCall["status"] =
              validation.valid &&
              !isPlanModeViolation
              ? "pending"
              : "failed";
            const toolCall: ToolCall = {
              id: toolCallId,
              name: toolCallName,
              arguments: toolCallArgs,
              status,
              requiresApproval: validation.requiresApproval,
              thoughtSignature: toolCallThoughtSignature,
              error: effectiveValidationError,
              endTime:
                validation.valid &&
                !isPlanModeViolation
                  ? undefined
                  : Date.now(),
            };

            if (!isInternalCompletionTool && !existingInlineToolCall) {
              assistantStore.addToolCallToMessage(msgId, toolCall);
            } else if (!isInternalCompletionTool && existingInlineToolCall) {
              assistantStore.updateToolCallInMessage(msgId, toolCallId, toolCall);
            }

            // Track every tool call (valid or invalid) so we can always attach a tool result
            // back to the model and keep Gemini's function-calling history consistent.
            allToolCalls.push({
              id: toolCallId,
              name: toolCallName,
              arguments: toolCallArgs,
              thoughtSignature: toolCallThoughtSignature,
            });

            if (
              !validation.valid ||
              isPlanModeViolation
            ) {
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
              if (
                !validation.valid &&
                toolCallName.startsWith("browser_") &&
                !assistantStore.browserToolsEnabled &&
                !warnedBrowserToolsDisabled
              ) {
                warnedBrowserToolsDisabled = true;
                showToast({
                  message:
                    "Browser tools are off. Click the globe toggle in chat to enable.",
                  type: "info",
                });
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
                } else {
                  assistantStore.updateToolCallInMessage(msgId, toolCallId, {
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

        await textBuffer.close();

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
        const planningPhaseRank = (toolName: string): number => {
          const phase = classifyPlanningPhase(toolName);
          if (phase === "discover") return 0;
          if (phase === "read") return 1;
          if (phase === "other") return 2;
          if (phase === "verify") return 3;
          return 4;
        };
        orderedImmediateNonFileTools = [...immediateNonFileTools].sort(
          (a, b) =>
            planningPhaseRank(a.name) - planningPhaseRank(b.name),
        );

        if (
          pendingToolCalls.length > 0 ||
          immediateNonFileTools.length > 0 ||
          deferredNonFileTools.length > 0 ||
          hasQueuedFileEdits
        ) {
          assistantStore.setAgentLoopState("waiting_tool", {
            iteration,
            pendingToolCalls: pendingToolCalls.length,
            eagerTools: immediateNonFileTools.length,
            deferredTools: deferredNonFileTools.length,
            fileQueues: fileEditQueues.size,
          });
        }
        } finally {
          clearInterval(stallWatchdog);
        }

        if (stalledAbortReason) {
          throw new Error(stalledAbortReason);
        }

        // Run non-file tools that don't depend on fresh edits.
        const eagerResults = await executeQueuedNonFileTools(
          orderedImmediateNonFileTools,
          {
            executeToolCall,
            signal: controller.signal,
            toolRunScope,
            getToolIdempotencyKey,
            updateToolCallInMessage:
              assistantStore.updateToolCallInMessage.bind(assistantStore),
            messageId: msgId,
            getFailureSignature,
            trackToolOutcome,
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
            trackToolOutcome,
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
            trackToolOutcome,
            onFailureSignature: (signature) => {
              const count = (failureSignatureCounts.get(signature) ?? 0) + 1;
              failureSignatureCounts.set(signature, count);
            },
          },
        );

        const verificationProfiles = getVerificationProfiles(projectStore.tree);
        const explicitVerificationCalled = allToolCalls.some((entry) =>
          isVerificationTool(
            entry.name,
            entry.arguments as Record<string, unknown>,
            verificationProfiles,
          ),
        );
        const fileEditsSucceeded = fileEditResults.some((entry) => entry.result.success);
        const autoVerificationAction = selectAutoVerificationAction({
          fileEditsSucceeded,
          explicitVerificationCalled,
          profiles: verificationProfiles,
          cwd: projectStore.rootPath,
        });
        const autoVerificationResults: Array<{
          id: string;
          name: string;
          result: ToolResult;
        }> = [];

        if (autoVerificationAction) {
          if (autoVerificationAction.toolName === 'get_diagnostics') {
            pendingVerificationState.add('diagnostics');
          } else if (
            autoVerificationAction.toolName === 'run_command' &&
            typeof autoVerificationAction.args.command === 'string'
          ) {
            pendingVerificationState.add(`command:${autoVerificationAction.args.command.trim()}`);
          }
          const autoToolId = `auto_verify_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          const autoToolCall: ToolCall = {
            id: autoToolId,
            name: autoVerificationAction.toolName,
            arguments: autoVerificationAction.args,
            status: "pending",
          };
          assistantStore.addToolCallToMessage(msgId, autoToolCall);
          allToolCalls.push({
            id: autoToolId,
            name: autoVerificationAction.toolName,
            arguments: autoVerificationAction.args,
          });
          assistantStore.updateToolCallInMessage(msgId, autoToolId, {
            status: "running",
            startTime: Date.now(),
            meta: { autoVerification: true, reason: autoVerificationAction.reason },
          });
          try {
            const result = await executeToolCall(
              autoVerificationAction.toolName,
              autoVerificationAction.args,
              {
                signal: controller.signal,
                idempotencyKey: getToolIdempotencyKey(
                  toolRunScope,
                  autoToolId,
                  autoVerificationAction.toolName,
                  autoVerificationAction.args,
                ),
              },
            );
            assistantStore.updateToolCallInMessage(msgId, autoToolId, {
              status: result.success ? "completed" : "failed",
              output: result.output,
              error: result.error,
              meta: {
                ...(result.meta || {}),
                autoVerification: true,
                reason: autoVerificationAction.reason,
              },
              data: result.data,
              endTime: Date.now(),
            });
            trackToolOutcome(
              autoVerificationAction.toolName,
              autoVerificationAction.args,
              result,
            );
            const signature = getFailureSignature(
              autoVerificationAction.toolName,
              autoVerificationAction.args,
              result,
            );
            if (signature) {
              const count = (failureSignatureCounts.get(signature) ?? 0) + 1;
              failureSignatureCounts.set(signature, count);
            }
            autoVerificationResults.push({
              id: autoToolId,
              name: autoVerificationAction.toolName,
              result,
            });
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            const result: ToolResult = {
              success: false,
              error: `Automatic verification failed: ${error}`,
              warnings: ["auto_verification_failed"],
              meta: {
                code: "AUTO_VERIFICATION_FAILED",
                autoVerification: true,
              },
            };
            assistantStore.updateToolCallInMessage(msgId, autoToolId, {
              status: "failed",
              error: result.error,
              meta: result.meta,
              endTime: Date.now(),
            });
            autoVerificationResults.push({
              id: autoToolId,
              name: autoVerificationAction.toolName,
              result,
            });
          }
        }

        // Combine all results
        const allEagerResults = [
          ...eagerResults,
          ...fileEditResults,
          ...deferredResults,
          ...autoVerificationResults,
        ];

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

          consecutiveEmptyResponses =
            noToolOutcome.state.consecutiveEmptyResponses;
          justProcessedToolResults =
            noToolOutcome.state.justProcessedToolResults;
          planModeViolationNudgeCount =
            noToolOutcome.state.planModeViolationNudgeCount;
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
              updateAssistantMessage:
                assistantStore.updateAssistantMessage.bind(assistantStore),
              markAssistantMessageStreamState:
                assistantStore.markAssistantMessageStreamState.bind(assistantStore),
              setAgentLoopState: assistantStore.setAgentLoopState.bind(assistantStore),
              finalizeOutcome,
              loopLog,
              showToast,
            });
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

        const uniqueResults = new Map<
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
              error:
                "Tool call did not produce a response (contract violation).",
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
        if (completionCandidate && (touchedFilePaths.size > 0 || structuralMutationPaths.size > 0)) {
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
            const diagMeta = (diagnosticsGateResult.meta ??
              {}) as Record<string, unknown>;
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
            const gateCode = typeof gateDecision.meta?.code === 'string' ? gateDecision.meta.code : undefined;
            if (gateDecision.shouldBlock && gateDecision.message && gateCode) {
              const gateMessage = gateDecision.message;
              trackingState.lastFailureClass = 'diagnostics_blocked';
              trackingState.openBlocker = gateMessage;
              pendingVerificationState.add('diagnostics');
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
              assistantStore.updateToolCallInMessage(
                msgId,
                completionCandidate.id,
                {
                  status: "failed",
                  error: gateMessage,
                  endTime: Date.now(),
                  meta: gateDecision.meta,
                },
              );
              assistantStore.addToolMessage({
                id: `completion_gate_${Date.now()}`,
                name: "_system_completion_gate",
                arguments: {},
                status: "completed",
                output: (gateDecision.meta?.verificationPlan as { requiresFollowUp?: boolean; recommendedTools?: string[] } | undefined)?.requiresFollowUp
                  ? `${gateDecision.output ?? gateMessage}\n\nRecommended follow-up: ${((gateDecision.meta?.verificationPlan as { recommendedTools?: string[] } | undefined)?.recommendedTools ?? []).join(", ")}`
                  : gateDecision.output ?? gateMessage,
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
        const toolsNeedingApproval = pendingToolCalls.filter(
          (tc) => !eagerIds.has(tc.id),
        );

        if (toolsNeedingApproval.length > 0) {
          assistantStore.setAgentLoopState("waiting_approval", {
            iteration,
            pendingApprovals: toolsNeedingApproval.length,
          });

          const approvalsProcessed = await processToolsNeedingApproval(
            msgId,
            toolsNeedingApproval,
            normalizedToolResults,
            {
              isTerminalToolName,
              getToolCapabilities,
              waitForToolApprovals,
              waitForToolCompletion,
              getMessages: () => assistantStore.getConversationMessages(conversationId),
              updateToolCallInMessage:
                assistantStore.updateToolCallInMessage.bind(assistantStore),
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
            },
          );
          const approvalDecision = agentRuntime.evaluateApprovalFlow(approvalsProcessed);
          if (approvalDecision.shouldAbort && approvalDecision.reason) {
            assistantStore.markAssistantMessageStreamState(
              msgId,
              approvalDecision.streamState ?? "failed",
              approvalDecision.streamIssue ?? "Approval flow incomplete",
            );
            assistantStore.setAgentLoopState("failed", {
              iteration,
              reason: approvalDecision.reason,
            });
            finalizeOutcome("failed", approvalDecision.reason, {
              iteration,
            });
            return;
          }
          assistantStore.setAgentLoopState("running", {
            iteration,
            resumedAfterApproval: true,
          });
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
          const [toolName = '', maybePath = ''] = signature.split(':', 3);
          const classified = classifyRecoveryIssue(
            toolName,
            maybePath ? { path: maybePath } : {},
            { success: false, error: signature },
          );
          repeatedFailureHint = buildRecoveryHint(classified ?? 'generic', {
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
          fullContent,
        });
        if (completionDecision.shouldComplete && completionDecision.completionToolId) {
          assistantStore.setAgentLoopState("completing", {
            iteration,
            completionToolId: completionDecision.completionToolId,
          });
          const completionText = completionDecision.completionText ?? "";
          if (completionText) {
            fullContent = completionText;
            assistantStore.updateAssistantMessage(msgId, fullContent, false);
          }
          assistantStore.markAssistantMessageStreamState(msgId, "completed");
          assistantStore.setAgentLoopState("completed", {
            iteration,
            completionToolId: completionDecision.completionToolId,
          });
          finalizeOutcome("completed", completionDecision.reason ?? "attempt_completion", {
            iteration,
            completionToolId: completionDecision.completionToolId,
          });
          loopLog("info", "loop_completed", {
            reason: completionDecision.reason ?? "attempt_completion",
            completionToolId: completionDecision.completionToolId,
          });
          logOutput(
            "Volt",
            `Agent: Completion accepted via attempt_completion at iteration ${iteration}.`,
          );
          return;
        }

        // Mark that we just processed tool results - if model doesn't respond next iteration,
        // we'll prompt it to continue
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
            assistantStore.setAgentLoopState("failed", {
              iteration,
              reason: abortIterationDecision.reason,
              error: abortIterationDecision.userMessage,
            });
            finalizeOutcome("failed", abortIterationDecision.reason, {
              iteration,
              error: abortIterationDecision.userMessage,
            });
            loopLog("error", "loop_failed", {
              reason: abortIterationDecision.reason,
              error: abortIterationDecision.userMessage,
            });
            showToast({ message: abortIterationDecision.userMessage, type: "warning" });
            return;
          }
          assistantStore.markAssistantMessageStreamState(
            msgId,
            "cancelled",
            "Streaming cancelled",
          );
          assistantStore.setAgentLoopState("cancelled", {
            iteration,
            reason: "abort_during_iteration",
          });
          finalizeOutcome("cancelled", "abort_during_iteration", {
            iteration,
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
        assistantStore.updateAssistantMessage(
          msgId,
          iterationErrorDecision.userMessage,
          false,
        );
        assistantStore.markAssistantMessageStreamState(
          msgId,
          iterationErrorDecision.isInterrupted ? "interrupted" : "failed",
          msg,
        );
        assistantStore.setAgentLoopState("failed", {
          iteration,
          reason: iterationErrorDecision.reason,
          error: msg,
        });
        finalizeOutcome("failed", iterationErrorDecision.reason, {
          iteration,
          error: msg,
        });
        showToast({ message: msg, type: "error" });
        return;
      }
    }
  }

  /**
   * Execute a tool call and update its status
   * Supports streaming progress for file write operations
   */
  async function executeToolAndUpdate(
    toolCall: ToolCall,
    options?: {
      conversationId?: string;
      messageId?: string;
      abortSignal?: AbortSignal;
    },
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const conversationId =
      options?.conversationId ?? assistantStore.currentConversation?.id ?? "ad-hoc";
    const scopedSignal = options?.abortSignal ?? signal;
    return executeToolWithUpdates({
      toolCall,
      signal: scopedSignal,
      idScope: conversationId,
      executeToolCall,
      getToolIdempotencyKey,
      updateToolCall: (toolCallId, patch) => {
        if (options?.messageId) {
          assistantStore.updateToolCallInMessage(options.messageId, toolCallId, patch);
          return;
        }
      },
    });
  }

  function handleStop(): void {
    assistantStore.stopStreaming();
  }

  function handleQuickPrompt(prompt: string): void {
    assistantStore.setInputValue(prompt, "user");
    if (inputRef) {
      inputRef.value = prompt;
      const cursor = prompt.length;
      inputRef.setSelectionRange(cursor, cursor);
      inputRef.focus();
    }
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
        const base64Data = await readBinaryFileBase64(path);
        if (!base64Data) {
          throw new Error(`Failed to read ${path}`);
        }

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
    assistantStore.newConversation();
    chatHistoryStore.activeConversationId =
      assistantStore.currentConversation?.id ?? null;

    void (async () => {
      await saveConversationToHistory();
      await chatHistoryStore.loadConversations();
    })();
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
   * Handle tool approval from inline display in message.
   * Approvals only unlock execution; the tool loop remains the single executor
   * so terminal commands cannot race each other or bypass queue ordering.
   */
  async function handleToolApproveInMessage(
    messageId: string,
    toolCall: ToolCall,
  ): Promise<void> {
    const conversationId = assistantStore.currentConversation?.id;
    if (!conversationId) return;
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

    const approvedArguments =
      isTerminalToolName(toolCall.name) &&
      !(
        typeof toolCall.arguments.cwd === "string" &&
        toolCall.arguments.cwd.trim()
      ) &&
      projectStore.rootPath
        ? {
            ...toolCall.arguments,
            cwd: projectStore.rootPath,
          }
        : toolCall.arguments;

    assistantStore.updateToolCallInMessage(messageId, toolCall.id, {
      arguments: approvedArguments,
      reviewStatus: "accepted",
      meta: {
        approvedAt: Date.now(),
        liveStatus: isTerminalToolName(toolCall.name)
          ? "Queued..."
          : "Approved...",
      },
    });
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
      reviewStatus: "rejected",
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
      const diskContent = await readFileQuiet(resolvedPlanPath);
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
    const liveTitle = assistantStore.currentConversation?.title?.trim();
    if (liveTitle) return liveTitle;

    const activeId = chatHistoryStore.activeConversationId;
    if (!activeId) return "New Chat";
    const conv = chatHistoryStore.conversations.find((c) => c.id === activeId);
    return conv?.title || "New Chat";
  });

  const conversationTabs = $derived.by(() => assistantStore.getOpenConversationTabs());

  function handleSelectTab(conversationId: string): void {
    if (!conversationId || assistantStore.currentConversation?.id === conversationId) return;
    const summary = chatHistoryStore.conversations.find((conv) => conv.id === conversationId);
    if (assistantStore.switchToConversation(conversationId, summary)) {
      chatHistoryStore.activeConversationId = conversationId;
      return;
    }

    if (!summary) return;
    void chatHistoryStore.getConversation(conversationId)
      .then((conversation) => {
        assistantStore.loadConversation(conversation);
        chatHistoryStore.activeConversationId = conversationId;
      })
      .catch((error) => {
        console.error('[AssistantPanel] Failed to switch conversation tab:', error);
      });
  }

  function handleCloseTab(conversationId: string, event: MouseEvent): void {
    event.stopPropagation();
    debugPanelSession('close_tab', {
      conversationId,
      activeConversationId: assistantStore.currentConversation?.id ?? null,
    });
    assistantStore.closeConversationTab(conversationId);
    chatHistoryStore.activeConversationId = assistantStore.currentConversation?.id ?? null;
  }
</script>

<aside class="assistant-panel" aria-label="AI Assistant">
  <!-- Header -->
  <header class="panel-header">
    <div class="header-left">
      <div class="header-icon">
        <UIIcon name="comment" size={14} />
      </div>
      <div class="conversation-tabs" bind:this={conversationTabsScrollRef}>
        {#each conversationTabs as tab (tab.id)}
          <div
            class="conversation-tab"
            class:active={tab.isActive}
            class:running={tab.isRunning}
            class:error={tab.hasError}
          >
            <button
              class="conversation-tab-main"
              type="button"
              title={tab.title}
              aria-label={tab.title}
              onclick={() => handleSelectTab(tab.id)}
            >
            <span class="conversation-tab-status" aria-hidden="true"></span>
            <span class="conversation-tab-title">{tab.title || currentChatTitle}</span>
            <span class="conversation-tab-meta">{tab.isRunning ? 'Running' : 'Idle'}</span>
            </button>
            <button
              class="conversation-tab-close"
              type="button"
              title="Close tab"
              aria-label="Close {tab.title}"
              onclick={(event) => handleCloseTab(tab.id, event)}
            >
              <UIIcon name="close" size={10} />
            </button>
          </div>
        {/each}
      </div>
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
      scrollRevision={assistantStore.chatScrollRevision}
      onQuickPrompt={handleQuickPrompt}
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
      isStreaming={isAssistantBusy}
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


