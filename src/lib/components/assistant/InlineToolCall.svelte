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
  import { projectDiagnostics } from "$lib/services/project-diagnostics";
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

  async function handleRefreshDiagnostics(): Promise<void> {
    if (!projectStore.rootPath) return;
    await projectDiagnostics.runDiagnostics(projectStore.rootPath);
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

        // Ghost snippet: first 30 chars of output if available
        if (toolCall.output && toolCall.output.length > 5) {
          return `"${toolCall.output.trim().slice(0, 30).replace(/\n/g, " ")}..."`;
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
  const reuseMeta = $derived(toolCall.meta as Record<string, unknown> | undefined);
  const reusedTerminal = $derived(Boolean(reuseMeta?.reused));

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
    if (!toolCall.meta) return null;
    const meta = toolCall.meta as any;
    const diagnosticsMeta =
      toolCall.name === "get_diagnostics" ? meta : meta.diagnostics;
    if (!diagnosticsMeta) return null;
    const items = (diagnosticsMeta.problems || []) as (Problem & {
      relativePath: string;
    })[];

    // Group by file
    const byFile = new Map<string, typeof items>();
    for (const p of items) {
      if (!byFile.has(p.relativePath)) byFile.set(p.relativePath, []);
      byFile.get(p.relativePath)!.push(p);
    }

    return {
      errorCount: diagnosticsMeta.errorCount || 0,
      warningCount: diagnosticsMeta.warningCount || 0,
      fileCount: diagnosticsMeta.fileCount || 0,
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
    <!-- Special terminal-style display - Next Level UI -->
    <div class="terminal-tool-container" class:expanded>
      <button
        class="terminal-header"
        onclick={() => (expanded = !expanded)}
        aria-expanded={expanded}
        type="button"
      >
        <div class="terminal-badge icon-only">
          <UIIcon name="terminal" size={14} />
        </div>

        <div class="terminal-command-preview">
          <span class="prompt-char">$</span>
          <span class="command-text">{terminalCommand || "command"}</span>
        </div>

        <div class="terminal-meta">
          {#if isRunning}
            <span class="status-pill running" title="Running">
              <span class="pulse-dot"></span>
              <span class="status-text">Running</span>
            </span>
          {:else if isComplete}
            <span class="status-pill success" title="Completed">
              <UIIcon name="check" size={12} />
              <span class="status-text">Done</span>
            </span>
          {:else if isFailed}
            <span class="status-pill error" title="Failed">
              <UIIcon name="error" size={12} />
              <span class="status-text">Failed</span>
            </span>
          {:else if isPending}
            <span class="status-pill pending" title="Approval Needed">
              <UIIcon name="clock" size={12} />
              <span class="status-text">Pending</span>
            </span>
          {/if}
          {#if reusedTerminal}
            <span class="status-pill reused" title="Reused running terminal">
              <UIIcon name="refresh" size={12} />
              <span class="status-text">Reused</span>
            </span>
          {/if}
          <span class="expand-caret" class:rotated={expanded}>
            <UIIcon name="chevron-down" size={14} />
          </span>
        </div>
      </button>
    </div>
  {:else}
    <!-- Standard tool display -->
    <button
      class="tool-header"
      onclick={() => (expanded = !expanded)}
      aria-expanded={expanded}
      type="button"
    >
      <div class="tool-main-info">
        {#if files.length === 0}
          <span
            class="tool-icon category-{getToolCategory()}"
            class:spinning={isRunning}
          >
            {#if isRunning}
              <UIIcon name="spinner" size={12} class="animate-spin" />
            {:else}
              <UIIcon name={getToolIcon()} size={12} />
            {/if}
          </span>
        {/if}
        <span class="tool-name">{getToolDisplayName()}</span>
      </div>

      <div class="header-right-meta">
        {#if diagnosticSummary}
          <div class="diag-mini-summary">
            {#if diagnosticSummary.errorCount > 0}
              <span class="diag-badge error"
                >{diagnosticSummary.errorCount}</span
              >
            {/if}
            {#if diagnosticSummary.warningCount > 0}
              <span class="diag-badge warning"
                >{diagnosticSummary.warningCount}</span
              >
            {/if}
            {#if diagnosticSummary.errorCount === 0 && diagnosticSummary.warningCount === 0}
              <span class="diag-badge success">Clean</span>
            {/if}
          </div>
        {:else if files.length > 0}
          <div class="files-container" class:multi={files.length > 1}>
            {#each files as file}
              {@const parts = file.path.split(/[/\\]/)}
              {@const dir =
                parts.length > 1 ? parts.slice(0, -1).join("/") : null}
              <div
                class="file-pill-group"
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
              >
                {#if dir}
                  <span class="path-pill">{dir}/</span>
                {/if}
                <div class="file-pill" class:is-loading={isRunning}>
                  {#if isRunning && !isStreaming}
                    <UIIcon name="spinner" size={12} class="spinner-icon" />
                  {:else}
                    <UIIcon name={file.icon} size={12} />
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
              </div>
            {/each}
          </div>
        {/if}

        {#if diffStats && (isComplete || isStreaming)}
          <div class="diff-ledger">
            {#if diffStats.added > 0}
              <span class="stat-added">+{diffStats.added}</span>
            {/if}
            {#if diffStats.removed > 0}
              <span class="stat-removed">-{diffStats.removed}</span>
            {/if}
          </div>
        {/if}

        {#if summary && !isStreaming}
          {@const isLineRange = summary.includes("#L")}
          {@const isSnippet = summary.startsWith('"')}
          {@const isRedundantPath =
            files.length > 0 && !isLineRange && !isSnippet}
          {#if !isRedundantPath}
            <span
              class="tool-summary"
              class:is-line-range={isLineRange}
              class:is-snippet={isSnippet}
            >
              {isLineRange ? "#" + summary.split("#")[1] : summary}
            </span>
          {/if}
        {/if}
      </div>

      <span class="tool-status-icon">
        {#if isStreaming}
          <span class="streaming-indicator"></span>
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

        {#if reusedTerminal}
          <div class="detail-row">
            <span class="detail-label">Status:</span>
            <span class="detail-value">Reused existing running terminal</span>
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

  /* Terminal Tool Next Level UI */
  .terminal-tool-container {
    margin: 4px 0;
    border-radius: 8px;
    background: #1e1e1e; /* Specific heavy terminal background */
    border: 1px solid var(--color-border);
    overflow: hidden;
    transition: all 0.2s ease;
  }

  .terminal-tool-container:hover {
    border-color: var(--color-border-hover, #3c3c3c);
  }

  .terminal-header {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 10px 14px;
    background: transparent;
    color: #cccccc;
    font-family: var(--font-mono, monospace);
    font-size: 13px;
    cursor: pointer;
    text-align: left;
  }

  .terminal-badge {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.08); /* Slightly darker/subtle */
    color: #a0a0a0;
  }

  .terminal-command-preview {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    overflow: hidden;
    color: #e0e0e0;
  }

  .prompt-char {
    color: #4ade80; /* Terminal green */
    font-weight: bold;
    user-select: none;
  }

  .command-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.9;
  }

  .terminal-meta {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .status-pill {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 500;
  }

  .status-text {
    font-size: 11px;
    line-height: 1;
  }

  .status-pill.running {
    background: rgba(59, 130, 246, 0.15);
    color: #60a5fa;
  }

  .status-pill.success {
    background: rgba(74, 222, 128, 0.15);
    color: #4ade80;
  }

  .status-pill.error {
    background: rgba(248, 113, 113, 0.15);
    color: #f87171;
  }

  .status-pill.pending {
    background: rgba(251, 191, 36, 0.15);
    color: #fbbf24;
  }

  .status-pill.reused {
    background: rgba(96, 165, 250, 0.15);
    color: #60a5fa;
  }

  .pulse-dot {
    width: 6px;
    height: 6px;
    background: currentColor;
    border-radius: 50%;
    animation: pulse 1.5s infinite;
  }

  .expand-caret {
    color: #808080;
    transition: transform 0.2s ease;
  }

  .expand-caret.rotated {
    transform: rotate(180deg);
  }

  /* Standard tool - transparent header */
  .tool-header {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 0;
    text-align: left;
    color: var(--color-text-secondary);
    font-size: 13px;
    transition: all 0.2s ease;
    border-radius: 6px;
  }

  .tool-main-info {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .tool-header:hover {
    color: var(--color-text);
  }

  /* Muted grey for all tool icons as requested */
  .tool-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    border-radius: 4px;
    background: var(--color-bg-input);
    border: 1px solid var(--color-border);
    color: var(--color-text-secondary);
  }

  .tool-icon.category-search,
  .tool-icon.category-file,
  .tool-icon.category-edit,
  .tool-icon.category-terminal,
  .tool-icon.category-diagnostic {
    color: var(--color-text-secondary);
    border-color: var(--color-border);
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
    font-weight: 500;
    color: var(--color-text-secondary);
    white-space: nowrap;
    font-size: 12px;
  }

  .header-right-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    justify-content: flex-start;
  }

  .inline-tool-call.running .tool-header {
    position: relative;
    overflow: hidden;
  }

  .inline-tool-call.running .tool-header::after {
    content: "";
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(
      90deg,
      transparent,
      rgba(255, 255, 255, 0.05),
      transparent
    );
    animation: header-shimmer 2s infinite linear;
    pointer-events: none;
  }

  @keyframes header-shimmer {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(100%);
    }
  }

  .files-container {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }

  .file-pill-group {
    display: flex;
    align-items: center;
    background: var(--color-bg-input);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    padding: 2px 6px;
    gap: 0;
    cursor: pointer;
    transition: all 0.1s ease;
    max-width: 280px;
    overflow: hidden;
  }

  .file-pill-group:hover {
    background: var(--color-hover);
    border-color: var(--color-active);
  }

  .path-pill {
    color: var(--color-text-secondary);
    opacity: 0.6;
    font-size: 11px;
    white-space: nowrap;
    padding-right: 4px;
  }

  .file-pill {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    color: var(--color-text-secondary);
  }

  .filename {
    font-size: 11px;
    font-weight: 500;
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.9;
  }

  .file-pill-group:hover .filename {
    color: var(--color-text);
    opacity: 1;
  }

  .diag-mini-summary {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .diag-badge {
    height: 18px;
    display: inline-flex;
    align-items: center;
    padding: 0 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 700;
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

  .diff-ledger {
    display: flex;
    align-items: center;
    gap: 4px;
    font-family: var(--font-mono, monospace);
    font-size: 10px;
    font-weight: 600;
    background: var(--color-bg-input);
    border: 1px solid var(--color-border);
    border-radius: 4px;
    padding: 2px 6px;
  }

  .stat-added {
    color: #4ade80;
  }

  .stat-removed {
    color: #f87171;
  }

  .tool-summary {
    color: var(--color-text-secondary);
    opacity: 0.6;
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 200px;
  }

  .tool-summary.is-line-range {
    color: #60a5fa;
    background: rgba(96, 165, 250, 0.08);
    padding: 0 4px;
    border-radius: 3px;
  }

  .tool-summary.is-snippet {
    font-style: italic;
    font-family: var(--font-mono, monospace);
    font-size: 10px;
    color: var(--color-text-secondary);
    opacity: 0.4;
    border-left: 1px solid rgba(255, 255, 255, 0.1);
    padding-left: 6px;
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
    background: rgba(var(--color-bg-rgb), 0.3);
    animation: slide-down 0.2s ease-out;
    overflow: hidden;
    backdrop-filter: blur(5px);
  }

  @keyframes slide-down {
    from {
      opacity: 0;
      transform: translateY(-4px);
      max-height: 0;
    }
    to {
      opacity: 1;
      transform: translateY(0);
      max-height: 1000px;
    }
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
