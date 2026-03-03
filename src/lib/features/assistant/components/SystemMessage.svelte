<script lang="ts">
  import { Markdown, UIIcon } from "$shared/components/ui";
  import type { AssistantMessage } from "$features/assistant/stores/assistant.svelte";

  interface Props {
    message: AssistantMessage;
  }

  let { message }: Props = $props();

  const isSummary = $derived(message.isSummary === true);
</script>

<div class="system-message" class:summary={isSummary}>
  <div class="system-header">
    <UIIcon name="sparkle" size={14} />
    <span>{isSummary ? "Conversation Summary" : "System"}</span>
  </div>
  <div class="system-body">
    <Markdown content={message.content} />
  </div>
</div>

<style>
  .system-message {
    border: 1px dashed var(--color-border);
    background: rgba(255, 255, 255, 0.03);
    border-radius: 10px;
    padding: 10px 12px;
    font-size: 12px;
    color: var(--color-text-secondary);
  }

  .system-message.summary {
    border-style: solid;
    background: rgba(255, 255, 255, 0.05);
  }

  .system-header {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 6px;
  }

  .system-body {
    font-size: 12px;
    line-height: 1.5;
    color: var(--color-text);
  }
</style>
