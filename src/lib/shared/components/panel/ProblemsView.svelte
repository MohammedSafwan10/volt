<script lang="ts">
  /**
   * ProblemsView - Displays diagnostic problems from Monaco Editor
   * Shows errors, warnings, and info messages grouped by file
   */
  import { SvelteSet } from "svelte/reactivity";
  import { tick } from "svelte";
  import { problemsStore, type Problem } from "$shared/stores/problems.svelte";
  import { editorStore } from "$features/editor/stores/editor.svelte";
  import { assistantStore } from "$features/assistant/stores/assistant.svelte";
  import { showToast } from "$shared/stores/toast.svelte";
  import { UIIcon, type UIIconName } from "$shared/components/ui";

  // Track expanded files (SvelteSet is already reactive)
  const expandedFiles = new SvelteSet<string>();
  const AUTO_EXPAND_FILE_LIMIT = 8;
  let hasInitializedExpansion = $state(false);

  function getSeverityIconName(severity: string): UIIconName {
    switch (severity) {
      case "error":
        return "error";
      case "warning":
        return "warning";
      case "info":
      case "hint":
        return "info";
      default:
        return "info";
    }
  }

  // Get severity class
  function getSeverityClass(severity: string): string {
    switch (severity) {
      case "error":
        return "severity-error";
      case "warning":
        return "severity-warning";
      case "info":
        return "severity-info";
      case "hint":
        return "severity-hint";
      default:
        return "";
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
    window.dispatchEvent(
      new CustomEvent("volt:navigate-to-position", {
        detail: {
          file: problem.file,
          line: problem.line,
          column: problem.column,
        },
      }),
    );
  }

  // Handle send to agent
  function handleSendToAgent(problem: Problem, event: MouseEvent): void {
    event.stopPropagation(); // Prevent navigation click

    const content = `[${problem.severity.toUpperCase()}] ${problem.message}
File: ${problem.file}:${problem.line}:${problem.column}
Source: ${problem.source}${problem.code ? ` (${problem.code})` : ""}`;

    const attachmentResult = assistantStore.attachSelection(
      content,
      problem.file,
      {
        startLine: problem.line,
        startCol: problem.column,
        endLine: problem.endLine,
        endCol: problem.endColumn,
      },
    );

    if (attachmentResult.success) {
      assistantStore.openPanel();
      // Optional: Set input value to prompt action
      if (!assistantStore.inputValue) {
        assistantStore.setInputValue("Fix this error");
      }
    } else {
      showToast({
        message: attachmentResult.error ?? "Failed to attach problem",
        type: "error",
      });
    }
  }

  // Handle send all problems to agent
  function handleSendAllToAgent(): void {
    const allProblems = problemsStore.allProblems;
    if (allProblems.length === 0) return;

    // Format all problems into a concise list
    const summary = allProblems
      .map(
        (p) =>
          `[${p.severity.toUpperCase()}] ${p.file}:${p.line} - ${p.message}`,
      )
      .join("\n");

    // Clean start to avoid duplicates
    assistantStore.clearAttachments();

    const attachmentResult = assistantStore.attachSelection(
      `All Workspace Problems:\n${summary}`,
      undefined, // No single file
      undefined,
    );

    if (attachmentResult.success) {
      assistantStore.openPanel();
      if (!assistantStore.inputValue) {
        assistantStore.setInputValue("Fix all these errors");
      }
    }
  }

  // Check if file is expanded
  function isExpanded(filePath: string): boolean {
    return expandedFiles.has(filePath);
  }

  // Get file error/warning counts
  function getFileCounts(problems: Problem[]): {
    errors: number;
    warnings: number;
  } {
    return {
      errors: problems.filter((p) => p.severity === "error").length,
      warnings: problems.filter((p) => p.severity === "warning").length,
    };
  }

  const visibleProblems = $derived(problemsStore.allProblems);

  function getVisibleProblemsForFile(filePath: string): Problem[] {
    return visibleProblems.filter((problem) => problem.file === filePath);
  }

  function getVisibleFilePaths(): string[] {
    const visibleFiles = new Set<string>();

    for (const problem of visibleProblems) {
      visibleFiles.add(problem.file);
    }

    return Array.from(visibleFiles);
  }

  $effect(() => {
    const filePaths = getVisibleFilePaths();

    if (filePaths.length === 0) {
      expandedFiles.clear();
      hasInitializedExpansion = false;
      return;
    }

    for (const filePath of Array.from(expandedFiles)) {
      if (!filePaths.includes(filePath)) {
        expandedFiles.delete(filePath);
      }
    }

    if (hasInitializedExpansion) return;

    for (const filePath of filePaths.slice(0, AUTO_EXPAND_FILE_LIMIT)) {
      expandedFiles.add(filePath);
    }

    hasInitializedExpansion = true;
  });
  
  // Handle filter change
  function handleFilterChange(filter: 'all' | 'error' | 'warning' | 'info'): void {
    problemsStore.setSeverityFilter(filter);
  }
  
  // Handle search
  function handleSearch(event: Event): void {
    const target = event.target as HTMLInputElement;
    problemsStore.setSearchQuery(target.value);
  }
  
  // Check if a filter is active
  function isFilterActive(filter: string): boolean {
    return problemsStore.severityFilter === filter;
  }

  const showAnalyzing = $derived(
    problemsStore.isUpdating && problemsStore.totalUnfilteredCount === 0,
  );
  const diagnosticsFreshness = $derived(problemsStore.diagnosticsFreshness);

  function getFreshnessTone(status: string): "success" | "warning" | "muted" {
    if (status === "fresh") return "success";
    if (status === "stale" || status === "updating" || status === "warming") return "warning";
    return "muted";
  }

  function getFreshnessLabel(status: string): string {
    if (status === "updating") return "Diagnostics updating";
    if (status === "warming") return "Diagnostics warming";
    if (status === "stale") return "Diagnostics stale";
    if (status === "fresh") return "Diagnostics fresh";
    return "Diagnostics idle";
  }

  function formatFileDirectory(filePath: string, fileName?: string): string {
    const normalized = filePath.replace(/\\/g, "/");
    const parts = normalized.split("/");
    const fallbackName = parts[parts.length - 1] ?? normalized;
    const currentFileName = fileName || fallbackName;
    const withoutName = normalized.endsWith(currentFileName)
      ? normalized.slice(0, Math.max(0, normalized.length - currentFileName.length))
      : normalized;
    return withoutName.replace(/\/$/, "");
  }
</script>

<div class="problems-view">
  <div class="problems-toolbar">
    <div class="toolbar-summary">
      <span class="summary-pill total">{problemsStore.totalUnfilteredCount} total</span>
      <span
        class="summary-pill freshness"
        class:success={getFreshnessTone(diagnosticsFreshness.status) === "success"}
        class:warning={getFreshnessTone(diagnosticsFreshness.status) === "warning"}
        title={diagnosticsFreshness.activeSources.length > 0
          ? `Sources: ${diagnosticsFreshness.activeSources.join(", ")}`
          : "No diagnostics sources have reported yet"}
      >
        {getFreshnessLabel(diagnosticsFreshness.status)}
      </span>
      {#if problemsStore.errorCount > 0}
        <span class="summary-pill error"
          ><UIIcon name="error" size={12} /> {problemsStore.errorCount}</span
        >
      {/if}
      {#if problemsStore.warningCount > 0}
        <span class="summary-pill warning"
          ><UIIcon name="warning" size={12} /> {problemsStore.warningCount}</span
        >
      {/if}
      {#if problemsStore.infoCount > 0}
        <span class="summary-pill info"
          ><UIIcon name="info" size={12} /> {problemsStore.infoCount}</span
        >
      {/if}
    </div>

    <div class="filter-buttons" role="tablist" aria-label="Problem filters">
      <button
        class="filter-btn"
        class:active={isFilterActive("all")}
        onclick={() => handleFilterChange("all")}
        title="Show all"
      >
        All ({problemsStore.totalUnfilteredCount})
      </button>
      <button
        class="filter-btn error"
        class:active={isFilterActive("error")}
        onclick={() => handleFilterChange("error")}
        title="Show errors only"
      >
        <UIIcon name="error" size={12} /> {problemsStore.errorCount}
      </button>
      <button
        class="filter-btn warning"
        class:active={isFilterActive("warning")}
        onclick={() => handleFilterChange("warning")}
        title="Show warnings only"
      >
        <UIIcon name="warning" size={12} /> {problemsStore.warningCount}
      </button>
      <button
        class="filter-btn info"
        class:active={isFilterActive("info")}
        onclick={() => handleFilterChange("info")}
        title="Show info only"
      >
        <UIIcon name="info" size={12} /> {problemsStore.infoCount}
      </button>
    </div>

    <div class="search-box">
      <UIIcon name="search" size={14} />
      <input
        type="text"
        placeholder="Filter problems..."
        value={problemsStore.searchQuery}
        oninput={handleSearch}
      />
      {#if problemsStore.searchQuery}
        <button
          class="clear-search"
          onclick={() => problemsStore.setSearchQuery("")}
        >
          <UIIcon name="close" size={12} />
        </button>
      {/if}
    </div>

    {#if showAnalyzing}
      <div class="activity-indicator" title="Analyzing...">
        <div class="spinner"></div>
      </div>
    {/if}

    {#if problemsStore.totalCount > 0}
      <button
        class="fix-all-btn"
        onclick={handleSendAllToAgent}
        title="Fix all problems with AI"
      >
        <UIIcon name="sparkle" size={14} />
        <span>Fix All with AI</span>
      </button>
    {/if}
  </div>

  {#if problemsStore.totalCount === 0 && problemsStore.totalUnfilteredCount === 0}
    <div class="panel-body empty-state-shell">
      <div class="empty-state">
      <div class="empty-icon"><UIIcon name="check" size={22} /></div>
      <p class="empty-title">No Problems</p>
      <p class="empty-description">
        {#if diagnosticsFreshness.status === "stale"}
          No current problems, but some diagnostics sources are stale
        {:else if diagnosticsFreshness.status === "warming"}
          No current problems; diagnostics are still warming up
        {:else if diagnosticsFreshness.status === "updating"}
          No current problems yet; diagnostics are still updating
        {:else}
          No errors or warnings detected in the workspace
        {/if}
      </p>
      </div>
    </div>
  {:else if problemsStore.totalCount === 0}
    <div class="panel-body empty-state-shell">
      <div class="empty-state">
      <div class="empty-icon"><UIIcon name="filter" size={22} /></div>
      <p class="empty-title">No Matching Problems</p>
      <p class="empty-description">
        {problemsStore.totalUnfilteredCount} problems hidden by filters
      </p>
      </div>
    </div>
  {:else}
    {@const visibleFilePaths = getVisibleFilePaths()}

    <div class="results-meta">
      Showing {problemsStore.totalCount} problem{problemsStore.totalCount === 1
        ? ""
        : "s"} across {visibleFilePaths.length} file{visibleFilePaths.length ===
      1
        ? ""
        : "s"}
      {#if diagnosticsFreshness.staleSources.length > 0}
        · stale sources: {diagnosticsFreshness.staleSources.join(", ")}
      {:else if diagnosticsFreshness.hasWarmingSources}
        · some diagnostics are warming up
      {:else if diagnosticsFreshness.isUpdating}
        · diagnostics still updating
      {/if}
    </div>

    <div class="problems-list">
      {#each visibleFilePaths as filePath (filePath)}
        {@const problems = getVisibleProblemsForFile(filePath)}
        {@const counts = getFileCounts(problems)}
        {@const expanded = isExpanded(filePath)}
        {@const fileName = problems[0]?.fileName || filePath.split(/[\\/]/).pop() || filePath}
        {@const fileDirectory = formatFileDirectory(filePath, fileName)}

        <div class="file-group">
          <button
            class="file-header"
            onclick={() => toggleFile(filePath)}
            aria-expanded={expanded}
          >
            <span class="expand-icon">
              <UIIcon
                name={expanded ? "chevron-down" : "chevron-right"}
                size={14}
              />
            </span>
            <span class="file-header-main">
              <span class="file-name">{fileName}</span>
              {#if fileDirectory}
                <span class="file-path">{fileDirectory}</span>
              {/if}
            </span>
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
              {#each problems as problem (problem.id)}
                <div class="problem-item-row">
                  <button
                    class="problem-item"
                    onclick={() => handleProblemClick(problem)}
                    title="{problem.file}:{problem.line}:{problem.column}"
                  >
                    <span
                      class="problem-icon {getSeverityClass(problem.severity)}"
                    >
                      <UIIcon
                        name={getSeverityIconName(problem.severity)}
                        size={14}
                      />
                    </span>
                    <span class="problem-content">
                      <span class="problem-message">{problem.message}</span>
                      <span class="problem-meta-line">
                        <span class="problem-location"
                          >Ln {problem.line}, Col {problem.column}</span
                        >
                        {#if problem.code}
                          <span class="problem-code"
                            >{problem.source} ({problem.code})</span
                          >
                        {:else}
                          <span class="problem-code">{problem.source}</span>
                        {/if}
                      </span>
                    </span>
                  </button>
                  <button
                    class="problem-action-btn"
                    onclick={(e) => handleSendToAgent(problem, e)}
                    title="Ask Agent to Fix"
                  >
                    <UIIcon name="sparkle" size={12} />
                  </button>
                </div>
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
    min-height: 0;
    background: var(--color-bg);
    overflow: hidden;
  }

  .problems-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg-header);
    overflow-x: auto;
    overflow-y: hidden;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .toolbar-summary {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .summary-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 18px;
    padding: 0 8px;
    border-radius: 999px;
    border: 1px solid var(--color-border);
    background: var(--color-bg);
    color: var(--color-text-secondary);
    font-size: 10px;
    font-weight: 600;
  }

  .summary-pill.error {
    color: var(--color-error);
  }

  .summary-pill.warning {
    color: var(--color-warning);
  }

  .summary-pill.info {
    color: var(--color-accent);
  }

  .summary-pill.freshness.success {
    color: var(--color-success);
    border-color: color-mix(in srgb, var(--color-success) 45%, var(--color-border));
  }

  .summary-pill.freshness.warning {
    color: var(--color-warning);
    border-color: color-mix(in srgb, var(--color-warning) 45%, var(--color-border));
  }

  .filter-buttons {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }

  .filter-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 8px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--color-text-secondary);
    font-size: 10px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  
  .filter-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }
  
  .filter-btn.active {
    background: var(--color-accent-bg);
    color: var(--color-accent);
    border-color: var(--color-accent);
  }

  .filter-btn.error.active {
    background: rgba(255, 85, 85, 0.15);
    color: var(--color-error);
    border-color: var(--color-error);
  }
  
  .filter-btn.warning.active {
    background: rgba(255, 180, 80, 0.15);
    color: var(--color-warning);
    border-color: var(--color-warning);
  }
  
  .filter-btn.info.active {
    background: rgba(100, 180, 255, 0.15);
    color: var(--color-accent);
    border-color: var(--color-accent);
  }

  .search-box {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 220px;
    max-width: 420px;
    padding: 3px 8px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-bg);
    color: var(--color-text-secondary);
  }
  
  .search-box:focus-within {
    border-color: var(--color-accent);
  }
  
  .search-box input {
    flex: 1;
    border: none;
    background: transparent;
    color: var(--color-text);
    font-size: 11px;
    outline: none;
  }
  
  .search-box input::placeholder {
    color: var(--color-text-secondary);
  }
  
  .clear-search {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2px;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--color-text-secondary);
    cursor: pointer;
  }
  
  .clear-search:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .activity-indicator {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    flex-shrink: 0;
  }
  
  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid var(--color-border);
    border-top-color: var(--color-accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  
  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .panel-body {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .empty-state-shell {
    display: flex;
    align-items: stretch;
  }

  .empty-state {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    align-items: center;
    justify-content: center;
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

  .results-meta {
    padding: 6px 10px;
    border-bottom: 1px solid var(--color-border);
    color: var(--color-text-secondary);
    font-size: 11px;
    flex-shrink: 0;
  }

  .fix-all-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    padding: 0 8px;
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    color: var(--color-accent);
    font-size: 10px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.1s ease;
    flex-shrink: 0;
  }

  .fix-all-btn:hover {
    background: color-mix(in srgb, var(--color-accent) 15%, transparent);
    border-color: var(--color-accent);
  }

  .problems-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 6px 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .file-group {
    border: 1px solid var(--color-border);
    border-radius: 8px;
    overflow: hidden;
    background: var(--color-bg-sidebar);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
    flex-shrink: 0;
  }

  .file-header {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 42px;
    padding: 8px 10px;
    background: var(--color-bg-sidebar);
    border: none;
    color: var(--color-text);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    transition:
      background 0.1s ease,
      border-color 0.1s ease;
  }

  .file-header:hover {
    background: color-mix(in srgb, var(--color-hover) 82%, var(--color-bg-sidebar));
  }

  .expand-icon {
    font-size: 12px;
    color: var(--color-text-secondary);
    width: 14px;
    flex-shrink: 0;
  }

  .file-header-main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
    gap: 3px;
  }

  .file-name {
    font-weight: 600;
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-path {
    font-size: 10px;
    color: var(--color-text-secondary);
    opacity: 0.95;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-counts {
    display: flex;
    gap: 4px;
  }

  .count-badge {
    min-width: 18px;
    padding: 2px 6px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 600;
    line-height: 1.2;
    text-align: center;
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
    border-top: 1px solid var(--color-border);
  }

  .problem-item-row {
    display: flex;
    align-items: stretch;
    width: 100%;
    padding-right: 10px;
    border-bottom: 1px solid color-mix(in srgb, var(--color-border) 60%, transparent);
    flex-shrink: 0;
  }

  .problem-item-row:last-child {
    border-bottom: none;
  }

  .problem-item-row:hover {
    background: var(--color-hover);
  }

  .problem-item-row:hover .problem-action-btn {
    opacity: 1;
  }

  .problem-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    flex: 1;
    min-width: 0;
    padding: 9px 10px 9px 24px;
    background: transparent;
    border: none;
    color: var(--color-text);
    font-size: 12px;
    line-height: 1.4;
    text-align: left;
    cursor: pointer;
  }

  .problem-item:hover {
    background: transparent;
  }

  .problem-content {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 4px;
    flex: 1;
  }

  .problem-meta-line {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex-wrap: wrap;
  }

  .problem-action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 4px;
    color: var(--color-text-secondary);
    background: transparent;
    border: none;
    cursor: pointer;
    opacity: 0; /* Hidden by default */
    transition:
      opacity 0.1s ease,
      background 0.1s ease;
  }

  .problem-action-btn:hover {
    background: var(--color-hover-dark); /* Slightly darker than row hover */
    color: var(--color-accent);
  }

  .problem-icon {
    flex-shrink: 0;
    width: 16px;
    text-align: center;
    margin-top: 1px;
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
    line-height: 1.45;
  }

  .problem-location {
    flex-shrink: 0;
    color: var(--color-text-secondary);
    font-family: monospace;
    font-size: 10px;
  }

  .problem-code {
    min-width: 0;
    color: var(--color-text-secondary);
    font-size: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
