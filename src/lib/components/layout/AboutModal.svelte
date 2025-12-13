<script lang="ts">
  import { uiStore } from '$lib/stores/ui.svelte';

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
      <div class="modal-header">
        <h2 id="about-title">About Volt</h2>
        <button class="close-btn" onclick={handleClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div class="modal-body">
        <div class="logo">⚡</div>
        <h1 class="app-title">Volt</h1>
        <p class="version">Version 0.1.0</p>
        <p class="description">
          A lightweight, fast code editor for web development.
        </p>

        <div class="tech-stack">
          <h3>Built with</h3>
          <ul>
            <li>Tauri v2 + Rust</li>
            <li>Svelte 5 + TypeScript</li>
            <li>Tailwind CSS</li>
          </ul>
        </div>

        <p class="copyright">
          © 2025 Volt. All rights reserved.
        </p>
      </div>

      <div class="modal-footer">
        <button class="btn-primary" onclick={handleClose}>
          OK
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
  }

  .modal-content {
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    width: 420px;
    max-width: 90vw;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--color-border);
  }

  .modal-header h2 {
    font-size: 16px;
    font-weight: 600;
    color: var(--color-text);
    margin: 0;
  }

  .close-btn {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--color-text-secondary);
    border-radius: 4px;
    transition: all 0.1s ease;
  }

  .close-btn:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .modal-body {
    padding: 24px 20px;
    text-align: center;
  }

  .logo {
    font-size: 48px;
    margin-bottom: 12px;
  }

  .app-title {
    font-size: 24px;
    font-weight: 700;
    color: var(--color-text);
    margin: 0 0 8px 0;
  }

  .version {
    font-size: 14px;
    color: var(--color-text-secondary);
    margin: 0 0 16px 0;
  }

  .description {
    font-size: 14px;
    color: var(--color-text);
    margin: 0 0 20px 0;
  }

  .tech-stack {
    text-align: left;
    background: var(--color-bg-sidebar);
    border-radius: 6px;
    padding: 12px 16px;
    margin-bottom: 16px;
  }

  .tech-stack h3 {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text-secondary);
    text-transform: uppercase;
    margin: 0 0 8px 0;
  }

  .tech-stack ul {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .tech-stack li {
    font-size: 13px;
    color: var(--color-text);
    padding: 4px 0;
  }

  .copyright {
    font-size: 12px;
    color: var(--color-text-disabled);
    margin: 0;
  }

  .modal-footer {
    padding: 16px 20px;
    border-top: 1px solid var(--color-border);
    display: flex;
    justify-content: flex-end;
  }

  .btn-primary {
    padding: 8px 20px;
    background: var(--color-accent);
    color: var(--color-bg);
    font-size: 13px;
    font-weight: 500;
    border-radius: 4px;
    transition: opacity 0.1s ease;
  }

  .btn-primary:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  .btn-primary:hover {
    opacity: 0.9;
  }
</style>
