<script lang="ts">
  import { UIIcon } from '$shared/components/ui';

  interface Props {
    open: boolean;
    title: string;
    description?: string;
    placeholder?: string;
    initialValue?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    onConfirm: (value: string) => void;
    onCancel: () => void;
  }

  let {
    open,
    title,
    description,
    placeholder,
    initialValue = '',
    confirmLabel = 'OK',
    cancelLabel = 'Cancel',
    onConfirm,
    onCancel
  }: Props = $props();

  let value = $state('');
  let inputEl = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (!open) return;
    value = initialValue;
    queueMicrotask(() => inputEl?.focus());
  });

  function handleBackdropClick(e: MouseEvent): void {
    if (e.target === e.currentTarget) onCancel();
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      onConfirm(value);
    }
  }
</script>

{#if open}
  <div class="backdrop" role="presentation" onclick={handleBackdropClick} onkeydown={handleKeydown} tabindex="-1">
    <div class="modal" role="dialog" aria-modal="true" aria-label={title}>
      <div class="header">
        <div class="title">{title}</div>
        <button class="close" type="button" onclick={onCancel} aria-label="Close">
          <UIIcon name="close" size={16} />
        </button>
      </div>

      {#if description}
        <div class="description">{description}</div>
      {/if}

      <input bind:this={inputEl} bind:value placeholder={placeholder} autocomplete="off" spellcheck={false} />

      <div class="actions">
        <button class="btn" type="button" onclick={onCancel}>{cancelLabel}</button>
        <button class="btn primary" type="button" onclick={() => onConfirm(value)}>{confirmLabel}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 2000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--color-bg) 40%, transparent);
    backdrop-filter: blur(6px);
  }

  .modal {
    width: min(520px, calc(100vw - 32px));
    background: var(--color-bg-elevated, var(--color-bg-panel));
    border: 1px solid var(--color-border);
    border-radius: 10px;
    box-shadow: var(--shadow-elevated, 0 10px 32px rgba(0, 0, 0, 0.35));
    padding: 12px;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
  }

  .title {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.2px;
  }

  .close {
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border-radius: 6px;
    color: var(--color-text-secondary);
  }

  .close:hover {
    background: var(--color-hover);
    color: var(--color-text);
  }

  .description {
    color: var(--color-text-secondary);
    font-size: 12px;
    margin-bottom: 10px;
  }

  input {
    width: 100%;
    height: 34px;
    border-radius: 8px;
    padding: 0 10px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }

  .btn {
    height: 30px;
    padding: 0 12px;
    border-radius: 8px;
    color: var(--color-text);
    background: var(--color-surface0);
    border: 1px solid color-mix(in srgb, var(--color-border) 70%, transparent);
    transition: background-color 0.12s ease, border-color 0.12s ease;
  }

  .btn:hover {
    background: var(--color-hover);
  }

  .btn.primary {
    background: color-mix(in srgb, var(--color-accent) 18%, var(--color-surface0));
    border-color: color-mix(in srgb, var(--color-accent) 40%, var(--color-border));
  }

  .btn.primary:hover {
    background: color-mix(in srgb, var(--color-accent) 28%, var(--color-surface0));
  }
</style>
