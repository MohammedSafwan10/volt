<script lang="ts">
  /**
   * InlineToolCall - Displays tool activity inline within assistant messages
   * Shows tool name, status, and expandable output
   */
  import { UIIcon, type UIIconName } from "$shared/components/ui";
  import { onMount } from "svelte";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { editorStore } from "$features/editor/stores/editor.svelte";
  import { projectStore } from "$shared/stores/project.svelte";
  import type {
    ToolCall,
  } from "$features/assistant/stores/assistant.svelte";
  import type { Problem } from "$shared/stores/problems.svelte";
  import { isTerminalTool as isTerminalToolName } from "$core/ai/tools";
  import { RETIRED_TOOL_NAMES } from "$core/ai/tools/definitions";

  type ProblemWithRelativePath = Problem & { relativePath: string };

  interface DiagnosticsMeta {
    problems?: ProblemWithRelativePath[];
    errorCount?: number;
    warningCount?: number;
    fileCount?: number;
  }

  interface FileEditMeta {
    added?: number;
    removed?: number;
  }

  interface TerminalRunMeta {
    state?: string;
    commandPreview?: string;
    excerpt?: string;
    detectedUrl?: string;
    processId?: number;
  }

  interface OutputSegment {
    key: string;
    type: "text" | "link";
    value: string;
  }

  interface InlineToolMeta extends Record<string, unknown> {
    diagnostics?: DiagnosticsMeta;
    fileEdit?: FileEditMeta;
    reused?: boolean;
    terminalRun?: TerminalRunMeta;
  }

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

  function getOutputSegments(text: string): OutputSegment[] {
    const segments: OutputSegment[] = [];
    const urlPattern = /(https?:\/\/[^\s<>"']+)/gi;
    let lastIndex = 0;

    for (const match of text.matchAll(urlPattern)) {
      const url = match[0];
      const index = match.index ?? 0;

      if (index > lastIndex) {
        segments.push({
          key: `text-${lastIndex}`,
          type: "text",
          value: text.slice(lastIndex, index),
        });
      }

      segments.push({
        key: `link-${index}`,
        type: "link",
        value: url,
      });

      lastIndex = index + url.length;
    }

    if (lastIndex < text.length) {
      segments.push({
        key: `text-${lastIndex}`,
        type: "text",
        value: text.slice(lastIndex),
      });
    }

    return segments;
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

  async function handleOutputLinkClick(url: string, event?: Event): Promise<void> {
    event?.stopPropagation();
    await openUrl(url);
  }

  // Tool display names (more user-friendly)
  const toolDisplayNames: Record<string, string> = {
    // Context & Search
    gather_context: "Gathering context",
    workspace_search: "Searched codebase",
    find_files: "Found files",
    list_dir: "Listed directory",
    read_file: "Read file",
    get_spec_state: "Checked spec state",
    stage_spec_requirements: "Staged requirements",
    // File operations
    apply_patch: "Applied patch",
    create_dir: "Created folder",
    delete_file: "Deleted file",
    rename_path: "Renamed",
    write_spec_phase: "Updated spec file",
    // Terminal - cleaner names
    run_command: "Run command",
    // Diagnostics
    get_diagnostics: "Got diagnostics",
  };

  // Tool icons - using valid UIIconName values
  const toolIcons: Record<string, UIIconName> = {
    // Context & Search
    gather_context: "search",
    workspace_search: "search",
    find_files: "search",
    list_dir: "folder",
    read_file: "file",
    get_spec_state: "file-search",
    stage_spec_requirements: "file-plus",
    // File operations
    apply_patch: "pencil",
    create_dir: "folder",
    delete_file: "trash",
    rename_path: "pencil",
    write_spec_phase: "file",
    // Terminal
    run_command: "terminal",
    // Diagnostics
    get_diagnostics: "warning",
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
    find_files: "search",
    list_dir: "search",
    read_file: "file",
    get_spec_state: "file",
    stage_spec_requirements: "edit",
    // Write/Edit
    apply_patch: "edit",
    create_dir: "edit",
    delete_file: "edit",
    rename_path: "edit",
    write_spec_phase: "edit",
    // Terminal
    run_command: "terminal",
    // Diagnostics
    get_diagnostics: "diagnostic",
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
      case "get_spec_state":
        return "active spec";
      case "stage_spec_requirements":
        return args.title ? String(args.title) : "";
      case "write_spec_phase":
        return args.phase ? String(args.phase) : "";
      case "find_files": {
        const query = args.query ? String(args.query) : "";
        return query ? `"${query}"` : "";
      }
      case "delete_file":
      case "apply_patch":
        return "";
      case "rename_path": {
        const oldP = String(args.oldPath || "")
          .split(/[/\\]/)
          .pop();
        const newP = String(args.newPath || "")
          .split(/[/\\]/)
          .pop();
        return oldP && newP ? `${oldP} → ${newP}` : "";
      }
      case "run_command":
        return args.command ? String(args.command).slice(0, 50) : "";
      case "get_diagnostics": {
        const paths = args.paths as string[] | undefined;
        if (!paths || paths.length === 0) return "all files";
        return `${paths.length} files`;
      }
      default:
        return "";
    }
  }

  // Get meta info if available
  function getMeta(): { why?: string; risk?: string; undo?: string; autoApproved?: boolean } | null {
    const meta = toolCall.arguments.meta as Record<string, unknown> | undefined;
    if (!meta) return null;
    return {
      why: meta.why ? String(meta.why) : undefined,
      risk: meta.risk ? String(meta.risk) : undefined,
      undo: meta.undo ? String(meta.undo) : undefined,
      autoApproved: meta.autoApproved === true,
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
      if (searchTelemetry.rgSource === "bundled") return "rg-bundled";
      if (searchTelemetry.rgSource === "system") return "rg-system";
      return "rg";
    }
    if (searchTelemetry.engine === "rg" && searchTelemetry.fallbackUsed) {
      return "retried";
    }
    if (searchTelemetry.engine === "legacy") {
      return searchTelemetry.fallbackUsed ? "legacy-fallback" : "legacy";
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
  const reuseMeta = $derived(toolCall.meta as InlineToolMeta | undefined);
  const terminalRunMeta = $derived(reuseMeta?.terminalRun);
  const reusedTerminal = $derived(Boolean(reuseMeta?.reused));

  // Check if this is a terminal command tool
  const isTerminalTool = $derived(
    isTerminalToolName(toolCall.name),
  );
  const shouldShowApproval = $derived(
    showApprovalInline &&
    isPending &&
    !isApprovedPending &&
    Boolean(onApprove) &&
    Boolean(onDeny) &&
    (!isTerminalTool || isFirstPendingTerminal),
  );

  // Get the command for terminal tools
  const terminalCommand = $derived.by(() => {
    if (!isTerminalTool) return "";
    const preview = terminalRunMeta?.commandPreview;
    if (typeof preview === "string" && preview.length > 0) return preview;
    return String(toolCall.arguments.command || "");
  });
  const terminalExcerpt = $derived.by(() => {
    if (!isTerminalTool) return "";
    const excerpt = terminalRunMeta?.excerpt;
    if (typeof excerpt === "string" && excerpt.length > 0) return excerpt;
    return toolCall.output || "";
  });
  const terminalStateLabel = $derived(
    terminalRunMeta?.state || toolCall.status,
  );

  // Check if this is a file write tool that supports streaming
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
    const diagnosticsMeta: DiagnosticsMeta | undefined =
      toolCall.name === "get_diagnostics"
        ? (toolCall.meta as DiagnosticsMeta | undefined)
        : (toolCall.meta as InlineToolMeta | undefined)?.diagnostics;
    if (!diagnosticsMeta) return null;
    const items = Array.isArray(diagnosticsMeta.problems)
      ? diagnosticsMeta.problems
      : [];

    // Group by file
    const byFile: Record<string, ProblemWithRelativePath[]> = {};
    for (const problem of items) {
      const key = problem.relativePath;
      byFile[key] = [...(byFile[key] || []), problem];
    }

    return {
      errorCount: typeof diagnosticsMeta.errorCount === "number" ? diagnosticsMeta.errorCount : 0,
      warningCount: typeof diagnosticsMeta.warningCount === "number" ? diagnosticsMeta.warningCount : 0,
      fileCount: typeof diagnosticsMeta.fileCount === "number" ? diagnosticsMeta.fileCount : 0,
      files: Object.entries(byFile).map(([path, problems]) => ({
        path,
        problems,
        errorCount: problems.filter((p) => p.severity === "error").length,
        warningCount: problems.filter((p) => p.severity === "warning").length,
      })),
    };
  });

  const diffStats = $derived.by(() => {
    const meta = toolCall.meta as InlineToolMeta | undefined;
    const stats = meta?.fileEdit;
    if (!stats) return null;
    return {
      added: typeof stats.added === "number" ? stats.added : 0,
      removed: typeof stats.removed === "number" ? stats.removed : 0,
    };
  });

  function getDisplayOutput(rawOutput: string): string {
    return rawOutput;
  }

  const outputSegments = $derived.by(() =>
    toolCall.output ? getOutputSegments(getDisplayOutput(toolCall.output)) : [],
  );
</script>

{#snippet customToolIcon(toolName: string, active: boolean, size: number = 14)}
  {#if active}
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" class="shimmer-icon" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2 2.5 2.5 0 0 1 .5 0Z" />
      <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2 2.5 2.5 0 0 0-.5 0Z" />
    </svg>
  {:else if toolName === 'read_file'}
    <!-- Beautiful custom Read/Eye icon -->
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  {:else if toolName === 'workspace_search' || toolName === 'gather_context'}
    <!-- Deep RAG Search Node icon -->
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11" cy="11" r="8"/>
      <path d="m21 21-4.3-4.3"/>
      <path d="M11 8v6"/>
      <path d="M8 11h6"/>
    </svg>
  {:else if toolName === 'run_command' || toolName === 'execute_command'}
    <!-- Custom sleek terminal -->
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="4 17 10 11 4 5"/>
      <line x1="12" x2="20" y1="19" y2="19"/>
    </svg>
  {:else if toolName === 'find_files' || toolName === 'list_dir'}
    <!-- Custom directory/tree icon -->
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
    </svg>
  {:else}
    <UIIcon name={getToolIcon()} size={size} />
  {/if}
{/snippet}

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
<div class="terminal-badge icon-only" class:shimmer-icon={isRunning} title={getToolDisplayName()}>
            {@render customToolIcon(toolCall.name, isRunning, 14)}
        </div>

        <div class="terminal-command-preview">
          <span class="prompt-char">$</span>
          <span class="command-text">{terminalCommand || "command"}</span>
        </div>

        <div class="terminal-meta">
          <span class="status-pill terminal-state">{terminalStateLabel}</span>
          {#if !isRunning}
            {#if isComplete}
              <span class="status-pill success" title="Completed">
                <UIIcon name="check" size={12} />
              </span>
            {:else if isFailed}
              <span class="status-pill error" title="Failed">
                <UIIcon name="error" size={12} />
              </span>
            {:else if isPending}
              <span
                class="status-pill pending"
                title={isApprovedPending ? "Queued" : "Approval Needed"}
              >
                <UIIcon name="clock" size={12} />
              </span>
            {/if}
            {#if reusedTerminal}
              <span class="status-pill reused" title="Reused running terminal">
                <UIIcon name="refresh" size={12} />
              </span>
            {/if}
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
      <div class="tool-main-info" class:icon-only-streaming={isRunning}>
        {#if files.length === 0}
          <span
            class="tool-icon category-{getToolCategory()}"
            class:running-shimmer={isRunning}
            title={getToolDisplayName()}
          >
            {@render customToolIcon(toolCall.name, isRunning, 12)}
          </span>
        {/if}
      </div>

      <div class="header-right-meta">
        {#if diagnosticSummary}
          <div class="diag-mini-summary">
            {#if diagnosticSummary.errorCount > 0}
              <span class="diag-badge error" title="{diagnosticSummary.errorCount} Errors"
                ><UIIcon name="error" size={12} /> {diagnosticSummary.errorCount}</span
              >
            {/if}
            {#if diagnosticSummary.warningCount > 0}
              <span class="diag-badge warning" title="{diagnosticSummary.warningCount} Warnings"
                ><UIIcon name="warning" size={12} /> {diagnosticSummary.warningCount}</span
              >
            {/if}
            {#if diagnosticSummary.errorCount === 0 && diagnosticSummary.warningCount === 0}
              <span class="diag-badge success" title="No errors found">
                <UIIcon name="check" size={12} />
              </span>
            {/if}
          </div>
        {:else if files.length > 0}
          <div class="files-container" class:multi={files.length > 1}>
            {#each primaryFiles as file (file.path || file)}
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
                  {#if isRunning}
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      class="shimmer-icon"
                    >
                      <path
                        d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2 2.5 2.5 0 0 1 .5 0Z"
                      />
                      <path
                        d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2 2.5 2.5 0 0 0-.5 0Z"
                      />
                    </svg>
                  {:else}
                    <UIIcon name={file.icon} size={12} />
                  {/if}
                  {#if !isRunning}<span class="filename">{file.filename}</span>{/if}
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
          ? (meta?.autoApproved ? "Auto-approved - waiting to run" : "Approved - waiting to run")
          : "Queued - waiting for previous command"}</span
      >
    </div>
  {/if}

  {#if expanded}
    <div class="tool-details">
      {#if diagnosticSummary && diagnosticSummary.files.length > 0}
        <div class="diagnostic-details">
          {#each diagnosticSummary.files as file (file.path)}
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
                {#each file.problems as p (p.id)}
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
              {#each files as file (file.path)}
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

        {#if isTerminalTool && terminalExcerpt}
          <div class="detail-section">
            <span class="detail-label">Output:</span>
            <pre class="detail-output">{terminalExcerpt}</pre>
          </div>
        {:else if toolCall.output}
          <div class="detail-section">
            <span class="detail-label">Output:</span>
            <pre class="detail-output">{#each outputSegments as segment (segment.key)}{#if segment.type === "link"}<button type="button" class="output-link" onclick={(event) => handleOutputLinkClick(segment.value, event)}>{segment.value}</button>{:else}{segment.value}{/if}{/each}</pre>
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
    background: transparent;
    border: none;
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
  width: max-content;
  padding: 6px 14px;
    cursor: pointer;
    text-align: left;
  }

  .inline-tool-call.compact .terminal-header {
    gap: 10px;
    padding: 8px 12px;
    font-size: 12px;
  }

  .terminal-state {
    text-transform: none;
    letter-spacing: 0;
    font-size: 10px;
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .terminal-badge {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    background: transparent;
    color: var(--color-text-secondary);
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
    background: rgba(255, 255, 255, 0.15);
    color: #ffffff;
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
    background: rgba(255, 255, 255, 0.15);
    color: #ffffff;
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
    width: max-content;
    padding: 6px 8px;
    text-align: left;
    color: var(--color-text-secondary);
    font-size: 13px;
    transition: all 0.2s ease;
    border-radius: 999px;
    background: rgba(255,255,255,0.02);
  }
  .tool-header:hover { 
    background: rgba(255,255,255,0.06); 
    color: var(--color-text);
  }

  .inline-tool-call.compact .tool-header {
    padding: 4px 6px;
    font-size: 12px;
  }

  .tool-main-info {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
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
    background: transparent;
    border: none;
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
  }

  .more-files-pill {
    height: 24px;
    display: inline-flex;
    align-items: center;
    padding: 0 8px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--color-text-secondary);
    font-size: 10px;
    font-weight: 600;
    white-space: nowrap;
    transition: all 0.12s ease;
  }

  .more-files-pill:hover {
    color: var(--color-text);
    background: var(--color-hover);
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

  .inline-tool-call.compact .tool-summary {
    max-width: 150px;
    font-size: 10px;
  }

  .tool-summary.is-line-range {
    color: #ffffff;
    background: rgba(255, 255, 255, 0.08);
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

</style>

