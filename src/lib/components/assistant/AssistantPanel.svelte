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
  import {
    sendChat,
    streamChat,
    type ChatMessage,
    type ContentPart,
    type FunctionResponsePart,
  } from "$lib/services/ai";
  import { getSystemPrompt } from "$lib/services/ai/prompts-v4";
  import {
    getSmartContext,
    formatSmartContext,
  } from "$lib/services/ai/context";
  import {
    getAllToolsForMode,
    getToolByName,
    validateToolCall as validateTool,
    executeToolCall,
    getToolCapabilities,
    isFileMutatingTool,
    isTerminalTool as isTerminalToolName,
    type ToolResult,
  } from "$lib/services/ai/tools";
  import { resolvePath } from "$lib/services/ai/tools/utils";
  import MessageList from "./MessageList.svelte";
  import ChatHistorySidebar from "./ChatHistorySidebar.svelte";
  import ChatInputBar from "./ChatInputBar.svelte";
  import RevertConfirmationModal from "./RevertConfirmationModal.svelte";
  import { open } from "@tauri-apps/plugin-dialog";
  import { readTextFile } from "@tauri-apps/plugin-fs";
  import { invoke } from "@tauri-apps/api/core";
  import {
    } from "$lib/services/monaco-models";
  import { chatHistoryStore } from "$lib/stores/chat-history.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";

  // Revert confirmation state
  let confirmRevertOpen = $state(false);
  let revertMetadata = $state<any[]>([]);
  let pendingRevertId = $state<string | null>(null);
  let selectedImage = $state<{
    data: string;
    label: string;
    mimeType: "image/png" | "image/jpeg" | "image/webp";
  } | null>(null);

  // Focus the input when panel opens
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

  function formatMessageForSummary(
    msg: (typeof assistantStore.messages)[number],
  ): string {
    if (msg.role === "system") {
      return `SYSTEM: ${msg.content}`;
    }
    if (msg.role === "tool") {
      const toolLines = (msg.toolCalls || []).map((tc) => {
        const output =
          tc.output ??
          (tc.data ? JSON.stringify(tc.data) : undefined) ??
          tc.error ??
          "No output";
        return `TOOL ${tc.name} (${tc.status}): ${output}`;
      });
      return toolLines.join("\n");
    }
    if (msg.role === "assistant") {
      return `ASSISTANT: ${msg.content || ""}`.trim();
    }
    return `USER: ${msg.content || ""}`.trim();
  }

  function buildSummaryInput(
    messages: (typeof assistantStore.messages)[number][],
    existingSummary?: string,
  ): string {
    const transcript = messages
      .map((m) => formatMessageForSummary(m))
      .filter(Boolean)
      .join("\n");

    const summaryHeader = existingSummary
      ? `Existing summary (update it, do NOT repeat verbatim):\n${existingSummary}\n\n`
      : "";

    return (
      `${summaryHeader}Summarize the conversation segment below in a structured, factual format.\n\n` +
      `Format:\n` +
      `Goals:\n- ...\n` +
      `Key Decisions:\n- ...\n` +
      `Files Changed:\n- path — what/why\n` +
      `Open TODOs:\n- ...\n` +
      `Constraints/Preferences:\n- ...\n` +
      `Risks/Unknowns:\n- ...\n\n` +
      `Rules:\n- Use facts only. If uncertain, write "Unknown".\n` +
      `- Include file paths and tool outputs when relevant.\n` +
      `- Keep it compact and precise.\n\n` +
      `Conversation segment:\n${transcript}`
    );
  }

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

  function normalizeQueueKey(path: string): string {
    if (!path) return path;
    const resolved = resolvePath(path);
    const normalized = resolved.replace(/\\/g, "/");
    if (/^[A-Za-z]:/.test(normalized)) {
      return normalized.toLowerCase();
    }
    return normalized;
  }

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
    return () => window.removeEventListener("volt:assistant-send", onAssistantSend);
  });

  function stableStringify(value: unknown): string {
    if (value == null || typeof value !== "object") {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map((v) => stableStringify(v)).join(",")}]`;
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(",")}}`;
  }

  function getToolIdempotencyKey(
    scopeId: string,
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): string {
    return `${scopeId}:${toolCallId}:${toolName}:${stableStringify(args)}`;
  }

  function shouldRunAfterFileEdits(toolName: string): boolean {
    if (toolName === "get_diagnostics" || toolName.startsWith("lsp_")) {
      return true;
    }

    const tool = getToolByName(toolName);
    const capabilities = getToolCapabilities(toolName);
    if (
      !tool ||
      capabilities.isMutating ||
      tool.category === "terminal" ||
      tool.category === "browser"
    ) {
      return false;
    }

    return (
      tool.category === "workspace_read" ||
      tool.category === "workspace_search" ||
      tool.category === "editor_context" ||
      tool.category === "diagnostics" ||
      capabilities.requiresWorkspacePathValidation
    );
  }

  function getAdaptiveFileEditConcurrency(queueCount: number): number {
    if (queueCount >= 12) return 2;
    if (queueCount >= 6) return 3;
    return 4;
  }

  async function mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    if (items.length === 0) return [];
    const bounded = Math.max(1, Math.min(concurrency, items.length));
    const results: R[] = new Array(items.length);
    let cursor = 0;

    const runWorker = async (): Promise<void> => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    };

    await Promise.all(Array.from({ length: bounded }, () => runWorker()));
    return results;
  }

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

  function toProviderMessages(
    messages: typeof assistantStore.messages,
  ): ChatMessage[] {
    const out: ChatMessage[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        out.push({ role: "system", content: msg.content });
        continue;
      }
      // Handle tool messages - convert to function response
      // These are the results of tool executions that need to go back to the model
      if (msg.role === "tool" && msg.toolCalls && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
          const responsePart: FunctionResponsePart = {
            type: "function_response",
            id: tc.id,
            name: tc.name,
            response: {
              success: tc.status === "completed",
              output:
                tc.output ??
                (tc.data ? JSON.stringify(tc.data) : undefined) ??
                tc.error ??
                "No output",
              error: tc.error ?? "",
              meta: tc.meta ?? {},
              data: tc.data,
            },
          };
          out.push({
            role: "user", // Function responses go as user role per Gemini API
            content: "",
            parts: [responsePart],
          });
        }
        continue;
      }

      if (msg.role === "assistant") {
        // CRITICAL: Include function calls in assistant message for multi-turn
        // Gemini requires the model's function call to be in history before function response
        const hasToolCalls =
          msg.inlineToolCalls && msg.inlineToolCalls.length > 0;

        if (hasToolCalls) {
          // Build parts: text content + function calls
          const parts: ContentPart[] = [];

          // 1. Add text content if present
          if (msg.content && msg.content.trim()) {
            parts.push({ type: "text", text: msg.content });
          }

          // 2. Add function call parts - these tell Gemini what the model called
          // CRITICAL: Include thoughtSignature for Gemini 3 models
          if (msg.inlineToolCalls) {
            for (const tc of msg.inlineToolCalls) {
              parts.push({
                type: "function_call",
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
                // Preserve thought signature for Gemini 3 multi-turn function calling
                thoughtSignature: tc.thoughtSignature,
              });
            }
          }

          out.push({ role: "assistant", content: msg.content, parts });
        } else {
          // No tool calls or thinking, just text content
          out.push({ role: "assistant", content: msg.content });
        }
        continue;
      }

      if (msg.role !== "user") continue;

      const attachments = msg.attachments ?? [];
      const imageAttachments = attachments.filter(
        (a) => a.type === "image",
      ) as ImageAttachment[];
      const elementAttachments = attachments.filter(
        (a) => a.type === "element",
      ) as ElementAttachment[];

      // Build parts for multimodal or context-rich messages
      const parts: ContentPart[] = [];

      // 1. Add Smart Context first as reference (hidden from UI)
      if (msg.smartContextBlock) {
        // Wrap in XML tags to prevent "completion" hallucinations where the model
        // treats the context as a sentence to finish.
        parts.push({
          type: "text",
          text: `<system_context>\n${msg.smartContextBlock}\n</system_context>`,
        });
      }

      // 1.5. Add Element Context (hidden from UI, shown as chip)
      for (const el of elementAttachments) {
        const elementContext = `<selected_element>
Element: <${el.tagName}${el.selector ? ` selector="${el.selector}"` : ""}>
HTML:
\`\`\`html
${el.html}
\`\`\`
CSS Properties:
${Object.entries(el.css)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join("\n")}
Dimensions: ${Math.round(el.rect.width)}×${Math.round(el.rect.height)} at (${Math.round(el.rect.x)}, ${Math.round(el.rect.y)})
</selected_element>`;
        parts.push({ type: "text", text: elementContext });
      }

      // 2. Add User Content
      if (msg.content && msg.content.trim()) {
        parts.push({ type: "text", text: msg.content });
      }

      // 3. Add Images
      for (const img of imageAttachments) {
        parts.push({ type: "image", mimeType: img.mimeType, data: img.data });
      }

      // If we only have text and no context/images, send simple content
      if (
        parts.length === 1 &&
        parts[0].type === "text" &&
        !msg.smartContextBlock
      ) {
        out.push({ role: "user", content: msg.content });
      } else if (parts.length > 0) {
        out.push({ role: "user", content: msg.content, parts });
      }
      continue;
    }

    return out;
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
    const { mcpStore } = await import("$lib/stores/mcp.svelte");
    const mcpToolsInfo = mcpStore.tools.map(({ serverId, tool }) => {
      const required = (tool.inputSchema as any)?.required || [];
      const description = tool.description || `MCP tool from ${serverId}`;
      const fullDesc =
        required.length > 0
          ? `${description} (Required: ${required.join(", ")})`
          : description;
      return {
        serverId,
        toolName: tool.name,
        description: fullDesc,
      };
    });

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
    const conv = assistantStore.currentConversation;
    if (!conv || conv.messages.length === 0) return;

    try {
      // Always try to create/update the conversation first
      // The backend will handle upsert logic (ignore if exists)
      try {
        await chatHistoryStore.createConversation(
          conv.id,
          assistantStore.currentMode,
        );
        chatHistoryStore.activeConversationId = conv.id;
      } catch (createErr) {
        // Conversation might already exist, that's fine
        console.log(
          "[AssistantPanel] Conversation may already exist:",
          createErr,
        );
      }

      // Save each message
      for (const msg of conv.messages) {
        const metadata = JSON.stringify({
          attachments: msg.attachments,
          toolCalls: msg.toolCalls,
          inlineToolCalls: msg.inlineToolCalls,
          contentParts: msg.contentParts,
          thinking: msg.thinking,
          smartContextBlock: msg.smartContextBlock,
          contextMentions: msg.contextMentions,
          isSummary: msg.isSummary,
        });

        try {
          await chatHistoryStore.saveMessage(conv.id, {
            id: msg.id,
            role: msg.role,
            content: msg.content,
            timestamp: msg.timestamp,
            metadata,
          });
        } catch (msgErr) {
          // Message might already exist (duplicate ID), skip
          console.log("[AssistantPanel] Message may already exist:", msgErr);
        }
      }

      console.log(
        "[AssistantPanel] Saved conversation:",
        conv.id,
        "with",
        conv.messages.length,
        "messages",
      );
    } catch (err) {
      console.error("[AssistantPanel] Failed to save conversation:", err);
    }
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

    // Streaming safety guards
    let lastChunk = "";
    let repeatedChunkCount = 0;
    const strictDelayTextForTools = false;

    const shouldAbortForLeak = (text: string): boolean => {
      const lower = text.toLowerCase();
      return (
        lower.includes("<system_context") ||
        lower.includes("</system_context") ||
        lower.includes("<smart_context") ||
        lower.includes("</smart_context")
      );
    };

    const isDegenerateRepeat = (chunk: string): boolean => {
      const normalized = chunk.trim();
      if (!normalized) return false;

      if (normalized === lastChunk) {
        repeatedChunkCount++;
      } else {
        lastChunk = normalized;
        repeatedChunkCount = 1;
      }

      return repeatedChunkCount >= 6;
    };

    let lastLine = "";
    let repeatedLineCount = 0;
    const isDegenerateLineRepeat = (text: string): boolean => {
      const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const current = lines.length > 0 ? lines[lines.length - 1] : "";
      if (!current) return false;

      // Ignore very short lines (high false-positive risk)
      if (current.length < 18) return false;

      if (current === lastLine) {
        repeatedLineCount++;
      } else {
        lastLine = current;
        repeatedLineCount = 1;
      }

      if (repeatedLineCount >= 6) return true;

      const lower = current.toLowerCase();
      if (lower.startsWith("i'll also") || lower.startsWith("i will also")) {
        const count = (text.toLowerCase().match(/\bi\s*'?ll\s+also\b/g) ?? [])
          .length;
        if (count >= 10) return true;
      }

      return false;
    };

    // Log start of agent loop
    import("$lib/stores/output.svelte").then((m) =>
      m.logOutput(
        "Volt",
        `Agent: Starting tool loop (max ${maxIterations} iterations)`,
      ),
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
        import("$lib/stores/output.svelte").then((m) =>
          m.logOutput("Volt", `Agent: Loop aborted at iteration ${iteration}`),
        );
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
      const queuedNonFileTools: Array<{
        id: string;
        name: string;
        args: Record<string, unknown>;
        runAfterFileEdits: boolean;
      }> = [];
      // Queue for sequential file edits - edits to the same file run one after another
      const fileEditQueues = new Map<
        string,
        Array<{
          id: string;
          name: string;
          args: Record<string, unknown>;
          queueIndex: number;
        }>
      >();
      // If the model emits an invalid tool call (e.g. missing required args/meta),
      // we must NOT leave it in a pending state (can deadlock approvals).
      const immediateResults: Array<{
        id: string;
        name: string;
        result: ToolResult;
      }> = [];

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
            if (shouldAbortForLeak(chunk.content)) {
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

            if (isDegenerateRepeat(chunk.content)) {
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

            if (isDegenerateLineRepeat(iterationContent + chunk.content)) {
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
            // Stream ALL content to UI immediately (no truncation)
            assistantStore.appendTextToMessage(msgId, chunk.content, true);
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
              error: validation.valid
                ? undefined
                : (validation.error ?? "Invalid tool call"),
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
              // Feed an error tool result back to the model so the conversation stays consistent.
              immediateResults.push({
                id: toolCallId,
                name: toolCallName,
                result: {
                  success: false,
                  error: validation.error ?? "Invalid tool call",
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
                isTerminalToolName(toolCallName) && capabilities.requiresApproval;
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
                const runAfterFileEdits =
                  shouldRunAfterFileEdits(toolCallName);

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

        // All content already streamed to UI, just update fullContent for history
        fullContent += iterationContent;

        // Reset repetition guard per iteration boundary so we don't over-trigger
        // on unrelated chunks in later iterations.
        lastChunk = "";
        repeatedChunkCount = 0;

        const executeQueuedNonFileTools = (
          toolsToRun: Array<{
            id: string;
            name: string;
            args: Record<string, unknown>;
            runAfterFileEdits: boolean;
          }>,
        ): Promise<
          Array<{
            id: string;
            name: string;
            result: ToolResult;
          }>
        > => {
          for (const queued of toolsToRun) {
            assistantStore.updateToolCallInMessage(msgId, queued.id, {
              status: "running" as const,
              startTime: Date.now(),
            });
          }

          const promises = toolsToRun.map((queued) =>
            executeToolCall(queued.name, queued.args, {
              signal: controller.signal,
              idempotencyKey: getToolIdempotencyKey(
                toolRunScope,
                queued.id,
                queued.name,
                queued.args,
              ),
            })
              .then((result) => {
                assistantStore.updateToolCallInMessage(msgId, queued.id, {
                  status: result.success ? "completed" : "failed",
                  output: result.output,
                  error: result.error,
                  meta: result.meta,
                  data: result.data,
                  endTime: Date.now(),
                });
                return { id: queued.id, name: queued.name, result };
              })
              .catch((err) => {
                const error = err instanceof Error ? err.message : String(err);
                assistantStore.updateToolCallInMessage(msgId, queued.id, {
                  status: "failed",
                  error,
                  endTime: Date.now(),
                });
                return {
                  id: queued.id,
                  name: queued.name,
                  result: { success: false, error },
                };
              }),
          );

          return Promise.all(promises);
        };

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
        );

        // Execute file edits SEQUENTIALLY per file path
        // This prevents race conditions where multiple str_replace calls to the same file
        // fail because the file content changed between reads
        const fileEditTasks = Array.from(fileEditQueues.entries());
        const fileEditConcurrency = getAdaptiveFileEditConcurrency(
          fileEditTasks.length,
        );
        const fileEditResultsNested = await mapWithConcurrency(
          fileEditTasks,
          fileEditConcurrency,
          async ([, edits]) => {
            let previousFailed = false;
            const results: Array<{
              id: string;
              name: string;
              result: {
                success: boolean;
                output?: string;
                error?: string;
                meta?: any;
              };
            }> = [];

            for (const edit of edits) {
              // If a previous edit to this file failed, skip remaining edits
              if (previousFailed) {
                assistantStore.updateToolCallInMessage(msgId, edit.id, {
                  status: "failed",
                  error: "Skipped: A previous edit to this file failed.",
                  endTime: Date.now(),
                  meta: { editPhase: "failed", queueIndex: edit.queueIndex },
                });
                results.push({
                  id: edit.id,
                  name: edit.name,
                  result: {
                    success: false,
                    error: "Skipped: A previous edit to this file failed.",
                  },
                });
                continue;
              }

              // Update UI to show writing in progress
              assistantStore.updateToolCallInMessage(msgId, edit.id, {
                status: "running" as const,
                startTime: Date.now(),
                meta: { editPhase: "writing", queueIndex: edit.queueIndex },
              });

              try {
                const isLastEditForPath = edit.queueIndex === edits.length;
                const result = await executeToolCall(
                  edit.name,
                  {
                    ...edit.args,
                    postEditDiagnostics: isLastEditForPath,
                  },
                  {
                    signal: controller.signal,
                    idempotencyKey: getToolIdempotencyKey(
                      toolRunScope,
                      edit.id,
                      edit.name,
                      {
                        ...edit.args,
                        postEditDiagnostics: isLastEditForPath,
                      },
                    ),
                  },
                );

                assistantStore.updateToolCallInMessage(msgId, edit.id, {
                  status: result.success ? "completed" : "failed",
                  output: result.output,
                  error: result.error,
                  meta: {
                    ...(result.meta || {}),
                    editPhase: result.success ? "done" : "failed",
                    queueIndex: edit.queueIndex,
                  },
                  data: result.data,
                  endTime: Date.now(),
                });

                results.push({ id: edit.id, name: edit.name, result });

                if (!result.success) {
                  previousFailed = true;
                }
              } catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                assistantStore.updateToolCallInMessage(msgId, edit.id, {
                  status: "failed",
                  error,
                  endTime: Date.now(),
                  meta: { editPhase: "failed", queueIndex: edit.queueIndex },
                });
                results.push({
                  id: edit.id,
                  name: edit.name,
                  result: { success: false, error },
                });
                previousFailed = true;
              }
            }

            return results;
          },
        );
        const fileEditResults = fileEditResultsNested.flat();

        // Run diagnostics/LSP tools after file edits so they see latest state.
        const deferredResults = await executeQueuedNonFileTools(
          deferredNonFileTools,
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
          // Check if model only produced thinking but no actual response
          // This can happen with Gemini thinking mode - model thinks but doesn't act
          if (iterationThinking && !iterationContent.trim()) {
            consecutiveEmptyResponses++;

            import("$lib/stores/output.svelte").then((m) =>
              m.logOutput(
                "Volt",
                `Agent: Model produced thinking but no response (${consecutiveEmptyResponses}/${MAX_EMPTY_RESPONSES}), prompting continuation...`,
              ),
            );

            // Check if we've hit max empty responses
            if (consecutiveEmptyResponses >= MAX_EMPTY_RESPONSES) {
              import("$lib/stores/output.svelte").then((m) =>
                m.logOutput(
                  "Volt",
                  `Agent: Too many empty responses, stopping.`,
                ),
              );
              assistantStore.updateAssistantMessage(
                msgId,
                fullContent ||
                  "I apologize, but I'm having trouble generating a response. Please try rephrasing your request.",
                false,
              );
              return;
            }

            // Add a continuation prompt to encourage the model to respond
            assistantStore.addToolMessage({
              id: `thinking_continue_${Date.now()}`,
              name: "_system_continuation",
              arguments: {},
              status: "completed",
              output:
                "You completed your reasoning but didn't provide a response or take action. Based on your thinking, please now either: (1) call the appropriate tool to execute your plan, or (2) provide a text response to the user. Do NOT remain silent after thinking.",
            });

            continue; // Continue to next iteration
          }

          // Check if model said it would do something but stopped without calling tools
          // This happens when Gemini stream ends prematurely before emitting tool call
          // Detect phrases like "I'll", "I will", "First,", "Let me" followed by action words
          const incompleteActionPatterns = [
            /\b(i'll|i will|let me|first,?\s*i'll|first,?\s*i will)\s+(update|edit|modify|change|fix|add|create|search|find|read|write|replace)/i,
            /\bfirst,?\s*(i'll|i will|let me)\b/i,
            /\b(updating|editing|modifying|searching|reading)\s+the\s+/i,
          ];
          const looksIncomplete = incompleteActionPatterns.some((p) =>
            p.test(iterationContent),
          );

          if (looksIncomplete && iterationContent.trim()) {
            consecutiveEmptyResponses++;

            import("$lib/stores/output.svelte").then((m) =>
              m.logOutput(
                "Volt",
                `Agent: Model said it would act but stopped without tool call (${consecutiveEmptyResponses}/${MAX_EMPTY_RESPONSES}), prompting continuation...`,
              ),
            );

            // Check if we've hit max empty responses
            if (consecutiveEmptyResponses >= MAX_EMPTY_RESPONSES) {
              import("$lib/stores/output.svelte").then((m) =>
                m.logOutput(
                  "Volt",
                  `Agent: Too many incomplete actions, stopping.`,
                ),
              );
              assistantStore.updateAssistantMessage(
                msgId,
                fullContent +
                  "\n\n(Stream ended unexpectedly. Please try again.)",
                false,
              );
              return;
            }

            // Add a continuation prompt to nudge the model to actually call the tool
            assistantStore.addToolMessage({
              id: `incomplete_action_${Date.now()}`,
              name: "_system_continuation",
              arguments: {},
              status: "completed",
              output:
                "You said you would take an action but the stream ended before you called any tools. Please NOW call the tool you mentioned. Do not describe what you will do - actually call the tool using function calling.",
            });

            continue; // Continue to next iteration
          }

          // Check if we just processed tool results but model didn't respond
          // This happens when Gemini decides to stop after seeing tool results
          if (justProcessedToolResults && !iterationContent.trim()) {
            consecutiveEmptyResponses++;

            import("$lib/stores/output.svelte").then((m) =>
              m.logOutput(
                "Volt",
                `Agent: Model didn't respond after tool results (${consecutiveEmptyResponses}/${MAX_EMPTY_RESPONSES}), prompting continuation...`,
              ),
            );

            // Check if we've hit max empty responses
            if (consecutiveEmptyResponses >= MAX_EMPTY_RESPONSES) {
              import("$lib/stores/output.svelte").then((m) =>
                m.logOutput(
                  "Volt",
                  `Agent: Too many empty responses after tools, stopping.`,
                ),
              );
              assistantStore.updateAssistantMessage(
                msgId,
                fullContent ||
                  "The tools completed but I couldn't generate a summary. Please check the tool results above.",
                false,
              );
              return;
            }

            // Add a continuation prompt to encourage the model to respond
            // This mimics how other AI IDEs handle silent completions
            assistantStore.addToolMessage({
              id: `continue_${Date.now()}`,
              name: "_system_continuation",
              arguments: {},
              status: "completed",
              output:
                "The tool execution has completed. You MUST now provide a response to the user explaining what happened. If the task succeeded, summarize the result. If it failed, explain why and suggest next steps. Do NOT remain silent.",
            });

            justProcessedToolResults = false;
            continue; // Continue to next iteration
          }

          // Successful completion with content
          import("$lib/stores/output.svelte").then((m) =>
            m.logOutput(
              "Volt",
              `Agent: Task completed successfully after ${iteration} iterations.`,
            ),
          );
          assistantStore.updateAssistantMessage(msgId, fullContent, false);
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

          // Separate terminal commands from other tools for sequential processing
          const terminalTools = toolsNeedingApproval.filter((tc) =>
            isTerminalToolName(tc.name) && getToolCapabilities(tc.name).requiresApproval,
          );
          const otherTools = toolsNeedingApproval.filter(
            (tc) =>
              !(isTerminalToolName(tc.name) && getToolCapabilities(tc.name).requiresApproval),
          );

          // Process non-terminal tools in parallel (old behavior)
          if (otherTools.length > 0) {
            const approvalsResolved = await waitForToolApprovals(
              msgId,
              otherTools.map((tc) => tc.id),
              controller.signal,
            );
            if (controller.signal.aborted || !approvalsResolved) return;

            for (const tc of otherTools) {
              let currentMsg = assistantStore.messages.find((m) => m.id === msgId);
              let currentToolCall = currentMsg?.inlineToolCalls?.find(
                (t) => t.id === tc.id,
              );

              if (currentToolCall?.status === "running") {
                const completed = await waitForToolCompletion(
                  msgId,
                  tc.id,
                  controller.signal,
                );
                if (!completed) return;
                currentMsg = assistantStore.messages.find((m) => m.id === msgId);
                currentToolCall = currentMsg?.inlineToolCalls?.find(
                  (t) => t.id === tc.id,
                );
              }

              if (
                currentToolCall?.status === "completed" ||
                currentToolCall?.status === "failed"
              ) {
                // Already executed inline; skip re-execution to avoid duplicates.
                continue;
              }

              if (currentToolCall?.status === "cancelled") {
                toolResults.push({
                  id: tc.id,
                  name: tc.name,
                  result: {
                    success: false,
                    error: "Tool execution denied by user",
                  },
                });
                continue;
              }

              assistantStore.updateToolCallInMessage(msgId, tc.id, {
                status: "running",
                startTime: Date.now(),
              });

              try {
                const result = await executeToolCall(tc.name, tc.arguments, {
                  signal: controller.signal,
                  idempotencyKey: getToolIdempotencyKey(
                    toolRunScope,
                    tc.id,
                    tc.name,
                    tc.arguments,
                  ),
                });
                toolResults.push({ id: tc.id, name: tc.name, result });
                assistantStore.updateToolCallInMessage(msgId, tc.id, {
                  status: result.success ? "completed" : "failed",
                  output: result.output,
                  error: result.error,
                  meta: result.meta,
                  data: result.data,
                  endTime: Date.now(),
                  streamingProgress: undefined,
                });

                
              } catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                toolResults.push({
                  id: tc.id,
                  name: tc.name,
                  result: { success: false, error },
                });
                assistantStore.updateToolCallInMessage(msgId, tc.id, {
                  status: "failed",
                  error,
                  endTime: Date.now(),
                });
              }
            }
          }

          // Process terminal commands SEQUENTIALLY (Kiro-style)
          // Wait for approval → execute → wait for next approval → execute...
          let previousTerminalFailed = false;
          for (const tc of terminalTools) {
            let currentMsg = assistantStore.messages.find(
              (m) => m.id === msgId,
            );
            let currentToolCall = currentMsg?.inlineToolCalls?.find(
              (t) => t.id === tc.id,
            );

            if (
              currentToolCall?.status === "completed" ||
              currentToolCall?.status === "failed"
            ) {
              // Already executed inline; skip re-execution.
              continue;
            }

            // If previous terminal command failed, skip remaining
            if (previousTerminalFailed) {
              assistantStore.updateToolCallInMessage(msgId, tc.id, {
                status: "failed",
                error: "Skipped: A previous command failed.",
                endTime: Date.now(),
              });
              toolResults.push({
                id: tc.id,
                name: tc.name,
                result: {
                  success: false,
                  error: "Skipped: A previous command failed.",
                },
              });
              continue;
            }

            // Wait for THIS specific tool's approval
            const approvalResolved = await waitForToolApprovals(
              msgId,
              [tc.id],
              controller.signal,
            );
            if (controller.signal.aborted || !approvalResolved) return;

            currentMsg = assistantStore.messages.find((m) => m.id === msgId);
            currentToolCall = currentMsg?.inlineToolCalls?.find(
              (t) => t.id === tc.id,
            );

            if (currentToolCall?.status === "running") {
              const completed = await waitForToolCompletion(
                msgId,
                tc.id,
                controller.signal,
              );
              if (!completed) return;
              currentMsg = assistantStore.messages.find((m) => m.id === msgId);
              currentToolCall = currentMsg?.inlineToolCalls?.find(
                (t) => t.id === tc.id,
              );
            }

            if (
              currentToolCall?.status === "completed" ||
              currentToolCall?.status === "failed"
            ) {
              // Already executed inline; skip re-execution.
              continue;
            }

            if (currentToolCall?.status === "cancelled") {
              toolResults.push({
                id: tc.id,
                name: tc.name,
                result: {
                  success: false,
                  error: "Tool execution denied by user",
                },
              });
              previousTerminalFailed = true; // Stop subsequent commands if user denies
              continue;
            }

            // Execute this terminal command
            assistantStore.updateToolCallInMessage(msgId, tc.id, {
              status: "running",
              startTime: Date.now(),
            });

            try {
              const result = await executeToolCall(tc.name, tc.arguments, {
                signal: controller.signal,
                idempotencyKey: getToolIdempotencyKey(
                  toolRunScope,
                  tc.id,
                  tc.name,
                  tc.arguments,
                ),
              });
              toolResults.push({ id: tc.id, name: tc.name, result });
              assistantStore.updateToolCallInMessage(msgId, tc.id, {
                status: result.success ? "completed" : "failed",
                output: result.output,
                error: result.error,
                meta: result.meta,
                data: result.data,
                endTime: Date.now(),
              });

              if (!result.success) {
                previousTerminalFailed = true;
              }
            } catch (err) {
              const error = err instanceof Error ? err.message : String(err);
              toolResults.push({
                id: tc.id,
                name: tc.name,
                result: { success: false, error },
              });
              assistantStore.updateToolCallInMessage(msgId, tc.id, {
                status: "failed",
                error,
                endTime: Date.now(),
              });
              previousTerminalFailed = true;
            }
          }
        }

        // Add ALL results to conversation as special tool messages
        addToolResultsToConversation(allToolCalls, toolResults);

        // Mark that we just processed tool results - if model doesn't respond next iteration,
        // we'll prompt it to continue
        justProcessedToolResults = true;
      } catch (err) {
        if (controller.signal.aborted) return;
        const msg = err instanceof Error ? err.message : "Unknown error";

        // Kiro-style: Check if this is a retryable error
        const isRetryable =
          /network|timeout|connection|interrupted|503|502|504|429/i.test(msg);

        import("$lib/stores/output.svelte").then((m) =>
          m.logOutput(
            "Volt",
            `Agent Loop Error (iteration ${iteration}): ${msg}`,
          ),
        );

        // If retryable and we have content, try to continue
        if (
          isRetryable &&
          iteration < maxIterations - 1 &&
          recoveryRetryCount < MAX_RECOVERY_RETRIES
        ) {
          recoveryRetryCount++;
          import("$lib/stores/output.svelte").then((m) =>
            m.logOutput(
              "Volt",
              `Retryable error detected, attempting to continue... (${recoveryRetryCount}/${MAX_RECOVERY_RETRIES})`,
            ),
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
   * Add tool results to the conversation for the next API call
   */
  function addToolResultsToConversation(
    toolCalls: Array<{
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }>,
    results: Array<{
      id: string;
      name: string;
      result: ToolResult;
    }>,
  ): void {
    // We need to add both the assistant's function calls and the user's function responses
    // to maintain proper conversation structure for Gemini

    // Then add a "tool" message with the results that will be converted to functionResponse
    for (const result of results) {
      const tc = toolCalls.find((t) => t.id === result.id);
      if (!tc) continue;

      // Add as a tool message - toProviderMessages will convert this
      assistantStore.addToolMessage({
        id: result.id,
        name: result.name,
        arguments: tc.arguments,
        status: result.result.success ? "completed" : "failed",
        output: result.result.output,
        error: result.result.error,
        meta: result.result.meta,
        data: result.result.data,
      });
    }
  }

  /**
   * Wait for user to approve or deny tools that require approval
   * Polls the tool status until all are resolved (not 'pending')
   */
  function waitForToolApprovals(
    messageId: string,
    toolIds: string[],
    signal: AbortSignal,
    maxWaitMs = 10 * 60 * 1000,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let finished = false;
      const finish = (ok: boolean): void => {
        if (finished) return;
        finished = true;
        clearInterval(checkInterval);
        signal.removeEventListener("abort", onAbort);
        resolve(ok);
      };

      const onAbort = (): void => finish(false);

      // Faster polling for snappier UX (50ms instead of 100ms)
      const checkInterval = setInterval(() => {
        // Check if aborted
        if (signal.aborted) {
          finish(false);
          return;
        }

        if (Date.now() - startedAt > maxWaitMs) {
          for (const toolId of toolIds) {
            assistantStore.updateToolCallInMessage(messageId, toolId, {
              status: "failed",
              error: `Approval timed out after ${Math.round(maxWaitMs / 1000)}s`,
              endTime: Date.now(),
            });
          }
          finish(false);
          return;
        }

        // Find the message and check tool statuses
        const msg = assistantStore.messages.find((m) => m.id === messageId);
        if (!msg?.inlineToolCalls) {
          finish(false);
          return;
        }

        // Check if all tools needing approval have been resolved
        const allResolved = toolIds.every((toolId) => {
          const tool = msg.inlineToolCalls?.find((t) => t.id === toolId);
          // Resolved means not 'pending' anymore
          return tool && tool.status !== "pending";
        });

        if (allResolved) {
          finish(true);
        }
      }, 50); // Check every 50ms for snappier response

      // Also listen for abort
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Wait for a running inline tool execution to finish.
   * Prevents duplicate execution in the main tool loop.
   */
  function waitForToolCompletion(
    messageId: string,
    toolId: string,
    signal: AbortSignal,
    maxWaitMs = 5 * 60 * 1000,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let finished = false;
      const finish = (ok: boolean): void => {
        if (finished) return;
        finished = true;
        clearInterval(checkInterval);
        signal.removeEventListener("abort", onAbort);
        resolve(ok);
      };
      const onAbort = (): void => finish(false);

      const checkInterval = setInterval(() => {
        if (signal.aborted) {
          finish(false);
          return;
        }

        if (Date.now() - startedAt > maxWaitMs) {
          assistantStore.updateToolCallInMessage(messageId, toolId, {
            status: "failed",
            error: `Execution timed out after ${Math.round(maxWaitMs / 1000)}s`,
            endTime: Date.now(),
          });
          finish(false);
          return;
        }

        const msg = assistantStore.messages.find((m) => m.id === messageId);
        const tool = msg?.inlineToolCalls?.find((t) => t.id === toolId);
        if (!tool || tool.status !== "running") {
          finish(true);
        }
      }, 50);

      signal.addEventListener("abort", onAbort, { once: true });
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
    assistantStore.updateToolCall(toolCall.id, {
      status: "running",
      startTime: Date.now(),
    });

    try {
      const result = await executeToolCall(toolCall.name, toolCall.arguments, {
        signal,
        idempotencyKey: getToolIdempotencyKey(
          assistantStore.currentConversation?.id ?? "ad-hoc",
          toolCall.id,
          toolCall.name,
          toolCall.arguments,
        ),
      });

      if (result.success) {
        assistantStore.updateToolCall(toolCall.id, {
          status: "completed",
          output: result.output,
          meta: result.meta,
          endTime: Date.now(),
          streamingProgress: undefined, // Clear progress on completion
        });

        
      } else {
        assistantStore.updateToolCall(toolCall.id, {
          status: "failed",
          error: result.error,
          meta: result.meta,
          endTime: Date.now(),
          streamingProgress: undefined,
        });
      }
      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      assistantStore.updateToolCall(toolCall.id, {
        status: "failed",
        error: errorMsg,
        endTime: Date.now(),
        streamingProgress: undefined,
      });
      return { success: false, error: errorMsg };
    }
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
    import("$lib/services/monaco-models")
      .then(({ getEditorSelection }) => {
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
        } else {
          showToast({ message: "No text selected in editor", type: "warning" });
        }
      })
      .catch(() => {
        showToast({ message: "Failed to get selection", type: "error" });
      });
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

  /**
   * Read a File as base64 string
   */
  function readFileAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Remove data URL prefix (e.g., "data:image/png;base64,")
        const base64 = result.split(",")[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /**
   * Get image dimensions from base64 data
   */
  function getImageDimensions(
    base64: string,
    mimeType: string,
  ): Promise<{ width: number; height: number } | undefined> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        resolve({ width: img.width, height: img.height });
      };
      img.onerror = () => {
        resolve(undefined);
      };
      img.src = `data:${mimeType};base64,${base64}`;
    });
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

    // Mark as running immediately for instant UI feedback
    assistantStore.updateToolCallInMessage(messageId, toolCall.id, {
      status: "running",
      startTime: Date.now(),
    });

    // Execute the tool immediately (don't wait for tool loop)
    try {
      const result = await executeToolCall(toolCall.name, toolCall.arguments, {
        signal: assistantStore.abortController?.signal,
        idempotencyKey: getToolIdempotencyKey(
          assistantStore.currentConversation?.id ?? "ad-hoc",
          toolCall.id,
          toolCall.name,
          toolCall.arguments,
        ),
      });

      assistantStore.updateToolCallInMessage(messageId, toolCall.id, {
        status: result.success ? "completed" : "failed",
        output: result.output,
        error: result.error,
        meta: result.meta,
        data: result.data,
        endTime: Date.now(),
      });

      recordToolResult(toolCall, result);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      assistantStore.updateToolCallInMessage(messageId, toolCall.id, {
        status: "failed",
        error,
        endTime: Date.now(),
      });
      recordToolResult(toolCall, { success: false, error });
    }
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
    const resolvedPlanPath = plan.absolutePath || resolvePath(guessedRelativePath);
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
