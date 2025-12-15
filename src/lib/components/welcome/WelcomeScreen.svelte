<script lang="ts">
  import { projectStore } from '$lib/stores/project.svelte';
  import { openFolderDialog, openFileDialog } from '$lib/services/file-system';
  import { UIIcon } from '$lib/components/ui';

  async function handleOpenFolder() {
    const path = await openFolderDialog();
    if (path) {
      await projectStore.openProject(path);
    }
  }

  async function handleOpenFile() {
    const path = await openFileDialog();
    if (path) {
      // For now, just show a toast - file opening will be implemented in editor tasks
      const { showToast } = await import('$lib/stores/toast.svelte');
      showToast({
        message: 'File editor coming soon',
        type: 'info'
      });
    }
  }

  async function handleOpenRecent(path: string) {
    const success = await projectStore.openProject(path);
    if (!success) {
      // Project failed to open - it may have been moved/deleted
      // The error toast is already shown by openProject
      projectStore.removeFromRecentProjects(path);
    }
  }

  function extractFolderName(path: string): string {
    const parts = path.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || path;
  }

  function formatPath(path: string): string {
    // Shorten long paths for display
    const maxLength = 50;
    if (path.length <= maxLength) return path;
    
    const parts = path.replace(/\\/g, '/').split('/');
    if (parts.length <= 3) return path;
    
    return parts[0] + '/.../' + parts.slice(-2).join('/');
  }
</script>

<div class="welcome-screen">
  <div class="welcome-content">
    <!-- Logo -->
    <div class="logo-section">
      <div class="logo">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" fill="url(#bolt-gradient)" stroke="var(--color-accent)" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
          <defs>
            <linearGradient id="bolt-gradient" x1="4" y1="2" x2="20" y2="22" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="#f9e2af"/>
              <stop offset="100%" stop-color="#fab387"/>
            </linearGradient>
          </defs>
        </svg>
      </div>
      <h1 class="title">VOLT</h1>
      <p class="subtitle">Fast Code Editor</p>
    </div>

    <!-- Start Section -->
    <div class="start-section">
      <h2 class="section-title">Start</h2>
      
      <button class="action-button" onclick={handleOpenFolder}>
        <span class="action-icon"><UIIcon name="folder-open" size={18} /></span>
        <span class="action-text">Open Folder...</span>
      </button>
      
      <button class="action-button" onclick={handleOpenFile}>
        <span class="action-icon"><UIIcon name="file" size={18} /></span>
        <span class="action-text">Open File...</span>
      </button>
    </div>

    <!-- Recent Projects Section -->
    {#if projectStore.recentProjects.length > 0}
      <div class="recent-section">
        <h2 class="section-title">Recent</h2>
        
        <div class="recent-list">
          {#each projectStore.recentProjects as path (path)}
            <button 
              class="recent-item"
              onclick={() => handleOpenRecent(path)}
              title={path}
            >
              <span class="recent-icon"><UIIcon name="folder" size={18} /></span>
              <div class="recent-info">
                <span class="recent-name">{extractFolderName(path)}</span>
                <span class="recent-path">{formatPath(path)}</span>
              </div>
            </button>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .welcome-screen {
    display: flex;
    align-items: flex-start;
    justify-content: center;
    width: 100%;
    height: 100%;
    background: var(--color-bg);
    overflow-y: auto;
    overflow-x: hidden;
  }

  .welcome-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 24px;
    padding: 32px 24px;
    max-width: 400px;
    width: 100%;
    margin: auto 0;
  }

  .logo-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
  }

  .logo {
    display: flex;
    align-items: center;
    justify-content: center;
    filter: drop-shadow(0 4px 12px rgba(249, 226, 175, 0.35));
  }

  .logo svg {
    width: 48px;
    height: 48px;
  }

  .title {
    font-size: 28px;
    font-weight: 700;
    color: var(--color-text);
    margin: 0;
    letter-spacing: 5px;
    background: linear-gradient(135deg, var(--color-text) 0%, var(--color-accent) 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .subtitle {
    font-size: 13px;
    color: var(--color-text-secondary);
    margin: 0;
    font-weight: 400;
  }

  .start-section,
  .recent-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
  }

  .section-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 1.5px;
    margin: 0 0 4px 0;
    padding-left: 4px;
  }

  .action-button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 10px 14px;
    background: var(--color-bg-panel);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    color: var(--color-text);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .action-button:hover {
    background: var(--color-hover);
    border-color: var(--color-accent);
  }

  .action-button:active {
    transform: scale(0.98);
  }

  .action-icon {
    font-size: 16px;
    flex-shrink: 0;
  }

  .action-text {
    flex: 1;
  }

  .recent-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 200px;
    overflow-y: auto;
  }

  .recent-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 5px;
    color: var(--color-text);
    text-align: left;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .recent-item:hover {
    background: var(--color-hover);
    border-color: var(--color-border);
  }

  .recent-icon {
    font-size: 14px;
    flex-shrink: 0;
    opacity: 0.8;
  }

  .recent-info {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    flex: 1;
  }

  .recent-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--color-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .recent-path {
    font-size: 11px;
    color: var(--color-text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
