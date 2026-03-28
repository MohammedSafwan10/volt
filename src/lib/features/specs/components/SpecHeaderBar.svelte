<script lang="ts">
  import UIIcon from '$shared/components/ui/UIIcon.svelte';
  import { specStore } from '$features/specs/stores/specs.svelte';
  import { assistantStore } from '$features/assistant/stores/assistant.svelte';

  interface Props {
    filepath: string;
  }

  let { filepath }: Props = $props();
  let expandedTaskIds = $state<Record<string, boolean>>({});

  const phase = $derived(specStore.activeFilePath ? (filepath.endsWith('requirements.md')
    ? 'requirements'
    : filepath.endsWith('design.md')
      ? 'design'
      : filepath.endsWith('tasks.md')
        ? 'tasks'
        : null) : null);

  function phaseLabel(id: 'requirements' | 'design' | 'tasks'): string {
    if (id === 'requirements') return 'Requirements';
    if (id === 'design') return 'Design';
    return 'Task List';
  }

  function statusClass(status: string): string {
    if (status === 'done') return 'done';
    if (status === 'running') return 'running';
    if (status === 'failed') return 'failed';
    if (status === 'blocked') return 'blocked';
    return 'todo';
  }

  function verificationClass(status: string, isStale = false): string {
    if (isStale) return 'blocked';
    if (status === 'passed') return 'done';
    if (status === 'running') return 'running';
    if (status === 'needs-fix' || status === 'incomplete') return 'failed';
    return 'failed';
  }

  function verificationLabel(status: string, isStale = false): string {
    if (isStale) return 'Review Stale';
    if (status === 'passed') return 'Verified';
    if (status === 'running') return 'Verifying';
    if (status === 'needs-fix') return 'Needs Fix';
    if (status === 'incomplete') return 'Incomplete';
    if (status === 'cancelled') return 'Review Cancelled';
    return 'Review Failed';
  }

  function isTaskExpanded(taskId: string): boolean {
    return Boolean(expandedTaskIds[taskId]);
  }

  function toggleTask(taskId: string): void {
    expandedTaskIds[taskId] = !expandedTaskIds[taskId];
  }

  const continueLabel = $derived.by(() => {
    const spec = specStore.activeSpec;
    if (!spec) return 'Continue';

    if (phase === 'requirements') {
      return !spec.designMarkdown || spec.staleFlags.design || spec.phaseStates.design !== 'ready'
        ? 'Continue to Design'
        : 'Open Design';
    }

    if (phase === 'design') {
      return spec.tasks.length === 0 || spec.staleFlags.tasks || spec.phaseStates.tasks !== 'ready'
        ? 'Continue to Tasks'
        : 'Open Task List';
    }

    return 'Open Task List';
  });

  const syncLabel = $derived.by(() => {
    if (phase === 'requirements') return 'Sync Downstream';
    if (phase === 'design') return 'Sync Tasks';
    return 'Sync Files';
  });
</script>

{#if specStore.activeSpec}
  <div class="spec-shell">
    <div class="spec-header">
      <div class="spec-title-group">
        <div class="spec-title">{specStore.activeSpec.title}</div>
        <div class="spec-subtitle">.volt/specs/{specStore.activeSpec.slug}</div>
      </div>

      <div class="spec-actions">
        <button class="action-btn" type="button" onclick={() => specStore.syncActiveSpec()} disabled={specStore.isBusy}>
          <UIIcon name="refresh" size={14} />
          <span>{syncLabel}</span>
        </button>
        <button class="action-btn primary" type="button" onclick={() => specStore.continueActiveSpec()} disabled={specStore.isBusy}>
          <UIIcon name="arrow-right" size={14} />
          <span>{continueLabel}</span>
        </button>
        {#if phase === 'tasks'}
          <button class="action-btn primary" type="button" onclick={() => specStore.runAllReadyTasks()} disabled={specStore.isBusy}>
            <UIIcon name="play" size={14} />
            <span>Run All Tasks</span>
          </button>
        {/if}
      </div>
    </div>

    <div class="spec-stepper">
      {#each ['requirements', 'design', 'tasks'] as step, index (step)}
        <button
          class="step-chip"
          class:active={phase === step}
          type="button"
          onclick={() => specStore.openActiveSpecPhase(step as 'requirements' | 'design' | 'tasks')}
        >
          <span class="step-index">{index + 1}</span>
          <span>{phaseLabel(step as 'requirements' | 'design' | 'tasks')}</span>
          {#if step === 'design' && specStore.activeSpec.staleFlags.design}
            <span class="stale-pill">Stale</span>
          {/if}
          {#if step === 'tasks' && specStore.activeSpec.staleFlags.tasks}
            <span class="stale-pill">Stale</span>
          {/if}
        </button>
      {/each}
      {#if specStore.isBusy}
        <div class="busy-pill">
          <span class="busy-dot"></span>
          <span>{specStore.busyLabel || 'Working'}</span>
        </div>
      {/if}
    </div>

    {#if phase === 'tasks'}
      <div class="task-strip">
        {#each specStore.activeSpec.tasks as task (task.id)}
          {@const expanded = isTaskExpanded(task.id)}
          <div class="task-card">
            <button class="task-main" type="button" onclick={() => toggleTask(task.id)}>
              <span class="task-status {statusClass(task.status)}"></span>
              <div class="task-copy">
                <div class="task-title">{task.id}. {task.title}</div>
                {#if task.summary}
                  <div class="task-summary">{task.summary}</div>
                {/if}
                {#if task.latestRunId}
                  {@const latestRun = task.runs.find((run) => run.runId === task.latestRunId)}
                  {#if latestRun?.lastStatusMessage}
                    <div class="task-meta">{latestRun.lastStatusMessage}</div>
                  {/if}
                {/if}
                {#if task.latestVerificationId}
                  {@const latestVerification = task.verifications.find((entry) => entry.verificationId === task.latestVerificationId)}
                  {#if latestVerification}
                    <div class="task-meta">
                      {verificationLabel(latestVerification.status, Boolean(latestVerification.isStale))}
                      {#if typeof latestVerification.completenessScore === 'number'}
                        · {latestVerification.completenessScore}/10
                      {/if}
                      {#if latestVerification.isStale}
                        · stale
                      {/if}
                    </div>
                  {/if}
                {/if}
              </div>
              <span class="task-expand" class:expanded={expanded}>
                <UIIcon name="chevron-down" size={14} />
              </span>
            </button>

            <div class="task-actions">
              <button class="mini-btn" type="button" onclick={() => specStore.openTaskInEditor(task.id)}>
                <UIIcon name="target" size={12} />
                <span>View In File</span>
              </button>
              {#if task.status === 'todo'}
                <button class="mini-btn primary" type="button" onclick={() => specStore.startTask(task.id)} disabled={specStore.isBusy}>
                  <UIIcon name="play" size={12} />
                  <span>Start Task</span>
                </button>
              {:else if task.status === 'running'}
                <div class="task-run-pill running">
                  <span class="task-status running"></span>
                  <span>Running</span>
                </div>
              {:else if task.status === 'done'}
                {@const latestVerification = task.latestVerificationId ? task.verifications.find((entry) => entry.verificationId === task.latestVerificationId) : undefined}
                <div class="task-done-actions">
                  <div class="task-run-pill done">
                    <span class="task-status done"></span>
                    <span>Completed</span>
                  </div>
                  {#if latestVerification}
                    <div class="task-run-pill" class:done={verificationClass(latestVerification.status, Boolean(latestVerification.isStale)) === 'done'} class:running={verificationClass(latestVerification.status, Boolean(latestVerification.isStale)) === 'running'} class:review-failed={verificationClass(latestVerification.status, Boolean(latestVerification.isStale)) === 'failed'}>
                      <span class="task-status {verificationClass(latestVerification.status, Boolean(latestVerification.isStale))}"></span>
                      <span>{verificationLabel(latestVerification.status, Boolean(latestVerification.isStale))}{#if typeof latestVerification.completenessScore === 'number'} {latestVerification.completenessScore}/10{/if}</span>
                    </div>
                  {/if}
                  <button class="mini-btn" type="button" onclick={() => specStore.verifyTask(task.id)} disabled={specStore.isBusy || assistantStore.isStreaming}>
                    <UIIcon name="check-circle" size={12} />
                    <span>{latestVerification ? 'Re-Verify' : 'Verify Task'}</span>
                  </button>
                  {#if latestVerification?.conversationId}
                    <button class="mini-btn" type="button" onclick={() => specStore.openTaskConversation(latestVerification.conversationId)}>
                      <UIIcon name="comment" size={12} />
                      <span>Open Verify Chat</span>
                    </button>
                  {/if}
                </div>
              {:else}
                <button class="mini-btn primary" type="button" onclick={() => specStore.retryTask(task.id)} disabled={specStore.isBusy}>
                  <UIIcon name="refresh" size={12} />
                  <span>Retry Task</span>
                </button>
              {/if}
              {#if task.latestRunId}
                {@const latestRun = task.runs.find((run) => run.runId === task.latestRunId)}
                {#if latestRun?.conversationId}
                  <button class="mini-btn" type="button" onclick={() => specStore.openTaskConversation(latestRun.conversationId)}>
                    <UIIcon name="comment" size={12} />
                    <span>Open Chat</span>
                  </button>
                {/if}
                <button class="mini-btn" type="button" onclick={() => specStore.openLatestRun(task.id)}>
                  <UIIcon name="file" size={12} />
                  <span>Open Run</span>
                </button>
              {/if}
            </div>

            {#if expanded}
              <div class="task-details">
                {#if task.summary}
                  <p class="task-detail-copy">{task.summary}</p>
                {/if}
                {#if task.requirementIds.length > 0}
                  <div class="task-detail-row"><strong>Requirements:</strong> {task.requirementIds.join(', ')}</div>
                {/if}
                {#if task.dependencyIds.length > 0}
                  <div class="task-detail-row"><strong>Depends on:</strong> {task.dependencyIds.join(', ')}</div>
                {/if}
                {#if task.scopeHints.length > 0}
                  <div class="task-detail-row"><strong>Scope:</strong> {task.scopeHints.join(', ')}</div>
                {/if}
                <div class="task-detail-row"><strong>Verification:</strong> {task.verification}</div>
                {#if task.latestVerificationId}
                  {@const latestVerification = task.verifications.find((entry) => entry.verificationId === task.latestVerificationId)}
                  {#if latestVerification}
                    <div class="task-detail-row"><strong>Latest Review:</strong> {verificationLabel(latestVerification.status, Boolean(latestVerification.isStale))}{#if typeof latestVerification.completenessScore === 'number'} ({latestVerification.completenessScore}/10){/if}{#if latestVerification.isStale} [stale]{/if}</div>
                    {#if latestVerification.summary}
                      <div class="task-detail-row"><strong>Review Summary:</strong> {latestVerification.summary}</div>
                    {/if}
                  {/if}
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .spec-shell {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 14px 10px;
    border-bottom: 1px solid var(--color-border);
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--color-surface1, var(--color-surface0)) 88%, transparent), transparent),
      var(--color-bg-panel);
  }

  .spec-header,
  .spec-stepper,
  .task-card,
  .task-main,
  .task-actions,
  .spec-actions {
    display: flex;
    align-items: center;
  }

  .spec-header,
  .task-card {
    justify-content: space-between;
    gap: 12px;
  }

  .spec-title-group,
  .task-copy {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .spec-title {
    font-size: 14px;
    font-weight: 700;
    color: var(--color-text);
  }

  .spec-subtitle,
  .task-summary,
  .task-meta {
    font-size: 12px;
    color: var(--color-text-secondary);
  }

  .spec-actions,
  .task-actions,
  .spec-stepper {
    gap: 8px;
    flex-wrap: wrap;
  }

  .action-btn,
  .mini-btn,
  .step-chip,
  .busy-pill,
  .task-run-pill,
  .task-done-actions {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .action-btn,
  .mini-btn,
  .step-chip,
  .busy-pill,
  .task-run-pill {
    border: 1px solid var(--color-border);
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-surface0) 90%, transparent);
    color: var(--color-text);
    font-size: 12px;
  }

  .action-btn,
  .mini-btn {
    padding: 7px 10px;
  }

  .action-btn.primary,
  .mini-btn.primary,
  .step-chip.active {
    background: color-mix(in srgb, var(--color-accent) 18%, var(--color-surface0));
    border-color: color-mix(in srgb, var(--color-accent) 45%, var(--color-border));
  }

  .step-chip {
    padding: 6px 10px;
    cursor: pointer;
  }

  .step-index {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--color-text) 14%, transparent);
    font-size: 11px;
    font-weight: 700;
  }

  .stale-pill {
    padding: 2px 6px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--color-warning) 20%, transparent);
    color: var(--color-warning);
  }

  .busy-pill {
    padding: 6px 10px;
    margin-left: auto;
  }

  .task-run-pill {
    padding: 7px 10px;
  }

  .busy-dot,
  .task-status {
    width: 10px;
    height: 10px;
    border-radius: 999px;
    background: var(--color-text-secondary);
  }

  .busy-dot,
  .task-status.running {
    background: var(--color-accent);
    animation: pulse 1s infinite ease-in-out;
  }

  .task-status.done {
    background: var(--color-success, #3fb950);
  }

  .task-status.failed,
  .task-status.blocked {
    background: var(--color-error);
  }

  .task-run-pill.done {
    border-color: color-mix(in srgb, var(--color-success, #3fb950) 40%, var(--color-border));
    background: color-mix(in srgb, var(--color-success, #3fb950) 14%, var(--color-surface0));
  }

  .task-done-actions {
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .task-run-pill.running {
    border-color: color-mix(in srgb, var(--color-accent) 45%, var(--color-border));
    background: color-mix(in srgb, var(--color-accent) 16%, var(--color-surface0));
  }

  .task-run-pill.review-failed {
    border-color: color-mix(in srgb, var(--color-error) 40%, var(--color-border));
    background: color-mix(in srgb, var(--color-error) 14%, var(--color-surface0));
  }

  .task-strip {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 240px;
    overflow: auto;
    padding-right: 4px;
  }

  .task-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--color-border);
    border-radius: 12px;
    background: color-mix(in srgb, var(--color-surface0) 94%, transparent);
  }

  .task-main {
    width: 100%;
    justify-content: space-between;
    gap: 10px;
    min-width: 0;
    text-align: left;
    cursor: pointer;
  }

  .task-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--color-text);
  }

  .task-expand {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--color-text-secondary);
    transition: transform 0.16s ease;
  }

  .task-expand.expanded {
    transform: rotate(180deg);
  }

  .task-details {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 4px 0 0 20px;
    border-top: 1px solid color-mix(in srgb, var(--color-border) 85%, transparent);
  }

  .task-detail-copy,
  .task-detail-row {
    margin: 0;
    font-size: 12px;
    line-height: 1.55;
    color: var(--color-text-secondary);
  }

  .mini-btn:disabled,
  .action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .step-chip:hover {
    border-color: color-mix(in srgb, var(--color-accent) 35%, var(--color-border));
  }

  @keyframes pulse {
    0%,
    100% {
      transform: scale(1);
      opacity: 0.7;
    }
    50% {
      transform: scale(1.15);
      opacity: 1;
    }
  }
</style>
