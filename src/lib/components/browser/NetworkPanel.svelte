<script lang="ts">
  import { UIIcon } from '$lib/components/ui';
  import { browserDevToolsStore, type NetworkRequest } from '$lib/stores/browser-devtools.svelte';
  import { browserStore } from '$lib/stores/browser.svelte';

  interface Props {
    onAskAI?: (context: string) => void;
  }

  let { onAskAI }: Props = $props();

  type SortField = 'timestamp' | 'duration' | 'status' | 'size';
  type DetailTab = 'overview' | 'request' | 'response' | 'timing';

  let searchQuery = $state('');
  let methodFilter = $state<'all' | string>('all');
  let statusFilter = $state<'all' | '2xx' | '3xx' | '4xx' | '5xx'>('all');
  let errorsOnly = $state(false);
  let slowOnly = $state(false);
  let minDurationMs = $state(800);
  let sortBy = $state<SortField>('timestamp');
  let sortOrder = $state<'asc' | 'desc'>('desc');
  let selectedRequestId = $state<string | null>(null);
  let detailTab = $state<DetailTab>('overview');
  let renderLimit = $state(400);

  const METHOD_VALUES = ['all', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

  const filteredRequests = $derived.by(() => {
    let items = [...browserDevToolsStore.networkRequests];

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      items = items.filter((item) => item.url.toLowerCase().includes(q));
    }

    if (methodFilter !== 'all') {
      items = items.filter((item) => item.method.toUpperCase() === methodFilter.toUpperCase());
    }

    if (statusFilter !== 'all') {
      items = items.filter((item) => {
        const status = item.status ?? 0;
        if (statusFilter === '2xx') return status >= 200 && status < 300;
        if (statusFilter === '3xx') return status >= 300 && status < 400;
        if (statusFilter === '4xx') return status >= 400 && status < 500;
        return status >= 500;
      });
    }

    if (errorsOnly) {
      items = items.filter((item) => (item.status ?? 0) >= 400 || Boolean(item.error));
    }

    if (slowOnly) {
      items = items.filter((item) => (item.duration ?? 0) >= minDurationMs);
    }

    const numeric = (value: number | undefined) => value ?? -1;
    const direction = sortOrder === 'asc' ? 1 : -1;
    items.sort((a, b) => {
      if (sortBy === 'duration') return (numeric(a.duration) - numeric(b.duration)) * direction;
      if (sortBy === 'status') return (numeric(a.status) - numeric(b.status)) * direction;
      if (sortBy === 'size') return (numeric(a.size) - numeric(b.size)) * direction;
      return (a.timestamp - b.timestamp) * direction;
    });

    return items;
  });

  const visibleRequests = $derived(filteredRequests.slice(0, renderLimit));

  const selectedRequest = $derived.by(() => {
    if (!selectedRequestId) return null;
    return browserDevToolsStore.getNetworkRequestById(selectedRequestId);
  });

  $effect(() => {
    if (!selectedRequest && selectedRequestId) {
      selectedRequestId = null;
    }
  });

  function clearFilters(): void {
    searchQuery = '';
    methodFilter = 'all';
    statusFilter = 'all';
    errorsOnly = false;
    slowOnly = false;
    minDurationMs = 800;
    sortBy = 'timestamp';
    sortOrder = 'desc';
  }

  function formatSize(value?: number): string {
    if (!value || value <= 0) return '-';
    if (value < 1024) return `${value}B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
    return `${(value / (1024 * 1024)).toFixed(2)}MB`;
  }

  function formatDuration(value?: number): string {
    if (value == null) return '-';
    return `${Math.round(value)}ms`;
  }

  function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function getStatusClass(req: NetworkRequest): string {
    const status = req.status ?? 0;
    if (status >= 500) return 'status-5xx';
    if (status >= 400) return 'status-4xx';
    if (status >= 300) return 'status-3xx';
    if (status >= 200) return 'status-2xx';
    return 'status-pending';
  }

  function getMethodClass(method: string): string {
    const m = method.toUpperCase();
    if (m === 'GET') return 'method-get';
    if (m === 'POST') return 'method-post';
    if (m === 'PUT' || m === 'PATCH') return 'method-put';
    if (m === 'DELETE') return 'method-delete';
    return 'method-other';
  }

  function askAIForNetworkIssues(): void {
    if (!onAskAI) return;
    const failed = filteredRequests.filter((r) => (r.status ?? 0) >= 400 || Boolean(r.error));
    const slow = filteredRequests.filter((r) => (r.duration ?? 0) >= minDurationMs).slice(0, 15);
    let context = `Network diagnostics\n`;
    context += `- Total visible requests: ${filteredRequests.length}\n`;
    context += `- Failed requests: ${failed.length}\n`;
    context += `- Slow requests (>= ${minDurationMs}ms): ${slow.length}\n\n`;
    if (failed.length > 0) {
      context += `Top failures:\n`;
      for (const req of failed.slice(0, 8)) {
        context += `- [${req.status ?? 'ERR'}] ${req.method} ${req.url}\n`;
      }
    }
    if (slow.length > 0) {
      context += `\nTop slow requests:\n`;
      for (const req of slow.slice(0, 8)) {
        context += `- [${Math.round(req.duration ?? 0)}ms] ${req.method} ${req.url}\n`;
      }
    }
    onAskAI(context);
  }

  function toggleSort(field: SortField): void {
    if (sortBy === field) {
      sortOrder = sortOrder === 'asc' ? 'desc' : 'asc';
      return;
    }
    sortBy = field;
    sortOrder = 'desc';
  }

  function displayJson(value: unknown): string {
    if (!value) return '-';
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
</script>

<div class="network-panel">
  <div class="toolbar">
    <div class="toolbar-left">
      <div class="search-box">
        <UIIcon name="search" size={12} />
        <input type="text" placeholder="Filter URL..." bind:value={searchQuery} />
      </div>
      <select bind:value={methodFilter}>
        {#each METHOD_VALUES as method}
          <option value={method}>{method}</option>
        {/each}
      </select>
      <select bind:value={statusFilter}>
        <option value="all">All status</option>
        <option value="2xx">2xx</option>
        <option value="3xx">3xx</option>
        <option value="4xx">4xx</option>
        <option value="5xx">5xx</option>
      </select>
      <label class="checkbox">
        <input type="checkbox" bind:checked={errorsOnly} />
        <span>Errors only</span>
      </label>
      <label class="checkbox">
        <input type="checkbox" bind:checked={slowOnly} />
        <span>Slow only</span>
      </label>
      {#if slowOnly}
        <label class="duration">
          <span>&ge;</span>
          <input type="number" min="1" bind:value={minDurationMs} />
          <span>ms</span>
        </label>
      {/if}
    </div>
    <div class="toolbar-right">
      <span class="count">{filteredRequests.length} req</span>
      {#if onAskAI}
        <button class="action" type="button" onclick={askAIForNetworkIssues}>
          <UIIcon name="sparkle" size={12} />
          <span>Ask AI</span>
        </button>
      {/if}
      <button class="icon-btn" type="button" title="Clear network" onclick={() => browserDevToolsStore.clearNetworkRequests()}>
        <UIIcon name="trash" size={12} />
      </button>
      <button class="icon-btn" type="button" title="Reset filters" onclick={clearFilters}>
        <UIIcon name="refresh" size={12} />
      </button>
    </div>
  </div>

  <div class="layout">
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th class="clickable" onclick={() => toggleSort('timestamp')}>Start</th>
            <th>Method</th>
            <th>URL</th>
            <th class="clickable" onclick={() => toggleSort('status')}>Status</th>
            <th>Type</th>
            <th class="clickable" onclick={() => toggleSort('size')}>Size</th>
            <th class="clickable" onclick={() => toggleSort('duration')}>Duration</th>
          </tr>
        </thead>
        <tbody>
          {#if visibleRequests.length === 0}
            <tr>
              <td colspan="7">
                <div class="empty">
                  <UIIcon name="globe" size={20} />
                  <span>No matching requests</span>
                  <span class="hint">If this is a game/canvas page, reload once to capture startup assets.</span>
                  <button type="button" class="empty-action" onclick={() => browserStore.reload()}>Reload page</button>
                </div>
              </td>
            </tr>
          {:else}
            {#each visibleRequests as req (req.id)}
              <tr class:selected={selectedRequestId === req.id} onclick={() => (selectedRequestId = req.id)}>
                <td>{formatTime(req.timestamp)}</td>
                <td><span class={`method ${getMethodClass(req.method)}`}>{req.method}</span></td>
                <td class="url-cell" title={req.url}>{req.url}</td>
                <td><span class={`status ${getStatusClass(req)}`}>{req.status ?? '-'}</span></td>
                <td>{req.resourceType ?? '-'}</td>
                <td>{formatSize(req.size)}</td>
                <td>{formatDuration(req.duration)}</td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
      {#if filteredRequests.length > renderLimit}
        <div class="load-more">
          <button type="button" onclick={() => (renderLimit += 300)}>
            Load more ({filteredRequests.length - renderLimit} remaining)
          </button>
        </div>
      {/if}
    </div>

    <aside class="details">
      {#if selectedRequest}
        {@const req = selectedRequest}
        <div class="details-header">
          <div class="details-title">
            <span class={`method ${getMethodClass(req.method)}`}>{req.method}</span>
            <span class="url" title={req.url}>{req.url}</span>
          </div>
          <span class={`status ${getStatusClass(req)}`}>{req.status ?? '-'}</span>
        </div>
        <div class="details-tabs">
          <button class:active={detailTab === 'overview'} type="button" onclick={() => (detailTab = 'overview')}>Overview</button>
          <button class:active={detailTab === 'request'} type="button" onclick={() => (detailTab = 'request')}>Request</button>
          <button class:active={detailTab === 'response'} type="button" onclick={() => (detailTab = 'response')}>Response</button>
          <button class:active={detailTab === 'timing'} type="button" onclick={() => (detailTab = 'timing')}>Timing</button>
        </div>
        <div class="details-body">
          {#if detailTab === 'overview'}
            <dl>
              <dt>Request ID</dt><dd>{req.id}</dd>
              <dt>Started</dt><dd>{formatTime(req.timestamp)}</dd>
              <dt>Status</dt><dd>{req.status ?? '-'} {req.statusText ?? ''}</dd>
              <dt>Duration</dt><dd>{formatDuration(req.duration)}</dd>
              <dt>Size</dt><dd>{formatSize(req.size)}</dd>
              <dt>Initiator</dt><dd>{req.initiator ?? '-'}</dd>
              <dt>Error</dt><dd>{req.error ?? '-'}</dd>
            </dl>
          {:else if detailTab === 'request'}
            <h4>Headers</h4>
            <pre>{displayJson(req.headers)}</pre>
            <h4>Body</h4>
            <pre>{req.body || '-'}</pre>
          {:else if detailTab === 'response'}
            <h4>Headers</h4>
            <pre>{displayJson(req.responseHeaders)}</pre>
            <h4>Body</h4>
            <pre>{req.responseBody || '-'}</pre>
          {:else}
            <dl>
              <dt>Total</dt><dd>{formatDuration(req.duration)}</dd>
              <dt>Downloaded</dt><dd>{formatSize(req.size)}</dd>
              <dt>Completed</dt><dd>{req.completed ? 'Yes' : 'No'}</dd>
            </dl>
          {/if}
        </div>
      {:else}
        <div class="empty-details">
          <UIIcon name="link" size={20} />
          <span>Select a request to inspect details</span>
        </div>
      {/if}
    </aside>
  </div>
</div>

<style>
  .network-panel {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--color-bg);
    font-size: 11px;
  }

  .toolbar {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 8px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg-panel);
  }

  .toolbar-left,
  .toolbar-right {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .search-box {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-surface0);
    height: 26px;
  }

  .search-box input {
    width: 180px;
    border: none;
    outline: none;
    background: transparent;
    color: var(--color-text);
    font-size: 11px;
  }

  select,
  .duration input {
    height: 26px;
    border-radius: 6px;
    border: 1px solid var(--color-border);
    background: var(--color-surface0);
    color: var(--color-text);
    padding: 0 8px;
    font-size: 11px;
  }

  .checkbox {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--color-text-secondary);
  }

  .duration {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--color-text-secondary);
  }

  .duration input {
    width: 70px;
  }

  .action,
  .icon-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: 1px solid var(--color-border);
    background: var(--color-surface0);
    color: var(--color-text-secondary);
    border-radius: 6px;
    padding: 0 8px;
    height: 26px;
  }

  .icon-btn {
    width: 26px;
    justify-content: center;
    padding: 0;
  }

  .action:hover,
  .icon-btn:hover {
    color: var(--color-text);
    border-color: var(--color-accent);
  }

  .count {
    color: var(--color-text-secondary);
  }

  .layout {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 320px;
  }

  .table-wrap {
    overflow: auto;
    border-right: 1px solid var(--color-border);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }

  th,
  td {
    padding: 6px 8px;
    border-bottom: 1px solid var(--color-border);
    text-align: left;
  }

  th {
    position: sticky;
    top: 0;
    background: var(--color-bg-panel);
    color: var(--color-text-secondary);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    z-index: 1;
  }

  th.clickable {
    cursor: pointer;
  }

  tr {
    cursor: pointer;
  }

  tr:hover {
    background: var(--color-hover);
  }

  tr.selected {
    background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  }

  .url-cell {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .method,
  .status {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    padding: 2px 6px;
    border-radius: 999px;
    font-size: 10px;
  }

  .method-get { background: rgba(34, 197, 94, 0.15); color: #4ade80; }
  .method-post { background: rgba(59, 130, 246, 0.15); color: #60a5fa; }
  .method-put { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
  .method-delete { background: rgba(239, 68, 68, 0.15); color: #f87171; }
  .method-other { background: rgba(148, 163, 184, 0.15); color: #cbd5e1; }

  .status-2xx { background: rgba(34, 197, 94, 0.15); color: #4ade80; }
  .status-3xx { background: rgba(59, 130, 246, 0.15); color: #60a5fa; }
  .status-4xx { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
  .status-5xx { background: rgba(239, 68, 68, 0.15); color: #f87171; }
  .status-pending { background: rgba(148, 163, 184, 0.15); color: #cbd5e1; }

  .details {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .details-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px;
    border-bottom: 1px solid var(--color-border);
  }

  .details-title {
    min-width: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .details-title .url {
    color: var(--color-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .details-tabs {
    display: flex;
    border-bottom: 1px solid var(--color-border);
  }

  .details-tabs button {
    flex: 1;
    height: 30px;
    color: var(--color-text-secondary);
  }

  .details-tabs button.active {
    color: var(--color-text);
    border-bottom: 2px solid var(--color-accent);
  }

  .details-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 8px;
  }

  .details-body h4 {
    margin: 8px 0 4px;
    font-size: 10px;
    text-transform: uppercase;
    color: var(--color-text-secondary);
    letter-spacing: 0.4px;
  }

  .details-body pre {
    margin: 0;
    padding: 8px;
    border-radius: 6px;
    background: var(--color-surface0);
    border: 1px solid var(--color-border);
    color: var(--color-text);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 220px;
    overflow: auto;
  }

  dl {
    margin: 0;
    display: grid;
    grid-template-columns: 120px 1fr;
    gap: 6px 8px;
  }

  dt {
    color: var(--color-text-secondary);
  }

  dd {
    margin: 0;
    color: var(--color-text);
    word-break: break-word;
  }

  .empty,
  .empty-details {
    min-height: 120px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--color-text-secondary);
  }

  .empty .hint {
    font-size: 10px;
    opacity: 0.8;
    max-width: 360px;
    text-align: center;
  }

  .empty-action {
    border: 1px solid var(--color-border);
    background: var(--color-surface0);
    color: var(--color-text-secondary);
    border-radius: 6px;
    padding: 5px 10px;
    font-size: 11px;
  }

  .empty-action:hover {
    color: var(--color-text);
    border-color: var(--color-accent);
  }

  .load-more {
    padding: 8px;
    display: flex;
    justify-content: center;
  }

  .load-more button {
    border: 1px solid var(--color-border);
    background: var(--color-surface0);
    color: var(--color-text-secondary);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 11px;
  }

  .load-more button:hover {
    color: var(--color-text);
    border-color: var(--color-accent);
  }

  @media (max-width: 1100px) {
    .layout {
      grid-template-columns: 1fr;
      grid-template-rows: minmax(0, 1fr) 220px;
    }

    .table-wrap {
      border-right: none;
      border-bottom: 1px solid var(--color-border);
    }
  }
</style>
