<script lang="ts">
  import { outputStore, type OutputChannel } from '$features/terminal/stores/output.svelte';
  import { UIIcon } from '$shared/components/ui';

  let outputContainer: HTMLDivElement | undefined = $state();

  function formatTimestamp(date: Date): string {
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  function handleChannelChange(channel: OutputChannel): void {
    outputStore.setActiveChannel(channel);
  }

  function handleClear(): void {
    outputStore.clear(outputStore.activeChannel);
  }

  // Auto-scroll to bottom when new lines are added
  $effect(() => {
    const lines = outputStore.activeLines;
    if (lines.length > 0 && outputContainer) {
      // Use requestAnimationFrame to ensure DOM has updated
      requestAnimationFrame(() => {
        if (outputContainer) {
          outputContainer.scrollTop = outputContainer.scrollHeight;
        }
      });
    }
  });
</script>

<div class="output-view">
  <div class="output-toolbar">
    <select
      class="channel-select"
      value={outputStore.activeChannel}
      onchange={(e) => handleChannelChange(e.currentTarget.value as OutputChannel)}
    >
      {#each outputStore.channelNames as channel (channel)}
        <option value={channel}>{channel}</option>
      {/each}
    </select>

    <button
      class="toolbar-btn"
      onclick={handleClear}
      title="Clear Output"
      aria-label="Clear Output"
    >
      <UIIcon name="trash" size={16} />
    </button>
  </div>

  <div class="output-content" bind:this={outputContainer}>
    {#if outputStore.activeLines.length === 0}
      <div class="empty-state">
        <p>No output in {outputStore.activeChannel} channel</p>
      </div>
    {:else}
      {#each outputStore.activeLines as line, index (index)}
        <div class="output-line">
          <span class="timestamp">[{formatTimestamp(line.timestamp)}]</span>
          <span class="message">{line.message}</span>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .output-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-bg);
  }

  .output-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    background: var(--color-bg-header);
    border-bottom: 1px solid var(--color-border);
  }

  .channel-select {
    padding: 2px 8px;
    font-size: 12px;
    color: var(--color-text);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    cursor: pointer;
  }

  .channel-select:focus {
    outline: 1px solid var(--color-accent);
    outline-offset: -1px;
  }

  .toolbar-btn {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    color: var(--color-text-secondary);
    background: transparent;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.1s ease;
  }

  .toolbar-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .output-content {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
    font-size: 12px;
    line-height: 1.4;
  }

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--color-text-secondary);
  }

  .empty-state p {
    font-size: 13px;
    margin: 0;
    font-style: italic;
  }

  .output-line {
    display: flex;
    gap: 8px;
    padding: 1px 0;
  }

  .timestamp {
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  .message {
    color: var(--color-text);
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
