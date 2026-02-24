<script lang="ts">
  import { uiStore } from '$lib/stores/ui.svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { UIIcon } from '$lib/components/ui';

  interface SystemInfo {
    os_name: string | null;
    os_version: string | null;
    kernel_version: string | null;
    host_name: string | null;
    total_memory: number;
    cpu_count: number;
    cpu_brand: string | null;
  }

  let systemInfo = $state<SystemInfo | null>(null);
  let loadingSystemInfo = $state(false);

  $effect(() => {
    if (uiStore.aboutModalOpen && !systemInfo && !loadingSystemInfo) {
      loadingSystemInfo = true;
      invoke<SystemInfo>('get_system_info')
        .then((info) => {
          systemInfo = info;
        })
        .catch((err) => {
          console.error('Failed to get system info:', err);
        })
        .finally(() => {
          loadingSystemInfo = false;
        });
    }
  });

  function formatBytes(bytes: number): string {
    const gb = bytes / (1024 * 1024 * 1024);
    return `${gb.toFixed(1)} GB`;
  }

  function handleClose() {
    uiStore.closeAboutModal();
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      handleClose();
    }
  }

  function handleBackdropKeydown(e: KeyboardEvent) {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
      handleClose();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if uiStore.aboutModalOpen}
  <div
    class="modal-backdrop"
    onclick={handleBackdropClick}
    onkeydown={handleBackdropKeydown}
    role="presentation"
  >
    <div
      class="modal-content"
      role="dialog"
      aria-modal="true"
      aria-labelledby="about-title"
      tabindex="0"
    >
      <button class="close-btn" onclick={handleClose} aria-label="Close">
        <UIIcon name="close" size={16} />
      </button>

      <div class="modal-body">
        <div class="header-section">
          <div class="logo" aria-hidden="true"><UIIcon name="bolt" size={22} /></div>
          <div class="title-group">
            <h1 id="about-title" class="app-title">Volt</h1>
            <span class="version">v0.1.0</span>
          </div>
        </div>

        <p class="description">A fast, smooth code editor for web development.</p>

        <div class="info-grid">
          <div class="info-card">
            <h3>Built With</h3>
            <div class="tech-list">
              <span class="tech-tag">Tauri v2</span>
              <span class="tech-tag">Rust</span>
              <span class="tech-tag">Svelte 5</span>
              <span class="tech-tag">TypeScript</span>
            </div>
          </div>

          <div class="info-card">
            <h3>System</h3>
            {#if loadingSystemInfo}
              <p class="loading">Loading...</p>
            {:else if systemInfo}
              <div class="system-list">
                <div class="sys-row">
                  <span class="sys-label">OS</span>
                  <span class="sys-value">{systemInfo.os_name ?? 'Unknown'}</span>
                </div>
                <div class="sys-row">
                  <span class="sys-label">Memory</span>
                  <span class="sys-value">{formatBytes(systemInfo.total_memory)}</span>
                </div>
                <div class="sys-row">
                  <span class="sys-label">CPU</span>
                  <span class="sys-value">{systemInfo.cpu_count} cores</span>
                </div>
              </div>
            {:else}
              <p class="error">Unable to load</p>
            {/if}
          </div>
        </div>

        <p class="copyright">© 2026 Volt</p>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--color-bg) 35%, transparent);
    backdrop-filter: blur(6px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
    padding: 16px;
  }

  .modal-content {
    position: relative;
    background: var(--color-bg-elevated, var(--color-bg));
    border: 1px solid var(--color-border);
    border-radius: 12px;
    width: 100%;
    max-width: 360px;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: var(--shadow-elevated, 0 10px 32px rgba(0, 0, 0, 0.35));
  }

  .close-btn {
    position: absolute;
    top: 12px;
    right: 12px;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-secondary);
    border-radius: 4px;
    font-size: 12px;
    transition: all 0.15s ease;
    z-index: 1;
  }

  .close-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .modal-body {
    padding: 24px;
  }

  .header-section {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }

  .logo {
    font-size: 36px;
    line-height: 1;
  }

  .title-group {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .app-title {
    font-size: 22px;
    font-weight: 700;
    color: var(--color-text);
    margin: 0;
  }

  .version {
    font-size: 12px;
    color: var(--color-text-secondary);
    background: var(--color-bg-sidebar);
    padding: 2px 6px;
    border-radius: 4px;
  }

  .description {
    font-size: 13px;
    color: var(--color-text-secondary);
    margin: 0 0 16px 0;
    line-height: 1.4;
  }

  .info-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 12px;
    margin-bottom: 16px;
  }

  .info-card {
    background: var(--color-bg-sidebar);
    border-radius: 8px;
    padding: 12px;
  }

  .info-card h3 {
    font-size: 10px;
    font-weight: 600;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 0 0 8px 0;
  }

  .tech-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .tech-tag {
    font-size: 11px;
    color: var(--color-text);
    background: var(--color-bg);
    padding: 3px 8px;
    border-radius: 4px;
    border: 1px solid var(--color-border);
  }

  .system-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .sys-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .sys-label {
    font-size: 12px;
    color: var(--color-text-secondary);
  }

  .sys-value {
    font-size: 12px;
    color: var(--color-text);
    font-weight: 500;
  }

  .loading,
  .error {
    font-size: 12px;
    color: var(--color-text-secondary);
    margin: 0;
  }

  .copyright {
    font-size: 11px;
    color: var(--color-text-disabled);
    margin: 0;
    text-align: center;
  }

  @media (max-width: 400px) {
    .modal-content {
      max-width: 100%;
    }
  }
</style>
