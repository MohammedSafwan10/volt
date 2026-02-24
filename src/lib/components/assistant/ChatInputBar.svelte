<script lang="ts">
  import { UIIcon } from "$lib/components/ui";
  import type { AIMode } from "$lib/stores/ai.svelte";
  import { aiSettingsStore, PROVIDERS } from "$lib/stores/ai.svelte";
  import { IMAGE_LIMITS, assistantStore } from "$lib/stores/assistant.svelte";
  import { toastStore } from "$lib/stores/toast.svelte";
  import { readTextFile } from "@tauri-apps/plugin-fs";
  import { chatHistoryStore } from "$lib/stores/chat-history.svelte";
  import { getFileInfo } from "$lib/services/file-system";
  import MentionsMenu, { type MentionItem } from "./MentionsMenu.svelte";
  import ContextUsage from "./ContextUsage.svelte";
  import { fade } from "svelte/transition";

  const TREE_NODE_MIME = "application/x-volt-tree-node";

  interface Props {
    inputRef?: HTMLTextAreaElement;
    value: string;
    isStreaming: boolean;
    currentMode: AIMode;
    onInput: (
      value: string,
      source?: "user" | "history",
      attachments?: typeof assistantStore.pendingAttachments,
    ) => void;
    onSend: () => void;
    onStop: () => void;
    onModeChange: (mode: AIMode) => void;
    onAttachFile: () => void;
    onAttachSelection: () => void;
    onAttachImage?: (file: File) => void;
    onAttachImageFromPicker?: () => void;
    onOpenPromptLibrary?: () => void;
  }

  let {
    inputRef = $bindable(),
    value,
    isStreaming,
    currentMode,
    onInput,
    onSend,
    onStop,
    onModeChange,
    onAttachFile,
    onAttachSelection,
    onAttachImage,
    onAttachImageFromPicker,
    onOpenPromptLibrary,
  }: Props = $props();

  // Get current model from settings store (synced with settings panel)
  const currentModel = $derived(aiSettingsStore.modelPerMode[currentMode]);

  // Context usage tracking (reactive) - use current model
  const contextUsage = $derived(assistantStore.getContextUsage(currentModel));

  // SVG circle parameters for progress ring
  const RING_SIZE = 24;
  const RING_STROKE = 2.5;
  const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

  // Calculate stroke dash offset for progress
  const strokeDashoffset = $derived(
    RING_CIRCUMFERENCE - (contextUsage.percentage / 100) * RING_CIRCUMFERENCE,
  );

  // Determine ring color based on usage
  const ringColor = $derived(
    contextUsage.isOverLimit
      ? "var(--color-error)"
      : contextUsage.isNearLimit
        ? "var(--color-warning)"
        : "var(--color-green)",
  );

  let isDraggingOver = $state(false);

  let showModeMenu = $state(false);
  let showModelMenu = $state(false);
  let showAttachMenu = $state(false);
  let showMentionsMenu = $state(false);
  let mentionQuery = $state("");

  // Available models from provider config
  const availableModels = $derived(
    PROVIDERS[aiSettingsStore.selectedProvider].models,
  );

  // Display-friendly model name
  function getModelDisplayName(model: string): string {
    const thinking = model.endsWith("|thinking");
    const base = thinking ? model.slice(0, -"|thinking".length) : model;

    // OpenRouter models (format: org/model:variant)
    if (base.includes("/")) {
      const parts = base.split("/");
      const modelPart = parts[parts.length - 1];
      let displayName = modelPart
        .replace(":free", "")
        .replace(/-/g, " ")
        .split(" ")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");

      if (model.includes(":free")) displayName += " (free)";
      return thinking ? `${displayName} (thinking)` : displayName;
    }

    // OpenAI GPT-5
    if (base.startsWith("gpt-")) {
      const name = base
        .replace("gpt-5.2 pro", "GPT 5.2 Pro")
        .replace("gpt-5.2", "GPT 5.2")
        .replace("gpt-5.1-chat-latest", "GPT 5.1 (Instant)")
        .replace("gpt-5.1", "GPT 5.1")
        .replace("gpt-5.3-codex", "GPT 5.3 Codex")
        .replace("gpt-5-mini", "GPT 5 Mini")
        .replace("gpt-5-nano", "GPT 5 Nano")
        .replace("gpt-4o", "GPT 4o");
      return thinking ? `${name} (Thinking)` : name;
    }

    // Anthropic Claude
    if (base.startsWith("claude-")) {
      const name = base
        .replace("claude-", "Claude ")
        .replace("-4-6", " 4.6")
        .replace("opus", "Opus")
        .replace("sonnet-4-5-20250929", "Sonnet 4.5")
        .replace("sonnet-latest", "3.5 Sonnet")
        .replace("opus-latest", "3.5 Opus");
      return thinking ? `${name} (Thinking)` : name;
    }

    // Gemini
    if (base.startsWith("gemini-")) {
      const name = base
        .replace("gemini-3-flash-preview", "Gemini 3 Flash")
        .replace("gemini-2.5-flash", "Gemini 2.5 Flash")
        .replace("gemini-2.0-flash-exp", "Gemini 2.0 Flash")
        .replace("gemini-1.5-pro-latest", "Gemini 1.5 Pro")
        .replace("gemini-1.5-flash-latest", "Gemini 1.5 Flash")
        .replace("gemini-2.0-pro-exp-02-05", "Gemini 2.0 Pro");
      return thinking ? `${name} (Thinking)` : name;
    }

    if (base.startsWith("devstral-") || base.startsWith("codestral-")) {
      const name = base
        .replace("devstral-latest", "Devstral (latest, v25.12)")
        .replace("codestral-latest", "Codestral (latest, v25.08)")
        .replace("devstral-medium-latest", "Devstral Medium (v25.07)");
      return thinking ? `${name} (Thinking)` : name;
    }

    return thinking ? `${base} (thinking)` : base;
  }

  const modes: {
    id: AIMode;
    label: string;
    shortcut?: string;
    description: string;
  }[] = [
    { id: "agent", label: "Agent", description: "Execute tasks with tools" },
    {
      id: "ask",
      label: "Ask",
      description: "Quick questions and explanations",
    },
    { id: "plan", label: "Plan", description: "Design and plan features" },
  ];

  const currentModeInfo = $derived(
    modes.find((m) => m.id === currentMode) ?? modes[0],
  );

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (value.trim()) {
        onSend();
      }
    }

    if (e.key === "ArrowUp") {
      // Only navigate history if at the beginning of the textarea or if single line
      const isAtStart = inputRef ? inputRef.selectionStart === 0 : true;
      if (isAtStart) {
        const historyEntry = assistantStore.navigateHistory("up");
        if (historyEntry !== null) {
          e.preventDefault();
          onInput(historyEntry.content, "history", historyEntry.attachments);
          // Wait for DOM to update then move cursor to end
          setTimeout(() => {
            if (inputRef) {
              const len = inputRef.value.length;
              inputRef.setSelectionRange(len, len);
            }
          }, 0);
        }
      }
    }

    if (e.key === "ArrowDown") {
      // Only navigate history if at the end of the textarea
      const isAtEnd = inputRef
        ? inputRef.selectionEnd === inputRef.value.length
        : true;
      if (isAtEnd) {
        const historyEntry = assistantStore.navigateHistory("down");
        if (historyEntry !== null) {
          e.preventDefault();
          onInput(historyEntry.content, "history", historyEntry.attachments);
          setTimeout(() => {
            if (inputRef) {
              const len = inputRef.value.length;
              inputRef.setSelectionRange(len, len);
            }
          }, 0);
        }
      }
    }

    if (e.key === "Escape") {
      if (showMentionsMenu) {
        e.preventDefault();
        e.stopPropagation();
        showMentionsMenu = false;
        mentionQuery = "";
      } else if (
        showModeMenu ||
        showModelMenu ||
        showAttachMenu ||
        isStreaming
      ) {
        e.preventDefault();
        e.stopPropagation();
        showModeMenu = false;
        showModelMenu = false;
        showAttachMenu = false;
        if (isStreaming) onStop();
      }
    }
  }

  function handleInput(e: Event): void {
    const target = e.target as HTMLTextAreaElement;
    const newValue = target.value;
    onInput(newValue, "user");
    autoResize(target);

    // Detect @ mentions
    const cursorPos = target.selectionStart ?? newValue.length;
    const textBeforeCursor = newValue.slice(0, cursorPos);
    const lastAtIndex = textBeforeCursor.lastIndexOf("@");

    if (lastAtIndex >= 0) {
      // Check if @ is at start or preceded by whitespace
      const charBefore =
        lastAtIndex > 0 ? textBeforeCursor[lastAtIndex - 1] : " ";
      if (charBefore === " " || charBefore === "\n" || lastAtIndex === 0) {
        const query = textBeforeCursor.slice(lastAtIndex + 1);
        // Only show menu if no spaces in query (still typing the mention)
        if (!query.includes(" ")) {
          mentionQuery = query;
          showMentionsMenu = true;
          return;
        }
      }
    }
    // Close menu if @ was deleted or completed
    if (showMentionsMenu) {
      showMentionsMenu = false;
      mentionQuery = "";
    }
  }

  function autoResize(textarea: HTMLTextAreaElement): void {
    if (!textarea) return;
    // Reset to auto first to get accurate scrollHeight for current content
    textarea.style.height = "auto";
    const newHeight = Math.min(Math.max(textarea.scrollHeight, 28), 200);
    textarea.style.height = newHeight + "px";
  }

  // Auto-resize textarea when value changes (e.g. after sending or on external update like revert)
  $effect(() => {
    if (inputRef) {
      if (!value) {
        inputRef.style.height = "28px";
      } else {
        autoResize(inputRef);
      }
    }
  });

  function selectMode(mode: AIMode): void {
    onModeChange(mode);
    showModeMenu = false;
  }

  function openMentionsFromButton(): void {
    showAttachMenu = false;
    showMentionsMenu = true;
    mentionQuery = "";
    // Insert @ into input if not already there
    if (!value.endsWith("@") && !value.endsWith("@ ")) {
      onInput(value + (value && !value.endsWith(" ") ? " @" : "@"));
    }
    inputRef?.focus();
  }

  async function handleMentionSelect(item: MentionItem): Promise<void> {
    // Handle category selection - update query prefix to filter
    if (item.category === "category") {
      const cat = item.data as { prefix: string };
      if (cat.prefix) {
        // Replace the current @ query with the category-prefixed one
        const cursorPos = inputRef?.selectionStart ?? value.length;
        const textBeforeCursor = value.slice(0, cursorPos);
        const lastAtIndex = textBeforeCursor.lastIndexOf("@");
        if (lastAtIndex >= 0) {
          const before = value.slice(0, lastAtIndex + 1);
          const after = value.slice(cursorPos);
          onInput(before + cat.prefix + after);
          mentionQuery = cat.prefix;
          // Move cursor to end of prefix
          setTimeout(() => {
            if (inputRef) {
              const newPos = before.length + cat.prefix.length;
              inputRef.setSelectionRange(newPos, newPos);
            }
          }, 0);
        }
      }
      return;
    }

    // Remove the @ query from input
    const cursorPos = inputRef?.selectionStart ?? value.length;
    const textBeforeCursor = value.slice(0, cursorPos);
    const lastAtIndex = textBeforeCursor.lastIndexOf("@");
    if (lastAtIndex >= 0) {
      const before = value.slice(0, lastAtIndex);
      const after = value.slice(cursorPos);
      onInput(before + after);
    }

    // Attach the actual context based on category
    try {
      if (item.category === "file") {
        // Read file content and attach it
        const filePath = item.id; // item.id is the full path
        try {
          const content = await readTextFile(filePath);
          const result = assistantStore.attachFile(
            filePath,
            content,
            item.label,
          );
          if (!result.success) {
            console.warn("[Mentions] Failed to attach file:", result.error);
            toastStore.show({
              type: "error",
              message: result.error || "Failed to attach file",
            });
          }
        } catch (err: any) {
          console.error("[Mentions] Failed to read file:", filePath, err);
          toastStore.show({
            type: "error",
            message: `Could not read file: ${err.message || "Unknown error"}`,
            duration: 4000,
          });
        }
      } else if (item.category === "directory") {
        // For directories, attach as folder context
        const folderPath = item.id;
        assistantStore.attachFolder(folderPath);
      } else if (item.category === "terminal") {
        // Attach terminal reference - actual output capture would need terminal integration
        const label = `Terminal: ${item.label}`;
        assistantStore.attachContext({
          type: "selection",
          content: `[Terminal session: ${item.label}]`,
          label,
        });
      } else if (item.category === "conversation") {
        // Get conversation messages and attach as context
        const conversationId = item.id;
        const conversation =
          await chatHistoryStore.getConversation(conversationId);
        if (conversation) {
          const messages = conversation.messages
            .slice(-10) // Last 10 messages
            .map((m) => `${m.role}: ${m.content}`)
            .join("\n\n");
          assistantStore.attachContext({
            type: "selection",
            content: messages,
            label: `Chat: ${item.label}`,
          });
        }
      } else if (item.category === "mcp") {
        // For MCP servers, add a reference (tools will be available)
        assistantStore.attachContext({
          type: "selection",
          content: `MCP Server: ${item.label} (${item.sublabel || "connected"})`,
          label: `MCP: ${item.label}`,
        });
      }
    } catch (err) {
      console.error("[Mentions] Failed to attach context:", err);
    }

    showMentionsMenu = false;
    mentionQuery = "";
    inputRef?.focus();
  }

  function closeMentionsMenu(): void {
    showMentionsMenu = false;
    mentionQuery = "";
  }

  function handleAttachFile(): void {
    onAttachFile();
  }

  function handleAttachSelection(): void {
    onAttachSelection();
  }

  function handleAttachImagePicker(): void {
    onAttachImageFromPicker?.();
  }

  // Handle paste for images
  function handlePaste(e: ClipboardEvent): void {
    if (!onAttachImage) return;

    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          onAttachImage(file);
        }
        return;
      }
    }
  }

  // Handle drag over
  function handleDragOver(e: DragEvent): void {
    e.preventDefault();
    const types = e.dataTransfer?.types ?? [];
    if (
      types.includes("Files") ||
      types.includes(TREE_NODE_MIME) ||
      types.includes("text/plain")
    ) {
      isDraggingOver = true;
    }
  }

  // Handle drag leave
  function handleDragLeave(e: DragEvent): void {
    e.preventDefault();
    isDraggingOver = false;
  }

  // Handle drop for images
  async function handleDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    isDraggingOver = false;

    const transfer = e.dataTransfer;
    if (!transfer) return;

    // Internal file-tree drag/drop payload
    const treeNodeData = transfer.getData(TREE_NODE_MIME);
    if (treeNodeData) {
      try {
        const parsed = JSON.parse(treeNodeData) as {
          path?: string;
          name?: string;
          isDir?: boolean;
        };
        const path = parsed.path?.trim();
        if (!path) return;

        if (parsed.isDir) {
          assistantStore.attachFolder(path);
          return;
        }

        const content = await readTextFile(path);
        const label = parsed.name || path.split(/[\\/]/).pop() || path;
        const result = assistantStore.attachFile(path, content, label);
        if (!result.success) {
          toastStore.show({
            type: "warning",
            message: result.error || `Failed to attach ${label}`,
          });
        }
      } catch (err: any) {
        toastStore.show({
          type: "error",
          message: `Could not attach dropped file: ${err?.message || "Unknown error"}`,
        });
      }
      return;
    }

    // Platform fallback: some drags only provide plain-text absolute path.
    const plainPath = await getDroppedPathAsPlainText(transfer);
    if (plainPath) {
      try {
        const info = await getFileInfo(plainPath);
        if (info?.isDir) {
          assistantStore.attachFolder(plainPath);
          return;
        }

        const content = await readTextFile(plainPath);
        const label = info?.name || plainPath.split(/[\\/]/).pop() || plainPath;
        const result = assistantStore.attachFile(plainPath, content, label);
        if (!result.success) {
          toastStore.show({
            type: "warning",
            message: result.error || `Failed to attach ${label}`,
          });
        }
      } catch (err: any) {
        toastStore.show({
          type: "error",
          message: `Could not attach dropped path: ${err?.message || "Unknown error"}`,
        });
      }
      return;
    }

    const files = transfer.files;
    if (!files) return;

    for (const file of files) {
      const mimeType =
        file.type as (typeof IMAGE_LIMITS.allowedMimeTypes)[number];
      if (IMAGE_LIMITS.allowedMimeTypes.includes(mimeType)) {
        onAttachImage?.(file);
        continue;
      }

      // Try attaching dropped text/code files from OS file explorer
      if (!canAttachAsTextFile(file)) {
        continue;
      }

      try {
        const droppedPath = getDroppedFilePath(file);
        const content = droppedPath
          ? await readTextFile(droppedPath)
          : await file.text();
        const attachPath = droppedPath || file.name;
        const result = assistantStore.attachFile(
          attachPath,
          content,
          file.name,
        );
        if (!result.success) {
          toastStore.show({
            type: "warning",
            message: result.error || `Failed to attach ${file.name}`,
          });
        }
      } catch (err: any) {
        toastStore.show({
          type: "error",
          message: `Could not attach ${file.name}: ${err?.message || "Unknown error"}`,
        });
      }
    }
  }

  function getDroppedFilePath(file: File): string | null {
    const maybePath = (file as any).path;
    return typeof maybePath === "string" && maybePath.trim().length > 0
      ? maybePath
      : null;
  }

  function canAttachAsTextFile(file: File): boolean {
    // Guard against huge files in chat context
    if (file.size > 2 * 1024 * 1024) return false;

    const type = (file.type || "").toLowerCase();
    if (type.startsWith("text/")) return true;
    if (
      type.includes("json") ||
      type.includes("javascript") ||
      type.includes("typescript") ||
      type.includes("xml") ||
      type.includes("yaml")
    ) {
      return true;
    }

    const name = (file.name || "").toLowerCase();
    const textExtensions = [
      ".md",
      ".txt",
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".json",
      ".css",
      ".scss",
      ".html",
      ".svelte",
      ".rs",
      ".py",
      ".java",
      ".go",
      ".yaml",
      ".yml",
      ".xml",
      ".env",
      ".toml",
      ".ini",
      ".sh",
      ".ps1",
    ];
    return textExtensions.some((ext) => name.endsWith(ext));
  }

  async function getDroppedPathAsPlainText(
    transfer: DataTransfer,
  ): Promise<string | null> {
    const plain = transfer.getData("text/plain")?.trim();
    if (!plain) return null;

    if (
      plain.startsWith("{") ||
      plain.startsWith("http://") ||
      plain.startsWith("https://")
    ) {
      return null;
    }

    try {
      const info = await getFileInfo(plain);
      return info ? plain : null;
    } catch {
      return null;
    }
  }

  function handleClickOutside(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (!target.closest(".mode-dropdown-container")) {
      showModeMenu = false;
    }
    if (!target.closest(".model-dropdown-container")) {
      showModelMenu = false;
    }
    if (!target.closest(".attach-dropdown-container")) {
      showAttachMenu = false;
    }
  }

  function selectModel(model: string): void {
    aiSettingsStore.setModelForMode(currentMode, model);
    showModelMenu = false;
  }
</script>

<svelte:window onclick={handleClickOutside} />

<div
  class="chat-input-bar"
  class:dragging={isDraggingOver}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
  role="region"
  aria-label="Chat input area"
>
  {#if isDraggingOver}
    <div class="drop-overlay">
      <div class="drop-card">
        <div class="drop-icon">
          <UIIcon name="file" size={20} />
        </div>
        <div class="drop-text">
          <span class="drop-title">Drop to attach</span>
          <span class="drop-subtitle">Images, files, or folders</span>
        </div>
      </div>
    </div>
  {/if}

  <div class="unified-input-container">
    <!-- Mentions Menu (positioned above input) -->
    {#if showMentionsMenu}
      <MentionsMenu
        query={mentionQuery}
        onSelect={handleMentionSelect}
        onClose={closeMentionsMenu}
      />
    {/if}

    <!-- Text Input Area -->
    <div class="input-wrapper">
      <textarea
        bind:this={inputRef}
        class="chat-textarea"
        placeholder="Ask anything (Ctrl+L), @ to mention, / for workflows"
        rows="1"
        {value}
        oninput={handleInput}
        onkeydown={handleKeydown}
        onpaste={handlePaste}
        aria-label="Message input"
      ></textarea>
    </div>

    <!-- Bottom Bar with Mode Selector and Actions -->
    <div class="bottom-bar">
      <div class="left-controls">
        <!-- Attach Button (+) -->
        <div class="attach-dropdown-container">
          <button
            class="plus-btn"
            onclick={() => (showAttachMenu = !showAttachMenu)}
            title="Add context"
            aria-expanded={showAttachMenu}
            aria-haspopup="menu"
            type="button"
          >
            <UIIcon name="plus" size={16} />
          </button>

          {#if showAttachMenu}
            <div class="attach-menu" role="menu">
              <div class="menu-title">Add context</div>
              <button
                class="attach-option"
                onclick={handleAttachImagePicker}
                role="menuitem"
                type="button"
              >
                <UIIcon name="image" size={14} />
                <span>Media</span>
              </button>
              <button
                class="attach-option"
                onclick={openMentionsFromButton}
                role="menuitem"
                type="button"
              >
                <UIIcon name="at-sign" size={14} />
                <span>Mentions (@)</span>
              </button>
              <button
                class="attach-option"
                onclick={() => {
                  showAttachMenu = false;
                  onOpenPromptLibrary?.();
                }}
                role="menuitem"
                type="button"
              >
                <UIIcon name="code" size={14} />
                <span>Workflows (/)</span>
              </button>
            </div>
          {/if}
        </div>

        <button
          class="browser-tools-btn"
          class:active={assistantStore.browserToolsEnabled}
          onclick={() => assistantStore.toggleBrowserToolsEnabled()}
          title={assistantStore.browserToolsEnabled
            ? "Browser tools enabled: AI can inspect and automate the browser."
            : "Browser tools disabled: AI cannot use browser actions until you enable this."}
          aria-label="Toggle browser tools"
          aria-pressed={assistantStore.browserToolsEnabled}
          type="button"
        >
          <UIIcon name="globe" size={14} />
        </button>

        <!-- Mode Selector Dropdown -->
        <div class="mode-dropdown-container">
          <button
            class="mode-selector-btn"
            onclick={() => (showModeMenu = !showModeMenu)}
            aria-expanded={showModeMenu}
            aria-haspopup="listbox"
            type="button"
          >
            <UIIcon name="chevron-up" size={12} />
            <span class="mode-label">{currentModeInfo.label}</span>
          </button>

          {#if showModeMenu}
            <div class="mode-menu" role="listbox">
              {#each modes as mode (mode.id)}
                <button
                  class="mode-option"
                  class:active={currentMode === mode.id}
                  onclick={() => selectMode(mode.id)}
                  role="option"
                  aria-selected={currentMode === mode.id}
                  type="button"
                >
                  <span class="option-check"
                    >{currentMode === mode.id ? "✓" : ""}</span
                  >
                  <span class="option-label">{mode.label}</span>
                  {#if mode.shortcut}
                    <span class="option-shortcut">{mode.shortcut}</span>
                  {/if}
                </button>
              {/each}
            </div>
          {/if}
        </div>

        <!-- Model Selector Dropdown -->
        <div class="model-dropdown-container">
          <button
            class="model-selector-btn"
            type="button"
            title="Select model"
            onclick={() => (showModelMenu = !showModelMenu)}
            aria-expanded={showModelMenu}
            aria-haspopup="listbox"
          >
            <UIIcon name="chevron-up" size={12} />
            <span class="model-label">{getModelDisplayName(currentModel)}</span>
          </button>

          {#if showModelMenu}
            <div class="model-menu" role="listbox">
              <div class="menu-header">
                {PROVIDERS[aiSettingsStore.selectedProvider].name} Models
              </div>
              <div class="model-scroll">
                {#each availableModels as model (model)}
                  <button
                    class="model-option"
                    class:active={currentModel === model}
                    onclick={() => selectModel(model)}
                    role="option"
                    aria-selected={currentModel === model}
                    type="button"
                  >
                    <span class="option-label"
                      >{getModelDisplayName(model)}</span
                    >
                    {#if currentModel === model}
                      <span class="option-check">✓</span>
                    {/if}
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        </div>

        <ContextUsage {currentMode} {isStreaming} />
      </div>

      <div class="right-controls">
        <!-- Send/Stop Button (Circular) -->
        {#if isStreaming}
          <button
            class="send-btn stop"
            onclick={onStop}
            title="Stop (Esc)"
            aria-label="Stop generation"
            type="button"
          >
            <UIIcon name="stop" size={16} />
          </button>
        {:else}
          <button
            class="send-btn"
            onclick={onSend}
            disabled={!value.trim() &&
              !inputRef?.value?.trim() &&
              assistantStore.pendingAttachments.length === 0 &&
              assistantStore.attachedContext.length === 0}
            title="Send (Enter)"
            aria-label="Send message"
            type="button"
          >
            <UIIcon name="arrow-up" size={18} />
          </button>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .chat-input-bar {
    display: flex;
    flex-direction: column;
    padding: 12px;
    gap: 8px;
    position: relative;
  }

  .chat-input-bar.dragging {
    background: color-mix(in srgb, var(--color-accent) 8%, transparent);
  }

  .drop-overlay {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 10px;
    background: color-mix(in srgb, var(--color-bg) 72%, transparent);
    border-radius: 10px;
    z-index: 10;
    pointer-events: none;
  }

  .drop-card {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 220px;
    padding: 10px 12px;
    background: color-mix(
      in srgb,
      var(--color-bg-elevated, var(--color-surface0)) 85%,
      var(--color-accent) 15%
    );
    border: 1px dashed
      color-mix(in srgb, var(--color-accent) 70%, var(--color-border) 30%);
    border-radius: 8px;
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.25);
    color: var(--color-text);
  }

  .drop-icon {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    display: grid;
    place-items: center;
    color: var(--color-accent);
    background: color-mix(in srgb, var(--color-accent) 16%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-accent) 40%, transparent);
    flex: 0 0 auto;
  }

  .drop-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    line-height: 1.2;
  }

  .drop-title {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.01em;
  }

  .drop-subtitle {
    font-size: 12px;
    color: var(--color-text-secondary);
  }

  .unified-input-container {
    background: var(--color-bg-input, var(--color-surface0));
    border: 1px solid var(--color-border);
    border-radius: 12px;
    padding: 8px 4px 6px 4px;
    transition:
      border-color 0.15s ease,
      box-shadow 0.15s ease;
    display: flex;
    flex-direction: column;
  }

  .unified-input-container:focus-within {
    border-color: var(--color-text-disabled);
    box-shadow: 0 0 0 1px var(--color-border);
  }

  .input-wrapper {
    padding: 2px 12px 4px 12px;
  }

  .chat-textarea {
    width: 100%;
    min-height: 28px;
    max-height: 200px;
    padding: 2px 0;
    background: transparent;
    border: none;
    color: var(--color-text);
    font-size: 13.5px;
    line-height: 1.5;
    resize: none;
    outline: none;

    /* Premium smooth interactions */
    transition:
      height 0.15s cubic-bezier(0.4, 0, 0.2, 1),
      color 0.1s ease;

    caret-color: #d8b4fe;
  }

  .chat-textarea::placeholder {
    color: var(--color-text-secondary);
    opacity: 0.6;
    transition: opacity 0.2s ease;
  }

  .chat-textarea:focus::placeholder {
    opacity: 0.4;
  }

  .bottom-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 8px;
    gap: 8px;
  }

  .left-controls {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .right-controls {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  /* Plus Button */
  .plus-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 8px;
    color: var(--color-text-secondary);
    transition: all 0.1s ease;
    border: 1px solid transparent;
  }

  .plus-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
    border-color: var(--color-border);
  }

  .browser-tools-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 8px;
    color: var(--color-text-secondary);
    transition: all 0.1s ease;
    border: 1px solid transparent;
    background: transparent;
  }

  .browser-tools-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
    border-color: var(--color-border);
  }

  .browser-tools-btn.active {
    background: var(--color-accent-alpha);
    color: var(--color-accent);
    border-color: color-mix(in srgb, var(--color-accent) 45%, var(--color-border));
  }

  /* Dropdowns */
  .attach-dropdown-container,
  .mode-dropdown-container,
  .model-dropdown-container {
    position: relative;
  }

  .mode-selector-btn,
  .model-selector-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: transparent;
    border-radius: 6px;
    color: var(--color-text-secondary);
    font-size: 13px;
    transition: all 0.1s ease;
  }

  .mode-selector-btn:hover,
  .model-selector-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .mode-label,
  .model-label {
    font-weight: 400;
  }

  .attach-menu,
  .mode-menu,
  .model-menu {
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: 8px;
    min-width: 210px;
    background: var(--color-bg-elevated);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    box-shadow: var(--shadow-elevated, 0 12px 40px rgba(0, 0, 0, 0.8));
    padding: 6px 0;
    z-index: 1000;
    animation: dropdownIn 0.12s cubic-bezier(0, 0, 0.2, 1);
    transform-origin: bottom left;
  }

  @keyframes dropdownIn {
    from {
      opacity: 0;
      transform: scale(0.96) translateY(4px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }

  .menu-header {
    padding: 8px 14px 4px 14px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-accent);
    opacity: 0.9;
  }

  .model-scroll {
    max-height: 280px;
    overflow-y: auto;
    padding: 4px 0;
  }

  /* Custom scrollbar for a sleeker look */
  .model-scroll::-webkit-scrollbar {
    width: 4px;
  }
  .model-scroll::-webkit-scrollbar-thumb {
    background: var(--color-border);
    border-radius: 4px;
  }

  .attach-option,
  .mode-option,
  .model-option {
    display: flex;
    align-items: center;
    gap: 10px;
    width: calc(100% - 12px);
    margin: 1px 6px;
    padding: 6px 10px;
    font-size: 13px;
    font-weight: 500;
    color: var(--color-text);
    text-align: left;
    transition: all 0.1s ease;
    border-radius: 6px;
  }

  .attach-option:hover,
  .mode-option:hover,
  .model-option:hover {
    background: var(--color-hover);
  }

  .mode-option.active,
  .model-option.active {
    background: var(--color-accent-alpha);
    color: var(
      --color-text
    ); /* Keep text readable, maybe --color-accent if desired, but text often cleaner */
  }

  .mode-option.active .option-check {
    color: var(--color-accent);
  }

  .option-check {
    width: 14px;
    font-size: 12px;
    color: var(--color-accent);
  }

  .option-label {
    flex: 1;
  }

  .option-shortcut {
    color: var(--color-text-secondary);
    font-size: 11px;
    opacity: 0.6;
  }

  /* Send Button (Circular and Premium) */
  .send-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 50%; /* Pure circular like the request */
    background: #3c3c3c; /* Grey background when no text */
    color: #1e1e1e; /* Darker icon color for contrast on grey */
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    border: none;
    cursor: pointer;
  }

  /* Active state (when there is text to send) */
  .send-btn:not(:disabled):not(.stop) {
    background: #ffffff; /* Bright white when active */
    color: #000000; /* Dark icon when active */
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
  }

  .send-btn:hover:not(:disabled) {
    transform: scale(1.05);
    filter: brightness(1.1);
  }

  .send-btn:active:not(:disabled) {
    transform: scale(0.95);
  }

  .send-btn:disabled {
    cursor: default;
    opacity: 0.5;
  }

  .send-btn.stop {
    background: var(--color-error);
    color: white;
    box-shadow: 0 4px 12px rgba(239, 68, 68, 0.3);
    border-radius: 8px; /* Square with rounded corners for stop */
  }

  .send-btn:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
</style>
