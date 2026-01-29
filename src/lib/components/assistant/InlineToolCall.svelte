<script lang="ts">
  /**
   * InlineToolCall - Displays tool activity inline within assistant messages
   * Shows tool name, status, and expandable output like Kiro's UI
   * Supports streaming progress for file write operations
   *
   * Kiro-style: Only shows approval for the FIRST pending terminal command
   */
  import { UIIcon, type UIIconName } from "$lib/components/ui";
  import { editorStore } from "$lib/stores/editor.svelte";
  import { projectStore } from "$lib/stores/project.svelte";
  import type {
    ToolCall,
    ToolCallStatus,
    StreamingProgress,
  } from "$lib/stores/assistant.svelte";
  import type { Problem } from "$lib/stores/problems.svelte";

  interface Props {
    toolCall: ToolCall;
    /** Streaming progress for file write tools */
    streamingProgress?: StreamingProgress | null;
    onApprove?: () => void;
    onDeny?: () => void;
    /** For terminal commands: is this the first pending one? (Kiro-style sequential approval) */
    isFirstPendingTerminal?: boolean;
  }

  let {
    toolCall,
    streamingProgress,
    onApprove,
    onDeny,
    isFirstPendingTerminal = true,
  }: Props = $props();

  let expanded = $state(false);

  // Auto-expand when screenshot data arrives
  $effect(() => {
    if (
      toolCall.name === "browser_screenshot" &&
      toolCall.data?.image_base64 &&
      !expanded
    ) {
      expanded = true;
    }
  });

  // Format output with clickable URLs (global handler in layout opens them in browser)
  function formatOutputWithLinks(text: string): string {
    return text.replace(
      /(https?:\/\/[^\s<>"']+)/gi,
      '<a href="$1" class="output-link">$1</a>',
    );
  }

  async function handleFileClick(path: string) {
    if (!path) return;

    let fullPath = path;
    if (projectStore.rootPath && !path.startsWith("/") && !path.includes(":")) {
      const sep = projectStore.rootPath.includes("\\") ? "\\" : "/";
      fullPath = `${projectStore.rootPath}${sep}${path}`;
    }

    await editorStore.openFile(fullPath);
  }

  async function handleProblemClick(
    problem: Problem & { relativePath?: string },
  ) {
    const path = problem.file;
    await editorStore.openFile(path);
    editorStore.setSelection(path, {
      startLine: problem.line,
      startColumn: problem.column,
      endLine: problem.endLine || problem.line,
      endColumn: problem.endColumn || problem.column,
    });
  }

  // Tool display names (more user-friendly)
  const toolDisplayNames: Record<string, string> = {
    // Context & Search
    gather_context: "Gathering context",
    workspace_search: "Searched workspace",
    list_dir: "Listed directory",
    read_file: "Read file",
    read_files: "Read files",
    get_file_info: "Got file info",
    get_file_tree: "Got file tree",
    find_files: "Found files",
    search_symbols: "Searched symbols",
    // Editor
    get_active_file: "Got active file",
    get_selection: "Got selection",
    get_open_files: "Got open files",
    // File operations
    write_file: "Wrote file",
    append_file: "Appended to file",
    str_replace: "Edited file",
    apply_edit: "Edited file",
    create_file: "Created file",
    create_dir: "Created directory",
    delete_file: "Deleted file",
    delete_path: "Deleted",
    rename_path: "Renamed",
    // Terminal - cleaner names
    run_command: "Run command",
    start_process: "Start process",
    stop_process: "Stopped process",
    list_processes: "Listed processes",
    get_process_output: "Got process output",
    terminal_create: "Created terminal",
    terminal_write: "Executed command",
    terminal_kill: "Killed terminal",
    terminal_get_output: "Got terminal output",
    read_terminal: "Read terminal",
    // Diagnostics
    run_check: "Ran check",
    get_diagnostics: "Got diagnostics",
  };

  // Tool icons - using valid UIIconName values
  const toolIcons: Record<string, UIIconName> = {
    // Context & Search
    gather_context: "search",
    workspace_search: "search",
    list_dir: "folder",
    read_file: "file",
    read_files: "files",
    get_file_info: "info",
    get_file_tree: "files",
    find_files: "search",
    search_symbols: "symbol-class",
    // Editor
    get_active_file: "file",
    get_selection: "code",
    get_open_files: "files",
    // File operations
    write_file: "pencil",
    append_file: "file-plus",
    str_replace: "pencil",
    apply_edit: "pencil",
    create_file: "file-plus",
    create_dir: "folder-plus",
    delete_file: "trash",
    delete_path: "trash",
    rename_path: "pencil",
    // Terminal
    run_command: "terminal",
    start_process: "play",
    stop_process: "stop",
    list_processes: "files",
    get_process_output: "terminal",
    terminal_create: "terminal",
    terminal_write: "terminal",
    terminal_kill: "close",
    terminal_get_output: "terminal",
    read_terminal: "terminal",
    // Diagnostics
    run_check: "search",
    get_diagnostics: "warning",
  };

  const statusIcons: Record<ToolCallStatus, UIIconName> = {
    pending: "clock",
    running: "spinner",
    completed: "check",
    failed: "error",
    cancelled: "close",
  };

  // Tool category for color coding
  type ToolCategory =
    | "search"
    | "file"
    | "edit"
    | "terminal"
    | "diagnostic"
    | "other";

  const toolCategories: Record<string, ToolCategory> = {
    // Search/Read
    gather_context: "search",
    workspace_search: "search",
    list_dir: "search",
    read_file: "file",
    read_files: "file",
    get_file_info: "file",
    get_file_tree: "search",
    find_files: "search",
    search_symbols: "search",
    get_active_file: "file",
    get_selection: "file",
    get_open_files: "file",
    // Write/Edit
    write_file: "edit",
    append_file: "edit",
    str_replace: "edit",
    apply_edit: "edit",
    create_file: "edit",
    create_dir: "edit",
    delete_file: "edit",
    delete_path: "edit",
    rename_path: "edit",
    // Terminal
    run_command: "terminal",
    start_process: "terminal",
    stop_process: "terminal",
    list_processes: "terminal",
    get_process_output: "terminal",
    terminal_create: "terminal",
    terminal_write: "terminal",
    terminal_kill: "terminal",
    terminal_get_output: "terminal",
    read_terminal: "terminal",
    // Diagnostics
    run_check: "diagnostic",
    get_diagnostics: "diagnostic",
  };

  function getToolCategory(): ToolCategory {
    return toolCategories[toolCall.name] ?? "other";
  }

  // Get display name for tool
  function getToolDisplayName(): string {
    return toolDisplayNames[toolCall.name] ?? toolCall.name;
  }

  // Get icon for tool
  function getToolIcon(): UIIconName {
    return toolIcons[toolCall.name] ?? "code";
  }

  // Get summary of what the tool is doing
  function getToolSummary(): string {
    const args = toolCall.arguments;
    const resultMeta = toolCall.meta as Record<string, unknown> | undefined;

    switch (toolCall.name) {
      case "list_dir":
        return args.path ? String(args.path) : ".";
      case "read_file": {
        // No filename here - it will be in the pill
        const startLine = args.startLine ? Number(args.startLine) : null;
        const endLine = args.endLine ? Number(args.endLine) : null;
        if (resultMeta?.startLine && resultMeta?.endLine) {
          return `#L${Number(resultMeta.startLine)}-${Number(resultMeta.endLine)}`;
        }
        if (startLine && endLine) {
          return `#L${startLine}-${endLine}`;
        } else if (startLine) {
          return `#L${startLine}+`;
        } else if (endLine) {
          return `#L1-${endLine}`;
        }
        return "";
      }
      case "read_files": {
        const paths = args.paths as string[] | undefined;
        if (!paths || paths.length === 0) return "";
        return `${paths.length} files`;
      }
      case "workspace_search": {
        const query = args.query ? String(args.query) : "";
        const pattern = args.includePattern
          ? ` in ${String(args.includePattern)}`
          : "";
        return query ? `"${query}"${pattern}` : "";
      }
      case "write_file":
      case "append_file":
      case "create_file":
      case "delete_path":
      case "create_dir":
        return "";
      case "rename_path":
        const oldP = String(args.oldPath || "")
          .split(/[/\\]/)
          .pop();
        const newP = String(args.newPath || "")
          .split(/[/\\]/)
          .pop();
        return oldP && newP ? `${oldP} → ${newP}` : "";
      case "run_command":
        return args.command ? String(args.command).slice(0, 50) : "";
      case "start_process":
        return args.command ? String(args.command).slice(0, 50) : "";
      case "stop_process":
        return args.processId ? `Process ${args.processId}` : "";
      case "get_process_output":
        return args.processId ? `Process ${args.processId}` : "";
      case "list_processes":
        return "";
      case "terminal_write":
        return args.command ? String(args.command).slice(0, 40) : "";
      case "get_diagnostics": {
        const paths = args.paths as string[] | undefined;
        if (!paths || paths.length === 0) return "all files";
        return `${paths.length} files`;
      }
      case "run_check":
        return args.checkType ? String(args.checkType) : "";
      default:
        return "";
    }
  }

  // Get meta info if available
  function getMeta(): { why?: string; risk?: string; undo?: string } | null {
    const meta = toolCall.arguments.meta as Record<string, unknown> | undefined;
    if (!meta) return null;
    return {
      why: meta.why ? String(meta.why) : undefined,
      risk: meta.risk ? String(meta.risk) : undefined,
      undo: meta.undo ? String(meta.undo) : undefined,
    };
  }

  const meta = $derived(getMeta());
  const summary = $derived(getToolSummary());
  const isRunning = $derived(toolCall.status === "running");
  const isPending = $derived(
    toolCall.status === "pending" && toolCall.requiresApproval,
  );
  const isComplete = $derived(toolCall.status === "completed");
  const isFailed = $derived(toolCall.status === "failed");

  // Check if this is a terminal command tool
  const isTerminalTool = $derived(
    toolCall.name === "run_command" ||
      toolCall.name === "start_process" ||
      toolCall.name === "terminal_write",
  );

  // For terminal commands, only show approval if this is the first pending one (Kiro-style)
  const shouldShowApproval = $derived(
    isPending &&
      onApprove &&
      onDeny &&
      (!isTerminalTool || isFirstPendingTerminal),
  );

  // Get the command for terminal tools
  const terminalCommand = $derived(
    isTerminalTool ? String(toolCall.arguments.command || "") : "",
  );

  // Check if this is a file write tool that supports streaming
  const isFileWriteTool = $derived(
    toolCall.name === "write_file" ||
      toolCall.name === "create_file" ||
      toolCall.name === "apply_edit" ||
      toolCall.name === "multi_replace_file_content",
  );
  const isStreaming = $derived(
    isFileWriteTool && isRunning && streamingProgress != null,
  );

  // Format streaming progress
  function formatProgress(progress: StreamingProgress): string {
    return `${progress.linesWritten}/${progress.totalLines} lines`;
  }

  function getFileExt(path: string): string {
    return path.split(".").pop()?.toLowerCase() || "";
  }

  function getFileIcon(ext: string, filename?: string): UIIconName {
    switch (ext) {
      case "svelte":
        return "svelte";
      case "ts":
      case "tsx":
        return "typescript";
      case "js":
      case "jsx":
        return "javascript";
      case "rs":
        return "rust";
      case "py":
        return "python";
      case "json":
        return "json";
      case "dart":
        return "dart";
      case "xml":
        if (filename?.toLowerCase().includes("androidmanifest"))
          return "android";
        return "xml";
      case "yaml":
      case "yml":
        return "yaml";
      case "md":
        return "markdown";
      case "css":
        return "css";
      case "html":
        return "html";
      default:
        return "file";
    }
  }

  const files = $derived.by(() => {
    const args = toolCall.arguments;
    const path = (args.path || args.filePath || args.oldPath) as
      | string
      | undefined;
    const paths = (args.paths || args.uris) as string[] | undefined;

    const allPaths = paths || (path ? [path] : []);
    if (allPaths.length === 0) return [];

    return allPaths.map((p) => {
      // robust splitting for Windows
      const parts = p.split(/[/\\]/);
      const filename = parts[parts.length - 1] || p;
      const ext = getFileExt(filename);
      return {
        filename,
        icon: getFileIcon(ext, filename),
        path: p,
      };
    });
  });

  const diagnosticSummary = $derived.by(() => {
    if (toolCall.name !== "get_diagnostics" || !toolCall.meta) return null;
    const meta = toolCall.meta as any;
    const items = (meta.problems || []) as (Problem & {
      relativePath: string;
    })[];

    // Group by file
    const byFile = new Map<string, typeof items>();
    for (const p of items) {
      if (!byFile.has(p.relativePath)) byFile.set(p.relativePath, []);
      byFile.get(p.relativePath)!.push(p);
    }

    return {
      errorCount: meta.errorCount || 0,
      warningCount: meta.warningCount || 0,
      fileCount: meta.fileCount || 0,
      files: Array.from(byFile.entries()).map(([path, problems]) => ({
        path,
        problems,
        errorCount: problems.filter((p) => p.severity === "error").length,
        warningCount: problems.filter((p) => p.severity === "warning").length,
      })),
    };
  });

  const diffStats = $derived.by(() => {
    const meta = toolCall.meta as Record<string, any> | undefined;
    const stats = meta?.fileEdit as Record<string, any> | undefined;
    if (!stats) return null;
    return {
      added: typeof stats.added === "number" ? stats.added : 0,
      removed: typeof stats.removed === "number" ? stats.removed : 0,
    };
  });
</script>

<div
  class="inline-tool-call {toolCall.status} category-{getToolCategory()}"
  class:terminal-tool={isTerminalTool}
  role="article"
  aria-label="Tool: {getToolDisplayName()}"
>
  {#if isTerminalTool}
    <!-- Special terminal-style display -->
    <button
      class="tool-header terminal-header"
      onclick={() => (expanded = !expanded)}
      aria-expanded={expanded}
      type="button"
    >
      <span class="terminal-prompt">
        <UIIcon name="terminal" size={14} />
        <span class="prompt-symbol">$</span>
      </span>
      <span class="terminal-command">{terminalCommand || "command"}</span>
      <span class="tool-status-icon">
        {#if isRunning}
          <span class="terminal-running-indicator"></span>
        {:else if isComplete}
          <!-- No check mark -->
        {:else if isFailed}
          <UIIcon name="error" size={12} />
        {:else if isPending}
          <UIIcon name="clock" size={12} />
        {/if}
      </span>
      <span class="expand-icon" class:expanded>
        <UIIcon name="chevron-down" size={12} />
      </span>
    </button>
  {:else}
    <!-- Standard tool display -->
    <button
      class="tool-header"
      onclick={() => (expanded = !expanded)}
      aria-expanded={expanded}
      type="button"
    >
      <span
        class="tool-icon category-{getToolCategory()}"
        class:spinning={isRunning && !isStreaming}
      >
        {#if isStreaming}
          <UIIcon name="pencil" size={12} />
        {:else if isRunning}
          <UIIcon name="spinner" size={12} />
        {:else}
          <UIIcon name={getToolIcon()} size={12} />
        {/if}
      </span>

      <span class="tool-name">{getToolDisplayName()}</span>

      {#if diagnosticSummary}
        <div class="diag-mini-summary">
          {#if diagnosticSummary.errorCount > 0}
            <span class="diag-badge error"
              >{diagnosticSummary.errorCount} Errors</span
            >
          {/if}
          {#if diagnosticSummary.warningCount > 0}
            <span class="diag-badge warning"
              >{diagnosticSummary.warningCount} Warnings</span
            >
          {/if}
          {#if diagnosticSummary.errorCount === 0 && diagnosticSummary.warningCount === 0}
            <span class="diag-badge success">Clean</span>
          {/if}
        </div>
      {:else if files.length > 0}
        <div class="files-container" class:multi={files.length > 1}>
          {#each files as file}
            <div
              class="file-pill"
              class:is-loading={isRunning}
              role="button"
              tabindex="0"
              onclick={(e) => {
                e.stopPropagation();
                handleFileClick(file.path);
              }}
              onkeydown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation();
                  handleFileClick(file.path);
                }
              }}
              aria-label="Open {file.filename}"
            >
              {#if isRunning && !isStreaming}
                <UIIcon name="spinner" size={14} class="spinner-icon" />
              {:else if isStreaming}
                <UIIcon name="spinner" size={14} class="spinner-icon" />
              {:else}
                <UIIcon name={file.icon} size={14} />
              {/if}
              <span class="filename">{file.filename}</span>

              {#if isStreaming && streamingProgress}
                <div class="pill-progress-bar">
                  <div
                    class="pill-progress-fill"
                    style="width: {streamingProgress.percent}%"
                  ></div>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}

      {#if diffStats && (isComplete || isStreaming)}
        <div class="diff-stats">
          {#if diffStats.added > 0}
            <span class="stat-added">+{diffStats.added}</span>
          {/if}
          {#if diffStats.removed > 0}
            <span class="stat-removed">-{diffStats.removed}</span>
          {/if}
        </div>
      {/if}

      {#if summary && !isStreaming}
        {@const isRedundantPath = files.length > 0 && !summary.includes("#L")}
        {#if !isRedundantPath}
          <span
            class="tool-summary"
            class:is-line-range={summary.includes("#L")}
          >
            {summary.includes("#L") ? "#" + summary.split("#")[1] : summary}
          </span>
        {/if}
      {/if}

      <span class="tool-status-icon">
        {#if isStreaming}
          <span class="streaming-indicator"></span>
        {:else if isRunning}
          <!-- Already showing spinner in tool-icon -->
        {:else if isComplete}
          <!-- No check mark -->
        {:else if isFailed}
          <UIIcon name="error" size={12} />
        {:else if isPending}
          <UIIcon name="clock" size={12} />
        {/if}
      </span>

      <span class="expand-icon" class:expanded>
        <UIIcon name="chevron-down" size={14} />
      </span>
    </button>
  {/if}

  {#if shouldShowApproval}
    <div class="approval-bar">
      {#if meta?.why}
        <span class="approval-reason">{meta.why}</span>
      {/if}
      <div class="approval-actions">
        <button class="approve-btn" onclick={onApprove} type="button">
          Approve
        </button>
        <button class="deny-btn" onclick={onDeny} type="button">
          <UIIcon name="close" size={12} />
          Deny
        </button>
      </div>
    </div>
  {:else if isPending && isTerminalTool && !isFirstPendingTerminal}
    <!-- Queued terminal command - waiting for previous to complete -->
    <div class="queued-bar">
      <UIIcon name="clock" size={12} />
      <span>Queued - waiting for previous command</span>
    </div>
  {/if}

  {#if expanded}
    <div class="tool-details">
      {#if diagnosticSummary && diagnosticSummary.files.length > 0}
        <div class="diagnostic-details">
          {#each diagnosticSummary.files as file}
            <div class="diag-file-group">
              <button
                class="diag-file-header"
                onclick={() => handleFileClick(file.path)}
                type="button"
              >
                <UIIcon name={getFileIcon(getFileExt(file.path))} size={14} />
                <span class="diag-filename">{file.path}</span>
                <div class="diag-file-badges">
                  {#if file.errorCount > 0}
                    <span class="diag-count-badge error">{file.errorCount}</span
                    >
                  {/if}
                  {#if file.warningCount > 0}
                    <span class="diag-count-badge warning"
                      >{file.warningCount}</span
                    >
                  {/if}
                </div>
              </button>
              <div class="diag-problems">
                {#each file.problems as p}
                  <button
                    class="diag-problem-row"
                    onclick={() => handleProblemClick(p)}
                    type="button"
                  >
                    <span class="diag-problem-severity {p.severity}">
                      <UIIcon
                        name={p.severity === "error" ? "error" : "warning"}
                        size={12}
                      />
                    </span>
                    <span class="diag-problem-loc">L{p.line}:</span>
                    <span class="diag-problem-msg">{p.message}</span>
                    {#if p.code}
                      <span class="diag-problem-code">[{p.code}]</span>
                    {/if}
                  </button>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      {:else}
        {#if meta?.why && !isPending}
          <div class="detail-row">
            <span class="detail-label">Why:</span>
            <span class="detail-value">{meta.why}</span>
          </div>
        {/if}

        {#if meta?.risk}
          <div class="detail-row">
            <span class="detail-label">Risk:</span>
            <span class="detail-value risk-{meta.risk}">{meta.risk}</span>
          </div>
        {/if}

        {#if toolCall.output}
          <div class="detail-section">
            <span class="detail-label">Output:</span>
            <pre class="detail-output">{@html formatOutputWithLinks(
                toolCall.output,
              )}</pre>
          </div>
        {/if}
      {/if}

      {#if toolCall.data?.image_base64}
        <div class="detail-section">
          <span class="detail-label">Screenshot:</span>
          <div class="screenshot-container">
            <img
              src="data:image/png;base64,{toolCall.data.image_base64}"
              alt="Browser screenshot"
              class="screenshot-image"
            />
          </div>
        </div>
      {/if}

      {#if toolCall.error}
        <div class="detail-section error">
          <span class="detail-label">Error:</span>
          <pre class="detail-output">{toolCall.error}</pre>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* Inline tool call - transparent/minimal like Cursor */
  .inline-tool-call {
    margin: 4px 0;
    font-size: 12px;
  }

  /* Terminal tool special styling - keep distinct */
  .inline-tool-call.terminal-tool {
    background: var(--color-surface0);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    overflow: hidden;
  }

  .inline-tool-call.terminal-tool.running {
    border-color: var(--color-accent);
  }

  .inline-tool-call.terminal-tool.completed {
    border-color: var(--color-success);
  }

  .inline-tool-call.terminal-tool.failed {
    border-color: var(--color-error);
  }

  .inline-tool-call.terminal-tool.pending {
    border-color: var(--color-warning);
  }

  .terminal-header {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 8px 10px;
    text-align: left;
    color: var(--color-text);
    background: var(--color-surface0);
    font-family: var(--font-mono, "Fira Code", "Consolas", monospace);
  }

  .terminal-header:hover {
    background: var(--color-hover);
  }

  .terminal-prompt {
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--color-success);
    flex-shrink: 0;
  }

  .prompt-symbol {
    font-weight: 600;
    font-size: 13px;
  }

  .terminal-command {
    flex: 1;
    font-size: 12px;
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .terminal-running-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-accent);
    animation: terminal-pulse 1s ease-in-out infinite;
  }

  @keyframes terminal-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }

  /* Standard tool - transparent header */
  .tool-header {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 0;
    text-align: left;
    color: var(--color-text-secondary);
    font-size: 13.5px;
    transition: color 0.15s ease;
  }

  .tool-header:hover {
    color: var(--color-text);
  }

  .tool-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  /* Category-based icon colors */
  .tool-icon.category-search {
    color: #60a5fa;
  } /* Blue for search */
  .tool-icon.category-file {
    color: #4ade80;
  } /* Green for file read */
  .tool-icon.category-edit {
    color: #fbbf24;
  } /* Amber for edits */
  .tool-icon.category-terminal {
    color: #a78bfa;
  } /* Purple for terminal */
  .tool-icon.category-diagnostic {
    color: #f97316;
  } /* Orange for diagnostics */
  .tool-icon.category-other {
    color: var(--color-text-secondary);
  }

  .tool-icon.spinning :global(svg) {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  .tool-name {
    font-weight: 400;
    color: var(--color-text-secondary);
    white-space: nowrap;
  }

  .files-container {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    flex-wrap: wrap;
  }

  .files-container.multi {
    flex-direction: row;
    align-items: center;
  }

  .diag-mini-summary {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: -4px;
  }

  .diag-badge {
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.2px;
  }

  .diag-badge.error {
    background: rgba(239, 68, 68, 0.15);
    color: #f87171;
  }
  .diag-badge.warning {
    background: rgba(245, 158, 11, 0.15);
    color: #fbbf24;
  }
  .diag-badge.success {
    background: rgba(34, 197, 94, 0.15);
    color: #4ade80;
  }

  /* Diagnostic Details */
  .diagnostic-details {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-top: 4px;
  }

  .diag-file-group {
    display: flex;
    flex-direction: column;
    background: rgba(255, 255, 255, 0.03);
    border-radius: 8px;
    border: 1px solid var(--color-border-subtle);
    overflow: hidden;
  }

  .diag-file-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    background: rgba(255, 255, 255, 0.02);
    border: none;
    border-bottom: 1px solid var(--color-border-subtle);
    width: 100%;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .diag-file-header:hover {
    background: rgba(255, 255, 255, 0.05);
  }

  .diag-filename {
    flex: 1;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--color-text);
    opacity: 0.9;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .diag-file-badges {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .diag-count-badge {
    min-width: 16px;
    height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    font-size: 9px;
    font-weight: 700;
    padding: 0 4px;
  }

  .diag-count-badge.error {
    background: #ef4444;
    color: white;
  }
  .diag-count-badge.warning {
    background: #f59e0b;
    color: black;
  }

  .diag-problems {
    display: flex;
    flex-direction: column;
  }

  .diag-problem-row {
    display: grid;
    grid-template-columns: 20px 35px 1fr auto;
    align-items: flex-start;
    gap: 8px;
    padding: 6px 12px;
    border: none;
    background: none;
    width: 100%;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s ease;
    border-bottom: 1px solid rgba(255, 255, 255, 0.02);
  }

  .diag-problem-row:last-child {
    border-bottom: none;
  }

  .diag-problem-row:hover {
    background: rgba(255, 255, 255, 0.04);
  }

  .diag-problem-severity {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 14px;
    margin-top: 1px;
  }

  .diag-problem-severity.error {
    color: #ef4444;
  }
  .diag-problem-severity.warning {
    color: #f59e0b;
  }

  .diag-problem-loc {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--color-text-disabled);
    margin-top: 2px;
  }

  .diag-problem-msg {
    font-size: 11px;
    color: var(--color-text-secondary);
    line-height: 1.4;
    padding-bottom: 2px;
  }

  .diag-problem-code {
    font-size: 10px;
    color: var(--color-text-disabled);
    opacity: 0.7;
    margin-top: 2px;
  }

  .file-pill {
    display: flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    padding: 2px 0;
    max-width: fit-content;
    min-width: 0;
    position: relative;
    overflow: hidden;
    cursor: pointer;
    border: none;
    text-align: left;
    font-family: inherit;
    transition: opacity 0.2s ease;
  }

  .file-pill:hover {
    opacity: 0.7;
  }

  .file-pill:hover .filename {
    text-decoration: underline;
  }

  .file-pill.is-loading {
    opacity: 0.8;
  }

  :global(.spinner-icon) {
    animation: spin 1s linear infinite;
    color: var(--color-accent);
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  .pill-progress-bar {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 1.5px;
    background: transparent;
  }

  .pill-progress-fill {
    height: 100%;
    background: var(--color-accent);
    transition: width 0.1s ease-out;
    box-shadow: 0 0 4px var(--color-accent);
  }

  .filename {
    font-size: 13px;
    font-weight: 500;
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 180px; /* Prevent long names from pushing everything off */
  }

  .file-count {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-accent);
    background: var(--color-accent-alpha);
    padding: 0 4px;
    border-radius: 4px;
    margin-left: -2px;
  }

  .diff-stats {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    font-weight: 600;
  }

  .stat-added {
    color: #4ade80;
    text-shadow: 0 0 10px rgba(74, 222, 128, 0.2);
  }

  .stat-removed {
    color: #f87171;
    text-shadow: 0 0 10px rgba(248, 113, 113, 0.2);
  }

  .tool-summary {
    color: var(--color-text-secondary);
    opacity: 0.8;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
  }

  .tool-summary.is-line-range {
    font-family: var(--font-mono, monospace);
    color: #60a5fa; /* Blue-ish for line numbers as requested */
    font-size: 11px;
    opacity: 0.7;
  }

  .tool-progress {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
  }

  .progress-text {
    font-size: 10px;
    color: var(--color-accent);
    font-family: monospace;
    white-space: nowrap;
  }

  .progress-bar {
    flex: 1;
    height: 3px;
    background: var(--color-surface1);
    border-radius: 2px;
    overflow: hidden;
    min-width: 40px;
    max-width: 100px;
  }

  .progress-fill {
    height: 100%;
    background: var(--color-accent);
    border-radius: 2px;
    transition: width 0.1s ease-out;
  }

  .streaming-indicator {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-accent);
    animation: pulse-stream 1s ease-in-out infinite;
  }

  @keyframes pulse-stream {
    0%,
    100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.5;
      transform: scale(0.8);
    }
  }

  .tool-status-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  .completed .tool-status-icon {
    color: var(--color-success);
  }

  .failed .tool-status-icon {
    color: var(--color-error);
  }

  .pending .tool-status-icon {
    color: var(--color-warning);
  }

  .expand-icon {
    display: flex;
    align-items: center;
    color: var(--color-text-secondary);
    transition: transform 0.2s ease;
    flex-shrink: 0;
  }

  .expand-icon.expanded {
    transform: rotate(180deg);
  }

  .approval-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
    background: color-mix(in srgb, var(--color-warning) 10%, var(--color-bg));
    border-top: 1px solid var(--color-border);
  }

  .queued-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--color-surface0);
    border-top: 1px solid var(--color-border);
    color: var(--color-text-secondary);
    font-size: 11px;
  }

  .approval-reason {
    color: var(--color-text-secondary);
    font-size: 11px;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .approval-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }

  .approve-btn,
  .deny-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    transition: all 0.15s ease;
  }

  .approve-btn {
    background: var(--color-success);
    color: var(--color-bg);
  }

  .approve-btn:hover {
    filter: brightness(1.1);
  }

  .deny-btn {
    background: var(--color-surface1);
    color: var(--color-text);
  }

  .deny-btn:hover {
    background: var(--color-error);
    color: var(--color-bg);
  }

  .tool-details {
    padding: 8px 12px;
    border-top: 1px solid var(--color-border);
    background: var(--color-bg);
  }

  .detail-row {
    display: flex;
    gap: 8px;
    margin-bottom: 4px;
  }

  .detail-row:last-child {
    margin-bottom: 0;
  }

  .detail-section {
    margin-top: 8px;
  }

  .detail-section.error {
    color: var(--color-error);
  }

  .detail-label {
    font-size: 10px;
    font-weight: 500;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .detail-value {
    font-size: 11px;
    color: var(--color-text);
  }

  .detail-value.risk-low {
    color: var(--color-success);
  }

  .detail-value.risk-medium {
    color: var(--color-warning);
  }

  .detail-value.risk-high {
    color: var(--color-error);
  }

  .detail-output {
    font-size: 11px;
    font-family: monospace;
    color: var(--color-text);
    white-space: pre-wrap;
    word-break: break-all;
    margin: 4px 0 0 0;
    padding: 8px;
    background: var(--color-surface0);
    border-radius: 4px;
    max-height: 200px;
    overflow-y: auto;
  }

  .detail-output :global(.output-link) {
    color: var(--color-accent);
    text-decoration: underline;
    cursor: pointer;
  }

  .detail-output :global(.output-link:hover) {
    color: var(--color-accent);
    text-decoration: underline;
    opacity: 0.8;
  }

  .screenshot-container {
    margin-top: 8px;
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid var(--color-border);
  }

  .screenshot-image {
    display: block;
    max-width: 100%;
    height: auto;
    max-height: 300px;
    object-fit: contain;
    background: var(--color-bg);
  }
</style>
