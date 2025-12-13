<script lang="ts">
  import { fly, fade } from 'svelte/transition';
  import type { Toast, ToastType } from '$lib/stores/toast.svelte';
  import { dismissToast } from '$lib/stores/toast.svelte';

  interface Props {
    toast: Toast;
  }

  let { toast }: Props = $props();

  const iconMap: Record<ToastType, string> = {
    success: '✓',
    error: '✕',
    warning: '⚠',
    info: 'ℹ'
  };

  const colorMap: Record<ToastType, string> = {
    success: 'var(--color-success)',
    error: 'var(--color-error)',
    warning: 'var(--color-warning)',
    info: 'var(--color-accent)'
  };

  // a11y: errors/warnings use assertive, success/info use polite
  const ariaLiveMap: Record<ToastType, 'assertive' | 'polite'> = {
    success: 'polite',
    error: 'assertive',
    warning: 'assertive',
    info: 'polite'
  };

  // a11y: errors/warnings use alert role, success/info use status
  const roleMap: Record<ToastType, 'alert' | 'status'> = {
    success: 'status',
    error: 'alert',
    warning: 'alert',
    info: 'status'
  };

  function handleDismiss() {
    dismissToast(toast.id);
  }

  function handleAction() {
    if (toast.action) {
      toast.action.onClick();
      dismissToast(toast.id);
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      handleDismiss();
    }
  }
</script>

<div
  class="toast"
  role={roleMap[toast.type]}
  aria-live={ariaLiveMap[toast.type]}
  in:fly={{ x: 100, duration: 200 }}
  out:fade={{ duration: 150 }}
  style="--toast-accent: {colorMap[toast.type]}"
>
  <div class="toast-icon" aria-hidden="true">
    {iconMap[toast.type]}
  </div>
  
  <div class="toast-content">
    <span class="toast-message">
      {toast.message}
      {#if toast.count > 1}
        <span class="toast-count">(x{toast.count})</span>
      {/if}
    </span>
  </div>

  {#if toast.action}
    <button
      class="toast-action"
      onclick={handleAction}
      type="button"
    >
      {toast.action.label}
    </button>
  {/if}

  <button
    class="toast-close"
    onclick={handleDismiss}
    onkeydown={handleKeydown}
    aria-label="Dismiss notification"
    type="button"
  >
    ✕
  </button>
</div>

<style>
  .toast {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    background: var(--color-surface0);
    border: 1px solid var(--color-border);
    border-left: 3px solid var(--toast-accent);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    min-width: 280px;
    max-width: 400px;
    pointer-events: auto;
  }

  .toast-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    color: var(--toast-accent);
    font-size: 14px;
    flex-shrink: 0;
  }

  .toast-content {
    flex: 1;
    min-width: 0;
  }

  .toast-message {
    color: var(--color-text);
    font-size: 13px;
    line-height: 1.4;
    word-wrap: break-word;
  }

  .toast-count {
    color: var(--color-text-secondary);
    font-size: 12px;
    margin-left: 0.25rem;
  }

  .toast-action {
    padding: 0.25rem 0.5rem;
    background: transparent;
    border: 1px solid var(--toast-accent);
    border-radius: 4px;
    color: var(--toast-accent);
    font-size: 12px;
    cursor: pointer;
    transition: background-color 0.15s ease;
    flex-shrink: 0;
  }

  .toast-action:hover {
    background: var(--toast-accent);
    color: var(--color-bg);
  }

  .toast-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    color: var(--color-text-secondary);
    font-size: 12px;
    cursor: pointer;
    border-radius: 4px;
    transition: color 0.15s ease, background-color 0.15s ease;
    flex-shrink: 0;
  }

  .toast-close:hover {
    color: var(--color-text);
    background: var(--color-hover);
  }
</style>
