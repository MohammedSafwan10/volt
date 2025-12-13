<script lang="ts">
  /**
   * ProblemsView - Displays diagnostic problems from Monaco Editor
   * Shows errors, warnings, and info messages grouped by file
   */
  import { SvelteSet } from 'svelte/reactivity';
	import { tick } from 'svelte';
  import { problemsStore, type Problem } from '$lib/stores/problems.svelte';
  import { editorStore } from '$lib/stores/editor.svelte';

  // Track expanded files (SvelteSet is already reactive)
  const expandedFiles = new SvelteSet<string>();

  // Get severity icon
  function getSeverityIcon(severity: string): string {
    switch (severity) {
      case 'error':
        return '✕';
      case 'warning':
        return '⚠';
      case 'info':
        return 'ℹ';
      case 'hint':
        return '💡';
      default:
        return '•';
    }
  }

  // Get severity class
  function getSeverityClass(severity: string): string {
    switch (severity) {
      case 'error':
        return 'severity-error';
      case 'warning':
        return 'severity-warning';
      case 'info':
        return 'severity-info';
      case 'hint':
        return 'severity-hint';
      default:
        return '';
    }
  }

  // Toggle file expansion
  function toggleFile(filePath: string): void {
    if (expandedFiles.has(filePath)) {
      expandedFiles.delete(filePath);
    } else {
      expandedFiles.add(filePath);
    }
  }

  // Handle problem click - open file and go to location
  async function handleProblemClick(problem: Problem): Promise<void> {
    // Open the file
    const opened = await editorStore.openFile(problem.file);
    if (!opened) return;
		// Wait for the editor to switch to the requested file before navigating.
		await tick();

    // The editor will be focused, and we need to navigate to the position
    // This is handled by the editor component listening to a navigation event
    // For now, we dispatch a custom event that the editor can listen to
    window.dispatchEvent(new CustomEvent('volt:navigate-to-position', {
      detail: {
        file: problem.file,
        line: problem.line,
        column: problem.column
      }
    }));
  }

  // Check if file is expanded
  function isExpanded(filePath: string): boolean {
    return expandedFiles.has(filePath);
  }

  // Get problems sorted by severity (errors first)
  function sortProblems(problems: Problem[]): Problem[] {
    const severityOrder = { error: 0, warning: 1, info: 2, hint: 3 };
    return [...problems].sort((a, b) => {
      const severityDiff = (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4);
      if (severityDiff !== 0) return severityDiff;
      return a.line - b.line;
    });
  }

  // Get file error/warning counts
  function getFileCounts(problems: Problem[]): { errors: number; warnings: number } {
    return {
      errors: problems.filter(p => p.severity === 'error').length,
      warnings: problems.filter(p => p.severity === 'warning').length
    };
  }
</script>

<div class="problems-view">
  {#if problemsStore.totalCount === 0}
    <div class="empty-state">
      <div class="empty-icon">✓</div>
      <p class="empty-title">No Problems</p>
      <p class="empty-description">No errors or warnings detected in the workspace</p>
    </div>
  {:else}
    <div class="problems-header">
      <span class="problem-count">
        {#if problemsStore.errorCount > 0}
          <span class="count-error">✕ {problemsStore.errorCount}</span>
        {/if}
        {#if problemsStore.warningCount > 0}
          <span class="count-warning">⚠ {problemsStore.warningCount}</span>
        {/if}
        {#if problemsStore.infoCount > 0}
          <span class="count-info">ℹ {problemsStore.infoCount}</span>
        {/if}
      </span>
    </div>

    <div class="problems-list">
      {#each problemsStore.filesWithProblems as filePath (filePath)}
        {@const problems = problemsStore.getProblemsForFile(filePath)}
        {@const counts = getFileCounts(problems)}
        {@const expanded = isExpanded(filePath)}
        
        <div class="file-group">
          <button
            class="file-header"
            onclick={() => toggleFile(filePath)}
            aria-expanded={expanded}
          >
            <span class="expand-icon">{expanded ? '▼' : '▶'}</span>
            <span class="file-name">{problems[0]?.fileName || filePath}</span>
            <span class="file-counts">
              {#if counts.errors > 0}
                <span class="count-badge error">{counts.errors}</span>
              {/if}
              {#if counts.warnings > 0}
                <span class="count-badge warning">{counts.warnings}</span>
              {/if}
            </span>
          </button>

          {#if expanded}
            <div class="problems-items">
              {#each sortProblems(problems) as problem (problem.id)}
                <button
                  class="problem-item"
                  onclick={() => handleProblemClick(problem)}
                  title="{problem.file}:{problem.line}:{problem.column}"
                >
                  <span class="problem-icon {getSeverityClass(problem.severity)}">
                    {getSeverityIcon(problem.severity)}
                  </span>
                  <span class="problem-message">{problem.message}</span>
                  <span class="problem-location">[{problem.line}, {problem.column}]</span>
                  {#if problem.code}
                    <span class="problem-code">{problem.source}({problem.code})</span>
                  {/if}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .problems-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--color-bg);
    overflow: hidden;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 8px;
    color: var(--color-text-secondary);
    padding: 24px;
  }

  .empty-icon {
    font-size: 32px;
    color: var(--color-success);
    margin-bottom: 8px;
  }

  .empty-title {
    font-size: 14px;
    font-weight: 500;
    color: var(--color-text);
    margin: 0;
  }

  .empty-description {
    font-size: 12px;
    margin: 0;
    text-align: center;
  }

  .problems-header {
    display: flex;
    align-items: center;
    padding: 6px 12px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg-header);
  }

  .problem-count {
    display: flex;
    gap: 12px;
    font-size: 12px;
  }

  .count-error {
    color: var(--color-error);
  }

  .count-warning {
    color: var(--color-warning);
  }

  .count-info {
    color: var(--color-accent);
  }

  .problems-list {
    flex: 1;
    overflow-y: auto;
  }

  .file-group {
    border-bottom: 1px solid var(--color-border);
  }

  .file-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 12px;
    background: var(--color-bg-sidebar);
    border: none;
    color: var(--color-text);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    transition: background 0.1s ease;
  }

  .file-header:hover {
    background: var(--color-hover);
  }

  .expand-icon {
    font-size: 10px;
    color: var(--color-text-secondary);
    width: 12px;
  }

  .file-name {
    flex: 1;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-counts {
    display: flex;
    gap: 4px;
  }

  .count-badge {
    padding: 1px 6px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 500;
  }

  .count-badge.error {
    background: var(--color-error);
    color: var(--color-bg);
  }

  .count-badge.warning {
    background: var(--color-warning);
    color: var(--color-bg);
  }

  .problems-items {
    background: var(--color-bg);
  }

  .problem-item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    width: 100%;
    padding: 4px 12px 4px 30px;
    background: transparent;
    border: none;
    color: var(--color-text);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    transition: background 0.1s ease;
  }

  .problem-item:hover {
    background: var(--color-hover);
  }

  .problem-icon {
    flex-shrink: 0;
    width: 14px;
    text-align: center;
  }

  .problem-icon.severity-error {
    color: var(--color-error);
  }

  .problem-icon.severity-warning {
    color: var(--color-warning);
  }

  .problem-icon.severity-info {
    color: var(--color-accent);
  }

  .problem-icon.severity-hint {
    color: var(--color-text-secondary);
  }

  .problem-message {
    flex: 1;
    word-break: break-word;
    line-height: 1.4;
  }

  .problem-location {
    flex-shrink: 0;
    color: var(--color-text-secondary);
    font-family: monospace;
    font-size: 11px;
  }

  .problem-code {
    flex-shrink: 0;
    color: var(--color-text-secondary);
    font-size: 11px;
  }
</style>
