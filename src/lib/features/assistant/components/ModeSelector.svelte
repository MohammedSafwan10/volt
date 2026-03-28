<script lang="ts">
  import type { AIMode } from '$features/assistant/stores/ai.svelte';

  interface Props {
    currentMode: AIMode;
    onModeChange: (mode: AIMode) => void;
  }

  let { currentMode, onModeChange }: Props = $props();

  const modes: { id: AIMode; label: string; description: string }[] = [
    { id: 'ask', label: 'Ask', description: 'Quick questions and explanations' },
    { id: 'plan', label: 'Plan', description: 'Design and plan features' },
    { id: 'spec', label: 'Spec', description: 'Create requirements, design, and tasks' },
    { id: 'agent', label: 'Agent', description: 'Execute tasks with tools' }
  ];

  function handleKeydown(e: KeyboardEvent, mode: AIMode): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onModeChange(mode);
    }
  }
</script>

<div class="mode-selector" role="tablist" aria-label="Assistant mode">
  {#each modes as mode (mode.id)}
    <button
      class="mode-btn"
      class:active={currentMode === mode.id}
      onclick={() => onModeChange(mode.id)}
      onkeydown={(e) => handleKeydown(e, mode.id)}
      role="tab"
      aria-selected={currentMode === mode.id}
      aria-controls="assistant-content"
      title="{mode.label}: {mode.description} (Ctrl+. to cycle)"
      type="button"
    >
      {mode.label}
    </button>
  {/each}
</div>

<style>
  .mode-selector {
    display: flex;
    gap: 4px;
    background: var(--color-bg-input);
    border-radius: 6px;
    padding: 2px;
  }

  .mode-btn {
    flex: 1;
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 500;
    color: var(--color-text-secondary);
    border-radius: 4px;
    transition: all 0.15s ease;
  }

  .mode-btn:hover {
    color: var(--color-text);
    background: var(--color-hover);
  }

  .mode-btn:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
  }

  .mode-btn.active {
    color: var(--color-text);
    background: var(--color-accent);
    color: var(--color-bg);
  }
</style>
