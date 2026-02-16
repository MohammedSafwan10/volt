<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { UIIcon } from '$lib/components/ui';
  import { browserDevToolsStore } from '$lib/stores/browser-devtools.svelte';
  import { browserStore } from '$lib/stores/browser.svelte';
  import { cdp } from '$lib/services/browser/cdp';
  import { connectCdpToBrowser } from '$lib/services/browser';

  interface Props {
    onAskAI?: (context: string) => void;
  }

  let { onAskAI }: Props = $props();
  let captureWindow = $state<'10s' | '30s' | '2m' | 'session'>('30s');
  let captureBusy = $state(false);
  let captureError = $state<string | null>(null);
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const perfData = $derived(browserDevToolsStore.getPerformanceForAI({ window: captureWindow, include_events: true }));
  const metrics = $derived(perfData.snapshot);
  const events = $derived(perfData.events ?? []);

  const summary = $derived.by(() => {
    const m = metrics;
    if (!m) return null;
    const high = events.filter((e) => e.severity === 'high');
    const longTasks = events.filter((e) => e.kind === 'long-task');
    const hints: string[] = [];
    if ((m.firstContentfulPaint ?? 0) > 2500) hints.push('First Contentful Paint is high');
    if ((m.largestContentfulPaint ?? 0) > 4000) hints.push('Largest Contentful Paint is high');
    if ((m.loadComplete ?? 0) > 5000) hints.push('Load completion is slow');
    if (longTasks.length > 0) hints.push(`${longTasks.length} long-task events detected`);
    if ((m.jsHeapSize ?? 0) > 100 * 1024 * 1024) hints.push('High JS heap usage');
    return {
      highSeverityCount: high.length,
      longTaskCount: longTasks.length,
      hints,
    };
  });

  function formatMs(value?: number): string {
    if (value == null) return '-';
    return `${Math.round(value)}ms`;
  }

  function formatBytes(value?: number): string {
    if (!value) return '-';
    if (value < 1024) return `${value}B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
    return `${(value / (1024 * 1024)).toFixed(2)}MB`;
  }

  function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function severityClass(severity: string): string {
    if (severity === 'high') return 'sev-high';
    if (severity === 'medium') return 'sev-medium';
    return 'sev-low';
  }

  function askAIForPerformance(): void {
    if (!onAskAI || !metrics) return;
    const m = metrics;
    const s = summary;
    let context = `Performance diagnostics (${captureWindow})\n`;
    context += `- DOMContentLoaded: ${formatMs(m.domContentLoaded)}\n`;
    context += `- Load Complete: ${formatMs(m.loadComplete)}\n`;
    context += `- First Paint: ${formatMs(m.firstPaint)}\n`;
    context += `- First Contentful Paint: ${formatMs(m.firstContentfulPaint)}\n`;
    context += `- Largest Contentful Paint: ${formatMs(m.largestContentfulPaint)}\n`;
    context += `- JS Heap Size: ${formatBytes(m.jsHeapSize)}\n`;
    context += `- Event Count: ${m.eventCount}\n`;
    if (s?.hints.length) {
      context += `\nDetected issues:\n`;
      for (const hint of s.hints) context += `- ${hint}\n`;
    }
    onAskAI(context);
  }

  function applyCdpMetrics(metrics: {
    dom_content_loaded: number | null;
    load_complete: number | null;
    first_paint: number | null;
    first_contentful_paint: number | null;
    largest_contentful_paint: number | null;
    js_heap_size: number | null;
    timestamp: number;
  }): void {
    browserDevToolsStore.setPerformance({
      domContentLoaded: metrics.dom_content_loaded ?? undefined,
      loadComplete: metrics.load_complete ?? undefined,
      firstPaint: metrics.first_paint ?? undefined,
      firstContentfulPaint: metrics.first_contentful_paint ?? undefined,
      largestContentfulPaint: metrics.largest_contentful_paint ?? undefined,
      jsHeapSize: metrics.js_heap_size ?? undefined,
      timestamp: metrics.timestamp || Date.now(),
    });
  }

  async function captureNow(): Promise<void> {
    if (captureBusy) return;
    captureBusy = true;
    captureError = null;
    try {
      if (!browserStore.isOpen) {
        captureError = 'Browser is not open';
        return;
      }

      let status = await cdp.getStatus();
      if (!status.connected) {
        const ok = await connectCdpToBrowser(browserStore.url);
        if (!ok) {
          captureError = 'CDP not connected yet. Reload page once and retry.';
          return;
        }
        status = await cdp.getStatus();
      }

      if (!status.connected) {
        captureError = 'CDP not connected';
        return;
      }

      const metrics = await cdp.getPerformance();
      applyCdpMetrics(metrics);
    } catch (err) {
      captureError = err instanceof Error ? err.message : String(err);
    } finally {
      captureBusy = false;
    }
  }

  onMount(() => {
    void captureNow();
    pollTimer = setInterval(() => {
      if (!browserStore.isOpen || !browserStore.isVisible) return;
      void captureNow();
    }, 2500);
  });

  onDestroy(() => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });
</script>

<div class="performance-panel">
  <div class="toolbar">
    <div class="left">
      <label for="window">Window</label>
      <select id="window" bind:value={captureWindow}>
        <option value="10s">10s</option>
        <option value="30s">30s</option>
        <option value="2m">2m</option>
        <option value="session">Session</option>
      </select>
    </div>
    <div class="right">
      <button class="action" type="button" onclick={captureNow} disabled={captureBusy}>
        <UIIcon name={captureBusy ? "spinner" : "refresh"} size={12} />
        <span>{captureBusy ? 'Capturing...' : 'Capture now'}</span>
      </button>
      <button class="icon-btn" type="button" title="Clear performance events" onclick={() => browserDevToolsStore.clearPerformance()}>
        <UIIcon name="trash" size={12} />
      </button>
      {#if onAskAI && metrics}
        <button class="action" type="button" onclick={askAIForPerformance}>
          <UIIcon name="sparkle" size={12} />
          <span>Ask AI</span>
        </button>
      {/if}
    </div>
  </div>

  {#if metrics}
    {@const m = metrics}
    <div class="cards">
      <div class="card">
        <span class="label">DOMContentLoaded</span>
        <span class="value">{formatMs(m.domContentLoaded)}</span>
      </div>
      <div class="card">
        <span class="label">Load Complete</span>
        <span class="value">{formatMs(m.loadComplete)}</span>
      </div>
      <div class="card">
        <span class="label">FCP</span>
        <span class="value">{formatMs(m.firstContentfulPaint)}</span>
      </div>
      <div class="card">
        <span class="label">LCP</span>
        <span class="value">{formatMs(m.largestContentfulPaint)}</span>
      </div>
      <div class="card">
        <span class="label">JS Heap</span>
        <span class="value">{formatBytes(m.jsHeapSize)}</span>
      </div>
      <div class="card">
        <span class="label">Events</span>
        <span class="value">{m.eventCount}</span>
      </div>
    </div>

    <div class="summary">
      <h4>Summary</h4>
      {#if summary && summary.hints.length > 0}
        <ul>
          {#each summary.hints as hint}
            <li>{hint}</li>
          {/each}
        </ul>
      {:else}
        <p>No obvious bottlenecks detected in this capture window.</p>
      {/if}
    </div>

    <div class="timeline">
      <h4>Timeline</h4>
      {#if events.length === 0}
        <div class="empty">
          <UIIcon name="bolt" size={18} />
          <span>No events in this window</span>
        </div>
      {:else}
        <div class="event-list">
          {#each events as event (event.id)}
            <div class="event-row">
              <span class="time">{formatTime(event.timestamp)}</span>
              <span class={`sev ${severityClass(event.severity)}`}>{event.severity}</span>
              <span class="kind">{event.kind}</span>
              <span class="label">{event.label}</span>
              <span class="metric">{event.value != null ? `${Math.round(event.value)}${event.unit ?? ''}` : '-'}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <div class="empty-root">
      <UIIcon name="bolt" size={24} />
      <span>No performance snapshot yet</span>
      <span class="hint">Navigate or reload a page to populate metrics</span>
    </div>
  {/if}
  {#if captureError}
    <div class="capture-error">{captureError}</div>
  {/if}
</div>

<style>
  .performance-panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--color-bg);
    font-size: 11px;
    overflow: auto;
  }

  .toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 8px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg-panel);
  }

  .left,
  .right {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .left label {
    color: var(--color-text-secondary);
  }

  select {
    height: 26px;
    border-radius: 6px;
    border: 1px solid var(--color-border);
    background: var(--color-surface0);
    color: var(--color-text);
    padding: 0 8px;
  }

  .icon-btn,
  .action {
    height: 26px;
    border-radius: 6px;
    border: 1px solid var(--color-border);
    background: var(--color-surface0);
    color: var(--color-text-secondary);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 0 8px;
  }

  .icon-btn {
    width: 26px;
    padding: 0;
  }

  .icon-btn:hover,
  .action:hover {
    color: var(--color-text);
    border-color: var(--color-accent);
  }

  .action[disabled] {
    opacity: 0.7;
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 8px;
    padding: 8px;
  }

  .card {
    border: 1px solid var(--color-border);
    background: var(--color-surface0);
    border-radius: 8px;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .card .label {
    color: var(--color-text-secondary);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  .card .value {
    color: var(--color-text);
    font-size: 13px;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
  }

  .summary,
  .timeline {
    margin: 0 8px 8px;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-surface0);
    padding: 10px;
  }

  .summary h4,
  .timeline h4 {
    margin: 0 0 8px;
    color: var(--color-text);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }

  .summary ul {
    margin: 0;
    padding-left: 16px;
    color: var(--color-text-secondary);
  }

  .summary p {
    margin: 0;
    color: var(--color-text-secondary);
  }

  .event-list {
    display: flex;
    flex-direction: column;
    max-height: 220px;
    overflow: auto;
  }

  .event-row {
    display: grid;
    grid-template-columns: 80px 62px 80px minmax(0, 1fr) 90px;
    gap: 8px;
    align-items: center;
    border-bottom: 1px solid var(--color-border);
    padding: 5px 2px;
  }

  .event-row:last-child {
    border-bottom: none;
  }

  .time,
  .metric {
    color: var(--color-text-secondary);
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
  }

  .kind {
    color: var(--color-text-secondary);
    text-transform: uppercase;
    font-size: 10px;
  }

  .label {
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sev {
    border-radius: 999px;
    padding: 2px 6px;
    font-size: 10px;
    text-transform: uppercase;
    text-align: center;
  }

  .sev-low {
    color: #4ade80;
    background: rgba(34, 197, 94, 0.15);
  }

  .sev-medium {
    color: #fbbf24;
    background: rgba(245, 158, 11, 0.15);
  }

  .sev-high {
    color: #f87171;
    background: rgba(239, 68, 68, 0.15);
  }

  .empty,
  .empty-root {
    min-height: 120px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--color-text-secondary);
  }

  .hint {
    font-size: 10px;
    opacity: 0.8;
  }

  .capture-error {
    margin: 0 8px 8px;
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--color-error) 40%, var(--color-border));
    background: color-mix(in srgb, var(--color-error) 10%, transparent);
    color: var(--color-error);
    font-size: 11px;
  }

  @media (max-width: 1100px) {
    .cards {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
