<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { onDestroy, onMount } from "svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import { UIIcon } from "$shared/components/ui";
  import type {
    AssistantMessage,
    ToolCall,
    ContentPart,
  } from "$features/assistant/stores/assistant.svelte";
  import AssistantStreamingMarkdown from "./AssistantStreamingMarkdown.svelte";
  import Markdown from "$shared/components/ui/Markdown.svelte";
  import InlineToolCall from "./InlineToolCall.svelte";
  import FileEditCard from "./FileEditCard.svelte";
  import { getFileEditDiffStats } from "./file-edit-stats";
  import { openFullDiffView } from "$features/editor/services/diff-view";
  import { writeFile } from "$core/services/file-system";
  import { showToast } from "$shared/stores/toast.svelte";
  import { editorStore } from "$features/editor/stores/editor.svelte";
  import { isFileMutatingTool, isTerminalTool as isTerminalToolName } from "$core/ai/tools";
  import { normalizeAssistantMarkdown } from "$features/assistant/utils/assistant-markdown";
  import { isUnresolvedTerminalToolCall } from "./assistant-message-row-helpers";

  interface FileEditMeta extends Record<string, unknown> {
    beforeContent?: string;
    afterContent?: string;
    relativePath?: string;
    absolutePath?: string;
    isNewFile?: boolean;
    isDirectory?: boolean;
    revertedContent?: string;
  }

  interface ToolCallMeta extends Record<string, unknown> {
    textOffset?: number;
    fileEdit?: FileEditMeta;
    terminalRun?: {
      state?: string;
      commandPreview?: string;
      excerpt?: string;
      detectedUrl?: string;
      processId?: number;
    };
  }

  interface Props {
    message: AssistantMessage;
    msgIdx: number;
    showStreamingFallback?: boolean;
    renderMode?: "history" | "active";
    compactHistory?: boolean;
    expanded?: boolean;
    onToggleExpand?: () => void;
    onToolApprove?: (messageId: string, toolCall: ToolCall) => void;
    onToolDeny?: (messageId: string, toolCall: ToolCall) => void;
    elapsedTime?: string | null;
  }

  let {
    message,
    msgIdx: _msgIdx,
    showStreamingFallback = false,
    renderMode = "history",
    compactHistory = false,
    expanded = false,
    onToggleExpand,
    onToolApprove,
    onToolDeny,
    elapsedTime,
  }: Props =
    $props();

  const showStreaming = $derived(
    Boolean(message.isStreaming || showStreamingFallback),
  );
  const isActiveRow = $derived(renderMode === "active");
  const isCompactHistory = $derived(
    Boolean(compactHistory && !isActiveRow && !showStreaming),
  );

  // Track reverted tool calls
  let revertedIds = new SvelteSet<string>();
  let copyStatus = $state<"idle" | "copied">("idle");
  let turnReviewExpanded = $state(false);
  let copyTimeout: ReturnType<typeof setTimeout> | null = null;
  let lastContentPartsSource: AssistantMessage | null = null;
  let lastContentPartsValue: ContentPart[] = [];

  // Live timer for active thinking - updates every second
  let now = $state(Date.now());
  let timerInterval: ReturnType<typeof setInterval> | null = null;

  // Check if any thinking part is active
  const hasActiveThinking = $derived.by(() => {
    const parts = message.contentParts ?? [];
    return parts.some((p) => p.type === "thinking" && p.isActive);
  });

  // Start/stop timer based on active thinking
  $effect(() => {
    if (hasActiveThinking) {
      if (!timerInterval) {
        timerInterval = setInterval(() => {
          now = Date.now();
        }, 1000);
      }
    } else {
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
    }
  });

  onDestroy(() => {
    if (timerInterval) {
      clearInterval(timerInterval);
    }
    if (copyTimeout) {
      clearTimeout(copyTimeout);
    }
  });

  function isFileEditTool(toolCall: ToolCall): boolean {
    return isFileMutatingTool(toolCall.name);
  }

  function shouldRenderFileEditAsApproval(toolCall: ToolCall): boolean {
    return Boolean(
      toolCall.requiresApproval &&
        toolCall.status === "pending" &&
        toolCall.reviewStatus !== "accepted",
    );
  }

  function getFirstUnresolvedTerminalId(parts: ContentPart[]): string | null {
    for (const part of parts) {
      if (part.type !== "tool") continue;
      if (isUnresolvedTerminalToolCall(part.toolCall)) {
        return part.toolCall.id;
      }
    }
    return null;
  }

  function getToolCallPath(tc: ToolCall): string | null {
    const path = tc.arguments.path as string | undefined;
    return path ? path.replace(/\\/g, "/") : null;
  }

  function getToolTextOffset(tc: ToolCall): number | null {
    const offset = (tc.meta as ToolCallMeta | undefined)?.textOffset;
    return typeof offset === "number" && offset >= 0 ? offset : null;
  }

  function buildContentPartsFromOffsets(
    msg: AssistantMessage,
  ): ContentPart[] | null {
    if (!msg.inlineToolCalls?.length) return null;

    // Tool-only assistant turns are valid (no narrative text).
    // Render tool cards directly so they are visible live, not only after reload reconstruction.
    if (!msg.content) {
      return msg.inlineToolCalls.map((tc) => ({ type: "tool", toolCall: tc }));
    }

    const toolCallsWithOffsets = msg.inlineToolCalls
      .map((tc) => ({ tc, offset: getToolTextOffset(tc) }))
      .filter((item): item is { tc: ToolCall; offset: number } =>
        typeof item.offset === "number",
      )
      .sort((a, b) => a.offset - b.offset);

    if (toolCallsWithOffsets.length === 0) return null;

    const parts: ContentPart[] = [];
    let cursor = 0;

    for (const { tc, offset } of toolCallsWithOffsets) {
      const safeOffset = Math.min(Math.max(offset, 0), msg.content.length);
      const textChunk = msg.content.slice(cursor, safeOffset);
      if (textChunk.trim()) {
        parts.push({ type: "text", text: textChunk });
      }
      parts.push({ type: "tool", toolCall: tc });
      cursor = safeOffset;
    }

    const tail = msg.content.slice(cursor);
    if (tail.trim()) parts.push({ type: "text", text: tail });

    return parts.length > 0 ? parts : null;
  }

  function getContentParts(msg: AssistantMessage): ContentPart[] {
    if (msg === lastContentPartsSource) {
      return lastContentPartsValue;
    }

    const sanitizeVisibleText = (text: string): string =>
      normalizeAssistantMarkdown(
        text
          .replace(/<volt-spec-verify-json>[\s\S]*?<\/volt-spec-verify-json>/gi, "")
          .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
          .replace(/<system_context>[\s\S]*?<\/system_context>/gi, "")
          .replace(/<smart_context>[\s\S]*?<\/smart_context>/gi, "")
          .replace(/\n{3,}/g, "\n\n"),
      );

    // PRIORITY: Use saved contentParts (has correct order from streaming/history)
    // Only rebuild from offsets as a fallback for legacy messages without contentParts
    if (msg.contentParts?.length) {
      const cached = msg.contentParts
        .map((part) =>
          part.type === "text"
            ? { ...part, text: sanitizeVisibleText(part.text) }
            : part,
        )
        .filter((part) => part.type !== "text" || part.text);
      lastContentPartsSource = msg;
      lastContentPartsValue = cached;
      return cached;
    }
    
    // Fallback: try to rebuild from offsets (for old messages without contentParts)
    const rebuilt = buildContentPartsFromOffsets(msg);
    if (rebuilt) {
      const cached = rebuilt
        .map((part) =>
          part.type === "text"
            ? { ...part, text: sanitizeVisibleText(part.text) }
            : part,
        )
        .filter((part) => part.type !== "text" || part.text);
      lastContentPartsSource = msg;
      lastContentPartsValue = cached;
      return cached;
    }

    // Last-chance fallback for live turns where contentParts was not yet materialized.
    if (msg.inlineToolCalls?.length) {
      const cached: ContentPart[] = msg.inlineToolCalls.map((tc) => ({
        type: "tool" as const,
        toolCall: tc,
      }));
      lastContentPartsSource = msg;
      lastContentPartsValue = cached;
      return cached;
    }
    
    // Last resort: just the text content
    if (msg.content) {
      const cleaned = sanitizeVisibleText(msg.content);
      if (cleaned) {
        const cached: ContentPart[] = [{ type: "text" as const, text: cleaned }];
        lastContentPartsSource = msg;
        lastContentPartsValue = cached;
        return cached;
      }
    }
    lastContentPartsSource = msg;
    lastContentPartsValue = [];
    return lastContentPartsValue;
  }

  // Format thinking duration for display (Cursor-style)
  // Uses the live 'now' timer for active thinking to show realtime elapsed time
  function formatThinkingDuration(
    startTime: number,
    endTime?: number,
    isActive?: boolean,
  ): string {
    const end = isActive ? now : (endTime ?? now);
    const durationMs = end - startTime;
    const seconds = Math.floor(durationMs / 1000);
    if (seconds < 1) return "<1s";
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function getThinkingBody(
    part: Extract<ContentPart, { type: "thinking" }>,
  ): string {
    if (!part.title || part.isActive) return part.thinking;
    const trimmed = part.thinking.trimStart();
    if (!trimmed) return part.thinking;

    const lines = trimmed.split("\n");
    const firstLine = lines[0]?.trim() ?? "";
    if (!firstLine) return part.thinking;

    const normalizedTitle = part.title.replace(/\.\.\.$/, "").trim();
    const normalizedFirstLine = firstLine.replace(/\.\.\.$/, "").trim();
    if (normalizedTitle !== normalizedFirstLine) return part.thinking;

    const body = lines.slice(1).join("\n").trimStart();
    return body || part.thinking;
  }

  function groupFileEdits(
    parts: ContentPart[],
  ): Map<string, { primary: ToolCall; grouped: ToolCall[] }> {
    const groups = new SvelteMap<
      string,
      { primary: ToolCall; grouped: ToolCall[] }
    >();
    const processedIds = new SvelteSet<string>();

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (
        part.type !== "tool" ||
        !isFileEditTool(part.toolCall) ||
        processedIds.has(part.toolCall.id)
      )
        continue;

      const path = getToolCallPath(part.toolCall);
      if (!path) continue;

      const group: ToolCall[] = [];
      processedIds.add(part.toolCall.id);

      for (let j = i + 1; j < parts.length; j++) {
        const nextPart = parts[j];
        if (nextPart.type !== "tool" || !isFileEditTool(nextPart.toolCall))
          break;
        if (getToolCallPath(nextPart.toolCall) !== path) break;
        group.push(nextPart.toolCall);
        processedIds.add(nextPart.toolCall.id);
      }

      groups.set(part.toolCall.id, { primary: part.toolCall, grouped: group });
    }
    return groups;
  }

  function shouldSkipToolCall(
    tcId: string,
    groups: Map<string, { primary: ToolCall; grouped: ToolCall[] }>,
  ): boolean {
    for (const [_, group] of groups) {
      if (group.grouped.some((tc) => tc.id === tcId)) return true;
    }
    return false;
  }

  /**
   * Open full Monaco DiffEditor with proper red/green inline diff
   * This shows deleted lines in RED and added lines in GREEN
   */
  function handleFullDiff(toolCall: ToolCall, allToolCalls?: ToolCall[]): void {
    // Get content for diff
    let originalContent: string | undefined;
    let modifiedContent: string | undefined;
    let filePath: string;

    if (allToolCalls && allToolCalls.length > 1) {
      // Grouped edits - use first beforeContent and last afterContent
      const firstMeta = allToolCalls[0].meta as ToolCallMeta | undefined;
      const firstFileEdit = firstMeta?.fileEdit;
      originalContent = firstFileEdit?.beforeContent;
      
      const lastMeta = allToolCalls[allToolCalls.length - 1].meta as ToolCallMeta | undefined;
      const lastFileEdit = lastMeta?.fileEdit;
      modifiedContent = lastFileEdit?.afterContent;
      
      filePath =
        firstFileEdit?.absolutePath ||
        (toolCall.arguments.path as string) ||
        firstFileEdit?.relativePath ||
        "";
    } else {
      // Single edit
      const meta = toolCall.meta as ToolCallMeta | undefined;
      const fileEdit = meta?.fileEdit;
      originalContent = fileEdit?.beforeContent;
      modifiedContent = fileEdit?.afterContent;
      filePath =
        fileEdit?.absolutePath ||
        (toolCall.arguments.path as string) ||
        fileEdit?.relativePath ||
        "";
    }

    if (typeof originalContent !== 'string' || typeof modifiedContent !== 'string') {
      showToast({ message: 'Cannot show diff: content not available', type: 'error' });
      return;
    }

    openFullDiffView({
      filePath,
      originalContent,
      modifiedContent,
      toolCallId: toolCall.id,
    });
  }

  async function handleRevert(toolCall: ToolCall): Promise<void> {
    const meta = toolCall.meta as ToolCallMeta | undefined;
    const fileEdit = meta?.fileEdit;
    const beforeContent = fileEdit?.beforeContent;
    const absolutePath = fileEdit?.absolutePath;
    const isNewFile = fileEdit?.isNewFile === true;
    const isDirectory = fileEdit?.isDirectory === true;

    // For new files, we want to delete on revert
    if (isNewFile && absolutePath) {
      try {
        await invoke("delete_path", { path: absolutePath });
        revertedIds.add(toolCall.id);
        showToast({ message: isDirectory ? "Folder deleted (reverted)" : "File deleted (reverted)", type: "success" });

        // Close tab if open
        editorStore.closeFile(absolutePath, true);
        return;
      } catch (e) {
        console.error("[Revert] Delete failed:", e);
        showToast({
          message: isDirectory ? "Failed to delete folder on revert" : "Failed to delete file on revert",
          type: "error",
        });
        return;
      }
    }

    if (typeof beforeContent !== "string" || !absolutePath) {
      showToast({
        message: "Cannot revert: original content not available",
        type: "error",
      });
      return;
    }

    // Store current content for undo
    const afterContent = fileEdit?.afterContent;
    if (afterContent !== undefined) {
      // Store in meta for undo
      (fileEdit as Record<string, unknown>).revertedContent = afterContent;
    }

    // Write the original content back
    const success = await writeFile(absolutePath, beforeContent);
    if (success) {
      revertedIds.add(toolCall.id);
      showToast({ message: "Changes reverted", type: "success" });

      // Reload file in editor if open
      await editorStore.reloadFile(absolutePath);
    } else {
      showToast({ message: "Failed to revert changes", type: "error" });
    }
  }

  async function handleUndoRevert(toolCall: ToolCall): Promise<void> {
    const meta = toolCall.meta as ToolCallMeta | undefined;
    const fileEdit = meta?.fileEdit;
    const afterContent = fileEdit?.afterContent;
    const revertedContent = fileEdit?.revertedContent;
    const absolutePath = fileEdit?.absolutePath;
    const isNewFile = fileEdit?.isNewFile === true;
    const isDirectory = fileEdit?.isDirectory === true;

    const contentToRestore = revertedContent ?? afterContent;

    if (isNewFile && isDirectory && absolutePath) {
      try {
        await invoke("create_dir", { path: absolutePath });
        revertedIds.delete(toolCall.id);
        showToast({ message: "Folder restored", type: "success" });
        return;
      } catch (e) {
        console.error("[Revert] Restore folder failed:", e);
        showToast({ message: "Failed to restore folder", type: "error" });
        return;
      }
    }

    if (typeof contentToRestore !== "string" || !absolutePath) {
      showToast({
        message: "Cannot restore: content not available",
        type: "error",
      });
      return;
    }

    // Write the AI content back
    const success = await writeFile(absolutePath, contentToRestore);
    if (success) {
      revertedIds.delete(toolCall.id);
      showToast({ message: "Changes restored", type: "success" });

      // Reload file in editor if open
      await editorStore.reloadFile(absolutePath);
    } else {
      showToast({ message: "Failed to restore changes", type: "error" });
    }
  }

  const renderContentParts = $derived.by(() =>
    isCompactHistory ? [] : getContentParts(message),
  );
  const completedFileEditCalls = $derived.by(() =>
    renderContentParts
      .filter(
        (part): part is Extract<ContentPart, { type: "tool" }> =>
          part.type === "tool" &&
          isFileEditTool(part.toolCall) &&
          part.toolCall.status === "completed",
      )
      .map((part) => part.toolCall),
  );
  function getFileEditMeta(toolCall: ToolCall): FileEditMeta | null {
    const meta = toolCall.meta as ToolCallMeta | undefined;
    return meta?.fileEdit ?? null;
  }
  function isDirectoryEditGroup(group: {
    primary: ToolCall;
    calls: ToolCall[];
  }): boolean {
    return group.calls.some((call) => getFileEditMeta(call)?.isDirectory === true);
  }
  function canShowGroupDiff(group: {
    primary: ToolCall;
    calls: ToolCall[];
  }): boolean {
    return group.calls.some((call) => {
      const fileEdit = getFileEditMeta(call);
      if (!fileEdit || fileEdit.isDirectory === true) return false;
      return (
        typeof fileEdit.beforeContent === "string" ||
        fileEdit.isNewFile === true
      );
    });
  }
  function getGroupReviewLabel(group: {
    primary: ToolCall;
    calls: ToolCall[];
  }): string {
    if (isDirectoryEditGroup(group)) return "Folder";
    const lastCall = group.calls[group.calls.length - 1] ?? group.primary;
    const fileEdit = getFileEditMeta(lastCall);
    return fileEdit?.isNewFile === true ? "Created file" : "Edited file";
  }
  const turnFileGroups = $derived.by(() => {
    const groups = new SvelteMap<
      string,
      { primary: ToolCall; calls: ToolCall[]; filename: string; stats: ReturnType<typeof getFileEditDiffStats> }
    >();
    for (const toolCall of completedFileEditCalls) {
      const path = String(toolCall.arguments.path || "");
      if (!path) continue;
      const existing = groups.get(path);
      if (existing) {
        existing.calls.push(toolCall);
        existing.stats = getFileEditDiffStats(existing.calls);
        continue;
      }
      groups.set(path, {
        primary: toolCall,
        calls: [toolCall],
        filename: path.split(/[/\\]/).pop() || path,
        stats: getFileEditDiffStats([toolCall]),
      });
    }
    return Array.from(groups.values());
  });
  const turnEditSummary = $derived.by(() => {
    if (turnFileGroups.length === 0) return null;
    let added = 0;
    let removed = 0;
    let folderCount = 0;
    for (const group of turnFileGroups) {
      if (group.stats) {
        added += group.stats.added;
        removed += group.stats.removed;
      }
      if (isDirectoryEditGroup(group)) folderCount++;
    }
    const fileCount = turnFileGroups.length - folderCount;
    const label =
      folderCount > 0 && fileCount === 0
        ? `Created ${folderCount} folder${folderCount === 1 ? "" : "s"}`
        : folderCount === 0
          ? `Edited ${fileCount} file${fileCount === 1 ? "" : "s"}`
          : `Changed ${turnFileGroups.length} item${turnFileGroups.length === 1 ? "" : "s"}`;
    return {
      label,
      fileCount: turnFileGroups.length,
      folderCount,
      added,
      removed,
    };
  });
  function isTextPart(part: ContentPart): part is Extract<ContentPart, { type: "text" }> {
    return part.type === "text";
  }

  const copyableText = $derived.by(() => {
    const textChunks = renderContentParts
      .filter(isTextPart)
      .map((p) => p.text)
      .filter(Boolean);
    if (textChunks.length > 0) return textChunks.join("\n\n").trim();
    return message.content?.trim() || "";
  });
  const fileEditGroups = $derived(groupFileEdits(renderContentParts));
  const visibleContentParts = $derived(
    renderContentParts.filter((part) => {
      if (part.type !== "tool") return true;
      return !shouldSkipToolCall(part.toolCall.id, fileEditGroups);
    }),
  );

  type ToolContentPart = Extract<ContentPart, { type: "tool" }>;
  type ThinkingContentPart = Extract<ContentPart, { type: "thinking" }>;
  type TextContentPart = Extract<ContentPart, { type: "text" }>;
  type ThinkingDisplayGroup = {
    parts: ThinkingContentPart[];
    indices: number[];
  };

  type DisplayBlock =
    | { type: "island"; parts: ToolContentPart[] }
    | { type: "thinking"; group: ThinkingDisplayGroup }
    | { type: "text"; part: TextContentPart; i: number };

  const displayBlocks = $derived.by(() => {
    let blocks: DisplayBlock[] = [];
    let currentIslandParts: ToolContentPart[] | null = null;
    
    for (let i = 0; i < visibleContentParts.length; i++) {
       const part = visibleContentParts[i];
       
       if (part.type === "tool") {
          if (!currentIslandParts) {
             currentIslandParts = [part];
             blocks.push({ type: "island", parts: currentIslandParts });
          } else {
             currentIslandParts.push(part);
          }
       } else {
          currentIslandParts = null;
          if (part.type === "thinking") {
             const previousBlock = blocks[blocks.length - 1];
             if (previousBlock?.type === "thinking") {
               previousBlock.group.parts.push(part);
               previousBlock.group.indices.push(i);
             } else {
               blocks.push({
                 type: "thinking",
                 group: {
                   parts: [part],
                   indices: [i],
                 },
               });
             }
          } else if (part.type === "text" && part.text.trim()) {
             blocks.push({ type: "text", part, i });
          }
       }
    }
    return blocks;
  });

  const lastVisibleTextPartIndex = $derived.by(() => {
    for (let index = visibleContentParts.length - 1; index >= 0; index -= 1) {
      const part = visibleContentParts[index];
      if (part.type === "text" && part.text.trim()) {
        return index;
      }
    }
    return -1;
  });
  const firstPendingTerminalId = $derived(
    isCompactHistory ? null : getFirstUnresolvedTerminalId(renderContentParts),
  );
  const compactToolCalls = $derived.by(() => {
    const calls = message.inlineToolCalls ?? message.toolCalls ?? [];
    return calls;
  });
  const compactToolCount = $derived(compactToolCalls.length);
  const compactFileEditCount = $derived.by(() =>
    compactToolCalls.filter((toolCall) => isFileEditTool(toolCall)).length,
  );
  const compactSummaryText = $derived.by(() => {
    const cleaned = normalizeAssistantMarkdown(
      message.content
        .replace(/<volt-spec-verify-json>[\s\S]*?<\/volt-spec-verify-json>/gi, "")
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
        .replace(/<system_context>[\s\S]*?<\/system_context>/gi, "")
        .replace(/<smart_context>[\s\S]*?<\/smart_context>/gi, ""),
    )
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return "";
    if (cleaned.length <= 220) return cleaned;
    return `${cleaned.slice(0, 219).trimEnd()}…`;
  });

  // Track manual toggle state for thinking blocks to avoid auto-reopening during streaming
  let manualThinkingStates = $state<Record<string, boolean>>({});
  let autoExpandThinking = $state(true);

  onMount(() => {
    try {
      const stored = localStorage.getItem("assistant.thinking.autoExpand");
      if (stored === "false") autoExpandThinking = false;
    } catch {
      // ignore
    }
  });

  function getThinkingKey(part: ContentPart, idx: number): string {
    if (part.type !== "thinking") return `text-${idx}`;
    const title = part.title ?? "";
    const end = typeof part.endTime === "number" ? part.endTime : "active";
    return `thinking:${part.startTime}:${end}:${title}`;
  }

  function handleThinkingToggle(key: string, event: Event) {
    const details = event.currentTarget as HTMLDetailsElement;
    manualThinkingStates[key] = details.open;
    autoExpandThinking = details.open;
    try {
      localStorage.setItem(
        "assistant.thinking.autoExpand",
        autoExpandThinking ? "true" : "false",
      );
    } catch {
      // ignore
    }
  }

  function getDisplayBlockKey(block: DisplayBlock): string {
    if (block.type === "island") {
      return `island:${block.parts.map((part) => part.toolCall.id).join(":")}`;
    }
    if (block.type === "thinking") {
      return block.group.parts
        .map((part, index) => getThinkingKey(part, block.group.indices[index] ?? index))
        .join("|");
    }
    return `text:${block.i}`;
  }

  function getThinkingGroupSummary(group: ThinkingDisplayGroup): {
    active: boolean;
    title: string;
    startTime: number;
    endTime?: number;
    body: string;
    key: string;
  } {
    const first = group.parts[0];
    const last = group.parts[group.parts.length - 1];
    const active = group.parts.some((part) => part.isActive);
    const title =
      last?.title ||
      first?.title ||
      (active ? "Thinking" : "Thought");
    const body = group.parts
      .map((part) => getThinkingBody(part))
      .filter((chunk) => chunk.trim().length > 0)
      .join("\n\n");

    return {
      active,
      title,
      startTime: first?.startTime ?? Date.now(),
      endTime: active ? undefined : last?.endTime,
      body,
      key: group.parts
        .map((part, index) => getThinkingKey(part, group.indices[index] ?? index))
        .join("|"),
    };
  }

  $effect(() => {
    if (isCompactHistory) return;
    // Auto-close finished thinking blocks
    const parts = getContentParts(message);
    parts.forEach((part, i) => {
      if (part.type === "thinking" && !part.isActive) {
        const key = getThinkingKey(part, i);
        if (manualThinkingStates[key] === undefined) {
          manualThinkingStates[key] = false;
        }
      }
    });
  });

  async function handleCopyMessage(): Promise<void> {
    if (!copyableText) {
      showToast({ message: "Nothing to copy", type: "warning" });
      return;
    }
    try {
      await navigator.clipboard.writeText(copyableText);
      copyStatus = "copied";
      if (copyTimeout) clearTimeout(copyTimeout);
      copyTimeout = setTimeout(() => {
        copyStatus = "idle";
      }, 1500);
    } catch (err) {
      showToast({
        message: err instanceof Error ? err.message : "Failed to copy",
        type: "error",
      });
    }
  }

</script>

<article
  class="message-row assistant"
  class:streaming={showStreaming}
  class:active-row={isActiveRow}
>
  <div class="msg-body">
    <div class="activity-thread">
      {#if !isActiveRow}
        <div class="activity-spine"></div>
      {/if}
      <div class="activity-content">
        {#if isCompactHistory}
          <div class="compact-history-row">
            <div class="compact-history-main">
              {#if compactSummaryText}
                <div class="compact-history-summary">{compactSummaryText}</div>
              {:else}
                <div class="compact-history-summary muted">Tool-only assistant turn</div>
              {/if}
              <div class="compact-history-badges">
                {#if compactToolCount > 0}
                  <span class="meta-pill">
                    <UIIcon name="tools" size={12} />
                    <span>{compactToolCount} tool{compactToolCount === 1 ? "" : "s"}</span>
                  </span>
                {/if}
                {#if compactFileEditCount > 0}
                  <span class="meta-pill">
                    <UIIcon name="pencil" size={12} />
                    <span>{compactFileEditCount} edit{compactFileEditCount === 1 ? "" : "s"}</span>
                  </span>
                {/if}
                {#if elapsedTime}
                  <span class="meta-pill">
                    <UIIcon name="clock" size={12} />
                    <span>{elapsedTime}</span>
                  </span>
                {/if}
              </div>
            </div>
            <button
              class="compact-history-expand"
              type="button"
              onclick={onToggleExpand}
            >
              <span>{expanded ? "Collapse" : "Expand"}</span>
            </button>
          </div>
        {:else}
          {#each displayBlocks as block (getDisplayBlockKey(block))}
            <div class="activity-item" class:island-wrapper={block.type === "island"}>
              {#if block.type === "thinking"}
                {@const summary = getThinkingGroupSummary(block.group)}
                <details
                  class="inline-thinking"
                  open={manualThinkingStates[summary.key] ??
                    (autoExpandThinking ? summary.active : false)}
                  ontoggle={(e) => handleThinkingToggle(summary.key, e)}
                >
                  <summary class="thinking-header">
                    <div class="thinking-header-content" class:active={summary.active}>
                      <span class="thinking-icon" class:active={summary.active}>
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <path
                            d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2 2.5 2.5 0 0 1 .5 0Z"
                          />
                          <path
                            d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2 2.5 2.5 0 0 0-.5 0Z"
                          />
                        </svg>
                      </span>
                      {#if summary.active}
                        <span class="thinking-label">
                          {summary.title}
                          <span class="thinking-dots"></span>
                          <span class="thinking-duration"
                            >({formatThinkingDuration(
                              summary.startTime,
                              undefined,
                              true,
                            )})</span
                          >
                        </span>
                      {:else}
                        <span class="thinking-duration">
                          {summary.title} for {formatThinkingDuration(
                            summary.startTime,
                            summary.endTime,
                            false,
                          )}
                        </span>
                      {/if}
                    </div>
                  </summary>
                  <div class="thinking-body">
                    {#if block.group.parts.length === 1 && summary.title && !summary.active}
                      <div class="thinking-title">{summary.title}</div>
                    {/if}
                    <div class="thinking-content">{summary.body}</div>
                  </div>
                </details>

              {:else if block.type === "island"}
                <div class="dynamic-tool-island">
                  {#each block.parts as part (part.toolCall.id)}
                    {@const isGroupedChild = shouldSkipToolCall(
                      part.toolCall.id,
                      fileEditGroups,
                    )}
                    {#if !isGroupedChild}
                      <div class="inline-tool-wrapper pill-mode">
                        {#if isFileEditTool(part.toolCall) && !shouldRenderFileEditAsApproval(part.toolCall)}
                          {@const group = fileEditGroups.get(part.toolCall.id)}
                          <FileEditCard
                            toolCall={part.toolCall}
                            groupedToolCalls={group?.grouped ?? []}
                            compact={isActiveRow}
                            onFullDiff={handleFullDiff}
                            onRevert={handleRevert}
                            onUndoRevert={handleUndoRevert}
                            isReverted={revertedIds.has(part.toolCall.id)}
                            {revertedIds}
                          />
                        {:else}
                          <InlineToolCall
                            toolCall={part.toolCall}
                            compact={isActiveRow}
                            showApprovalInline={true}
                            onApprove={onToolApprove
                              ? () => onToolApprove(message.id, part.toolCall)
                              : undefined}
                            onDeny={onToolDeny
                              ? () => onToolDeny(message.id, part.toolCall)
                              : undefined}
                            isFirstPendingTerminal={!isTerminalToolName(part.toolCall.name) ||
                              part.toolCall.id === firstPendingTerminalId}
                          />
                        {/if}
                      </div>
                    {/if}
                  {/each}
                </div>

              {:else if block.type === "text"}
                {@const part = block.part}
                {@const i = block.i}
                <div class="msg-content">
                  {#if showStreaming && i === lastVisibleTextPartIndex}
                    <div class="streaming-tail">
                      <AssistantStreamingMarkdown
                        content={part.text}
                        streaming={true}
                      />
                    </div>
                  {:else}
                    <Markdown content={part.text} profile="chat" />
                  {/if}
                </div>
              {/if}
            </div>
          {/each}

          {#if showStreaming}
            <div class="msg-content">
              <div
                class="streaming-indicator-row"
                class:only-indicator={renderContentParts.length === 0}
                aria-hidden="true"
              >
                <span class="snake-grid"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
              </div>
            </div>
          {/if}
        {/if}
      </div>
    </div>

    {#if !showStreaming && !isCompactHistory}
      {#if turnEditSummary}
        <div class="turn-summary">
          <span class="turn-summary-label">{turnEditSummary.label}</span>
          <span class="turn-summary-ledger">
            {#if turnEditSummary.added > 0}
              <span class="added">+{turnEditSummary.added}</span>
            {/if}
            {#if turnEditSummary.removed > 0}
              <span class="removed">-{turnEditSummary.removed}</span>
            {/if}
          </span>
          <button
            class="turn-summary-action"
            type="button"
            onclick={() => (turnReviewExpanded = !turnReviewExpanded)}
          >
            {turnReviewExpanded ? "Hide review" : "Review"}
          </button>
        </div>
        {#if turnReviewExpanded}
          <div class="turn-review">
            {#each turnFileGroups as group (group.primary.arguments.path as string)}
              <div class="turn-review-row">
                <div class="turn-review-file">
                  <span class="turn-review-name">{group.filename}</span>
                  <span class="turn-review-path">{group.primary.arguments.path as string}</span>
                </div>
                <div class="turn-review-meta">
                  <span class="turn-review-kind">{getGroupReviewLabel(group)}</span>
                  {#if group.stats}
                    <span class="turn-review-ledger">
                      {#if group.stats.added > 0}
                        <span class="added">+{group.stats.added}</span>
                      {/if}
                      {#if group.stats.removed > 0}
                        <span class="removed">-{group.stats.removed}</span>
                      {/if}
                    </span>
                  {/if}
                  {#if canShowGroupDiff(group)}
                    <button
                      class="turn-review-diff"
                      type="button"
                      onclick={() =>
                        handleFullDiff(
                          group.primary,
                          group.calls.length > 1 ? group.calls : undefined,
                        )}
                    >
                      Diff
                    </button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      {/if}
      <div class="message-meta">
        <div class="meta-left">
          <span class="meta-time">{formatTime(message.timestamp)}</span>
          {#if message.streamState === "interrupted"}
            <span class="meta-pill warning" title={message.streamIssue || "Stream interrupted"}>
              <UIIcon name="warning" size={12} />
              <span>Interrupted</span>
            </span>
          {:else if message.streamState === "failed"}
            <span class="meta-pill error" title={message.streamIssue || "Generation failed"}>
              <UIIcon name="error" size={12} />
              <span>Failed</span>
            </span>
          {:else if message.streamState === "cancelled"}
            <span class="meta-pill" title={message.streamIssue || "Generation cancelled"}>
              <UIIcon name="close" size={12} />
              <span>Cancelled</span>
            </span>
          {/if}
          {#if elapsedTime}
            <span class="meta-pill" title="Generation time">
              <UIIcon name="clock" size={12} />
              <span>{elapsedTime}</span>
            </span>
          {/if}
        </div>
        {#if copyableText}
          <div class="meta-actions">
            <button
              class="copy-btn"
              onclick={handleCopyMessage}
              title="Copy assistant text (excludes tool cards)"
              type="button"
              aria-label="Copy assistant text"
            >
              <UIIcon
                name={copyStatus === "copied" ? "check" : "copy"}
                size={12}
              />
              <span class="copy-label"
                >{copyStatus === "copied" ? "Copied" : "Copy"}</span
              >
            </button>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</article>

<style>
  .message-row {
    display: flex;
    gap: 10px;
    animation: slideIn 0.2s ease;
  }

  .message-row.active-row {
    animation: none;
  }
  @keyframes slideIn {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .msg-body {
    flex: 1;
    min-width: 0;
    max-width: 100%;
    padding-top: 0;
  }

  .activity-thread {
    position: relative;
    padding-left: 18px;
  }

  .dynamic-tool-island {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    background: transparent;
    padding: 0 0 6px 0;
  }

  .dynamic-tool-island > :global(.inline-tool-wrapper) {
    min-width: 0;
    max-width: 100%;
  }

  .dynamic-tool-island > :global(.inline-tool-wrapper > *) {
    margin: 0 !important;
  }

  .active-row .activity-thread {
    padding-left: 0;
  }

  .compact-history-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid var(--color-border);
    border-radius: 10px;
    background: color-mix(in srgb, var(--color-bg-secondary) 82%, transparent);
  }

  .compact-history-main {
    min-width: 0;
    display: grid;
    gap: 8px;
  }

  .compact-history-summary {
    color: var(--color-text);
    line-height: 1.55;
    word-break: break-word;
  }

  .compact-history-summary.muted {
    color: var(--color-text-secondary);
  }

  .compact-history-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .compact-history-expand {
    flex: 0 0 auto;
    padding: 6px 10px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: transparent;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: border-color 0.15s ease, color 0.15s ease,
      background 0.15s ease;
  }

  .compact-history-expand:hover {
    color: var(--color-text);
    border-color: color-mix(in srgb, var(--color-accent) 32%, var(--color-border));
    background: color-mix(in srgb, var(--color-bg-hover) 80%, transparent);
  }

  .activity-spine {
    position: absolute;
    left: 4px;
    top: 6px;
    bottom: 6px;
    width: 1px;
    background: linear-gradient(
      to bottom,
      var(--color-border) 0%,
      var(--color-border) 70%,
      transparent 100%
    );
    opacity: 0.5;
  }

  .activity-item {
    position: relative;
    margin-bottom: 8px;
  }

  .active-row .activity-item {
    margin-bottom: 6px;
  }

  .activity-item:last-child {
    margin-bottom: 0;
  }

  .activity-item::before {
    content: "";
    position: absolute;
    left: -14px;
    top: 8px;
    width: 13px;
    height: 1px;
    background: var(--color-border);
    opacity: 0.3;
  }

  .active-row .activity-item::before {
    display: none;
  }

  .inline-tool-wrapper {
    margin: 2px 0;
  }

  .msg-content {
    font-size: 13px;
    line-height: 1.6;
    color: var(--color-text);
    word-break: break-word;
  }

  .active-row .msg-content {
    font-size: 12.5px;
    line-height: 1.55;
  }

  .streaming-tail {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    min-width: 0;
  }

  .streaming-indicator-row {
    display: flex;
    align-items: center;
    min-height: 13px;
    padding-left: 2px;
  }

  .streaming-indicator-row.only-indicator {
    padding-left: 0;
  }

  .snake-grid {
    display: grid;
    grid-template-columns: repeat(3, 3px);
    grid-template-rows: repeat(3, 3px);
    gap: 2px;
  }
  
  .snake-grid i {
    width: 3px;
    height: 3px;
    background-color: var(--color-text);
    border-radius: 50%;
    opacity: 0.15;
  }
  
  .snake-grid i:nth-child(1) { animation: fill-1 1.35s infinite; }
  .snake-grid i:nth-child(2) { animation: fill-2 1.35s infinite; }
  .snake-grid i:nth-child(3) { animation: fill-3 1.35s infinite; }
  .snake-grid i:nth-child(6) { animation: fill-6 1.35s infinite; }
  .snake-grid i:nth-child(9) { animation: fill-9 1.35s infinite; }
  .snake-grid i:nth-child(8) { animation: fill-8 1.35s infinite; }
  .snake-grid i:nth-child(7) { animation: fill-7 1.35s infinite; }
  .snake-grid i:nth-child(4) { animation: fill-4 1.35s infinite; }
  .snake-grid i:nth-child(5) { animation: fill-5 1.35s infinite; }
  
  @keyframes fill-1 { 0% { opacity: 0.15; transform: scale(0.95); } 11%, 95% { opacity: 0.85; transform: scale(1.15); } 100% { opacity: 0.15; transform: scale(0.95); } }
  @keyframes fill-2 { 0%, 11% { opacity: 0.15; transform: scale(0.95); } 22%, 95% { opacity: 0.85; transform: scale(1.15); } 100% { opacity: 0.15; transform: scale(0.95); } }
  @keyframes fill-3 { 0%, 22% { opacity: 0.15; transform: scale(0.95); } 33%, 95% { opacity: 0.85; transform: scale(1.15); } 100% { opacity: 0.15; transform: scale(0.95); } }
  @keyframes fill-6 { 0%, 33% { opacity: 0.15; transform: scale(0.95); } 44%, 95% { opacity: 0.85; transform: scale(1.15); } 100% { opacity: 0.15; transform: scale(0.95); } }
  @keyframes fill-9 { 0%, 44% { opacity: 0.15; transform: scale(0.95); } 55%, 95% { opacity: 0.85; transform: scale(1.15); } 100% { opacity: 0.15; transform: scale(0.95); } }
  @keyframes fill-8 { 0%, 55% { opacity: 0.15; transform: scale(0.95); } 66%, 95% { opacity: 0.85; transform: scale(1.15); } 100% { opacity: 0.15; transform: scale(0.95); } }
  @keyframes fill-7 { 0%, 66% { opacity: 0.15; transform: scale(0.95); } 77%, 95% { opacity: 0.85; transform: scale(1.15); } 100% { opacity: 0.15; transform: scale(0.95); } }
  @keyframes fill-4 { 0%, 77% { opacity: 0.15; transform: scale(0.95); } 88%, 95% { opacity: 0.85; transform: scale(1.15); } 100% { opacity: 0.15; transform: scale(0.95); } }
  @keyframes fill-5 { 0%, 88% { opacity: 0.15; transform: scale(0.95); } 95% { opacity: 0.85; transform: scale(1.15); } 100% { opacity: 0.15; transform: scale(0.95); } }
  @keyframes blink {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0;
    }
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  .message-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 10px;
    gap: 12px;
  }

  .turn-summary {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    margin-top: 10px;
    padding: 4px 8px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-bg-elevated, var(--color-bg)) 90%, transparent);
    font-size: 11px;
  }

  .turn-summary-label {
    color: var(--color-text-secondary);
  }

  .turn-summary-ledger {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: "JetBrains Mono", "Fira Code", monospace;
    font-weight: 600;
  }

  .turn-summary .added {
    color: #4ade80;
  }

  .turn-summary .removed {
    color: #f87171;
  }

  .turn-summary-action {
    height: 22px;
    padding: 0 8px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--color-accent) 40%, var(--color-border));
    background: transparent;
    color: var(--color-text);
    font-size: 11px;
    font-weight: 600;
    transition: all 0.15s ease;
  }

  .turn-summary-action:hover {
    background: color-mix(in srgb, var(--color-accent) 12%, transparent);
    border-color: var(--color-accent);
  }

  .turn-review {
    margin-top: 8px;
    border: 1px solid color-mix(in srgb, var(--color-border) 88%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--color-bg-elevated, var(--color-bg)) 92%, transparent);
    overflow: hidden;
  }

  .turn-review-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border-top: 1px solid color-mix(in srgb, var(--color-border) 82%, transparent);
  }

  .turn-review-row:first-child {
    border-top: none;
  }

  .turn-review-file {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .turn-review-name {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text);
  }

  .turn-review-path {
    font-size: 11px;
    color: var(--color-text-secondary);
    font-family: "JetBrains Mono", "Fira Code", monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .turn-review-meta {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }

  .turn-review-kind {
    font-size: 11px;
    color: var(--color-text-secondary);
    white-space: nowrap;
  }

  .turn-review-ledger {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 56px;
    justify-content: flex-end;
    font-family: "JetBrains Mono", "Fira Code", monospace;
    font-size: 11px;
    font-weight: 600;
  }

  .turn-review-diff {
    height: 26px;
    padding: 0 10px;
    border-radius: 6px;
    border: 1px solid var(--color-border);
    background: transparent;
    color: var(--color-text-secondary);
    font-size: 11px;
    font-weight: 600;
    transition: all 0.15s ease;
  }

  .turn-review-diff:hover {
    border-color: var(--color-accent);
    color: var(--color-text);
    background: color-mix(in srgb, var(--color-accent) 10%, transparent);
  }

  .meta-left {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    min-height: 22px;
  }

  .meta-time {
    font-size: 10px;
    color: var(--color-text-secondary);
    opacity: 0.7;
  }

  .meta-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    font-size: 11px;
    color: var(--color-text-secondary);
    opacity: 0.8;
    transition: all 0.2s ease;
    user-select: none;
  }

  .meta-pill:hover {
    opacity: 1;
    background: rgba(255, 255, 255, 0.06);
    border-color: var(--color-accent);
    color: var(--color-text);
  }

  .meta-pill.warning {
    border-color: color-mix(in srgb, #f59e0b 45%, var(--color-border));
    color: #fbbf24;
  }

  .meta-pill.error {
    border-color: color-mix(in srgb, #ef4444 45%, var(--color-border));
    color: #f87171;
  }

  .meta-actions {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  .message-row.assistant:hover .meta-actions {
    opacity: 1;
  }

  .copy-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--color-border);
    color: var(--color-text-secondary);
    padding: 3px 8px;
    border-radius: 6px;
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .copy-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    color: var(--color-text);
    border-color: var(--color-accent);
  }

  .copy-label {
    line-height: 1;
  }


  /* Inline thinking block (Cursor-style - transparent/minimal) */
  .inline-thinking {
    margin: 2px 0;
  }
  .thinking-header {
    padding: 4px 0;
    font-size: 13px;
    color: var(--color-text-secondary);
    cursor: pointer;
    user-select: none;
    list-style: none;
    transition: color 0.15s ease;
    outline: none;
  }
  .thinking-header::-webkit-details-marker {
    display: none;
  }
  .thinking-header-content {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .thinking-header-content.active .thinking-label {
    background: linear-gradient(
      90deg,
      rgba(255, 255, 255, 0.35) 0%,
      rgba(255, 255, 255, 0.9) 45%,
      rgba(255, 255, 255, 0.35) 100%
    );
    background-size: 200% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: thinking-shimmer 1.6s linear infinite;
  }
  .thinking-icon {
    display: flex;
    color: var(--color-text-secondary);
    opacity: 0.7;
    flex-shrink: 0;
  }
  .thinking-icon.active {
    animation: pulse 2s ease-in-out infinite;
    color: var(--color-accent);
    opacity: 1;
  }
  .inline-thinking[open] .thinking-icon {
    opacity: 1;
  }

  /* Smooth Dot Animation */
  .thinking-dots {
    display: inline-block;
    width: 16px;
    margin-right: 8px;
  }
  .thinking-dots::after {
    content: "";
    display: inline-block;
    animation: thinking-dots 2s steps(4, end) infinite;
    text-align: left;
  }

  @keyframes thinking-dots {
    0%,
    20% {
      content: "";
    }
    40% {
      content: ".";
    }
    60% {
      content: "..";
    }
    80%,
    100% {
      content: "...";
    }
  }
  @keyframes thinking-shimmer {
    0% {
      background-position: 200% 0;
    }
    100% {
      background-position: -200% 0;
    }
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }
  .thinking-label {
    font-weight: 400;
  }
  .thinking-duration {
    color: var(--color-text-secondary);
    font-size: 11px;
    opacity: 0.6;
    font-weight: 400;
  }

  @media (prefers-reduced-motion: reduce) {
    .thinking-header-content.active .thinking-label {
      animation: none;
      color: var(--color-text);
      background: none;
    }
  }
  .thinking-body {
    padding-left: 14px;
    margin-left: 4px;
    border-left: 1px solid var(--color-border);
    margin-top: 4px;
    padding-bottom: 8px;
  }
  .thinking-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-text);
    margin-bottom: 6px;
  }
  .thinking-content {
    font-size: 12px;
    line-height: 1.5;
    color: var(--color-text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow-y: auto;
  }
</style>
