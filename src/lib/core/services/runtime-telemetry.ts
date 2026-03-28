import { getLspRegistry } from '$core/lsp/sidecar/register';

export interface RuntimeTelemetrySample {
  timestamp: number;
  uptimeMs: number;
  lsp: ReturnType<ReturnType<typeof getLspRegistry>['getRuntimeSnapshot']>;
  heap: {
    usedJSHeapSize: number | null;
    totalJSHeapSize: number | null;
    jsHeapSizeLimit: number | null;
  };
}

const MAX_SAMPLES = 240; // ~2h of history at 30s interval

class RuntimeTelemetryStore {
  private startedAt = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  private samples: RuntimeTelemetrySample[] = [];

  start(intervalMs = 30_000, logToConsole = false): void {
    if (typeof window === 'undefined' || this.timer) return;

    this.startedAt = Date.now();
    (window as Window & { __voltRuntimeTelemetry?: RuntimeTelemetryStore }).__voltRuntimeTelemetry = this;
    void this.capture(logToConsole);
    this.timer = setInterval(() => {
      void this.capture(logToConsole);
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (typeof window !== 'undefined') {
      (window as Window & { __voltRuntimeTelemetry?: RuntimeTelemetryStore }).__voltRuntimeTelemetry =
        undefined;
    }
  }

  getLatest(): RuntimeTelemetrySample | null {
    return this.samples[this.samples.length - 1] ?? null;
  }

  getHistory(): RuntimeTelemetrySample[] {
    return [...this.samples];
  }

  private async capture(logToConsole: boolean): Promise<void> {
    const lsp = getLspRegistry().getRuntimeSnapshot();
    const perf = performance as Performance & {
      memory?: {
        usedJSHeapSize: number;
        totalJSHeapSize: number;
        jsHeapSizeLimit: number;
      };
    };
    const heap = perf.memory
      ? {
          usedJSHeapSize: perf.memory.usedJSHeapSize,
          totalJSHeapSize: perf.memory.totalJSHeapSize,
          jsHeapSizeLimit: perf.memory.jsHeapSizeLimit,
        }
      : {
          usedJSHeapSize: null,
          totalJSHeapSize: null,
          jsHeapSizeLimit: null,
        };

    const sample: RuntimeTelemetrySample = {
      timestamp: Date.now(),
      uptimeMs: Date.now() - this.startedAt,
      lsp,
      heap,
    };

    this.samples.push(sample);
    if (this.samples.length > MAX_SAMPLES) {
      this.samples = this.samples.slice(-MAX_SAMPLES);
    }

    if (logToConsole) {
      const heapMb =
        heap.usedJSHeapSize !== null
          ? Math.round((heap.usedJSHeapSize / (1024 * 1024)) * 10) / 10
          : null;
      console.log('[runtime-telemetry]', {
        uptimeMs: sample.uptimeMs,
        lspServers: sample.lsp.serverCount,
        lspPendingRequests: sample.lsp.totals.pendingRequests,
        lspListeners: sample.lsp.totals.eventListeners,
        heapMb,
      });
    }
  }
}

export const runtimeTelemetry = new RuntimeTelemetryStore();
