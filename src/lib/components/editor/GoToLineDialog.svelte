<script lang="ts">
  import { UIIcon } from '$lib/components/ui';

  interface Props {
    open: boolean;
    maxLine: number;
    onGo: (line: number) => void;
    onClose: () => void;
  }

  let { open, maxLine, onGo, onClose }: Props = $props();

  let inputValue = $state('');
  let inputElement: HTMLInputElement | undefined = $state();

  // Focus input when dialog opens
  $effect(() => {
    if (open) {
      inputValue = '';
      setTimeout(() => inputElement?.focus(), 0);
    }
  });

  function handleSubmit(e: Event) {
    e.preventDefault();
    const line = parseInt(inputValue, 10);
    if (!isNaN(line) && line >= 1 && line <= maxLine) {
      onGo(line);
      onClose();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="dialog-backdrop" role="presentation" onclick={handleBackdropClick}>
    <div class="dialog" role="dialog" aria-label="Go to Line">
      <form onsubmit={handleSubmit}>
        <div class="input-container">
          <span class="input-icon">
            <UIIcon name="code" size={16} />
          </span>
          <input
            bind:this={inputElement}
            bind:value={inputValue}
            type="text"
            class="line-input"
            placeholder="Go to line (1-{maxLine})"
            autocomplete="off"
            spellcheck="false"
          />
          <span class="hint">
            <kbd>Enter</kbd>
          </span>
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  .dialog-backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--color-bg) 40%, transparent);
    backdrop-filter: blur(4px);
    display: flex;
    justify-content: center;
    padding-top: 15vh;
    z-index: 9999;
  }

  .dialog {
    width: 100%;
    max-width: 400px;
    background: var(--color-bg-elevated, var(--color-bg-sidebar));
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: var(--shadow-elevated, 0 10px 32px rgba(0, 0, 0, 0.35));
    overflow: hidden;
    height: fit-content;
  }

  .input-container {
    display: flex;
    align-items: center;
    padding: 10px 12px;
    gap: 10px;
  }

  .input-icon {
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }

  .line-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    font-size: 14px;
    color: var(--color-text);
    padding: 0;
    font-family: inherit;
  }

  .line-input::placeholder {
    color: var(--color-text-secondary);
  }

  .hint {
    flex-shrink: 0;
    opacity: 0.7;
  }

  kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    height: 22px;
    padding: 0 6px;
    font-size: 11px;
    font-family: inherit;
    color: var(--color-text-secondary);
    background: color-mix(in srgb, var(--color-surface0) 78%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-border) 80%, transparent);
    border-radius: 6px;
  }
</style>
