<script lang="ts">
  import { UIIcon } from '$lib/components/ui';
  import { browserDevToolsStore, type BrowserSecurityIssue } from '$lib/stores/browser-devtools.svelte';

  interface Props {
    onAskAI?: (context: string) => void;
  }

  let { onAskAI }: Props = $props();

  let severityFilter = $state<'all' | 'low' | 'medium' | 'high'>('all');
  let kindFilter = $state<'all' | BrowserSecurityIssue['kind']>('all');
  let errorsOnly = $state(false);
  let expandedIssueId = $state<string | null>(null);
  let refreshBusy = $state(false);

  const snapshot = $derived(browserDevToolsStore.securitySnapshot);

  const issues = $derived.by(() => {
    const source = snapshot?.issues ?? [];
    return source
      .filter((issue) => (severityFilter === 'all' ? true : issue.severity === severityFilter))
      .filter((issue) => (kindFilter === 'all' ? true : issue.kind === kindFilter))
      .filter((issue) => (errorsOnly ? issue.severity !== 'low' : true));
  });

  function severityClass(severity: BrowserSecurityIssue['severity']): string {
    if (severity === 'high') return 'sev-high';
    if (severity === 'medium') return 'sev-medium';
    return 'sev-low';
  }

  async function refresh(): Promise<void> {
    refreshBusy = true;
    try {
      browserDevToolsStore.refreshSecuritySnapshot();
    } finally {
      refreshBusy = false;
    }
  }

  function askAI(): void {
    if (!onAskAI || !snapshot) return;
    const lines: string[] = [
      'Security diagnostics',
      `- Total issues: ${snapshot.summary.total}`,
      `- High: ${snapshot.summary.high}`,
      `- Medium: ${snapshot.summary.medium}`,
      `- Low: ${snapshot.summary.low}`,
      `- Coverage: mixed=${snapshot.coverage.mixed_content}, cors=${snapshot.coverage.cors}, csp=${snapshot.coverage.csp}, tls=${snapshot.coverage.tls}`,
      '',
      'Top issues:',
      ...issues.slice(0, 8).map((issue) => `- [${issue.severity}] ${issue.kind} ${issue.url ? `(${issue.url})` : ''}: ${issue.description}`),
    ];
    onAskAI(lines.join('\n'));
  }

  function recommendationFor(issue: BrowserSecurityIssue): string {
    switch (issue.kind) {
      case 'mixed-content':
        return 'Serve all subresources over HTTPS and update hardcoded http:// URLs.';
      case 'cors':
        return 'Adjust Access-Control-Allow-Origin/Methods/Headers and preflight handling on server.';
      case 'csp':
        return 'Update CSP directives (script-src/style-src/connect-src) to allow required origins safely.';
      case 'tls':
        return 'Enable strict TLS policy (HSTS) and ensure modern TLS configuration at edge/proxy.';
      case 'cert':
        return 'Verify certificate chain/SAN/expiry and proxy TLS termination settings.';
      case 'cookie-policy':
        return 'Review cookie flags: Secure, HttpOnly, SameSite and domain/path scoping.';
      default:
        return 'Inspect raw evidence and reproduce with a clean capture to isolate root cause.';
    }
  }
</script>

<div class="security-panel">
  <div class="toolbar">
    <div class="toolbar-left">
      <select bind:value={severityFilter}>
        <option value="all">All severity</option>
        <option value="high">High</option>
        <option value="medium">Medium</option>
        <option value="low">Low</option>
      </select>
      <select bind:value={kindFilter}>
        <option value="all">All kinds</option>
        <option value="mixed-content">Mixed content</option>
        <option value="cors">CORS</option>
        <option value="csp">CSP</option>
        <option value="tls">TLS</option>
        <option value="cert">Certificate</option>
        <option value="cookie-policy">Cookie policy</option>
        <option value="other">Other</option>
      </select>
      <label class="checkbox">
        <input type="checkbox" bind:checked={errorsOnly} />
        <span>Errors only</span>
      </label>
    </div>
    <div class="toolbar-right">
      {#if onAskAI}
        <button class="action" type="button" onclick={askAI}>
          <UIIcon name="sparkle" size={12} />
          <span>Ask AI</span>
        </button>
      {/if}
      <button class="icon-btn" type="button" title="Refresh diagnostics" onclick={refresh} disabled={refreshBusy}>
        <UIIcon name={refreshBusy ? 'spinner' : 'refresh'} size={12} />
      </button>
      <button class="icon-btn" type="button" title="Clear issues" onclick={() => browserDevToolsStore.clearSecurity()}>
        <UIIcon name="trash" size={12} />
      </button>
    </div>
  </div>

  {#if snapshot}
    <div class="summary">
      <div class="card high"><span>High</span><strong>{snapshot.summary.high}</strong></div>
      <div class="card medium"><span>Medium</span><strong>{snapshot.summary.medium}</strong></div>
      <div class="card low"><span>Low</span><strong>{snapshot.summary.low}</strong></div>
      <div class="card coverage">
        <span>Coverage</span>
        <strong>mixed:{snapshot.coverage.mixed_content ? 'Y' : 'N'} cors:{snapshot.coverage.cors ? 'Y' : 'N'} csp:{snapshot.coverage.csp ? 'Y' : 'N'} tls:{snapshot.coverage.tls ? 'Y' : 'N'}</strong>
      </div>
    </div>

    <div class="reco-box">
      <h4>Recommended Fixes</h4>
      {#if issues.length === 0}
        <p>No active issues for current filters.</p>
      {:else}
        <ul>
          {#each issues.slice(0, 5) as issue (issue.id)}
            <li>
              <strong>{issue.kind}:</strong> {recommendationFor(issue)}
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="issues">
      {#if issues.length === 0}
        <div class="empty">
          <UIIcon name="warning" size={20} />
          <span>No matching security issues</span>
        </div>
      {:else}
        {#each issues as issue (issue.id)}
          <div class="issue">
            <button class="issue-head" type="button" onclick={() => expandedIssueId = expandedIssueId === issue.id ? null : issue.id}>
              <span class={`sev ${severityClass(issue.severity)}`}>{issue.severity}</span>
              <span class="kind">{issue.kind}</span>
              <span class="title">{issue.title}</span>
              <span class="time">{new Date(issue.timestamp).toLocaleTimeString()}</span>
            </button>
            {#if expandedIssueId === issue.id}
              <div class="issue-body">
                <p>{issue.description}</p>
                {#if issue.url}<p class="mono">{issue.url}</p>{/if}
                {#if issue.evidence}
                  <pre>{JSON.stringify(issue.evidence, null, 2)}</pre>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
  {:else}
    <div class="empty">
      <UIIcon name="warning" size={20} />
      <span>No security snapshot yet</span>
      <span class="hint">Security issues appear from network/console/CSP events.</span>
    </div>
  {/if}
</div>

<style>
  .security-panel { height: 100%; display: flex; flex-direction: column; background: var(--color-bg); font-size: 11px; }
  .toolbar { display: flex; justify-content: space-between; gap: 8px; padding: 8px; border-bottom: 1px solid var(--color-border); background: var(--color-bg-panel); }
  .toolbar-left, .toolbar-right { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  select { height: 26px; border-radius: 6px; border: 1px solid var(--color-border); background: var(--color-surface0); color: var(--color-text); padding: 0 8px; font-size: 11px; }
  .checkbox { display: inline-flex; align-items: center; gap: 4px; color: var(--color-text-secondary); }
  .action, .icon-btn { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--color-border); background: var(--color-surface0); color: var(--color-text-secondary); border-radius: 6px; padding: 0 8px; height: 26px; }
  .icon-btn { width: 26px; justify-content: center; padding: 0; }
  .action:hover, .icon-btn:hover { color: var(--color-text); border-color: var(--color-accent); }
  .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; padding: 8px; border-bottom: 1px solid var(--color-border); }
  .card { border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-bg-panel); padding: 8px; display: flex; flex-direction: column; gap: 4px; }
  .card span { color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.4px; font-size: 10px; }
  .card strong { color: var(--color-text); font-size: 12px; }
  .card.high strong { color: #f87171; }
  .card.medium strong { color: #fbbf24; }
  .card.low strong { color: #4ade80; }
  .issues { flex: 1; overflow: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
  .reco-box { margin: 0 8px; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-bg-panel); padding: 8px; }
  .reco-box h4 { margin: 0 0 6px 0; font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--color-text-secondary); }
  .reco-box p { margin: 0; color: var(--color-text-secondary); }
  .reco-box ul { margin: 0; padding-left: 18px; color: var(--color-text); display: grid; gap: 4px; }
  .issue { border: 1px solid var(--color-border); border-radius: 8px; overflow: hidden; background: var(--color-bg-panel); }
  .issue-head { width: 100%; display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 8px; text-align: left; }
  .sev { padding: 2px 6px; border-radius: 999px; font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 10px; text-transform: uppercase; }
  .sev-high { background: rgba(239, 68, 68, 0.15); color: #f87171; }
  .sev-medium { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
  .sev-low { background: rgba(34, 197, 94, 0.15); color: #4ade80; }
  .kind { color: var(--color-text-secondary); font-family: 'JetBrains Mono', 'Fira Code', monospace; }
  .title { color: var(--color-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .time { color: var(--color-text-secondary); }
  .issue-body { border-top: 1px solid var(--color-border); padding: 8px; display: flex; flex-direction: column; gap: 6px; }
  .issue-body p { margin: 0; color: var(--color-text); }
  .issue-body pre { margin: 0; background: color-mix(in srgb, var(--color-bg) 70%, transparent); border: 1px solid var(--color-border); border-radius: 6px; padding: 8px; white-space: pre-wrap; word-break: break-word; }
  .mono { font-family: 'JetBrains Mono', 'Fira Code', monospace; color: var(--color-text-secondary); }
  .empty { flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 8px; color: var(--color-text-secondary); }
  .hint { opacity: 0.75; }
</style>
