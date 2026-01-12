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
          icon: "robot" as const,
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
          icon: "file" as const,
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
          icon: "sparkle" as const,
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
  <div class="empty-icon {currentMode}">
    <UIIcon name={content.icon} size={32} />
  </div>
  <h3 class="empty-title">{content.title}</h3>
  <p class="empty-hint">{content.hint}</p>
  <div class="quick-actions">
    {#each content.actions as action (action.label)}
      <button class="quick-action" type="button">
        <UIIcon name={action.icon} size={14} />
        <span>{action.label}</span>
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
    padding: 40px 20px;
    gap: 12px;
    flex: 1;
  }

  .empty-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 56px;
    border-radius: 16px;
    color: var(--color-bg);
    margin-bottom: 4px;
  }

  .empty-icon.ask {
    background: linear-gradient(135deg, var(--color-accent), var(--color-sapphire));
  }
  .empty-icon.agent {
    background: linear-gradient(135deg, var(--color-green), var(--color-teal));
  }
  .empty-icon.plan {
    background: linear-gradient(135deg, var(--color-mauve), var(--color-pink));
  }

  .empty-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--color-text);
    margin: 0;
  }

  .empty-hint {
    font-size: 12px;
    color: var(--color-text-secondary);
    max-width: 240px;
    margin: 0;
    line-height: 1.5;
  }

  .quick-actions {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 16px;
    width: 100%;
    max-width: 200px;
  }

  .quick-action {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    font-size: 12px;
    color: var(--color-text);
    transition: all 0.15s ease;
    text-align: left;
  }

  .quick-action:hover {
    background: var(--color-hover);
    border-color: var(--color-accent);
    transform: translateY(-1px);
  }
</style>
