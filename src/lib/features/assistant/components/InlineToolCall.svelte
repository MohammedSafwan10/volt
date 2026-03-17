<script lang="ts">
  /**
   * InlineToolCall - Displays tool activity inline within assistant messages
   * Shows tool name, status, and expandable output
   */
  import { UIIcon, type UIIconName } from "$shared/components/ui";
  import { onMount } from "svelte";
  import { editorStore } from "$features/editor/stores/editor.svelte";
  import { projectStore } from "$shared/stores/project.svelte";
  import { projectDiagnostics } from "$core/services/project-diagnostics";
  import type {
    ToolCall,
    ToolCallStatus,
  } from "$features/assistant/stores/assistant.svelte";
  import type { Problem } from "$shared/stores/problems.svelte";
  import { isFileMutatingTool, isTerminalTool as isTerminalToolName } from "$core/ai/tools";
  import { RETIRED_TOOL_NAMES } from "$core/ai/tools/definitions";

  interface Props {
    toolCall: ToolCall;
    compact?: boolean;
    showApprovalInline?: boolean;
    onApprove?: () => void;
    onDeny?: () => void;
    isFirstPendingTerminal?: boolean;
  }

  let {
    toolCall,
    compact = false,
    showApprovalInline = true,
    onApprove,
    onDeny,
    isFirstPendingTerminal = true,
  }: Props = $props();

  let expanded = $state(false);
  let screenshotExpanded = $state(false);

  const EXPANDED_KEY_PREFIX = "assistant.tool.expanded:";
  const SCREENSHOT_KEY_PREFIX = "assistant.tool.screenshot.expanded:";

  function getPersistedKey(prefix: string): string {
    return `${prefix}${toolCall.id}:${toolCall.name}`;
  }

  function loadExpandedState(): void {
    try {
      const raw = localStorage.getItem(getPersistedKey(EXPANDED_KEY_PREFIX));
      expanded = raw === "true";
    } catch {
      expanded = false;
    }
  }

  function persistExpandedState(next: boolean): void {
    try {
      localStorage.setItem(getPersistedKey(EXPANDED_KEY_PREFIX), next ? "true" : "false");
    } catch {
      // ignore storage failures
    }
  }

  function loadScreenshotExpandedState(): void {
    try {
      const raw = localStorage.getItem(getPersistedKey(SCREENSHOT_KEY_PREFIX));
      screenshotExpanded = raw === "true";
    } catch {
      screenshotExpanded = false;
    }
  }

  function persistScreenshotExpandedState(next: boolean): void {
    try {
      localStorage.setItem(getPersistedKey(SCREENSHOT_KEY_PREFIX), next ? "true" : "false");
    } catch {
      // ignore storage failures
    }
  }

  function toggleExpanded(event?: Event): void {
    if (event) event.stopPropagation();
    const next = !expanded;
    expanded = next;
    persistExpandedState(next);
  }

  function setExpanded(next: boolean, event?: Event): void {
    if (event) event.stopPropagation();
    expanded = next;
    persistExpandedState(next);
  }

  function toggleScreenshotExpanded(event?: Event): void {
    if (event) event.stopPropagation();
    const next = !screenshotExpanded;
    screenshotExpanded = next;
    persistScreenshotExpandedState(next);
  }

  onMount(() => {
    loadExpandedState();
    loadScreenshotExpandedState();
  });

  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Format output with clickable URLs (global handler in layout opens them in browser)
  function formatOutputWithLinks(text: string): string {
    const escaped = escapeHtml(text);
    return escaped.replace(
      /(https?:\/\/[^\s<>"']+)/gi,
      '<a href="$1" class="output-link" rel="noopener noreferrer nofollow" target="_blank">$1</a>',
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
    workspace_search: "Searched codebase",
    find_files: "Found files",
    list_dir: "Listed directory",
    read_file: "Read file",
    // File operations
    apply_patch: "Applied patch",
    delete_file: "Deleted file",
    rename_path: "Renamed",
    // Terminal - cleaner names
    run_command: "Run command",
    // Diagnostics
    get_diagnostics: "Got diagnostics",
    // Browser
    browser_navigate: "Navigated browser",
    browser_click: "Clicked element",
    browser_type: "Typed text",
    browser_wait_for: "Waited for element",
    browser_scroll: "Scrolled page",
    browser_screenshot: "Captured screenshot",
    browser_get_console_logs: "Got console logs",
    browser_get_errors: "Got browser errors",
    browser_get_network_requests: "Got network requests",
    browser_get_network_request_details: "Got request details",
    browser_get_performance: "Got performance metrics",
    browser_get_selected_element: "Got selected element",
    browser_get_summary: "Got browser summary",
    browser_get_application_storage: "Got application storage",
    browser_get_security_report: "Got security report",
    browser_propose_action: "Proposed actions",
    browser_preview_action: "Previewed action",
    browser_execute_action: "Executed action",
    browser_get_element: "Got element",
    browser_get_elements: "Got elements",
    browser_evaluate: "Evaluated script",
  };

  // Tool icons - using valid UIIconName values
  const toolIcons: Record<string, UIIconName> = {
    // Context & Search
    gather_context: "search",
    workspace_search: "search",
    find_files: "search",
    list_dir: "folder",
    read_file: "file",
    // File operations
    apply_patch: "pencil",
    delete_file: "trash",
    rename_path: "pencil",
    // Terminal
    run_command: "terminal",
    // Diagnostics
    get_diagnostics: "warning",
    // Browser
    browser_navigate: "globe",
    browser_click: "target",
    browser_type: "pencil",
    browser_wait_for: "clock",
    browser_scroll: "arrow-right",
    browser_screenshot: "screenshot",
    browser_get_console_logs: "console",
    browser_get_errors: "error",
    browser_get_network_requests: "link",
    browser_get_network_request_details: "link",
    browser_get_performance: "bolt",
    browser_get_selected_element: "target",
    browser_get_summary: "globe",
    browser_get_application_storage: "files",
    browser_get_security_report: "warning",
    browser_propose_action: "sparkle",
    browser_preview_action: "info",
    browser_execute_action: "play",
    browser_get_element: "target",
    browser_get_elements: "target",
    browser_evaluate: "code",
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
    | "browser"
    | "other";

  const toolCategories: Record<string, ToolCategory> = {
    // Search/Read
    gather_context: "search",
    workspace_search: "search",
    find_files: "search",
    list_dir: "search",
    read_file: "file",
    // Write/Edit
    apply_patch: "edit",
    delete_file: "edit",
    rename_path: "edit",
    // Terminal
    run_command: "terminal",
    // Diagnostics
    get_diagnostics: "diagnostic",
    // Browser
    browser_navigate: "browser",
    browser_click: "browser",
    browser_type: "browser",
    browser_wait_for: "browser",
    browser_scroll: "browser",
    browser_screenshot: "browser",
    browser_get_console_logs: "browser",
    browser_get_errors: "browser",
    browser_get_network_requests: "browser",
    browser_get_network_request_details: "browser",
    browser_get_performance: "browser",
    browser_get_selected_element: "browser",
    browser_get_summary: "browser",
    browser_get_application_storage: "browser",
    browser_get_security_report: "browser",
    browser_propose_action: "browser",
    browser_preview_action: "browser",
    browser_execute_action: "browser",
    browser_get_element: "browser",
    browser_get_elements: "browser",
    browser_evaluate: "browser",
  };

  function canonicalToolName(name: string): string {
    if (name === "apply_edit") return "apply_patch";
    if (name === "delete_path") return "delete_file";
    return name;
  }

  function isLegacyAliasName(name: string): boolean {
    return name === "apply_edit" || name === "delete_path";
  }

  function getToolCategory(): ToolCategory {
    return toolCategories[canonicalToolName(toolCall.name)] ?? "other";
  }

  // Get display name for tool
  function getToolDisplayName(): string {
    const canonical = canonicalToolName(toolCall.name);
    const label = toolDisplayNames[canonical] ?? canonical;
    if (isLegacyAliasName(toolCall.name) || RETIRED_TOOL_NAMES.has(canonical)) {
      return `${label} (legacy)`;
    }
    return label;
  }

  // Get icon for tool
  function getToolIcon(): UIIconName {
    return toolIcons[canonicalToolName(toolCall.name)] ?? "code";
  }

  // Get summary of what the tool is doing
  function getToolSummary(): string {
    const toolName = canonicalToolName(toolCall.name);
    const args = toolCall.arguments;
    const resultMeta = toolCall.meta as Record<string, unknown> | undefined;

    switch (toolName) {
      case "list_dir":
        return args.path ? String(args.path) : ".";
      case "read_file": {
        // No filename here - it will be in the pill
        const offset =
          typeof args.offset === "number"
            ? Number(args.offset)
            : resultMeta?.startLine
              ? Number(resultMeta.startLine) - 1
              : null;
        const limit =
          typeof args.limit === "number"
            ? Number(args.limit)
            : resultMeta?.endLine && resultMeta?.startLine
              ? Number(resultMeta.endLine) - Number(resultMeta.startLine) + 1
              : null;
        if (resultMeta?.startLine && resultMeta?.endLine) {
          return `#L${Number(resultMeta.startLine)}-${Number(resultMeta.endLine)}`;
        }
        if (offset !== null && limit !== null) {
          const start = offset + 1;
          const end = Math.max(start, start + limit - 1);
          return `#L${start}-${end}`;
        } else if (offset !== null) {
          return `#L${offset + 1}+`;
        } else if (limit !== null) {
          return `#L1-${limit}`;
        }

        // Ghost snippet: first 30 chars of output if available
        if (toolCall.output && toolCall.output.length > 5) {
          return `"${toolCall.output.trim().slice(0, 30).replace(/\n/g, " ")}..."`;
        }
        return "";
      }
      case "workspace_search": {
        const query = args.query ? String(args.query) : "";
        const pattern = args.includePattern
          ? ` in ${String(args.includePattern)}`
          : "";
        return query ? `"${query}"${pattern}` : "";
      }
      case "find_files": {
        const query = args.query ? String(args.query) : "";
        return query ? `"${query}"` : "";
      }
      case "delete_file":
      case "apply_patch":
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
      case "get_diagnostics": {
        const paths = args.paths as string[] | undefined;
        if (!paths || paths.length === 0) return "all files";
        return `${paths.length} files`;
      }
      case "browser_navigate": {
        const url = args.url ? String(args.url) : "";
        if (!url) return "";
        try {
          return new URL(url).hostname;
        } catch {
          return url.slice(0, 36);
        }
      }
      case "browser_click":
      case "browser_wait_for":
      case "browser_get_element":
      case "browser_get_elements":
        return args.selector ? String(args.selector).slice(0, 40) : "";
      case "browser_type": {
        const selector = args.selector ? String(args.selector).slice(0, 24) : "focused";
        const text = args.text ? String(args.text) : "";
        return `${selector} · ${text.length} chars`;
      }
      case "browser_scroll":
        return args.selector
          ? String(args.selector).slice(0, 30)
          : `${Number(args.x || 0)}, ${Number(args.y || 0)} px`;
      case "browser_screenshot":
        return args.selector
          ? `element: ${String(args.selector).slice(0, 24)}`
          : args.full_page
            ? "full page"
            : "viewport";
      case "browser_get_console_logs":
        return args.level ? `level: ${String(args.level)}` : "latest logs";
      case "browser_get_errors":
        return "javascript errors";
      case "browser_get_network_requests":
        return args.failed_only ? "failed requests" : "recent requests";
      case "browser_get_network_request_details":
        return args.request_id ? `id: ${String(args.request_id).slice(0, 16)}` : "request details";
      case "browser_get_performance":
        return "page metrics";
      case "browser_get_selected_element":
        return "devtools selection";
      case "browser_get_summary":
        return "runtime snapshot";
      case "browser_get_application_storage":
        return "storage/cookies/indexeddb";
      case "browser_get_security_report":
        return "security diagnostics";
      case "browser_propose_action":
        return args.intent ? String(args.intent).slice(0, 40) : "guided actions";
      case "browser_preview_action":
        return args.action_id ? String(args.action_id).slice(0, 24) : "action preview";
      case "browser_execute_action":
        return args.action_id ? String(args.action_id).slice(0, 24) : "action execute";
      case "browser_evaluate":
        return args.expression
          ? String(args.expression).replace(/\s+/g, " ").slice(0, 36)
          : "";
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
  const searchTelemetry = $derived.by(() => {
    const toolName = canonicalToolName(toolCall.name);
    if (toolName !== "workspace_search" && toolName !== "find_files") return null;
    const meta = (toolCall.meta as Record<string, unknown> | undefined) ?? {};
    const telemetry = meta.searchTelemetry as
      | {
          engine?: string;
          rgSource?: string;
          fallbackUsed?: boolean;
          fallbackReason?: string | null;
          elapsedMs?: number;
        }
      | undefined;
    if (!telemetry) return null;
    return {
      engine: telemetry.engine ?? "unknown",
      rgSource: telemetry.rgSource ?? "none",
      fallbackUsed: Boolean(telemetry.fallbackUsed),
      fallbackReason: telemetry.fallbackReason ?? null,
      elapsedMs: telemetry.elapsedMs ?? 0,
    };
  });
  const searchEngineBadge = $derived.by(() => {
    if (!searchTelemetry) return null;
    if (searchTelemetry.engine === "rg" && !searchTelemetry.fallbackUsed) {
      return searchTelemetry.rgSource === "bundled" ? "rg-bundled" : "rg";
    }
    if (searchTelemetry.engine === "rg" && searchTelemetry.fallbackUsed) {
      return "retried";
    }
    if (searchTelemetry.engine === "legacy") {
      return "legacy";
    }
    return "search";
  });
  const searchEngineTitle = $derived.by(() => {
    if (!searchTelemetry) return "";
    if (searchTelemetry.engine === "rg" && !searchTelemetry.fallbackUsed) {
      return `Search used ripgrep${searchTelemetry.rgSource ? ` (${searchTelemetry.rgSource})` : ""} in ${searchTelemetry.elapsedMs}ms`;
    }
    if (searchTelemetry.engine === "rg" && searchTelemetry.fallbackUsed) {
      const reason = searchTelemetry.fallbackReason ?? "retried";
      return `Search used ripgrep after one safe retry in ${searchTelemetry.elapsedMs}ms (${reason})`;
    }
    if (searchTelemetry.engine === "legacy") {
      const reason = searchTelemetry.fallbackReason ?? "backend degraded mode";
      return `Search used backend legacy mode in ${searchTelemetry.elapsedMs}ms (${reason})`;
    }
    const reason = searchTelemetry.fallbackReason ?? "backend unavailable";
    return `Search backend was unavailable (${reason})`;
  });
  const isRunning = $derived(toolCall.status === "running");
  const isPending = $derived(
    toolCall.status === "pending" && toolCall.requiresApproval,
  );
  const isApprovedPending = $derived(
    toolCall.status === "pending" && toolCall.reviewStatus === "accepted",
  );
  const isComplete = $derived(toolCall.status === "completed");
  const isFailed = $derived(toolCall.status === "failed");
  const reuseMeta = $derived(toolCall.meta as Record<string, unknown> | undefined);
  const reusedTerminal = $derived(Boolean(reuseMeta?.reused));

  // Check if this is a terminal command tool
  const isTerminalTool = $derived(
    isTerminalToolName(toolCall.name),
  );
  const isBrowserTool = $derived(toolCall.name.startsWith("browser_"));
  const shouldShowApproval = $derived(
    showApprovalInline &&
    isPending &&
    !isApprovedPending &&
    Boolean(onApprove) &&
    Boolean(onDeny) &&
    (!isTerminalTool || isFirstPendingTerminal),
  );

  // Get the command for terminal tools
  const terminalCommand = $derived(
    isTerminalTool ? String(toolCall.arguments.command || "") : "",
  );

  // Check if this is a file write tool that supports streaming
  const isFileWriteTool = $derived(
    isFileMutatingTool(toolCall.name),
  );
  const isStreaming = $derived(false);

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

  const primaryFiles = $derived(files.slice(0, 1));
  const remainingFileCount = $derived(Math.max(0, files.length - primaryFiles.length));

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

  function getDisplayOutput(rawOutput: string): string {
    if (!isBrowserTool) return rawOutput;

    if (toolCall.name === "browser_screenshot") {
      try {
        const parsed = JSON.parse(rawOutput) as Record<string, unknown>;
        if ("image_base64" in parsed) {
          parsed.image_base64 = "[omitted]";
        }
        return JSON.stringify(parsed, null, 2);
      } catch {
        return rawOutput.replace(/"image_base64"\s*:\s*"[^"]+"/g, '"image_base64":"[omitted]"');
      }
    }

    return rawOutput.length > 4000
      ? `${rawOutput.slice(0, 4000)}\n... [truncated ${rawOutput.length - 4000} chars]`
      : rawOutput;
  }
</script>

<div
  class="inline-tool-call {toolCall.status} category-{getToolCategory()}"
  class:compact
  class:terminal-tool={isTerminalTool}
  role="article"
  aria-label="Tool: {getToolDisplayName()}"
>
  {#if isTerminalTool}
    <!-- Special terminal-style display - Next Level UI -->
    <div class="terminal-tool-container" class:expanded>
      <button
        class="terminal-header"
        onclick={toggleExpanded}
        aria-expanded={expanded}
        type="button"
      >
        <div class="terminal-badge icon-only">
          <UIIcon name="terminal" size={14} />
        </div>

        <div class="terminal-command-preview">
          <span class="prompt-char">$</span>
          <span class="command-text" class:loading-text={isRunning}
            >{terminalCommand || "command"}</span
          >
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
            <span
              class="status-pill pending"
              title={isApprovedPending ? "Queued" : "Approval Needed"}
            >
              <UIIcon name="clock" size={12} />
              <span class="status-text"
                >{isApprovedPending ? "Queued" : "Pending"}</span
              >
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
      onclick={toggleExpanded}
      aria-expanded={expanded}
      type="button"
    >
      <div class="tool-main-info">
        {#if files.length === 0}
          <span
            class="tool-icon category-{getToolCategory()}"
            class:running-shimmer={isRunning}
          >
            {#if isRunning}
              <UIIcon name="sparkle" size={12} class="shimmer-icon" />
            {:else}
              <UIIcon name={getToolIcon()} size={12} />
            {/if}
          </span>
        {/if}
        <span class="tool-name" class:loading-text={isRunning}
          >{getToolDisplayName()}</span
        >
        {#if isBrowserTool}
          <span class="tool-kind-badge">Browser</span>
        {/if}
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
            {#each primaryFiles as file}
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
                <div class="file-pill" class:is-loading={isRunning}>
                  {#if isRunning && !isStreaming}
                    <UIIcon name="sparkle" size={12} class="shimmer-icon" />
                  {:else}
                    <UIIcon name={file.icon} size={12} />
                  {/if}
                  <span class="filename" class:loading-text={isRunning}
                    >{file.filename}</span
                  >
                </div>
              </div>
            {/each}
            {#if remainingFileCount > 0}
              <span
                class="more-files-pill"
                role="button"
                tabindex="0"
                onclick={(e) => {
                  setExpanded(true, e);
                }}
                onkeydown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    setExpanded(true, e);
                  }
                }}
              >
                +{remainingFileCount} more
              </span>
            {/if}
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
        {#if searchEngineBadge}
          <span
            class="tool-engine-badge"
            class:warning={searchTelemetry?.fallbackUsed}
            title={searchEngineTitle}
          >
            {searchEngineBadge}
          </span>
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
  {:else if (isApprovedPending || (isPending && isTerminalTool && !isFirstPendingTerminal))}
    <div class="queued-bar">
      <UIIcon name="clock" size={12} />
      <span
        >{isApprovedPending
          ? "Approved - waiting to run"
          : "Queued - waiting for previous command"}</span
      >
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
        {#if files.length > 1}
          <div class="detail-section">
            <span class="detail-label">Files:</span>
            <div class="detail-file-list">
              {#each files as file}
                <button
                  class="detail-file-item"
                  type="button"
                  onclick={() => handleFileClick(file.path)}
                >
                  <UIIcon name={file.icon} size={12} />
                  <span class="detail-file-name">{file.filename}</span>
                  <span class="detail-file-path">{file.path}</span>
                </button>
              {/each}
            </div>
          </div>
        {/if}

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
                getDisplayOutput(toolCall.output),
              )}</pre>
          </div>
        {:else if isRunning}
          <div class="detail-section">
            <span class="detail-label">Output:</span>
            <div class="detail-skeleton" aria-hidden="true">
              <span class="skeleton-line short"></span>
              <span class="skeleton-line medium"></span>
              <span class="skeleton-line long"></span>
            </div>
          </div>
        {/if}
      {/if}

      {#if toolCall.data?.image_base64}
        <div class="detail-section">
          <button
            class="screenshot-header"
            type="button"
            onclick={toggleScreenshotExpanded}
            aria-expanded={screenshotExpanded}
          >
            <span class="detail-label">Screenshot:</span>
            <span class="screenshot-toggle">
              <UIIcon
                name={screenshotExpanded ? "chevron-down" : "chevron-right"}
                size={12}
              />
              <span>{screenshotExpanded ? "Hide" : "Show"}</span>
            </span>
          </button>
          {#if screenshotExpanded}
            <div class="screenshot-container">
              <img
                src="data:image/png;base64,{toolCall.data.image_base64}"
                alt="Browser screenshot"
                class="screenshot-image"
              />
            </div>
          {/if}
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
  .screenshot-header {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: var(--color-text-secondary);
    background: transparent;
    padding: 0;
  }

  .screenshot-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
  }

  .screenshot-header:hover {
    color: var(--color-text);
  }

  .screenshot-header:hover .screenshot-toggle {
    color: var(--color-accent);
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
  /* Inline tool call - transparent/minimal like Cursor */
  .inline-tool-call {
    margin: 4px 0;
    font-size: 12px;
  }

  .inline-tool-call.compact {
    margin: 2px 0;
    font-size: 11px;
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

  .inline-tool-call.compact .terminal-header {
    gap: 10px;
    padding: 8px 12px;
    font-size: 12px;
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

  .inline-tool-call.compact .tool-header {
    gap: 6px;
    padding: 4px 0;
    font-size: 12px;
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
  .tool-icon.category-browser {
    color: #7dd3fc;
    border-color: color-mix(in srgb, #7dd3fc 35%, var(--color-border));
    background: color-mix(in srgb, #0ea5e9 10%, var(--color-bg-input));
  }

  .tool-icon.running-shimmer {
    border-color: color-mix(in srgb, var(--color-accent) 35%, var(--color-border));
    background: color-mix(in srgb, var(--color-accent) 12%, var(--color-bg-input));
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

  .inline-tool-call.compact .tool-name {
    font-size: 11px;
  }

  .tool-kind-badge {
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
    color: #7dd3fc;
    border: 1px solid color-mix(in srgb, #7dd3fc 35%, var(--color-border));
    border-radius: 999px;
    padding: 2px 6px;
    background: color-mix(in srgb, #0ea5e9 10%, transparent);
  }

  .loading-text {
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--color-text-secondary) 45%, transparent) 0%,
      color-mix(in srgb, var(--color-text) 85%, transparent) 50%,
      color-mix(in srgb, var(--color-text-secondary) 45%, transparent) 100%
    );
    background-size: 220% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: tool-text-shimmer 1.5s linear infinite;
  }

  .header-right-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    justify-content: flex-start;
  }

  .inline-tool-call.compact .header-right-meta {
    gap: 4px;
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

  .more-files-pill {
    height: 24px;
    display: inline-flex;
    align-items: center;
    padding: 0 8px;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    background: var(--color-bg-input);
    color: var(--color-text-secondary);
    font-size: 10px;
    font-weight: 600;
    white-space: nowrap;
    transition: all 0.12s ease;
  }

  .more-files-pill:hover {
    color: var(--color-text);
    border-color: var(--color-active);
    background: var(--color-hover);
  }

  .file-pill {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    color: var(--color-text-secondary);
  }

  .shimmer-icon {
    color: var(--color-accent);
    animation: tool-text-shimmer 1.4s linear infinite;
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

  .inline-tool-call.compact .tool-summary {
    max-width: 150px;
    font-size: 10px;
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

  .tool-engine-badge {
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border);
    border-radius: 999px;
    padding: 2px 6px;
    background: var(--color-bg-input);
    white-space: nowrap;
  }

  .tool-engine-badge.warning {
    color: var(--color-warning);
    border-color: var(--color-warning);
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

  .detail-file-list {
    margin-top: 4px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 180px;
    overflow-y: auto;
  }

  .detail-file-item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border-radius: 4px;
    background: var(--color-surface0);
    border: 1px solid var(--color-border);
    color: var(--color-text-secondary);
    font-size: 11px;
    text-align: left;
  }

  .detail-file-item:hover {
    background: var(--color-hover);
    border-color: var(--color-active);
    color: var(--color-text);
  }

  .detail-file-name {
    font-weight: 600;
    flex-shrink: 0;
  }

  .detail-file-path {
    opacity: 0.7;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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

  .detail-skeleton {
    margin-top: 4px;
    padding: 8px;
    background: var(--color-surface0);
    border-radius: 4px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .skeleton-line {
    height: 10px;
    border-radius: 4px;
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--color-surface1) 75%, transparent) 0%,
      color-mix(in srgb, var(--color-text-secondary) 20%, transparent) 50%,
      color-mix(in srgb, var(--color-surface1) 75%, transparent) 100%
    );
    background-size: 220% 100%;
    animation: tool-text-shimmer 1.4s linear infinite;
  }

  .skeleton-line.short {
    width: 38%;
  }

  .skeleton-line.medium {
    width: 63%;
  }

  .skeleton-line.long {
    width: 84%;
  }

  @keyframes tool-text-shimmer {
    0% {
      background-position: 200% 0;
    }
    100% {
      background-position: -20% 0;
    }
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
