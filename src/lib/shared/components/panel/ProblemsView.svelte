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

  // Get problems sorted by severity (errors first)
  function sortProblems(problems: Problem[]): Problem[] {
    const severityOrder = { error: 0, warning: 1, info: 2, hint: 3 };
    return [...problems].sort((a, b) => {
      const severityDiff =
        (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4);
      if (severityDiff !== 0) return severityDiff;
      return a.line - b.line;
    });
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

  function getVisibleProblemsForFile(filePath: string): Problem[] {
    let problems = problemsStore.getProblemsForFile(filePath);

    if (problemsStore.severityFilter !== "all") {
      problems = problems.filter(
        (p) => p.severity === problemsStore.severityFilter,
      );
    }

    if (problemsStore.searchQuery) {
      const query = problemsStore.searchQuery.toLowerCase();
      problems = problems.filter(
        (p) =>
          p.message.toLowerCase().includes(query) ||
          p.file.toLowerCase().includes(query) ||
          p.source.toLowerCase().includes(query) ||
          (p.code && p.code.toLowerCase().includes(query)),
      );
    }

    return problems;
  }

  function getVisibleFilePaths(): string[] {
    const visibleFiles = new Set(problemsStore.allProblems.map((p) => p.file));
    return problemsStore.filesWithProblems.filter((path) =>
      visibleFiles.has(path),
    );
  }
  
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
    if (status === "stale" || status === "updating") return "warning";
    return "muted";
  }

  function getFreshnessLabel(status: string): string {
    if (status === "updating") return "Diagnostics updating";
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
    <div class="empty-state">
      <div class="empty-icon"><UIIcon name="check" size={22} /></div>
      <p class="empty-title">No Problems</p>
      <p class="empty-description">
        {#if diagnosticsFreshness.status === "stale"}
          No current problems, but some diagnostics sources are stale
        {:else if diagnosticsFreshness.status === "updating"}
          No current problems yet; diagnostics are still updating
        {:else}
          No errors or warnings detected in the workspace
        {/if}
      </p>
    </div>
  {:else if problemsStore.totalCount === 0}
    <div class="empty-state">
      <div class="empty-icon"><UIIcon name="filter" size={22} /></div>
      <p class="empty-title">No Matching Problems</p>
      <p class="empty-description">
        {problemsStore.totalUnfilteredCount} problems hidden by filters
      </p>
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
              {#each sortProblems(problems) as problem (problem.id)}
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

  .results-meta {
    padding: 4px 10px;
    border-bottom: 1px solid var(--color-border);
    color: var(--color-text-secondary);
    font-size: 10px;
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
    gap: 6px;
  }

  .file-group {
    border: 1px solid var(--color-border);
    border-radius: 6px;
    overflow: hidden;
    background: var(--color-bg-sidebar);
  }

  .file-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 8px;
    background: var(--color-bg-sidebar);
    border: none;
    color: var(--color-text);
    font-size: 11px;
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

  .file-header-main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
    gap: 2px;
  }

  .file-name {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-path {
    font-size: 9px;
    color: var(--color-text-secondary);
    opacity: 0.75;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-counts {
    display: flex;
    gap: 4px;
  }

  .count-badge {
    padding: 1px 5px;
    border-radius: 10px;
    font-size: 9px;
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
    border-top: 1px solid var(--color-border);
    max-height: 220px;
    overflow-y: auto;
  }

  .problem-item-row {
    display: flex;
    align-items: stretch;
    width: 100%;
    padding-right: 8px;
    border-bottom: 1px solid color-mix(in srgb, var(--color-border) 60%, transparent);
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
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
    padding: 6px 8px 6px 24px;
    background: transparent;
    border: none;
    color: var(--color-text);
    font-size: 11px;
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
    gap: 2px;
    flex: 1;
  }

  .problem-meta-line {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .problem-action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
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
    font-size: 9px;
  }

  .problem-code {
    min-width: 0;
    color: var(--color-text-secondary);
    font-size: 9px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
