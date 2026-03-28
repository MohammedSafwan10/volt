<script lang="ts">
  import { onMount } from 'svelte';
  import { getLspRegistry } from '$core/lsp/sidecar';
  import { getDartLspStatus } from '$core/lsp/dart-sidecar';
  import { problemsStore } from '$shared/stores/problems.svelte';
  import { projectStore } from '$shared/stores/project.svelte';
  import { UIIcon } from '$shared/components/ui';

  type ServerHealthRow = {
    id: string;
    type: string;
    health: {
      healthy: boolean;
      consecutiveFailures: number;
      avgResponseTimeMs: number | null;
      message: string;
      lastResponseAt: number | null;
    };
  };

  type RuntimeSnapshot = ReturnType<ReturnType<typeof getLspRegistry>['getRuntimeSnapshot']>;

  let serverHealth = $state<ServerHealthRow[]>([]);
  let runtimeSnapshot = $state<RuntimeSnapshot | null>(null);
  let dartLspStatus = $state(getDartLspStatus());

  const diagnosticsFreshness = $derived(problemsStore.diagnosticsFreshness);
  const isDartWorkspace = $derived(
    Boolean(projectStore.rootPath) &&
      projectStore.tree.some((node) =>
        ['pubspec.yaml', 'analysis_options.yaml'].includes(node.name.toLowerCase()),
      ),
  );

  function refresh(): void {
    const registry = getLspRegistry();
    serverHealth = registry.getAllServerHealth();
    runtimeSnapshot = registry.getRuntimeSnapshot();
    dartLspStatus = getDartLspStatus();
  }

  function formatTimestamp(value: number | null): string {
    if (!value) return 'never';
    return new Date(value).toLocaleTimeString();
  }

  onMount(() => {
    refresh();
    const interval = window.setInterval(refresh, 2000);
    return () => window.clearInterval(interval);
  });
</script>

<div class="lsp-debug-view">
  <div class="lsp-summary">
    <div class="summary-card">
      <span class="summary-label">Servers</span>
      <span class="summary-value">{runtimeSnapshot?.serverCount ?? 0}</span>
    </div>
    <div class="summary-card">
      <span class="summary-label">Pending Requests</span>
      <span class="summary-value">{runtimeSnapshot?.totals.pendingRequests ?? 0}</span>
    </div>
    <div class="summary-card">
      <span class="summary-label">Diagnostics</span>
      <span class="summary-value">{diagnosticsFreshness.status}</span>
    </div>
    <div class="summary-card">
      <span class="summary-label">Stale Sources</span>
      <span class="summary-value">{diagnosticsFreshness.staleSources.length}</span>
    </div>
    <div class="summary-card">
      <span class="summary-label">Warming Sources</span>
      <span class="summary-value">{diagnosticsFreshness.sourceStatuses.filter((source) => source.status === 'warming').length}</span>
    </div>
  </div>

  <div class="debug-section">
    <div class="section-title">Server Health</div>
    {#if isDartWorkspace && !dartLspStatus.running}
      <div class="dart-status-banner warning">
        <div class="section-title">Dart / Flutter</div>
        <div class="server-message">
          {#if dartLspStatus.sdkInfo}
            Dart SDK detected at {dartLspStatus.sdkInfo.dartPath} via {dartLspStatus.sdkInfo.detectionSource}, but the Dart LSP is not running yet.
          {:else}
            {dartLspStatus.lastIssue ?? 'Dart SDK not detected yet. Volt cannot start Flutter analysis without a working Dart or Flutter SDK.'}
          {/if}
        </div>
        {#if dartLspStatus.sdkInfo}
          <div class="server-message">
            {#if dartLspStatus.sdkInfo.flutterPath}
              Flutter: {dartLspStatus.sdkInfo.flutterPath} ({dartLspStatus.sdkInfo.flutterVersion ?? 'version unavailable'})
            {:else}
              Dart only: {dartLspStatus.sdkInfo.version}
            {/if}
          </div>
        {:else}
          <div class="server-message">
            Tip: open Settings → Dart / Flutter and set a Flutter SDK root if Volt cannot see your terminal PATH.
          </div>
        {/if}
      </div>
    {/if}
    {#if serverHealth.length === 0}
      <div class="empty-state">No running LSP servers</div>
    {:else}
      <div class="server-list">
        {#each serverHealth as server (server.id)}
          {@const runtimeServer = runtimeSnapshot?.servers.find((item) => item.id === server.id)}
          <div class="server-card">
            <div class="server-header">
              <div>
                <div class="server-name">{server.type}</div>
                <div class="server-id">{server.id}</div>
              </div>
              <div class:healthy={server.health.healthy} class:unhealthy={!server.health.healthy} class="server-status">
                <UIIcon name={server.health.healthy ? 'check' : 'warning'} size={12} />
                <span>{server.health.healthy ? 'healthy' : 'degraded'}</span>
              </div>
            </div>
            <div class="server-meta">
              <span>Failures: {server.health.consecutiveFailures}</span>
              <span>Avg: {server.health.avgResponseTimeMs ?? '-'}ms</span>
              <span>Last response: {formatTimestamp(server.health.lastResponseAt)}</span>
              <span>Restarts: {runtimeServer?.restartCount ?? 0}</span>
            </div>
            <div class="server-message">{server.health.message}</div>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <div class="debug-section">
    <div class="section-title">Runtime Snapshot</div>
    <div class="snapshot-grid">
      <div>Listeners: {runtimeSnapshot?.totals.eventListeners ?? 0}</div>
      <div>Message Handlers: {runtimeSnapshot?.totals.messageHandlers ?? 0}</div>
      <div>Error Handlers: {runtimeSnapshot?.totals.errorHandlers ?? 0}</div>
      <div>Exit Handlers: {runtimeSnapshot?.totals.exitHandlers ?? 0}</div>
      <div>Health Handlers: {runtimeSnapshot?.totals.healthHandlers ?? 0}</div>
    </div>
  </div>

  <div class="debug-section">
    <div class="section-title">Diagnostics Freshness</div>
    <div class="freshness-meta">
      <span>Status: {diagnosticsFreshness.status}</span>
      <span>Updating: {diagnosticsFreshness.isUpdating ? 'yes' : 'no'}</span>
      <span>Warming: {diagnosticsFreshness.hasWarmingSources ? 'yes' : 'no'}</span>
      <span>Sources: {diagnosticsFreshness.activeSources.length}</span>
    </div>
    {#if diagnosticsFreshness.staleSources.length > 0}
      <div class="stale-sources">Stale: {diagnosticsFreshness.staleSources.join(', ')}</div>
    {:else if diagnosticsFreshness.hasWarmingSources}
      <div class="stale-sources">Warming: {diagnosticsFreshness.sourceStatuses.filter((source) => source.status === 'warming').map((source) => source.source).join(', ')}</div>
    {/if}
  </div>
</div>

<style>
  .lsp-debug-view {
    display: flex;
    flex-direction: column;
    gap: 12px;
    height: 100%;
    overflow-y: auto;
    padding: 12px;
    background: var(--color-bg);
    color: var(--color-text);
  }
  .lsp-summary, .snapshot-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 10px;
  }
  .summary-card, .server-card, .debug-section {
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg-sidebar);
  }
  .dart-status-banner {
    border: 1px solid var(--color-warning);
    border-radius: 8px;
    padding: 10px 12px;
    margin-top: 10px;
    background: color-mix(in srgb, var(--color-warning) 10%, var(--color-bg-sidebar));
  }
  .summary-card {
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .summary-label, .server-id, .server-meta, .server-message, .freshness-meta, .stale-sources {
    color: var(--color-text-secondary);
    font-size: 11px;
  }
  .summary-value, .section-title, .server-name {
    font-size: 13px;
    font-weight: 600;
  }
  .debug-section {
    padding: 12px;
  }
  .server-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 10px;
  }
  .server-card {
    padding: 10px 12px;
  }
  .server-header, .server-meta, .freshness-meta {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .server-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
  }
  .server-status.healthy { color: var(--color-success); }
  .server-status.unhealthy { color: var(--color-warning); }
  .empty-state { color: var(--color-text-secondary); margin-top: 8px; }
</style>
