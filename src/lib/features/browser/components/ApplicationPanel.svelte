<script lang="ts">
  import { UIIcon } from '$shared/components/ui';
  import { browserDevToolsStore, type BrowserStorageEntry } from '$features/browser/stores/browser-devtools.svelte';
  import { browserStore } from '$features/browser/stores/browser.svelte';

  interface Props {
    onAskAI?: (context: string) => void;
  }

  let { onAskAI }: Props = $props();

  type AreaFilter = 'all' | 'localStorage' | 'sessionStorage' | 'cookies' | 'indexeddb';

  let areaFilter = $state<AreaFilter>('all');
  let search = $state('');
  let showSensitive = $state(false);
  let isRefreshing = $state(false);
  let captureError = $state<string | null>(null);
  let storageRenderLimit = $state(300);
  let cookieRenderLimit = $state(300);
  const RENDER_STEP = 300;

  const appData = $derived(browserDevToolsStore.applicationSnapshot);
  const warnings = $derived(browserDevToolsStore.applicationWarnings);

  const storageEntries = $derived.by(() => {
    const snapshot = appData;
    if (!snapshot) return [];
    const pattern = search.trim().toLowerCase();
    return snapshot.storage_entries
      .filter((entry) => areaFilter === 'all' || areaFilter === entry.area)
      .filter((entry) => {
        if (!pattern) return true;
        return entry.key.toLowerCase().includes(pattern);
      });
  });
  const visibleStorageEntries = $derived(storageEntries.slice(0, storageRenderLimit));

  const cookies = $derived.by(() => {
    const snapshot = appData;
    if (!snapshot || (areaFilter !== 'all' && areaFilter !== 'cookies')) return [];
    const pattern = search.trim().toLowerCase();
    return snapshot.cookies.filter((cookie) => (!pattern ? true : cookie.name.toLowerCase().includes(pattern)));
  });
  const visibleCookies = $derived(cookies.slice(0, cookieRenderLimit));

  const indexeddb = $derived.by(() => {
    const snapshot = appData;
    if (!snapshot || (areaFilter !== 'all' && areaFilter !== 'indexeddb')) return [];
    const pattern = search.trim().toLowerCase();
    return snapshot.indexeddb.filter((db) => (!pattern ? true : db.name.toLowerCase().includes(pattern)));
  });

  function displayValue(entry: BrowserStorageEntry): string {
    if (showSensitive) return entry.value || entry.value_masked;
    return entry.value_masked;
  }

  function displayCookieValue(value: { value?: string; value_masked: string }): string {
    return showSensitive ? value.value || value.value_masked : value.value_masked;
  }

  async function refresh(): Promise<void> {
    captureError = null;
    isRefreshing = true;
    try {
      const result = await browserDevToolsStore.refreshApplicationSnapshot();
      if (!result.success) {
        captureError = result.error || 'Failed to capture application snapshot';
      }
    } catch (err) {
      captureError = err instanceof Error ? err.message : String(err);
    } finally {
      isRefreshing = false;
    }
  }

  function askAI(): void {
    if (!onAskAI || !appData) return;
    const summary = [
      `Application diagnostics`,
      `- Origin: ${appData.origin}`,
      `- Storage entries: ${appData.storage_entries.length}`,
      `- Cookies: ${appData.cookies.length}`,
      `- IndexedDB DBs: ${appData.indexeddb.length}`,
    ];
    if (warnings.length > 0) summary.push('', 'Warnings:', ...warnings.map((warning) => `- ${warning}`));
    onAskAI(summary.join('\n'));
  }

  function onStorageScroll(event: Event): void {
    const el = event.currentTarget as HTMLDivElement;
    if (!el) return;
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 48;
    if (nearBottom && storageRenderLimit < storageEntries.length) {
      storageRenderLimit = Math.min(storageEntries.length, storageRenderLimit + RENDER_STEP);
    }
  }

  function onCookieScroll(event: Event): void {
    const el = event.currentTarget as HTMLDivElement;
    if (!el) return;
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 48;
    if (nearBottom && cookieRenderLimit < cookies.length) {
      cookieRenderLimit = Math.min(cookies.length, cookieRenderLimit + RENDER_STEP);
    }
  }

  $effect(() => {
    void areaFilter;
    void search;
    storageRenderLimit = RENDER_STEP;
    cookieRenderLimit = RENDER_STEP;
  });
</script>

<div class="application-panel">
  <div class="toolbar">
    <div class="toolbar-left">
      <div class="search-box">
        <UIIcon name="search" size={12} />
        <input type="text" placeholder="Search keys/cookies/db..." bind:value={search} />
      </div>
      <select bind:value={areaFilter}>
        <option value="all">All</option>
        <option value="localStorage">localStorage</option>
        <option value="sessionStorage">sessionStorage</option>
        <option value="cookies">cookies</option>
        <option value="indexeddb">indexedDB</option>
      </select>
      <label class="checkbox">
        <input type="checkbox" bind:checked={showSensitive} />
        <span>Show sensitive</span>
      </label>
    </div>
    <div class="toolbar-right">
      {#if onAskAI}
        <button class="action" type="button" onclick={askAI}>
          <UIIcon name="sparkle" size={12} />
          <span>Ask AI</span>
        </button>
      {/if}
      <button class="icon-btn" type="button" title="Refresh capture" disabled={isRefreshing} onclick={refresh}>
        <UIIcon name={isRefreshing ? 'spinner' : 'refresh'} size={12} />
      </button>
      <button class="icon-btn" type="button" title="Clear snapshot" onclick={() => browserDevToolsStore.clearApplication()}>
        <UIIcon name="trash" size={12} />
      </button>
    </div>
  </div>

  {#if !appData}
    <div class="empty">
      <UIIcon name="files" size={20} />
      <span>No application snapshot yet</span>
      <span class="hint">Capture storage/cookies/indexedDB from current page.</span>
      <button class="empty-action" type="button" disabled={!browserStore.isOpen || isRefreshing} onclick={refresh}>
        Capture now
      </button>
    </div>
  {:else}
    <div class="grid">
      {#if areaFilter === 'all' || areaFilter === 'localStorage' || areaFilter === 'sessionStorage'}
        <section class="card">
          <h4>Storage ({storageEntries.length})</h4>
          <div class="table-wrap" onscroll={onStorageScroll}>
            <table>
              <thead><tr><th>Area</th><th>Key</th><th>Value</th><th>Len</th></tr></thead>
              <tbody>
                {#each visibleStorageEntries as entry (entry.area + ':' + entry.key)}
                  <tr>
                    <td>{entry.area}</td>
                    <td class="mono">{entry.key}</td>
                    <td class={`mono ${entry.is_sensitive ? 'sensitive' : ''}`} title={displayValue(entry)}>{displayValue(entry)}</td>
                    <td>{entry.value_length}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
            {#if visibleStorageEntries.length < storageEntries.length}
              <div class="more">Showing {visibleStorageEntries.length}/{storageEntries.length} rows. Scroll to load more.</div>
            {/if}
          </div>
        </section>
      {/if}

      {#if areaFilter === 'all' || areaFilter === 'cookies'}
        <section class="card">
          <h4>Cookies ({cookies.length})</h4>
          <div class="table-wrap" onscroll={onCookieScroll}>
            <table>
              <thead><tr><th>Name</th><th>Value</th><th>Domain</th><th>Flags</th></tr></thead>
              <tbody>
                {#each visibleCookies as cookie (cookie.name + ':' + (cookie.domain || ''))}
                  <tr>
                    <td class="mono">{cookie.name}</td>
                    <td class={`mono ${cookie.is_sensitive ? 'sensitive' : ''}`} title={displayCookieValue(cookie)}>{displayCookieValue(cookie)}</td>
                    <td>{cookie.domain || '-'}</td>
                    <td>{cookie.secure ? 'Secure ' : ''}{cookie.httpOnly ? 'HttpOnly' : ''}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
            {#if visibleCookies.length < cookies.length}
              <div class="more">Showing {visibleCookies.length}/{cookies.length} rows. Scroll to load more.</div>
            {/if}
          </div>
        </section>
      {/if}

      {#if areaFilter === 'all' || areaFilter === 'indexeddb'}
        <section class="card">
          <h4>IndexedDB ({indexeddb.length})</h4>
          <div class="db-list">
            {#if indexeddb.length === 0}
              <span class="hint">No IndexedDB metadata captured.</span>
            {:else}
              {#each indexeddb as db (db.name)}
                <div class="db-row">
                  <span class="mono">{db.name}</span>
                  <span>v{db.version ?? '-'}</span>
                  <span>{db.object_store_count} stores</span>
                </div>
              {/each}
            {/if}
          </div>
        </section>
      {/if}
    </div>
  {/if}

  {#if warnings.length > 0}
    <div class="warnings">{warnings.join(' | ')}</div>
  {/if}
  {#if captureError}
    <div class="error">{captureError}</div>
  {/if}
</div>

<style>
  .application-panel { height: 100%; display: flex; flex-direction: column; background: var(--color-bg); font-size: 11px; }
  .toolbar { display: flex; justify-content: space-between; gap: 8px; padding: 8px; border-bottom: 1px solid var(--color-border); background: var(--color-bg-panel); }
  .toolbar-left, .toolbar-right { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .search-box { display: inline-flex; align-items: center; gap: 6px; padding: 0 8px; border: 1px solid var(--color-border); border-radius: 6px; background: var(--color-surface0); height: 26px; }
  .search-box input { width: 220px; border: none; outline: none; background: transparent; color: var(--color-text); font-size: 11px; }
  select { height: 26px; border-radius: 6px; border: 1px solid var(--color-border); background: var(--color-surface0); color: var(--color-text); padding: 0 8px; font-size: 11px; }
  .checkbox { display: inline-flex; align-items: center; gap: 4px; color: var(--color-text-secondary); }
  .action, .icon-btn, .empty-action { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--color-border); background: var(--color-surface0); color: var(--color-text-secondary); border-radius: 6px; padding: 0 8px; height: 26px; }
  .icon-btn { width: 26px; justify-content: center; padding: 0; }
  .action:hover, .icon-btn:hover, .empty-action:hover { color: var(--color-text); border-color: var(--color-accent); }
  .empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--color-text-secondary); }
  .hint { opacity: 0.75; }
  .grid { flex: 1; min-height: 0; overflow: auto; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; padding: 8px; }
  .card { border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-bg-panel); display: flex; flex-direction: column; min-height: 240px; }
  .card h4 { margin: 0; padding: 8px; font-size: 11px; color: var(--color-text-secondary); border-bottom: 1px solid var(--color-border); text-transform: uppercase; letter-spacing: 0.4px; }
  .table-wrap { flex: 1; overflow: auto; }
  .more { position: sticky; bottom: 0; background: color-mix(in srgb, var(--color-bg-panel) 85%, transparent); border-top: 1px solid var(--color-border); padding: 6px 8px; color: var(--color-text-secondary); font-size: 10px; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  th, td { padding: 6px 8px; border-bottom: 1px solid var(--color-border); text-align: left; vertical-align: top; }
  th { position: sticky; top: 0; background: var(--color-bg-panel); z-index: 1; color: var(--color-text-secondary); font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px; }
  .mono { font-family: 'JetBrains Mono', 'Fira Code', monospace; word-break: break-word; }
  .sensitive { color: #f59e0b; }
  .db-list { padding: 8px; display: flex; flex-direction: column; gap: 6px; overflow: auto; }
  .db-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; border: 1px solid var(--color-border); border-radius: 6px; padding: 6px 8px; }
  .warnings, .error { border-top: 1px solid var(--color-border); padding: 6px 8px; font-size: 10px; }
  .warnings { color: var(--color-warning); background: color-mix(in srgb, var(--color-warning) 8%, transparent); }
  .error { color: var(--color-error); background: color-mix(in srgb, var(--color-error) 8%, transparent); }
</style>
