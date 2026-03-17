<script lang="ts">
  /**
   * MessageList - Main chat message container
   * Renders user/assistant messages with auto-scroll
   */
  import { UIIcon } from "$shared/components/ui";
  import type {
    AssistantMessage,
    ToolCall,
    ImageAttachment,
  } from "$features/assistant/stores/assistant.svelte";
  import type { AIMode } from "$features/assistant/stores/ai.svelte";
  import EmptyState from "./EmptyState.svelte";
  import UserMessage from "./UserMessage.svelte";
  import AssistantMessageRow from "./AssistantMessageRow.svelte";
  import SystemMessage from "./SystemMessage.svelte";
  import ImagePreviewModal from "./ImagePreviewModal.svelte";

  interface Props {
    messages: AssistantMessage[];
    currentMode?: AIMode;
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
    onRevert?: (messageId: string) => void;
  }

  let {
    messages,
    currentMode = "ask",
    isStreaming = false,
    scrollRevision = 0,
    onQuickPrompt,
    onToolApprove,
    onToolDeny,
    onStartImplementation,
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
  const historyMessages = $derived(
    messages.filter((m, index) => m.role !== "tool" && index !== activeAssistantIndex),
  );

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

  function getMessageElapsedTime(
    message: AssistantMessage,
    index: number,
  ): string | null {
    if (message.role !== "assistant" || message.isStreaming || !message.endTime)
      return null;
    for (let i = index - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        return formatElapsedTime(messages[i].timestamp, message.endTime);
      }
    }
    return formatElapsedTime(message.timestamp, message.endTime);
  }

  function isLatestAssistantMessage(index: number): boolean {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        return i === index;
      }
    }
    return false;
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
          const meta = (tc.meta ?? {}) as Record<string, any>;
          const planMeta = (meta.planFile ?? {}) as Record<string, any>;
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

  function handleStartImplementation(): void {
    const plan = findPlanFileCreated();
    if (plan && onStartImplementation) onStartImplementation(plan);
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
      {#each historyMessages as message (message.id)}
        {@const originalIdx = messages.findIndex((m) => m.id === message.id)}
        <div class="message-row">
          {#if message.role === "user"}
            <UserMessage
              {message}
              expanded={expandedMessages[message.id]}
              onToggleExpand={() => toggleMessage(message.id)}
              onImageClick={openImagePreview}
              {onRevert}
            />
          {:else if message.role === "assistant"}
            <AssistantMessageRow
              {message}
              msgIdx={originalIdx}
              showStreamingFallback={isStreaming &&
                isLatestAssistantMessage(originalIdx)}
              renderMode="history"
              elapsedTime={getMessageElapsedTime(message, originalIdx)}
            />
          {:else if message.role === "system"}
            <SystemMessage {message} />
          {/if}
        </div>
      {/each}

      {#if activeAssistantMessage}
        <div class="active-turn-shell">
          <AssistantMessageRow
            message={activeAssistantMessage}
            msgIdx={activeAssistantIndex}
            showStreamingFallback={true}
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
  }

  .active-turn-shell {
    margin-top: 8px;
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
