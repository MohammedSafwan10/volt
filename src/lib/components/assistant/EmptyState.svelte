<script lang="ts">
  import { UIIcon } from "$lib/components/ui";
  import type { AIMode } from "$lib/stores/ai.svelte";

  interface Props {
    currentMode: AIMode;
  }

  let { currentMode }: Props = $props();

  const content = $derived.by(() => {
    switch (currentMode) {
      case "agent":
        return {
          title: "Agent Mode",
          hint: "I can execute tasks, run commands, edit files, and help you build features.",
          actions: [
            { icon: "file-plus" as const, label: "Create a component" },
            { icon: "pencil" as const, label: "Refactor this file" },
            { icon: "terminal" as const, label: "Run tests" },
          ],
        };
      case "plan":
        return {
          title: "Plan Mode",
          hint: "Let me help you design and plan features with detailed specs.",
          actions: [
            { icon: "file" as const, label: "Design a feature" },
            { icon: "code" as const, label: "Plan architecture" },
            { icon: "search" as const, label: "Review requirements" },
          ],
        };
      default:
        return {
          title: "How can I help?",
          hint: "Ask me anything about your code. I can explain or help debug.",
          actions: [
            { icon: "code" as const, label: "Explain this code" },
            { icon: "warning" as const, label: "Fix a bug" },
            { icon: "info" as const, label: "How does this work?" },
          ],
        };
    }
  });
</script>

<div class="empty-state">
  <div class="welcome-container">
    <div class="empty-icon {currentMode}">
      {#if currentMode === 'agent'}
        <!-- Custom Agent Icon: Technical Robot Head -->
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 8V4H8" />
          <rect x="5" y="8" width="14" height="12" rx="2" />
          <path d="M9 12h.01" />
          <path d="M15 12h.01" />
          <path d="M9 16h6" />
        </svg>
      {:else if currentMode === 'plan'}
        <!-- Custom Plan Icon: Strategic Roadmap -->
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 3v18h18" />
          <path d="M18 9l-5 5-2-2-4 4" />
          <circle cx="18" cy="9" r="2" />
        </svg>
      {:else}
        <!-- Custom Ask Icon: Clean Message Bubble -->
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          <path d="M12 10h.01" />
        </svg>
      {/if}
    </div>
    <h3 class="empty-title">{content.title}</h3>
    <p class="empty-hint">{content.hint}</p>
  </div>

  <div class="quick-actions">
    {#each content.actions as action (action.label)}
      <button class="quick-action" type="button">
        <div class="action-icon">
          <UIIcon name={action.icon} size={16} />
        </div>
        <span class="action-label">{action.label}</span>
      </button>
    {/each}
  </div>
</div>

<style>
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 60px 24px;
    gap: 32px;
    flex: 1;
    height: 100%;
  }

  .welcome-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
  }

  .empty-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 64px;
    height: 64px;
    border-radius: 16px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: var(--color-text-secondary);
    margin-bottom: 8px;
    transition: all 0.3s ease;
  }

  .empty-icon.agent {
    background: rgba(var(--color-accent-rgb), 0.05);
    border-color: rgba(var(--color-accent-rgb), 0.15);
    color: var(--color-accent);
  }

  .empty-title {
    font-size: 20px;
    font-weight: 600;
    color: #ffffff;
    margin: 0;
    letter-spacing: -0.01em;
  }

  .empty-hint {
    font-size: 14px;
    color: var(--color-text-secondary);
    max-width: 320px;
    margin: 0;
    line-height: 1.6;
    opacity: 0.8;
  }

  .quick-actions {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
    max-width: 280px;
  }

  .quick-action {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 10px;
    font-size: 13.5px;
    color: var(--color-text);
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    text-align: left;
    width: 100%;
  }

  .quick-action:hover {
    background: rgba(255, 255, 255, 0.05);
    border-color: rgba(255, 255, 255, 0.1);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  }

  .action-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    color: var(--color-text-secondary);
    opacity: 0.7;
  }

  .quick-action:hover .action-icon {
    color: var(--color-accent);
    opacity: 1;
  }

  .action-label {
    flex: 1;
    font-weight: 500;
  }
</style>
