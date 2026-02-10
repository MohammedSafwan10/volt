/**
 * Tool observability store
 * Captures execution telemetry for dashboards and debugging.
 */

export interface ToolExecutionEvent {
  timestamp: number;
  toolName: string;
  signature: string;
  idempotencyKey?: string;
  durationMs: number;
  success: boolean;
  code: string;
  retryable: boolean;
  attempt: number;
  maxAttempts: number;
  replayed: boolean;
  budgetMs?: number;
  latencyStatus?: ToolLatencyStatus;
}

export type ToolLatencyStatus = 'ok' | 'slow' | 'critical';

export interface ToolAggregate {
  toolName: string;
  total: number;
  success: number;
  failed: number;
  retries: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  errorRate: number;
  slowCount: number;
  criticalCount: number;
  slowRate: number;
}

const MAX_EVENTS = 3000;

const LATENCY_BUDGETS_MS: Record<string, { warn: number; critical: number }> = {
  // Read/search
  list_dir: { warn: 1200, critical: 3000 },
  read_file: { warn: 1200, critical: 3000 },
  read_files: { warn: 1500, critical: 3500 },
  workspace_search: { warn: 1800, critical: 4500 },
  find_files: { warn: 1800, critical: 4500 },
  read_code: { warn: 1800, critical: 4500 },
  file_outline: { warn: 1200, critical: 3000 },
  search_symbols: { warn: 1800, critical: 4500 },
  // Write/edit
  write_file: { warn: 2500, critical: 7000 },
  append_file: { warn: 2500, critical: 7000 },
  str_replace: { warn: 2500, critical: 7000 },
  multi_replace: { warn: 3000, critical: 8000 },
  replace_lines: { warn: 2500, critical: 7000 },
  format_file: { warn: 3500, critical: 9000 },
  // Diagnostics/LSP
  get_diagnostics: { warn: 1800, critical: 5000 },
  get_tool_metrics: { warn: 1000, critical: 2500 },
  // Terminal/process
  run_command: { warn: 7000, critical: 20000 },
  start_process: { warn: 4000, critical: 12000 },
  get_process_output: { warn: 2000, critical: 6000 },
};

const DEFAULT_BUDGET = { warn: 2000, critical: 6000 };

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

function getBudget(toolName: string): { warn: number; critical: number } {
  if (toolName.startsWith('lsp_')) return { warn: 2200, critical: 6500 };
  if (toolName.startsWith('mcp_')) return { warn: 3000, critical: 9000 };
  return LATENCY_BUDGETS_MS[toolName] ?? DEFAULT_BUDGET;
}

function classifyLatency(durationMs: number, budget: { warn: number; critical: number }): ToolLatencyStatus {
  if (durationMs >= budget.critical) return 'critical';
  if (durationMs >= budget.warn) return 'slow';
  return 'ok';
}

class ToolObservabilityStore {
  events = $state<ToolExecutionEvent[]>([]);

  record(event: ToolExecutionEvent): void {
    const budget = getBudget(event.toolName);
    const normalized: ToolExecutionEvent = {
      ...event,
      budgetMs: event.budgetMs ?? budget.warn,
      latencyStatus: event.latencyStatus ?? classifyLatency(event.durationMs, budget),
    };
    this.events = [...this.events, normalized];
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }
  }

  clear(): void {
    this.events = [];
  }

  get totalExecutions(): number {
    return this.events.length;
  }

  get successRate(): number {
    if (this.events.length === 0) return 1;
    const success = this.events.filter((e) => e.success).length;
    return success / this.events.length;
  }

  get toolAggregates(): ToolAggregate[] {
    const byTool = new Map<string, ToolExecutionEvent[]>();
    for (const event of this.events) {
      const group = byTool.get(event.toolName) ?? [];
      group.push(event);
      byTool.set(event.toolName, group);
    }

    const out: ToolAggregate[] = [];
    for (const [toolName, group] of byTool) {
      const total = group.length;
      const success = group.filter((e) => e.success).length;
      const failed = total - success;
      const retries = group.filter((e) => e.attempt > 1).length;
      const latencies = group.map((e) => e.durationMs);
      const slowCount = group.filter((e) => e.latencyStatus === 'slow').length;
      const criticalCount = group.filter((e) => e.latencyStatus === 'critical').length;
      const avgLatencyMs =
        latencies.reduce((acc, v) => acc + v, 0) / Math.max(1, latencies.length);
      const p95LatencyMs = percentile(latencies, 95);

      out.push({
        toolName,
        total,
        success,
        failed,
        retries,
        avgLatencyMs,
        p95LatencyMs,
        errorRate: failed / Math.max(1, total),
        slowCount,
        criticalCount,
        slowRate: (slowCount + criticalCount) / Math.max(1, total),
      });
    }

    return out.sort((a, b) => b.total - a.total);
  }

  get topFailingSignatures(): Array<{ signature: string; failures: number; lastSeen: number }> {
    const failures = this.events.filter((e) => !e.success);
    const bySignature = new Map<string, { failures: number; lastSeen: number }>();

    for (const event of failures) {
      const current = bySignature.get(event.signature) ?? { failures: 0, lastSeen: 0 };
      current.failures += 1;
      current.lastSeen = Math.max(current.lastSeen, event.timestamp);
      bySignature.set(event.signature, current);
    }

    return Array.from(bySignature.entries())
      .map(([signature, stats]) => ({ signature, ...stats }))
      .sort((a, b) => b.failures - a.failures)
      .slice(0, 20);
  }

  get topSlowTools(): Array<{ toolName: string; slowRate: number; criticalCount: number; p95LatencyMs: number }> {
    return this.toolAggregates
      .filter((x) => x.slowCount + x.criticalCount > 0)
      .sort((a, b) => {
        if (b.slowRate !== a.slowRate) return b.slowRate - a.slowRate;
        return b.p95LatencyMs - a.p95LatencyMs;
      })
      .slice(0, 20)
      .map((x) => ({
        toolName: x.toolName,
        slowRate: x.slowRate,
        criticalCount: x.criticalCount,
        p95LatencyMs: x.p95LatencyMs,
      }));
  }

  get recentSlowEvents(): ToolExecutionEvent[] {
    return this.events
      .filter((e) => e.latencyStatus === 'slow' || e.latencyStatus === 'critical')
      .slice(-50);
  }
}

export const toolObservabilityStore = new ToolObservabilityStore();
