<script lang="ts">
  import { assistantStore } from "$lib/stores/assistant.svelte";
  import { aiSettingsStore, type AIMode } from "$lib/stores/ai.svelte";
  import { fade } from "svelte/transition";

  interface Props {
    currentMode: AIMode;
    isStreaming: boolean;
  }

  let { currentMode, isStreaming }: Props = $props();

  // Get current model from settings store
  const currentModel = $derived(aiSettingsStore.modelPerMode[currentMode as AIMode] || 'gemini-2.5-flash');
  
  // Context usage tracking (reactive)
  const usage = $derived(assistantStore.getContextUsage(currentModel));

  // SVG circle parameters for progress ring
  const RING_SIZE = 16;
  const RING_STROKE = 2;
  const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

  // Calculate stroke dash offset for progress
  const strokeDashoffset = $derived(
    RING_CIRCUMFERENCE - (usage.percentage / 100) * RING_CIRCUMFERENCE,
  );

  // Determine ring color based on usage
  const ringColor = $derived(
    usage.isOverLimit
      ? "#f14c4c" // Error red
      : usage.isNearLimit
        ? "#cca700" // Warning yellow
        : "#4ec9b0", // Success teal
  );

  let showTooltip = $state(false);
</script>

<div 
  class="context-usage-container"
  onmouseenter={() => showTooltip = true}
  onmouseleave={() => showTooltip = false}
  role="status"
  aria-label="Context usage"
>
  <div class="progress-ring-wrapper" class:streaming={isStreaming}>
    <svg width={RING_SIZE} height={RING_SIZE}>
      <circle
        class="ring-bg"
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        stroke-width={RING_STROKE}
      />
      <circle
        class="ring-fill"
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={RING_RADIUS}
        stroke-width={RING_STROKE}
        stroke={ringColor}
        stroke-dasharray={RING_CIRCUMFERENCE}
        style="stroke-dashoffset: {strokeDashoffset}"
      />
    </svg>
    
    {#if isStreaming}
      <div class="streaming-dot" style="background-color: {ringColor}"></div>
    {/if}
  </div>

  {#if showTooltip}
    <div class="usage-tooltip" transition:fade={{ duration: 100 }}>
      <div class="tooltip-header">
        <span class="percentage">{Math.round(usage.percentage)}%</span>
        <span class="label">context used</span>
      </div>
      <div class="tooltip-details">
        <span class="used">{assistantStore.formatTokenCount(usage.usedTokens)}</span>
        <span class="divider">/</span>
        <span class="total">{assistantStore.formatTokenCount(usage.maxTokens)}</span>
      </div>
      <div class="model-name">
        {currentModel.split('/').pop()}
      </div>
    </div>
  {/if}
</div>

<style>
  .context-usage-container {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: help;
    padding: 2px;
  }

  .progress-ring-wrapper {
    position: relative;
    width: 16px;
    height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  svg {
    transform: rotate(-90deg);
  }

  .ring-bg {
    fill: none;
    stroke: rgba(255, 255, 255, 0.1);
  }

  .ring-fill {
    fill: none;
    stroke-linecap: round;
    transition: stroke-dashoffset 0.3s ease, stroke 0.3s ease;
  }

  .streaming-dot {
    position: absolute;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    animation: pulse 1.5s infinite ease-in-out;
  }

  @keyframes pulse {
    0%, 100% { transform: scale(0.8); opacity: 0.5; }
    50% { transform: scale(1.2); opacity: 1; }
  }

  .progress-ring-wrapper.streaming {
    animation: rotate 2s linear infinite;
  }

  @keyframes rotate {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .usage-tooltip {
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: 8px;
    background: #252526;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 8px 12px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
    z-index: 1000;
    white-space: nowrap;
    display: flex;
    flex-direction: column;
    gap: 2px;
    pointer-events: none;
  }

  .tooltip-header {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    font-weight: 600;
    color: #cccccc;
  }

  .percentage {
    color: #ffffff;
  }

  .tooltip-details {
    display: flex;
    align-items: center;
    gap: 3px;
    font-size: 11px;
    color: var(--color-text-secondary);
    font-family: var(--font-mono, monospace);
  }

  .divider {
    opacity: 0.5;
  }

  .model-name {
    font-size: 10px;
    color: var(--color-text-disabled);
    margin-top: 2px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
</style>
