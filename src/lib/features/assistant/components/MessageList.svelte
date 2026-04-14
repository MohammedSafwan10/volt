<script lang="ts">
  /**
   * MessageList - Main chat message container
   * Renders user/assistant messages with auto-scroll
   */
  import { tick } from "svelte";
  import { UIIcon } from "$shared/components/ui";
  import type {
    AssistantMessage,
    ToolCall,
    ImageAttachment,
  } from "$features/assistant/stores/assistant.svelte";
  import type { AIMode } from "$features/assistant/stores/ai.svelte";
  import { specStore } from "$features/specs/stores/specs.svelte";
  import EmptyState from "./EmptyState.svelte";
  import UserMessage from "./UserMessage.svelte";
  import AssistantMessageRow from "./AssistantMessageRow.svelte";
  import SystemMessage from "./SystemMessage.svelte";
  import ImagePreviewModal from "./ImagePreviewModal.svelte";

  interface Props {
    messages: AssistantMessage[];
    currentMode?: AIMode;
    currentConversationId?: string | null;
    isStreaming?: boolean;
    scrollRevision?: number;
    onQuickPrompt?: (prompt: string) => void;
    onToolApprove?: (messageId: string, toolCall: ToolCall) => void;
    onToolDeny?: (messageId: string, toolCall: ToolCall) => void;
    onStartImplementation?: (plan: {
      filename: string;
      content: string;
      relativePath?: string;
      absolutePath?: string;
    }) => void;
    onConfirmSpecDraft?: () => void;
    onDiscardSpecDraft?: () => void;
    onRevert?: (messageId: string) => void;
  }

  let {
    messages,
    currentMode = "ask",
    currentConversationId = null,
    isStreaming = false,
    scrollRevision = 0,
    onQuickPrompt,
    onToolApprove,
    onToolDeny,
    onStartImplementation,
    onConfirmSpecDraft,
    onDiscardSpecDraft,
    onRevert,
  }: Props = $props();

  // Image preview state
  let previewImage = $state<{ src: string; alt: string } | null>(null);

  // Expanded messages state
  let expandedMessages = $state<Record<string, boolean>>({});

  // Scroll state
  let containerRef: HTMLDivElement | undefined = $state();
  let userNearBottom = $state(true);
  let isFollowing = $state(true);
  let showJumpButton = $state(false);
  let visibleHistoryCount = $state(60);
  let lastVisibleConversationId = $state<string | null>(null);

  const HISTORY_PAGE_SIZE = 40;
  const INITIAL_VISIBLE_HISTORY_COUNT = 60;

  function getActiveAssistantIndex(): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (
        message.role === "assistant" &&
        (message.isStreaming || message.streamState === "active")
      ) {
        return i;
      }
    }
    return -1;
  }

  const activeAssistantIndex = $derived(getActiveAssistantIndex());
  const activeAssistantMessage = $derived(
    activeAssistantIndex >= 0 ? messages[activeAssistantIndex] : null,
  );
  const latestAssistantIndex = $derived.by(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant") return i;
    }
    return -1;
  });
  const historyRows = $derived.by(() => {
    const rows: Array<{
      message: AssistantMessage;
      originalIdx: number;
      elapsedTime: string | null;
      showStreamingFallback: boolean;
      assistantDistanceFromEnd: number | null;
    }> = [];

    let lastUserTimestamp: number | null = null;
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      if (message.role === "user") {
        lastUserTimestamp = message.timestamp;
      }
      if (message.role === "tool" || index === activeAssistantIndex) {
        continue;
      }

      const elapsedTime =
        message.role === "assistant" && !message.isStreaming && message.endTime
          ? formatElapsedTime(
              lastUserTimestamp ?? message.timestamp,
              message.endTime,
            )
          : null;

      rows.push({
        message,
        originalIdx: index,
        elapsedTime,
        showStreamingFallback: isStreaming && latestAssistantIndex === index,
        assistantDistanceFromEnd: null,
      });
    }

    let assistantDistance = 0;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (rows[index].message.role !== "assistant") continue;
      rows[index].assistantDistanceFromEnd = assistantDistance;
      assistantDistance += 1;
    }

    return rows;
  });
  const hiddenHistoryCount = $derived(
    Math.max(0, historyRows.length - visibleHistoryCount),
  );
  const visibleHistoryRows = $derived(
    hiddenHistoryCount > 0
      ? historyRows.slice(historyRows.length - visibleHistoryCount)
      : historyRows,
  );

  $effect(() => {
    const conversationKey = currentConversationId ?? "__no_conversation__";
    const totalRows = historyRows.length;

    if (lastVisibleConversationId !== conversationKey) {
      lastVisibleConversationId = conversationKey;
      visibleHistoryCount = Math.min(
        Math.max(totalRows, 1),
        INITIAL_VISIBLE_HISTORY_COUNT,
      );
      return;
    }

    if (totalRows <= visibleHistoryCount) {
      visibleHistoryCount = Math.max(totalRows, INITIAL_VISIBLE_HISTORY_COUNT);
    }
  });

  function syncScrollStateFromContainer(): void {
    if (!containerRef) return;
    const scrollTop = containerRef.scrollTop;
    const { scrollHeight, clientHeight } = containerRef;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const atBottom = distanceFromBottom < 40;
    userNearBottom = atBottom;
    showJumpButton = distanceFromBottom > 200;
  }

  function openImagePreview(img: ImageAttachment): void {
    previewImage = {
      src: `data:${img.mimeType};base64,${img.data}`,
      alt: img.filename,
    };
  }

  function closeImagePreview(): void {
    previewImage = null;
  }

  function toggleMessage(id: string): void {
    expandedMessages[id] = !expandedMessages[id];
  }

  function handleScroll(): void {
    if (!containerRef) return;
    syncScrollStateFromContainer();
    const { scrollHeight, clientHeight, scrollTop } = containerRef;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const atBottom = distanceFromBottom < 40;

    // If we're streaming and user manually scrolls up, stop following
    if (!atBottom && isFollowing && (isStreaming || messages.length > 0)) {
      // Small buffer to allow minor layout shifts
      if (distanceFromBottom > 80) {
        isFollowing = false;
      }
    }

    // If user scrolls back to bottom, resume following
    if (atBottom) {
      isFollowing = true;
    }
  }

  function jumpToBottom(): void {
    if (!containerRef) return;
    const targetTop = Math.max(0, containerRef.scrollHeight - containerRef.clientHeight);
    containerRef.scrollTo({
      top: targetTop,
      behavior: "smooth",
    });
    syncScrollStateFromContainer();
    isFollowing = true;
  }

  function scrollToBottom(behavior: ScrollBehavior = "auto"): void {
    if (!containerRef) return;
    const targetTop = Math.max(0, containerRef.scrollHeight - containerRef.clientHeight);
    containerRef.scrollTo({
      top: targetTop,
      behavior,
    });
    syncScrollStateFromContainer();
  }

  // Auto-scroll effect
  $effect(() => {
    void messages.length;
    void scrollRevision;
    const lastMessage = messages[messages.length - 1];
    const lastMessageId = lastMessage?.id;
    const lastMessageRole = lastMessage?.role;
    const lastMessageStreaming = lastMessage?.isStreaming;
    const lastMessageState = lastMessage?.streamState;

    if (!containerRef) return;

    // Logic:
    // 1. If user just sent a message, always scroll to bottom
    // 2. If we are streaming and currently following, scroll to bottom
    // 3. If a new message arrived and we were at the bottom, follow it
    const lastMsgIsUser = lastMessageRole === "user";
    const shouldScroll = lastMsgIsUser || isFollowing;
    void lastMessageId;
    void lastMessageStreaming;
    void lastMessageState;

    if (shouldScroll) {
      // Use requestAnimationFrame to ensure DOM is updated
      let timer: number | undefined;
      const rafId = requestAnimationFrame(() => {
        scrollToBottom("auto");

        // Secondary safety check for dynamic height elements (like images/code blocks)
        timer = window.setTimeout(() => {
          if (isFollowing || userNearBottom) {
            scrollToBottom("auto");
          }
        }, 100);
      });

      return () => {
        cancelAnimationFrame(rafId);
        if (timer !== undefined) {
          window.clearTimeout(timer);
        }
      };
    }
  });

  // Elapsed time helper
  function formatElapsedTime(startTs: number, endTs: number): string {
    const elapsed = Math.max(0, endTs - startTs);
    const seconds = Math.floor(elapsed / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${seconds}s`;
  }

  // Plan mode: check for plan file
  function findPlanFileCreated(): {
    filename: string;
    content: string;
    relativePath?: string;
    absolutePath?: string;
  } | null {
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      for (const part of msg.contentParts ?? []) {
        if (part.type !== "tool") continue;
        const tc = part.toolCall;
        if (tc.name === "write_plan_file" && tc.status === "completed") {
          const content = tc.arguments.content as string;
          const filename = tc.arguments.filename as string;
          const meta = (tc.meta ?? {}) as Record<string, unknown>;
          const planMeta = (meta.planFile ?? {}) as Record<string, unknown>;
          if (content && filename) {
            return {
              filename: String(planMeta.filename || filename),
              content,
              relativePath: planMeta.relativePath
                ? String(planMeta.relativePath)
                : undefined,
              absolutePath: planMeta.absolutePath
                ? String(planMeta.absolutePath)
                : undefined,
            };
          }
        }
      }
    }
    return null;
  }

  const showStartImplementation = $derived.by(() => {
    if (currentMode !== "plan") return false;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.isStreaming) return false;
    return findPlanFileCreated() !== null;
  });

  const showSpecDraftActions = $derived.by(() => {
    if (currentMode !== "spec" || isStreaming) return false;
    return specStore.hasPendingDraftForConversation(currentConversationId);
  });

  const verificationConversationActions = $derived.by(() =>
    specStore.getVerificationConversationActionState(currentConversationId),
  );

  function handleStartImplementation(): void {
    const plan = findPlanFileCreated();
    if (plan && onStartImplementation) onStartImplementation(plan);
  }

  async function showOlderMessages(): Promise<void> {
    if (!containerRef || hiddenHistoryCount <= 0) return;
    const previousScrollHeight = containerRef.scrollHeight;
    const previousScrollTop = containerRef.scrollTop;
    visibleHistoryCount = Math.min(
      historyRows.length,
      visibleHistoryCount + HISTORY_PAGE_SIZE,
    );
    await tick();
    const nextScrollHeight = containerRef.scrollHeight;
    containerRef.scrollTop =
      previousScrollTop + (nextScrollHeight - previousScrollHeight);
    syncScrollStateFromContainer();
  }

  function showAllMessages(): void {
    visibleHistoryCount = historyRows.length;
  }

</script>

<div class="message-list-wrapper">
  <div
    class="message-list"
    bind:this={containerRef}
    onscroll={handleScroll}
    role="log"
    aria-live={isStreaming ? "off" : "polite"}
    aria-relevant="additions"
  >
    {#if messages.length === 0}
      <EmptyState {currentMode} {onQuickPrompt} />
    {:else}
      {#if hiddenHistoryCount > 0}
        <div class="history-window-banner">
          <button
            class="history-window-btn"
            onclick={showOlderMessages}
            type="button"
          >
            <UIIcon name="chevron-up" size={14} />
            <span>Show {Math.min(HISTORY_PAGE_SIZE, hiddenHistoryCount)} older message{Math.min(HISTORY_PAGE_SIZE, hiddenHistoryCount) === 1 ? "" : "s"}</span>
          </button>
          {#if hiddenHistoryCount > HISTORY_PAGE_SIZE}
            <button
              class="history-window-btn ghost"
              onclick={showAllMessages}
              type="button"
            >
              <span>Show all {hiddenHistoryCount} older</span>
            </button>
          {/if}
        </div>
      {/if}

      {#each visibleHistoryRows as row (row.message.id)}
        <div class="message-row">
          {#if row.message.role === "user"}
            <UserMessage
              message={row.message}
              expanded={expandedMessages[row.message.id]}
              onToggleExpand={() => toggleMessage(row.message.id)}
              onImageClick={openImagePreview}
              {onRevert}
            />
          {:else if row.message.role === "assistant"}
            <AssistantMessageRow
              message={row.message}
              msgIdx={row.originalIdx}
              showStreamingFallback={row.showStreamingFallback}
              renderMode="history"
              elapsedTime={row.elapsedTime}
              expanded={Boolean(expandedMessages[row.message.id])}
              compactHistory={
                (row.assistantDistanceFromEnd ?? 0) >= 12 &&
                !expandedMessages[row.message.id]
              }
              onToggleExpand={() => toggleMessage(row.message.id)}
            />
          {:else if row.message.role === "system"}
            <SystemMessage message={row.message} />
          {/if}
        </div>
      {/each}

      {#if activeAssistantMessage}
        <div class="active-turn-shell">
          <AssistantMessageRow
            message={activeAssistantMessage}
            msgIdx={activeAssistantIndex}
              showStreamingFallback={Boolean(
                isStreaming &&
                  (activeAssistantMessage.isStreaming ||
                    activeAssistantMessage.streamState === "active"),
              )}
            renderMode="active"
            {onToolApprove}
            {onToolDeny}
            elapsedTime={null}
          />
        </div>
      {/if}
    {/if}

    {#if showStartImplementation}
      <div class="start-implementation-wrapper">
        <button
          class="start-implementation-btn"
          onclick={handleStartImplementation}
          type="button"
        >
          <UIIcon name="robot" size={16} />
          <span>Start Implementation</span>
          <UIIcon name="arrow-right" size={14} />
        </button>
      </div>
    {/if}

    {#if showSpecDraftActions}
      <div class="spec-draft-wrapper">
        <div class="spec-draft-copy">
          <div class="spec-draft-title">Requirements draft ready</div>
          <div class="spec-draft-subtitle">
            Write <code>.volt/specs/{specStore.pendingDraft?.slug}/requirements.md</code> into this workspace?
          </div>
        </div>
        <div class="spec-draft-actions">
          <button
            class="spec-draft-btn ghost"
            onclick={() => onDiscardSpecDraft?.()}
            type="button"
          >
            <UIIcon name="close" size={14} />
            <span>Discard</span>
          </button>
          <button
            class="spec-draft-btn primary"
            onclick={() => onConfirmSpecDraft?.()}
            type="button"
          >
            <UIIcon name="file" size={14} />
            <span>Create Requirements</span>
          </button>
        </div>
      </div>
    {/if}

    {#if verificationConversationActions && !isStreaming}
      <div class="spec-draft-wrapper verify-followup">
        <div class="spec-draft-copy">
          <div class="spec-draft-title">
            {#if verificationConversationActions.isStale}
              Review Stale
            {:else if verificationConversationActions.verdict === "needs-fix" || verificationConversationActions.status === "needs-fix"}
              Review Found Fixes
            {:else if verificationConversationActions.verdict === "incomplete" || verificationConversationActions.status === "incomplete"}
              Review Marked Task Incomplete
            {:else if verificationConversationActions.hasReviewPayload}
              Review Ready
            {:else}
              Verification Follow-up
            {/if} · {verificationConversationActions.taskId}
          </div>
          <div class="spec-draft-subtitle">
            {verificationConversationActions.taskTitle}
            {#if verificationConversationActions.isStale}
              · run a fresh pass when the fixes settle.
            {:else}
              · continue in this chat with the verifier's punch list.
            {/if}
          </div>
        </div>
        <div class="spec-draft-actions">
          {#if verificationConversationActions.canApplyFixes}
            <button
              class="spec-draft-btn primary"
              onclick={() => specStore.applyReviewFixesForConversation(currentConversationId)}
              type="button"
            >
              <UIIcon name="robot" size={14} />
              <span>Apply Review Fixes</span>
            </button>
          {/if}
          {#if verificationConversationActions.canReverify}
            <button
              class="spec-draft-btn ghost"
              onclick={() => specStore.reverifyConversationTask(currentConversationId)}
              type="button"
            >
              <UIIcon name="refresh" size={14} />
              <span>Re-Verify</span>
            </button>
          {/if}
        </div>
      </div>
    {/if}
  </div>

  {#if showJumpButton && messages.length > 0}
    <button
      class="jump-to-bottom"
      onclick={jumpToBottom}
      title="Jump to bottom"
      aria-label="Jump to latest message"
      type="button"
    >
      <UIIcon name="chevron-down" size={14} />
    </button>
  {/if}

  {#if previewImage}
    <ImagePreviewModal
      src={previewImage.src}
      alt={previewImage.alt}
      onClose={closeImagePreview}
    />
  {/if}
</div>

<style>
  .message-list-wrapper {
    position: relative;
    height: 100%;
    overflow: hidden;
  }

  .message-list {
    padding: 12px;
    overflow-y: auto;
    height: 100%;
    overflow-anchor: none;
  }

  .message-row {
    padding-bottom: 8px;
    content-visibility: auto;
    contain-intrinsic-size: 220px;
  }

  .active-turn-shell {
    margin-top: 8px;
  }

  .history-window-banner {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin: 0 0 12px;
    padding: 8px 10px;
    border: 1px solid var(--color-border);
    border-radius: 10px;
    background: color-mix(in srgb, var(--color-bg-secondary) 82%, transparent);
    content-visibility: auto;
    contain-intrinsic-size: 48px;
  }

  .history-window-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: var(--color-bg-elevated, var(--color-bg-secondary));
    color: var(--color-text);
    font-size: 12px;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
  }

  .history-window-btn:hover {
    background: color-mix(in srgb, var(--color-bg-hover) 85%, transparent);
    border-color: color-mix(in srgb, var(--color-accent) 30%, var(--color-border));
  }

  .history-window-btn.ghost {
    background: transparent;
    color: var(--color-text-secondary);
  }

  .jump-to-bottom {
    position: absolute;
    bottom: 12px;
    left: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: transparent;
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: all 0.15s ease;
    animation: fadeIn 0.15s ease;
    z-index: 10;
  }

  .jump-to-bottom:hover {
    color: var(--color-accent);
    transform: scale(1.15);
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .start-implementation-wrapper {
    display: flex;
    justify-content: center;
    padding: 10px 0;
    margin-top: 4px;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
    animation: slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .spec-draft-wrapper {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding: 10px 0;
    margin-top: 4px;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
    animation: slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .spec-draft-wrapper.verify-followup {
    align-items: flex-start;
    padding: 10px 12px;
    margin-top: 8px;
    border: 1px solid color-mix(in srgb, var(--color-warning, #cca700) 28%, var(--color-border));
    border-radius: 10px;
    background: color-mix(in srgb, var(--color-surface0) 94%, var(--color-warning, #cca700) 6%);
  }

  .spec-draft-copy {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .spec-draft-title {
    font-size: 12.5px;
    font-weight: 700;
    color: var(--color-text);
  }

  .spec-draft-subtitle {
    font-size: 12px;
    color: var(--color-text-secondary);
  }

  .spec-draft-subtitle code {
    font-family: var(--font-family-mono, monospace);
    color: var(--color-text);
  }

  .spec-draft-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .spec-draft-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 8px;
    border: 1px solid var(--color-border);
    background: var(--color-surface0);
    color: var(--color-text);
    font-size: 11.5px;
    font-weight: 600;
    cursor: pointer;
    transition: transform 0.16s ease, border-color 0.16s ease, background 0.16s ease;
  }

  .spec-draft-btn:hover {
    transform: translateY(-1px);
    border-color: color-mix(in srgb, var(--color-accent) 35%, var(--color-border));
  }

  .spec-draft-btn.primary {
    background: color-mix(in srgb, var(--color-accent) 18%, var(--color-surface0));
    border-color: color-mix(in srgb, var(--color-accent) 52%, var(--color-border));
    color: var(--color-text);
  }

  .spec-draft-btn.ghost {
    background: transparent;
  }

  .verify-followup .spec-draft-title {
    font-size: 12px;
    letter-spacing: 0.01em;
  }

  .verify-followup .spec-draft-subtitle {
    font-size: 11.5px;
    line-height: 1.35;
  }

  .start-implementation-btn {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 18px;
    background: linear-gradient(135deg, hsl(165, 75%, 42%), hsl(180, 80%, 35%));
    color: white;
    border-radius: 8px;
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    box-shadow:
      0 4px 12px rgba(0, 0, 0, 0.4),
      0 0 0 1px rgba(255, 255, 255, 0.1),
      inset 0 1px 0 rgba(255, 255, 255, 0.2);
    overflow: hidden;
  }

  .start-implementation-btn::before {
    content: "";
    position: absolute;
    top: 0;
    left: -100%;
    width: 100%;
    height: 100%;
    background: linear-gradient(
      90deg,
      transparent,
      rgba(255, 255, 255, 0.15),
      transparent
    );
    transition: 0.5s;
  }

  .start-implementation-btn:hover {
    transform: translateY(-2px);
    box-shadow:
      0 8px 20px rgba(0, 0, 0, 0.5),
      0 0 15px rgba(78, 201, 176, 0.3);
    filter: brightness(1.05);
  }

  .start-implementation-btn:hover::before {
    left: 100%;
  }

  .start-implementation-btn:active {
    transform: translateY(0) scale(0.96);
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  }

  @keyframes slideUp {
    from {
      opacity: 0;
      transform: translateY(12px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
