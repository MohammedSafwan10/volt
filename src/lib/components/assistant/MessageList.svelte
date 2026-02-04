<script lang="ts">
  /**
   * MessageList - Main chat message container
   * Renders user/assistant messages with auto-scroll
   */
  import { UIIcon } from "$lib/components/ui";
  import type {
    AssistantMessage,
    ToolCall,
    ImageAttachment,
  } from "$lib/stores/assistant.svelte";
  import type { AIMode } from "$lib/stores/ai.svelte";
  import EmptyState from "./EmptyState.svelte";
  import UserMessage from "./UserMessage.svelte";
  import AssistantMessageRow from "./AssistantMessageRow.svelte";
  import SystemMessage from "./SystemMessage.svelte";
  import ImagePreviewModal from "./ImagePreviewModal.svelte";

  interface Props {
    messages: AssistantMessage[];
    currentMode?: AIMode;
    isStreaming?: boolean;
    onToolApprove?: (messageId: string, toolCall: ToolCall) => void;
    onToolDeny?: (messageId: string, toolCall: ToolCall) => void;
    onStartImplementation?: (planContent: string) => void;
    onRevert?: (messageId: string) => void;
  }

  let {
    messages,
    currentMode = "ask",
    isStreaming = false,
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
    const { scrollTop, scrollHeight, clientHeight } = containerRef;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    const atBottom = distanceFromBottom < 40;
    userNearBottom = atBottom;
    showJumpButton = distanceFromBottom > 200;

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
    containerRef.scrollTo({
      top: containerRef.scrollHeight,
      behavior: "smooth",
    });
    isFollowing = true;
    userNearBottom = true;
    showJumpButton = false;
  }

  function scrollToBottom(behavior: ScrollBehavior = "auto"): void {
    if (!containerRef) return;
    containerRef.scrollTo({
      top: containerRef.scrollHeight,
      behavior,
    });
  }

  // Auto-scroll effect
  $effect(() => {
    // Track dependencies for streaming content
    messages.forEach((m) => {
      void m.content;
      void m.thinking;
      void m.isStreaming;
      if (m.contentParts) {
        m.contentParts.forEach((p) => {
          if (p.type === "text") void p.text;
          if (p.type === "thinking") void p.thinking;
          if (p.type === "tool") {
            void p.toolCall.status;
            void p.toolCall.output;
            void p.toolCall.streamingProgress;
          }
        });
      }
    });
    void messages.length;

    if (!containerRef) return;

    // Logic:
    // 1. If user just sent a message, always scroll to bottom
    // 2. If we are streaming and currently following, scroll to bottom
    // 3. If a new message arrived and we were at the bottom, follow it
    const lastMsgIsUser =
      messages.length > 0 && messages[messages.length - 1].role === "user";
    const shouldScroll =
      lastMsgIsUser || (isStreaming && isFollowing) || userNearBottom;

    if (shouldScroll) {
      // Use requestAnimationFrame to ensure DOM is updated
      requestAnimationFrame(() => {
        scrollToBottom(lastMsgIsUser ? "smooth" : "auto");

        // Secondary safety check for dynamic height elements (like images/code blocks)
        const timer = setTimeout(() => {
          if (isFollowing || userNearBottom) {
            scrollToBottom("auto");
          }
        }, 100);
        return () => clearTimeout(timer);
      });
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

  // Plan mode: check for plan file
  function findPlanFileCreated(): { filename: string; content: string } | null {
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      for (const part of msg.contentParts ?? []) {
        if (part.type !== "tool") continue;
        const tc = part.toolCall;
        if (tc.name === "write_plan_file" && tc.status === "completed") {
          const content = tc.arguments.content as string;
          const filename = tc.arguments.filename as string;
          if (content && filename) return { filename, content };
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
    if (plan && onStartImplementation) onStartImplementation(plan.content);
  }
</script>

<div class="message-list-wrapper">
  <div
    class="message-list"
    bind:this={containerRef}
    onscroll={handleScroll}
    role="log"
    aria-live="polite"
  >
    {#if messages.length === 0}
      <EmptyState {currentMode} />
    {:else}
      {#each messages as message, msgIdx (message.id)}
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
            {msgIdx}
            {onToolApprove}
            {onToolDeny}
            elapsedTime={getMessageElapsedTime(message, msgIdx)}
          />
        {:else if message.role === "system"}
          <SystemMessage {message} />
        {/if}
      {/each}
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
        <p class="implementation-hint">
          Switch to Agent mode and execute the plan
        </p>
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
    display: flex;
    flex-direction: column;
    padding: 12px;
    overflow-y: auto;
    height: 100%;
    gap: 8px;
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
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 20px;
    margin-top: 12px;
  }

  .start-implementation-btn {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 24px;
    background: linear-gradient(135deg, var(--color-green), var(--color-teal));
    color: var(--color-bg);
    border-radius: 12px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  }

  .start-implementation-btn:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  }

  .implementation-hint {
    font-size: 11px;
    color: var(--color-text-secondary);
    margin: 0;
  }
</style>
