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
    type SyntheticPromptMeta,
  } from "$features/assistant/stores/assistant.svelte";
  import { editorStore } from "$features/editor/stores/editor.svelte";
  import { projectStore } from "$shared/stores/project.svelte";
  import { showToast } from "$shared/stores/toast.svelte";
  import { aiSettingsStore, type AIMode } from "$features/assistant/stores/ai.svelte";
  import { getSystemPrompt } from "$core/ai/prompts/prompts-v4";
  import {
    buildContextV2,
    buildMinimalContextFallback,
    formatContextV2,
  } from "$core/ai/context/context-v2";
  import {
    getAllToolsForMode,
    validateToolCall as validateTool,
    isTerminalTool as isTerminalToolName,
  } from "$core/ai/tools";
  import { resolvePath } from "$core/ai/tools/utils";
  import { buildCompactWorkingSetSummary } from "./panel/utils";
  import { autoSummarizeIfNeeded } from "./panel/auto-summarize";
  import { getImageDimensions, readFileAsBase64 } from "./panel/image-utils";
  import { saveConversationToHistory as persistConversationToHistory } from "./panel/conversation-persistence";
  import { getMcpToolsInfo } from "./panel/mcp-tools";
  import { filterToolsForChat } from "./panel/tool-gating";
  import MessageList from "./MessageList.svelte";
  import ChatHistorySidebar from "./ChatHistorySidebar.svelte";
  import ChatInputBar from "./ChatInputBar.svelte";
  import AssistantPanelAttachments from "./AssistantPanelAttachments.svelte";
  import AssistantPanelTabs from "./AssistantPanelTabs.svelte";
  import RevertConfirmationModal from "./RevertConfirmationModal.svelte";
  import { open } from "@tauri-apps/plugin-dialog";
  import type { UnlistenFn } from "@tauri-apps/api/event";
  import { readBinaryFileBase64, readFileQuiet } from "$core/services/file-system";
  import { getEditorSelection } from "$core/services/monaco-models";
  import { chatHistoryStore } from "$features/assistant/stores/chat-history.svelte";
  import { uiStore } from "$shared/stores/ui.svelte";
  import { terminalStore } from "$features/terminal/stores/terminal.svelte";
  import { gitStore } from "$features/git/stores/git.svelte";
  import { agentTelemetryStore } from "$features/assistant/stores/agent-telemetry.svelte";
  import { buildRuntimeContextBlock } from "$core/ai/context/runtime-context";
  import {
    assistantRunUpdateApproval,
    listenToAssistantRuntimeEvents,
  } from "$features/assistant/runtime/native-runtime";
  import { createAssistantPanelNativeRuntimeBridge } from "./panel/native-runtime-bridge";
  import { createAssistantLoopRunner } from "./panel/assistant-loop-runner";
  import { approveToolInMessage, denyToolInMessage } from "./panel/approval-actions";
  import {
    createAttachmentActions,
    createConversationActions,
    createImplementationActions,
    createRevertActions,
    createTabActions,
  } from "./panel/panel-actions";
  import { specStore } from "$features/specs/stores/specs.svelte";
  import { SvelteMap } from "svelte/reactivity";
  import './AssistantPanel.css';

  interface RevertMetadataItem {
    path: string;
    name: string;
    isNewFile: boolean;
    isDirectory: boolean;
    isDeletion: boolean;
    isRename: boolean;
    addedLines: number;
    removedLines: number;
  }

  // Revert confirmation state
  let confirmRevertOpen = $state(false);
  let revertMetadata = $state<RevertMetadataItem[]>([]);
  let pendingRevertId = $state<string | null>(null);
  let selectedImage = $state<{
    data: string;
    label: string;
    mimeType: "image/png" | "image/jpeg" | "image/webp";
  } | null>(null);
  let inputRef: HTMLTextAreaElement | undefined = $state();
  let tabContextMenu = $state<{
    x: number;
    y: number;
    conversationId: string;
    title: string;
  } | null>(null);
  let renameTabDialog = $state<{
    conversationId: string;
    title: string;
  } | null>(null);

  let hasContextWarned = $state(false);
  let isAutoSummarizing = $state(false);
  let lastConversationId: string | null = null;
  let lastHydratedConversationId: string | null = null;
  let conversationTabsScrollRef: HTMLDivElement | undefined = $state();
  const nativeRunIds = new SvelteMap<string, string>();
  let assistantRuntimeUnlisten: UnlistenFn | null = null;

  function debugPanelSession(event: string, details: Record<string, unknown> = {}): void {
    console.info('[AssistantPanelSession]', { event, ...details, at: Date.now() });
  }

  function buildWorkspaceRuntimeSummary(): {
    rootEntryCount?: number;
    rootEntries: string[];
    isProbablyEmpty?: boolean;
  } {
    if (!projectStore.rootPath) {
      return {
        rootEntries: [],
      };
    }

    const rootEntries = (projectStore.tree ?? [])
      .map((entry) => String(entry?.name ?? "").trim())
      .filter(Boolean)
      .slice(0, 24);
    const rootEntryCount = Array.isArray(projectStore.tree) ? projectStore.tree.length : 0;

    return {
      rootEntryCount,
      rootEntries,
      isProbablyEmpty: rootEntryCount === 0,
    };
  }

  const {
    buildNativeRuntimeDecision,
    applyNativeRuntimeDecision,
    startNativeAssistantRun,
    hydrateNativeAssistantSnapshot,
    publishNativeAssistantEvent,
    publishNativeToolPatch,
    createNativeDispatchAuthority,
    resolveNativeApprovalAuthority,
    waitForNativeToolApprovals,
    cancelNativeAssistantRun,
  } = createAssistantPanelNativeRuntimeBridge({
    assistantStore,
    agentTelemetryStore,
    nativeRunIds,
  });

  const {
    handleAttachCurrentFile,
    handleAttachSelection,
    handleAttachImage,
    handleAttachImageFromPicker,
  } = createAttachmentActions({
    assistantStore,
    editorStore,
    showToast,
    getEditorSelection,
    readFileAsBase64,
    getImageDimensions,
    openImagePicker: () =>
      open({
        multiple: true,
        filters: [
          {
            name: "Images",
            extensions: ["png", "jpg", "jpeg", "webp"],
          },
        ],
      }),
    readBinaryFileBase64,
  });

  let handleSendRef: (() => void) | null = null;

  const { handleClearConversation } = createConversationActions({
    assistantStore,
    chatHistoryStore,
    saveConversationToHistory,
  });

  const { handleRevertRequested, confirmRevert, cancelRevert } =
    createRevertActions({
      assistantStore,
      getPendingRevertId: () => pendingRevertId,
      setPendingRevertId: (value) => (pendingRevertId = value),
      setRevertMetadata: (value) => (revertMetadata = value),
      setConfirmRevertOpen: (value) => (confirmRevertOpen = value),
    });

  const { handleStartImplementation } = createImplementationActions({
    assistantStore,
    resolvePath,
    readFileQuiet,
    showToast,
    setInputValue: (value) => assistantStore.setInputValue(value),
    setInputElementValue: (value) => {
      if (inputRef) {
        inputRef.value = value;
      }
    },
    triggerSend: () => handleSendRef?.(),
  });

  const {
    handleSelectTab,
    handleCloseTab,
    handleTabContextMenu,
    openRenameTabDialog,
    submitRenameTab,
  } = createTabActions({
    assistantStore,
    chatHistoryStore,
    debugPanelSession,
    setTabContextMenu: (value) => (tabContextMenu = value),
    getTabContextMenu: () => tabContextMenu,
    setRenameTabDialog: (value) => (renameTabDialog = value),
    getRenameTabDialog: () => renameTabDialog,
  });

  $effect(() => {
    let disposed = false;
    void listenToAssistantRuntimeEvents((event) => {
      if (event.runId) {
        nativeRunIds.set(event.conversationId, event.runId);
      }
      assistantStore.applyNativeRuntimeEvent(event);
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }
      assistantRuntimeUnlisten = unlisten;
    });

    return () => {
      disposed = true;
      if (assistantRuntimeUnlisten) {
        assistantRuntimeUnlisten();
        assistantRuntimeUnlisten = null;
      }
    };
  });

  $effect(() => {
    const conversationId = assistantStore.currentConversation?.id ?? null;
    if (!conversationId) {
      lastHydratedConversationId = null;
      return;
    }
    // Regression guard: hydrating the same conversation snapshot on every reactive
    // churn can create a native <-> store feedback loop that makes the whole IDE
    // feel laggy even when backend calls are individually fast.
    if (conversationId === lastHydratedConversationId) return;
    lastHydratedConversationId = conversationId;
    void hydrateNativeAssistantSnapshot(conversationId);
  });

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
    return assistantStore.isConversationBusy(currentConversationId);
  });

  function handleOpenPromptLibrary(): void {
    uiStore.setActiveSidebarPanel("prompts");
  }


  $effect(() => {
    const onAssistantSend = () => {
      void handleSend();
    };
    const onAssistantSendPrompt = (event: Event) => {
      const detail = (event as CustomEvent<{
        prompt?: string;
        syntheticPrompt?: SyntheticPromptMeta;
        suppressAutoTitle?: boolean;
      }>).detail;
      const prompt = detail?.prompt;
      if (typeof prompt === "string") {
        assistantStore.setInputValue(prompt);
        if (inputRef) inputRef.value = prompt;
      }
      void handleSend({
        syntheticPrompt: detail?.syntheticPrompt,
        suppressAutoTitle: detail?.suppressAutoTitle,
      });
    };
    window.addEventListener("volt:assistant-send", onAssistantSend);
    window.addEventListener("volt:assistant-send-prompt", onAssistantSendPrompt);
    return () => {
      window.removeEventListener("volt:assistant-send", onAssistantSend);
      window.removeEventListener("volt:assistant-send-prompt", onAssistantSendPrompt);
    };
  });

  $effect(() => {
    if (!tabContextMenu && !renameTabDialog) return;
    const closeMenus = () => {
      tabContextMenu = null;
    };
    window.addEventListener("click", closeMenus);
    return () => {
      window.removeEventListener("click", closeMenus);
    };
  });

  function normalizeWorkspacePath(path: string | null | undefined): string | null {
    if (!path) return null;
    const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
    return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
  }

  function normalizeToolArgumentsForWorkspace(
    toolName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!isTerminalToolName(toolName)) return args;
    const projectRoot =
      typeof projectStore.rootPath === "string" && projectStore.rootPath.trim()
        ? projectStore.rootPath.trim()
        : null;
    if (!projectRoot) return args;
    const explicitCwd =
      typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : null;
    const normalizedProjectRoot = normalizeWorkspacePath(projectRoot);
    const normalizedExplicit = normalizeWorkspacePath(explicitCwd);
    const cwdWithinProject =
      normalizedExplicit &&
      normalizedProjectRoot &&
      (normalizedExplicit === normalizedProjectRoot ||
        normalizedExplicit.startsWith(`${normalizedProjectRoot}/`));
    if (cwdWithinProject) return args;
    return {
      ...args,
      cwd: projectRoot,
    };
  }

  const { runToolLoop } = createAssistantLoopRunner({
    normalizeToolArgumentsForWorkspace,
    buildNativeRuntimeDecision,
    applyNativeRuntimeDecision,
    startNativeAssistantRun,
    publishNativeAssistantEvent,
    publishNativeToolPatch,
    createNativeDispatchAuthority,
    resolveNativeApprovalAuthority,
    waitForNativeToolApprovals,
    cancelNativeAssistantRun,
    getNativeRunId: (id) => nativeRunIds.get(id),
    syncNativeSnapshot: (id, snapshot) => {
      if (!snapshot) return;
      nativeRunIds.set(id, snapshot.runId);
      assistantStore.applyNativeRuntimeSnapshot(snapshot);
    },
  });

  async function handleSend(options: {
    syntheticPrompt?: SyntheticPromptMeta;
    suppressAutoTitle?: boolean;
  } = {}): Promise<void> {
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
      const healed = assistantStore.healStaleConversationRunState(conversationId);
      if (!healed) {
        assistantStore.stopStreaming();
      }
    }

    const context = [...assistantStore.attachedContext];

    // Clear input and context - also clear the textarea directly
    assistantStore.setInputValue("");
    if (inputRef) inputRef.value = "";
    assistantStore.clearContext();

    const controller = assistantStore.startStreaming();
    const userMessageId = assistantStore.addUserMessage(
      content,
      context,
      undefined,
      options,
    );

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
      workspaceSummary: buildWorkspaceRuntimeSummary(),
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

    let contextBlock: string;
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

    // Patch the already-rendered user message with the final hidden context block
    assistantStore.updateUserMessageSmartContext(userMessageId, contextBlock);

    // Get tools for current mode (includes MCP tools in agent mode)
    const tools = filterToolsForChat(
      getAllToolsForMode(assistantStore.currentMode),
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
    }
  }
  handleSendRef = () => {
    void handleSend();
  };

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
  function handleStop(): void {
    const conversationId = assistantStore.currentConversation?.id ?? null;
    if (conversationId) {
      void cancelNativeAssistantRun(conversationId, "user_stop");
    }
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

  function handleRemoveContext(index: number): void {
    assistantStore.removeContext(index);
  }

  function handleRemoveAttachment(id: string): void {
    assistantStore.removeAttachment(id);
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
    await approveToolInMessage({
      assistantStore,
      nativeRunIds,
      conversationId,
      messageId,
      toolCall,
      validateTool,
      normalizeToolArgumentsForWorkspace,
      isTerminalToolName,
      showToast,
      updateApproval: async (params) =>
        assistantRunUpdateApproval(params).catch((error) => {
          console.warn("[AssistantPanel] Failed to update native approval acceptance", {
            conversationId,
            toolCallId: toolCall.id,
            error,
          });
          throw error;
        }),
    });
  }

  /**
   * Handle tool denial from inline display in message
   */
  function handleToolDenyInMessage(
    messageId: string,
    toolCall: ToolCall,
  ): void {
    const conversationId = assistantStore.currentConversation?.id;
    if (!conversationId) return;
    void denyToolInMessage({
      assistantStore,
      nativeRunIds,
      conversationId,
      messageId,
      toolCall,
      updateApproval: async (params) =>
        assistantRunUpdateApproval(params).catch((error) => {
          console.warn("[AssistantPanel] Failed to update native approval rejection", {
            conversationId,
            toolCallId: toolCall.id,
            error,
          });
          throw error;
        }),
    });
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

</script>

<aside class="assistant-panel" aria-label="AI Assistant">
  <!-- Header -->
  <header class="panel-header">
    <div class="header-left">
      <AssistantPanelTabs
        bind:conversationTabsScrollRef
        {conversationTabs}
        {currentChatTitle}
        onSelectTab={handleSelectTab}
        onCloseTab={handleCloseTab}
        onTabContextMenu={handleTabContextMenu}
      />
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
      currentConversationId={assistantStore.currentConversation?.id ?? null}
      isStreaming={assistantStore.isStreaming}
      scrollRevision={assistantStore.chatScrollRevision}
      onQuickPrompt={handleQuickPrompt}
      onToolApprove={handleToolApproveInMessage}
      onToolDeny={handleToolDenyInMessage}
      onStartImplementation={handleStartImplementation}
      onConfirmSpecDraft={() => specStore.confirmPendingDraft()}
      onDiscardSpecDraft={() => specStore.discardPendingDraft()}
      onRevert={handleRevertRequested}
    />
  </div>

  <!-- Input Area (Bottom) -->
  <div class="input-area">
    <AssistantPanelAttachments
      {attachmentPreviews}
      attachedContext={assistantStore.attachedContext}
      onPreviewImage={(preview) =>
        (selectedImage = {
          data: preview.thumbnailData ?? "",
          label: preview.label,
          mimeType: preview.mimeType ?? "image/png",
        })}
      onRemoveAttachment={handleRemoveAttachment}
      onRemoveContext={handleRemoveContext}
    />

    <ChatInputBar
      bind:inputRef
      value={assistantStore.inputValue}
      isStreaming={isAssistantBusy}
      currentMode={assistantStore.currentMode}
      onInput={(
        v: string,
        source?: "user" | "history",
        attachments?: typeof assistantStore.pendingAttachments,
      ) => {
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

{#if tabContextMenu}
  <div
    class="assistant-tab-menu"
    style="left: {tabContextMenu.x}px; top: {tabContextMenu.y}px;"
  >
    <button type="button" onclick={openRenameTabDialog}>
      <UIIcon name="pencil" size={14} />
      <span>Rename</span>
    </button>
  </div>
{/if}

{#if renameTabDialog}
  <div class="assistant-tab-dialog-backdrop">
    <div class="assistant-tab-dialog">
      <h3>Rename Chat</h3>
      <input
        type="text"
        bind:value={renameTabDialog.title}
        onkeydown={(event) => event.key === "Enter" && submitRenameTab()}
      />
      <div class="assistant-tab-dialog-actions">
        <button class="cancel" type="button" onclick={() => (renameTabDialog = null)}>
          Cancel
        </button>
        <button class="confirm" type="button" onclick={submitRenameTab}>
          Rename
        </button>
      </div>
    </div>
  </div>
{/if}

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


