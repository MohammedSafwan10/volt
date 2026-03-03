<script lang="ts">
  import { UIIcon } from "$shared/components/ui";
  import type { AIMode } from "$features/assistant/stores/ai.svelte";

  interface Props {
    currentMode: AIMode;
    onQuickPrompt?: (prompt: string) => void;
  }

  let { currentMode, onQuickPrompt }: Props = $props();

  const content = $derived.by(() => {
    switch (currentMode) {
      case "agent":
        return {
          title: "Agent Mode",
          hint: "Run tasks across search, edits, and verification.",
          actions: [
            {
              icon: "file-plus" as const,
              label: "Create component",
              desc: "Scaffold and wire a new reusable component.",
              prompt:
                "Create a new reusable component in this project. Follow existing patterns and verify after edits.",
            },
            {
              icon: "pencil" as const,
              label: "Refactor current file",
              desc: "Improve structure without changing behavior.",
              prompt:
                "Refactor the currently active file for readability and maintainability without changing behavior.",
            },
            {
              icon: "terminal" as const,
              label: "Find and fix bugs",
              desc: "Prioritize high-impact issues and patch them.",
              prompt:
                "Find the most important bugs in this workspace, fix them safely, and run verification after edits.",
            },
          ],
        };
      case "plan":
        return {
          title: "Plan Mode",
          hint: "Create implementation-ready plans with clear milestones.",
          actions: [
            {
              icon: "file" as const,
              label: "Design feature plan",
              desc: "Scope, files, risks, and acceptance criteria.",
              prompt:
                "Design a full implementation plan for this feature request with scope, files to change, test plan, and rollout notes.",
            },
            {
              icon: "code" as const,
              label: "Architecture review",
              desc: "Propose cleaner structure with tradeoffs.",
              prompt:
                "Review the current architecture and propose a better structure with tradeoffs and migration steps.",
            },
            {
              icon: "search" as const,
              label: "Requirement breakdown",
              desc: "Convert goals into phased execution steps.",
              prompt:
                "Break down this requirement into clear phases, acceptance criteria, risks, and validation steps.",
            },
          ],
        };
      default:
        return {
          title: "Ask Mode",
          hint: "Quick explanations, debugging, and code understanding.",
          actions: [
            {
              icon: "code" as const,
              label: "Explain code",
              desc: "Understand structure and logic fast.",
              prompt:
                "Explain the active file in simple terms: purpose, key functions, data flow, and possible issues.",
            },
            {
              icon: "warning" as const,
              label: "Debug issue",
              desc: "Narrow root causes step by step.",
              prompt:
                "Help me debug this issue step by step. Start with likely root causes and how to confirm each one.",
            },
            {
              icon: "info" as const,
              label: "How it works",
              desc: "Summarize architecture and runtime flow.",
              prompt:
                "How does this project work end-to-end? Summarize architecture, runtime flow, and key modules.",
            },
          ],
        };
    }
  });
</script>

<div class="empty-state">
  <header class="empty-header">
    <h3 class="empty-title">{content.title}</h3>
    <p class="empty-hint">{content.hint}</p>
  </header>

  <section class="quick-actions" aria-label="Starter prompts">
    {#each content.actions as action (action.label)}
      <button
        class="quick-action"
        type="button"
        onclick={() => onQuickPrompt?.(action.prompt)}
        title={action.prompt}
      >
        <div class="action-leading">
          <UIIcon name={action.icon} size={16} />
        </div>
        <div class="action-content">
          <span class="action-label">{action.label}</span>
          <span class="action-desc">{action.desc}</span>
        </div>
        <UIIcon name="arrow-right" size={14} />
      </button>
    {/each}
  </section>
</div>

<style>
  .empty-state {
    display: flex;
    flex-direction: column;
    gap: 12px;
    flex: 1;
    padding: 14px 12px 10px;
    max-width: 620px;
    margin: 0 auto;
    width: 100%;
  }

  .empty-header {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 2px 2px 6px;
  }

  .empty-title {
    margin: 0;
    font-size: 18px;
    line-height: 1.2;
    letter-spacing: -0.01em;
    font-weight: 600;
    color: var(--color-text);
  }

  .empty-hint {
    margin: 0;
    font-size: 13px;
    color: var(--color-text-secondary);
    line-height: 1.35;
  }

  .quick-actions {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .quick-action {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 54px;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid color-mix(in srgb, var(--color-border) 85%, transparent);
    background: color-mix(in srgb, var(--color-surface0) 82%, transparent);
    color: var(--color-text);
    text-align: left;
    transition: background 0.12s ease, border-color 0.12s ease, transform 0.12s ease;
  }

  .quick-action:hover {
    background: color-mix(in srgb, var(--color-surface1, var(--color-surface0)) 88%, transparent);
    border-color: color-mix(in srgb, var(--color-accent) 40%, var(--color-border));
    transform: translateY(-1px);
  }

  .action-leading {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-secondary);
    flex: 0 0 auto;
  }

  .action-content {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }

  .action-label {
    font-size: 13.5px;
    font-weight: 600;
    line-height: 1.2;
    color: var(--color-text);
  }

  .action-desc {
    font-size: 12px;
    color: var(--color-text-secondary);
    line-height: 1.2;
  }
</style>
