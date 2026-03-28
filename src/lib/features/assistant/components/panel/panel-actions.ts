import type { AIMode } from "$features/assistant/stores/ai.svelte";
import type { Conversation as ChatHistoryConversation } from "$features/assistant/stores/chat-history.svelte";

import { IMAGE_LIMITS } from "$features/assistant/stores/assistant.svelte";

type ShowToast = (params: { message: string; type: "warning" | "error" | "success" }) => void;

interface SelectionSnapshot {
  text: string;
  path?: string | null;
  range?: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
}

interface ConversationSummaryLike {
  id: string;
  createdAt: number;
  updatedAt?: number;
  title?: string;
  isPinned?: boolean;
  mode?: string;
}

interface AttachmentAssistantStoreLike {
  attachFile: (
    path: string,
    content: string,
    label?: string,
  ) => { success: boolean; error?: string };
  attachContext: (context: {
    type: "file" | "selection";
    path?: string;
    content: string;
    label: string;
  }) => void;
  attachSelection: (
    text: string,
    path?: string,
    range?: {
      startLine: number;
      startCol: number;
      endLine: number;
      endCol: number;
    },
  ) => { success: boolean; error?: string };
  attachImage: (
    filename: string,
    mimeType: "image/png" | "image/jpeg" | "image/webp",
    data: string,
    dimensions?: { width: number; height: number },
  ) => { success: boolean; error?: string };
}

interface ConversationAssistantStoreLike {
  newConversation: () => void;
  currentConversation?: { id: string } | null;
}

interface RevertAssistantStoreLike {
  getRevertMetadata: (messageId: string) => Promise<unknown[]>;
  revertToMessage: (messageId: string) => Promise<void>;
}

interface ImplementationAssistantStoreLike {
  setMode: (mode: AIMode) => void;
  attachFile: (
    path: string,
    content: string,
    label?: string,
  ) => { success: boolean; error?: string };
}

interface TabAssistantStoreLike {
  currentConversation?: { id: string } | null;
  switchToConversation: (
    conversationId: string,
    summary?: ConversationSummaryLike,
  ) => boolean;
  loadConversation: (conversation: ChatHistoryConversation) => void;
  closeConversationTab: (conversationId: string) => void;
  setConversationTitle: (title: string, conversationId: string) => void;
}

interface ChatHistoryStoreLike {
  activeConversationId: string | null;
  conversations: Array<ConversationSummaryLike & { title: string }>;
  loadConversations: () => Promise<void>;
  getConversation: (conversationId: string) => Promise<ChatHistoryConversation>;
  updateTitle: (conversationId: string, title: string) => Promise<void>;
}

interface EditorStoreLike {
  activeFile?: {
    path: string;
    content: string;
  } | null;
}

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

export function createAttachmentActions(deps: {
  assistantStore: AttachmentAssistantStoreLike;
  editorStore: EditorStoreLike;
  showToast: ShowToast;
  getEditorSelection: () => SelectionSnapshot | null;
  readFileAsBase64: (file: File) => Promise<string>;
  getImageDimensions: (
    base64Data: string,
    mimeType: "image/png" | "image/jpeg" | "image/webp",
  ) => Promise<{ width: number; height: number } | undefined>;
  openImagePicker: () => Promise<string | string[] | null>;
  readBinaryFileBase64: (path: string) => Promise<string | null>;
}) {
  const handleAttachCurrentFile = (): void => {
    const activeFile = deps.editorStore.activeFile;
    if (!activeFile) {
      deps.showToast({ message: "No file is currently open", type: "warning" });
      return;
    }

    const result = deps.assistantStore.attachFile(activeFile.path, activeFile.content);
    if (!result.success) {
      deps.showToast({
        message: result.error ?? "Failed to attach file",
        type: "warning",
      });
    }

    deps.assistantStore.attachContext({
      type: "file",
      path: activeFile.path,
      content: activeFile.content,
      label: activeFile.path.split("/").pop() ?? activeFile.path,
    });
  };

  const handleAttachSelection = (): void => {
    const selection = deps.getEditorSelection();
    if (selection && selection.text) {
      const result = deps.assistantStore.attachSelection(
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
        deps.showToast({
          message: result.error ?? "Failed to attach selection",
          type: "warning",
        });
        return;
      }

      deps.assistantStore.attachContext({
        type: "selection",
        path: selection.path ?? undefined,
        content: selection.text,
        label: `Selection from ${selection.path?.split("/").pop() ?? "editor"}`,
      });
      return;
    }

    deps.showToast({ message: "No text selected in editor", type: "warning" });
  };

  const handleAttachImage = async (file: File): Promise<void> => {
    const mimeType = file.type as (typeof IMAGE_LIMITS.allowedMimeTypes)[number];
    if (!IMAGE_LIMITS.allowedMimeTypes.includes(mimeType)) {
      deps.showToast({
        message: `Unsupported image type: ${file.type}. Use PNG, JPEG, or WebP.`,
        type: "warning",
      });
      return;
    }

    if (file.size > IMAGE_LIMITS.maxImageBytes) {
      const maxMB = IMAGE_LIMITS.maxImageBytes / (1024 * 1024);
      deps.showToast({
        message: `Image too large (${(file.size / (1024 * 1024)).toFixed(1)}MB). Maximum: ${maxMB}MB`,
        type: "warning",
      });
      return;
    }

    try {
      const base64Data = await deps.readFileAsBase64(file);
      const dimensions = await deps.getImageDimensions(base64Data, mimeType);
      const result = deps.assistantStore.attachImage(
        file.name,
        mimeType,
        base64Data,
        dimensions,
      );

      if (!result.success) {
        deps.showToast({
          message: result.error ?? "Failed to attach image",
          type: "warning",
        });
      }
    } catch {
      deps.showToast({ message: "Failed to read image file", type: "error" });
    }
  };

  const handleAttachImageFromPicker = async (): Promise<void> => {
    try {
      const selected = await deps.openImagePicker();
      if (!selected) return;

      const paths = Array.isArray(selected) ? selected : [selected];
      for (const path of paths) {
        const base64Data = await deps.readBinaryFileBase64(path);
        if (!base64Data) {
          throw new Error(`Failed to read ${path}`);
        }

        const ext = path.split(".").pop()?.toLowerCase();
        let mimeType: "image/png" | "image/jpeg" | "image/webp" = "image/png";
        if (ext === "jpg" || ext === "jpeg") mimeType = "image/jpeg";
        else if (ext === "webp") mimeType = "image/webp";

        const filename = path.split(/[/\\]/).pop() ?? "image";
        const dimensions = await deps.getImageDimensions(base64Data, mimeType);
        const result = deps.assistantStore.attachImage(
          filename,
          mimeType,
          base64Data,
          dimensions,
        );
        if (!result.success) {
          deps.showToast({
            message: result.error ?? "Failed to attach image",
            type: "warning",
          });
        }
      }
    } catch {
      deps.showToast({ message: "Failed to open image picker", type: "error" });
    }
  };

  return {
    handleAttachCurrentFile,
    handleAttachSelection,
    handleAttachImage,
    handleAttachImageFromPicker,
  };
}

export function createConversationActions(deps: {
  assistantStore: ConversationAssistantStoreLike;
  chatHistoryStore: ChatHistoryStoreLike;
  saveConversationToHistory: () => Promise<void>;
}) {
  const handleClearConversation = async (): Promise<void> => {
    deps.assistantStore.newConversation();
    deps.chatHistoryStore.activeConversationId =
      deps.assistantStore.currentConversation?.id ?? null;

    void (async () => {
      await deps.saveConversationToHistory();
      await deps.chatHistoryStore.loadConversations();
    })();
  };

  return { handleClearConversation };
}

export function createRevertActions(deps: {
  assistantStore: RevertAssistantStoreLike;
  getPendingRevertId: () => string | null;
  setPendingRevertId: (value: string | null) => void;
  setRevertMetadata: (value: RevertMetadataItem[]) => void;
  setConfirmRevertOpen: (value: boolean) => void;
}) {
  const handleRevertRequested = async (messageId: string): Promise<void> => {
    deps.setPendingRevertId(messageId);
    const metadata = await deps.assistantStore.getRevertMetadata(messageId);
    if (metadata.length === 0) {
      await deps.assistantStore.revertToMessage(messageId);
      return;
    }
    deps.setRevertMetadata(metadata as RevertMetadataItem[]);
    deps.setConfirmRevertOpen(true);
  };

  const cancelRevert = (): void => {
    deps.setConfirmRevertOpen(false);
    deps.setPendingRevertId(null);
    deps.setRevertMetadata([]);
  };

  const confirmRevert = async (): Promise<void> => {
    const pendingRevertId = deps.getPendingRevertId();
    if (pendingRevertId) {
      await deps.assistantStore.revertToMessage(pendingRevertId);
    }
    cancelRevert();
  };

  return {
    handleRevertRequested,
    confirmRevert,
    cancelRevert,
  };
}

export function createImplementationActions(deps: {
  assistantStore: ImplementationAssistantStoreLike;
  resolvePath: (path: string) => string;
  readFileQuiet: (path: string) => Promise<string | null>;
  showToast: ShowToast;
  setInputValue: (value: string) => void;
  setInputElementValue: (value: string) => void;
  triggerSend: () => void;
}) {
  const handleStartImplementation = async (plan: {
    filename: string;
    content: string;
    relativePath?: string;
    absolutePath?: string;
  }): Promise<void> => {
    deps.assistantStore.setMode("agent");

    const guessedRelativePath =
      plan.relativePath ||
      `.volt/plans/${plan.filename.endsWith(".md") ? plan.filename : `${plan.filename}.md`}`;
    const attachmentPath = plan.absolutePath || guessedRelativePath;
    const resolvedPlanPath = plan.absolutePath || deps.resolvePath(guessedRelativePath);
    let latestPlanContent = plan.content;

    try {
      const diskContent = await deps.readFileQuiet(resolvedPlanPath);
      if (diskContent && diskContent.trim().length > 0) {
        latestPlanContent = diskContent;
      }
    } catch {
      // Fallback to tool-captured content from chat history.
    }

    const attachResult = deps.assistantStore.attachFile(
      attachmentPath,
      latestPlanContent,
      plan.filename,
    );

    if (!attachResult.success) {
      deps.showToast({
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

    deps.setInputValue(implementationPrompt);
    deps.setInputElementValue(implementationPrompt);
    deps.triggerSend();
  };

  return { handleStartImplementation };
}

export function createTabActions(deps: {
  assistantStore: TabAssistantStoreLike;
  chatHistoryStore: ChatHistoryStoreLike;
  debugPanelSession: (event: string, details?: Record<string, unknown>) => void;
  setTabContextMenu: (
    value: { x: number; y: number; conversationId: string; title: string } | null,
  ) => void;
  getTabContextMenu: () => {
    x: number;
    y: number;
    conversationId: string;
    title: string;
  } | null;
  setRenameTabDialog: (value: { conversationId: string; title: string } | null) => void;
  getRenameTabDialog: () => { conversationId: string; title: string } | null;
}) {
  const handleSelectTab = (conversationId: string): void => {
    if (!conversationId || deps.assistantStore.currentConversation?.id === conversationId) return;
    const summary = deps.chatHistoryStore.conversations.find((conv) => conv.id === conversationId);
    if (deps.assistantStore.switchToConversation(conversationId, summary)) {
      deps.chatHistoryStore.activeConversationId = conversationId;
      return;
    }

    if (!summary) return;
    void deps.chatHistoryStore
      .getConversation(conversationId)
      .then((conversation) => {
        deps.assistantStore.loadConversation(conversation);
        deps.chatHistoryStore.activeConversationId = conversationId;
      })
      .catch((error) => {
        console.error("[AssistantPanel] Failed to switch conversation tab:", error);
      });
  };

  const handleCloseTab = (conversationId: string, event: MouseEvent): void => {
    event.stopPropagation();
    deps.debugPanelSession("close_tab", {
      conversationId,
      activeConversationId: deps.assistantStore.currentConversation?.id ?? null,
    });
    deps.assistantStore.closeConversationTab(conversationId);
    deps.chatHistoryStore.activeConversationId =
      deps.assistantStore.currentConversation?.id ?? null;
  };

  const handleTabContextMenu = (
    tab: { id: string; fullTitle: string },
    event: MouseEvent,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    deps.setTabContextMenu({
      x: event.clientX,
      y: event.clientY,
      conversationId: tab.id,
      title: tab.fullTitle,
    });
  };

  const openRenameTabDialog = (): void => {
    const tabContextMenu = deps.getTabContextMenu();
    if (!tabContextMenu) return;
    deps.setRenameTabDialog({
      conversationId: tabContextMenu.conversationId,
      title: tabContextMenu.title,
    });
    deps.setTabContextMenu(null);
  };

  const submitRenameTab = async (): Promise<void> => {
    const renameTabDialog = deps.getRenameTabDialog();
    if (!renameTabDialog) return;
    const nextTitle = renameTabDialog.title.trim();
    if (!nextTitle) {
      deps.setRenameTabDialog(null);
      return;
    }
    await deps.chatHistoryStore.updateTitle(renameTabDialog.conversationId, nextTitle);
    deps.assistantStore.setConversationTitle(nextTitle, renameTabDialog.conversationId);
    deps.setRenameTabDialog(null);
  };

  return {
    handleSelectTab,
    handleCloseTab,
    handleTabContextMenu,
    openRenameTabDialog,
    submitRenameTab,
  };
}
