<script lang="ts">
  import { aiSettingsStore, PROVIDERS, type AIMode, type AIProvider } from '$lib/stores/ai.svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import UIIcon from '$lib/components/ui/UIIcon.svelte';
  import { onMount } from 'svelte';
  import { getModelConfig, formatContextSize } from '$lib/services/ai/models';
  import { validateGeminiKey } from '$lib/services/ai/gemini';
  import { validateOpenRouterKey } from '$lib/services/ai/openrouter';

  let apiKeyInput = $state('');
  let showKey = $state(false);
  let isSaving = $state(false);

  onMount(async () => {
    await aiSettingsStore.initialize();
    if (aiSettingsStore.hasApiKey[aiSettingsStore.selectedProvider]) {
      apiKeyInput = '••••••••••••••••••••';
    }
  });

  const currentProvider = $derived(PROVIDERS[aiSettingsStore.selectedProvider]);
  
  // Get current model config for displaying info
  const currentAgentModel = $derived(aiSettingsStore.modelPerMode['agent']);
  const currentModelConfig = $derived(getModelConfig(currentAgentModel));

  function handleProviderChange(e: Event): void {
    const newProvider = (e.target as HTMLSelectElement).value as AIProvider;
    aiSettingsStore.setProvider(newProvider);
    // Reset API key input when switching providers
    if (aiSettingsStore.hasApiKey[newProvider]) {
      apiKeyInput = '••••••••••••••••••••';
    } else {
      apiKeyInput = '';
    }
  }

  async function handleSaveKey(): Promise<void> {
    if (!apiKeyInput || apiKeyInput.startsWith('••')) {
      showToast({ message: 'Please enter a valid API key', type: 'warning' });
      return;
    }
    isSaving = true;
    try {
      await aiSettingsStore.saveApiKey(aiSettingsStore.selectedProvider, apiKeyInput);
      apiKeyInput = '••••••••••••••••••••';
      showToast({ message: 'API key saved securely', type: 'success' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save';
      showToast({ message: msg, type: 'error' });
    } finally {
      isSaving = false;
    }
  }

  async function handleValidate(): Promise<void> {
    const canValidateTyped = !!apiKeyInput && !apiKeyInput.startsWith('••');
    
    if (canValidateTyped) {
      // Validate the typed key directly
      if (aiSettingsStore.selectedProvider === 'gemini') {
        const result = await validateGeminiKey(apiKeyInput);
        if (result.success) {
          showToast({ message: 'API key is valid!', type: 'success' });
        } else {
          showToast({ message: result.error ?? 'Validation failed', type: 'error' });
        }
      } else if (aiSettingsStore.selectedProvider === 'openrouter') {
        const result = await validateOpenRouterKey(apiKeyInput);
        if (result.success) {
          showToast({ message: 'API key is valid!', type: 'success' });
        } else {
          showToast({ message: result.error ?? 'Validation failed', type: 'error' });
        }
      }
    } else {
      // Validate stored key
      const result = await aiSettingsStore.validateApiKey(aiSettingsStore.selectedProvider);
      if (result.success) {
        showToast({ message: 'API key is valid!', type: 'success' });
      } else {
        showToast({ message: result.error ?? 'Validation failed', type: 'error' });
      }
    }
  }

  async function handleRemoveKey(): Promise<void> {
    const ok = confirm('Remove the API key for this provider?');
    if (!ok) return;
    await aiSettingsStore.removeApiKey(aiSettingsStore.selectedProvider);
    apiKeyInput = '';
    showToast({ message: 'API key removed', type: 'info' });
  }

  function handleInputFocus(): void {
    if (apiKeyInput.startsWith('••')) {
      apiKeyInput = '';
    }
  }

  function handleInputBlur(): void {
    if (!apiKeyInput && aiSettingsStore.hasApiKey[aiSettingsStore.selectedProvider]) {
      apiKeyInput = '••••••••••••••••••••';
    }
  }

  const modelOptions = $derived(currentProvider.models);

  function formatModelLabel(model: string): string {
    const thinking = model.endsWith('|thinking');
    const base = thinking ? model.slice(0, -'|thinking'.length) : model;
    
    // For OpenRouter models (format: org/model:variant)
    if (base.includes('/')) {
      const parts = base.split('/');
      const modelPart = parts[parts.length - 1];
      // Remove :free suffix for display but keep it in value
      const displayName = modelPart.replace(':free', ' (free)');
      return thinking ? `${displayName} (thinking)` : displayName;
    }
    
    return thinking ? `${base} (thinking)` : base;
  }

  const modeLabels: Record<AIMode, string> = {
    ask: 'Ask Mode',
    plan: 'Plan Mode',
    agent: 'Agent Mode'
  };
</script>

<div class="ai-settings">
  <div class="section-title">AI Provider</div>

  <div class="setting">
    <div class="setting-label">
      <div class="name">Provider</div>
      <div class="description">Select your AI provider</div>
    </div>
    <div class="setting-control">
      <select class="select" value={aiSettingsStore.selectedProvider} onchange={handleProviderChange} aria-label="AI Provider">
        {#each Object.values(PROVIDERS) as provider (provider.id)}
          <option value={provider.id}>{provider.name}</option>
        {/each}
      </select>
    </div>
  </div>

  <div class="setting">
    <div class="setting-label">
      <div class="name">API Key</div>
      <div class="description">
        Your {currentProvider.name} API key (stored securely)
        {#if aiSettingsStore.selectedProvider === 'openrouter'}
          <br/><a href="https://openrouter.ai/keys" target="_blank" class="key-link">Get free API key →</a>
        {:else if aiSettingsStore.selectedProvider === 'gemini'}
          <br/><a href="https://aistudio.google.com/apikey" target="_blank" class="key-link">Get API key →</a>
        {/if}
      </div>
    </div>
    <div class="setting-control key-control">
      <div class="key-input-row">
        <input
          class="text-input"
          type={showKey ? 'text' : 'password'}
          placeholder="Enter API key..."
          bind:value={apiKeyInput}
          onfocus={handleInputFocus}
          onblur={handleInputBlur}
          aria-label="API Key"
        />
        <button class="icon-btn" type="button" onclick={() => showKey = !showKey} aria-label={showKey ? 'Hide key' : 'Show key'}>
          <UIIcon name={showKey ? 'eye-off' : 'eye'} size={14} />
        </button>
      </div>
      <div class="key-actions">
        <button class="btn primary" type="button" onclick={handleSaveKey} disabled={isSaving || !apiKeyInput || apiKeyInput.startsWith('••')}>
          {isSaving ? 'Saving...' : 'Save'}
        </button>
        <button class="btn" type="button" onclick={handleValidate} disabled={aiSettingsStore.isValidating || (!aiSettingsStore.hasApiKey[aiSettingsStore.selectedProvider] && (!apiKeyInput || apiKeyInput.startsWith('••')))}>
          {aiSettingsStore.isValidating ? 'Validating...' : 'Validate'}
        </button>
        {#if aiSettingsStore.hasApiKey[aiSettingsStore.selectedProvider]}
          <button class="btn danger" type="button" onclick={handleRemoveKey}>Remove</button>
        {/if}
      </div>
    </div>
  </div>

  {#if aiSettingsStore.validationError}
    <div class="error-banner">{aiSettingsStore.validationError}</div>
  {/if}

  {#if aiSettingsStore.hasApiKey[aiSettingsStore.selectedProvider]}
    <div class="success-indicator">✓ API key configured</div>
  {/if}

  <div class="section-title model-section">Model Selection</div>

  {#each (['ask', 'plan', 'agent'] as AIMode[]) as mode (mode)}
    {@const selectedModel = aiSettingsStore.modelPerMode[mode]}
    {@const modelConfig = getModelConfig(selectedModel)}
    <div class="setting">
      <div class="setting-label">
        <div class="name">{modeLabels[mode]}</div>
        <div class="description">
          {#if mode === 'agent' && !aiSettingsStore.agentModeAvailable}
            <span class="warning">⚠️ Requires tool support</span>
          {:else if mode === 'agent' && modelConfig && !modelConfig.supportsTools}
            <span class="warning">⚠️ Model doesn't support tools</span>
          {:else if modelConfig}
            Context: {formatContextSize(modelConfig.contextWindow)} · Output: {formatContextSize(modelConfig.maxOutput)}
            {#if modelConfig.free}<span class="free-badge">FREE</span>{/if}
            {#if !modelConfig.supportsTools}<span class="no-tools-badge">NO TOOLS</span>{/if}
          {:else}
            Model for {mode} operations
          {/if}
        </div>
      </div>
      <div class="setting-control">
        <select
          class="select"
          value={aiSettingsStore.modelPerMode[mode]}
          onchange={(e) => aiSettingsStore.setModelForMode(mode, (e.target as HTMLSelectElement).value)}
          disabled={mode === 'agent' && !aiSettingsStore.agentModeAvailable}
          aria-label="{modeLabels[mode]} model"
        >
          {#each modelOptions as model (model)}
            <option value={model}>{formatModelLabel(model)}</option>
          {/each}
        </select>
      </div>
    </div>
  {/each}

  <div class="capabilities">
    <div class="cap-title">Provider Capabilities</div>
    <div class="cap-list">
      <span class="cap" class:supported={currentProvider.capabilities.supportsStreaming}>
        {currentProvider.capabilities.supportsStreaming ? '✓' : '✗'} Streaming
      </span>
      <span class="cap" class:supported={currentProvider.capabilities.supportsTools}>
        {currentProvider.capabilities.supportsTools ? '✓' : '✗'} Tool Calling
      </span>
      <span class="cap" class:supported={currentProvider.capabilities.supportsJsonSchema}>
        {currentProvider.capabilities.supportsJsonSchema ? '✓' : '✗'} JSON Schema
      </span>
    </div>
  </div>
</div>


<style>
  .ai-settings { display: flex; flex-direction: column; gap: 12px; }
  .section-title { font-size: 11px; font-weight: 600; letter-spacing: 0.4px; color: var(--color-text-secondary); text-transform: uppercase; padding-bottom: 4px; border-bottom: 1px solid var(--color-border); }
  .model-section { margin-top: 8px; }
  .setting { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 8px 0; }
  .setting-label { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 160px; }
  .name { font-size: 13px; color: var(--color-text); }
  .description { font-size: 12px; color: var(--color-text-secondary); }
  .setting-control { display: flex; flex-direction: column; gap: 8px; flex: 1 1 200px; }
  .key-control { flex: 1 1 280px; }
  .key-input-row { display: flex; gap: 4px; }
  .key-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .select { background: var(--color-bg-input); border: 1px solid var(--color-border); color: var(--color-text); border-radius: 4px; padding: 6px 8px; font-size: 13px; min-width: 140px; }
  .text-input { flex: 1; background: var(--color-bg-input); border: 1px solid var(--color-border); color: var(--color-text); border-radius: 4px; padding: 6px 8px; font-size: 13px; font-family: monospace; }
  .icon-btn { background: var(--color-bg-input); border: 1px solid var(--color-border); color: var(--color-text); border-radius: 4px; padding: 6px 8px; cursor: pointer; font-size: 14px; }
  .icon-btn:hover { background: var(--color-hover); }
  .btn { background: var(--color-bg-input); border: 1px solid var(--color-border); color: var(--color-text); border-radius: 4px; padding: 6px 12px; font-size: 12px; cursor: pointer; }
  .btn:hover:not(:disabled) { background: var(--color-hover); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn.primary { background: var(--color-accent); border-color: var(--color-accent); color: var(--color-bg); }
  .btn.primary:hover:not(:disabled) { filter: brightness(1.1); }
  .btn.danger { color: var(--color-error); border-color: var(--color-error); }
  .btn.danger:hover:not(:disabled) { background: var(--color-error); color: var(--color-bg); }
  .error-banner { background: color-mix(in srgb, var(--color-error) 15%, transparent); border: 1px solid var(--color-error); border-radius: 4px; padding: 8px 12px; font-size: 12px; color: var(--color-error); }
  .success-indicator { font-size: 12px; color: var(--color-success); padding: 4px 0; }
  .warning { color: var(--color-warning); }
  .capabilities { margin-top: 8px; padding: 10px; background: var(--color-bg-input); border: 1px solid var(--color-border); border-radius: 4px; }
  .cap-title { font-size: 11px; font-weight: 600; color: var(--color-text-secondary); margin-bottom: 6px; }
  .cap-list { display: flex; gap: 12px; flex-wrap: wrap; }
  .cap { font-size: 12px; color: var(--color-text-secondary); }
  .cap.supported { color: var(--color-success); }
  .key-link { color: var(--color-accent); text-decoration: none; font-size: 11px; }
  .key-link:hover { text-decoration: underline; }
  .free-badge { display: inline-block; background: var(--color-success); color: var(--color-bg); font-size: 9px; font-weight: 600; padding: 1px 4px; border-radius: 3px; margin-left: 4px; vertical-align: middle; }
  .no-tools-badge { display: inline-block; background: var(--color-warning); color: var(--color-bg); font-size: 9px; font-weight: 600; padding: 1px 4px; border-radius: 3px; margin-left: 4px; vertical-align: middle; }
  .select:focus-visible, .text-input:focus-visible, .btn:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 1px; }
</style>
