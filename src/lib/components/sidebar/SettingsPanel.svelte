<script lang="ts">
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { themeStore, type ThemeMode } from "$lib/stores/theme.svelte";
  import AISettingsSection from "./AISettingsSection.svelte";

  function toNumber(value: string): number | null {
    if (value.trim() === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function handleThemeChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as ThemeMode;
    if (
      value === "dark-modern" ||
      value === "dark" ||
      value === "light" ||
      value === "midnight"
    ) {
      themeStore.setMode(value);
    }
  }

  function handleCheckboxChange(
    event: Event,
    setValue: (v: boolean) => void,
  ): void {
    setValue((event.target as HTMLInputElement).checked);
  }

  function handleNumberChange(
    event: Event,
    setValue: (v: number) => void,
  ): void {
    const n = toNumber((event.target as HTMLInputElement).value);
    if (n === null) return;
    setValue(n);
  }

  function handleResetDefaults(): void {
    const ok = confirm("Reset all settings to defaults?");
    if (!ok) return;
    settingsStore.resetToDefaults();
    themeStore.setMode("dark-modern");
  }

  const previewText = `function hello(name) {
  return "Hello, " + name;
}
`;
</script>

<div class="settings">
  <div class="header">
    <div class="header-title">Settings</div>
    <button
      class="reset"
      type="button"
      onclick={handleResetDefaults}
      aria-label="Reset settings to defaults"
    >
      Reset to defaults
    </button>
  </div>

  <div class="section">
    <div class="section-title">Appearance</div>

    <div class="setting">
      <div class="setting-label">
        <div class="name">Color theme</div>
        <div class="description">
          Choose Dark Modern, Dark, Midnight, Light, or follow System.
        </div>
      </div>
      <div class="setting-control">
        <select
          class="select"
          value={themeStore.mode}
          onchange={handleThemeChange}
          aria-label="Color theme"
        >
          <option value="dark-modern">Dark Modern</option>
          <option value="dark">Dark</option>
          <option value="midnight">Midnight</option>
          <option value="light">Light</option>
        </select>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Editor</div>

    <div class="setting">
      <div class="setting-label">
        <div class="name">Font size</div>
        <div class="description">Adjust the editor text size.</div>
      </div>
      <div class="setting-control">
        <input
          class="number"
          type="number"
          min={10}
          max={24}
          step={1}
          value={settingsStore.editorFontSize}
          oninput={(e) =>
            handleNumberChange(e, (v) => settingsStore.setEditorFontSize(v))}
          aria-label="Editor font size"
        />
      </div>
    </div>

    <div class="preview" aria-label="Editor font size preview">
      <div class="preview-title">Preview</div>
      <pre
        class="preview-code"
        style={`font-size: ${settingsStore.editorFontSize}px`}>{previewText}</pre>
      <div class="preview-hint">
        Open any file tab to see it applied in the editor.
      </div>
    </div>

    <div class="setting">
      <div class="setting-label">
        <div class="name">Line numbers</div>
        <div class="description">Show line numbers in the gutter.</div>
      </div>
      <div class="setting-control">
        <label class="checkbox">
          <input
            type="checkbox"
            checked={settingsStore.editorLineNumbersEnabled}
            onchange={(e) =>
              handleCheckboxChange(e, (v) =>
                settingsStore.setEditorLineNumbersEnabled(v),
              )}
          />
          <span>Enabled</span>
        </label>
      </div>
    </div>

    <div class="setting">
      <div class="setting-label">
        <div class="name">Minimap</div>
        <div class="description">Show the code minimap on the right.</div>
      </div>
      <div class="setting-control">
        <label class="checkbox">
          <input
            type="checkbox"
            checked={settingsStore.editorMinimapEnabled}
            onchange={(e) =>
              handleCheckboxChange(e, (v) =>
                settingsStore.setEditorMinimapEnabled(v),
              )}
          />
          <span>Enabled</span>
        </label>
      </div>
    </div>

    <div class="setting">
      <div class="setting-label">
        <div class="name">Indentation</div>
        <div class="description">Default indentation used by the editor.</div>
      </div>
      <div class="setting-control row">
        <label class="field">
          <span class="field-label">Tab size</span>
          <input
            class="number"
            type="number"
            min={1}
            max={8}
            step={1}
            value={settingsStore.editorTabSize}
            oninput={(e) =>
              handleNumberChange(e, (v) => settingsStore.setEditorTabSize(v))}
            aria-label="Editor tab size"
          />
        </label>

        <label class="checkbox field">
          <input
            type="checkbox"
            checked={settingsStore.editorInsertSpaces}
            onchange={(e) =>
              handleCheckboxChange(e, (v) =>
                settingsStore.setEditorInsertSpaces(v),
              )}
          />
          <span class="field-label">Spaces</span>
        </label>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Files</div>

    <div class="setting">
      <div class="setting-label">
        <div class="name">Auto-save</div>
        <div class="description">
          Save files automatically after a short delay.
        </div>
      </div>
      <div class="setting-control">
        <label class="checkbox">
          <input
            type="checkbox"
            checked={settingsStore.autoSaveEnabled}
            onchange={(e) =>
              handleCheckboxChange(e, (v) =>
                settingsStore.setAutoSaveEnabled(v),
              )}
          />
          <span>Enabled</span>
        </label>
      </div>
    </div>

    <div class="setting">
      <div class="setting-label">
        <div class="name">Auto-save delay (ms)</div>
        <div class="description">
          How long to wait after edits before saving.
        </div>
      </div>
      <div class="setting-control">
        <input
          class="number"
          type="number"
          min={500}
          max={5000}
          step={100}
          value={settingsStore.autoSaveDelay}
          disabled={!settingsStore.autoSaveEnabled}
          aria-disabled={!settingsStore.autoSaveEnabled}
          oninput={(e) =>
            handleNumberChange(e, (v) => settingsStore.setAutoSaveDelay(v))}
          aria-label="Auto-save delay"
        />
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Formatting</div>

    <div class="setting">
      <div class="setting-label">
        <div class="name">Format on save</div>
        <div class="description">
          Automatically format supported files when saving.
        </div>
      </div>
      <div class="setting-control">
        <label class="checkbox">
          <input
            type="checkbox"
            checked={settingsStore.formatOnSaveEnabled}
            onchange={(e) =>
              handleCheckboxChange(e, (v) =>
                settingsStore.setFormatOnSaveEnabled(v),
              )}
          />
          <span>Enabled</span>
        </label>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">AI</div>
    <div class="ai-section-content">
      <AISettingsSection />
    </div>
  </div>
</div>

<style>
  .settings {
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .header-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text);
  }

  .reset {
    background: var(--color-bg-input);
    border: 1px solid var(--color-border);
    color: var(--color-text);
    border-radius: 4px;
    padding: 6px 10px;
    font-size: 12px;
  }

  .reset:hover {
    background: var(--color-hover);
  }

  .reset:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }

  .preview {
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg-panel);
    padding: 10px 12px;
  }

  .preview-title {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    color: var(--color-text-secondary);
    margin-bottom: 8px;
  }

  .preview-code {
    margin: 0;
    padding: 10px;
    border-radius: 4px;
    background: var(--color-bg-input);
    border: 1px solid var(--color-border);
    color: var(--color-text);
    line-height: 1.45;
    overflow: auto;
    white-space: pre;
  }

  .preview-hint {
    margin-top: 8px;
    font-size: 12px;
    color: var(--color-text-secondary);
  }

  .section {
    border: 1px solid var(--color-border);
    border-radius: 6px;
    overflow: hidden;
    background: var(--color-bg-panel);
  }

  .section-title {
    padding: 10px 12px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.4px;
    color: var(--color-text-secondary);
    background: var(--color-bg-header);
    border-bottom: 1px solid var(--color-border);
    text-transform: uppercase;
  }

  .setting {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--color-border);
  }

  .setting:last-child {
    border-bottom: none;
  }

  .ai-section-content {
    padding: 10px 12px;
  }

  .setting-label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1 1 180px;
  }

  .name {
    font-size: 13px;
    color: var(--color-text);
  }

  .description {
    font-size: 12px;
    color: var(--color-text-secondary);
  }

  .setting-control {
    display: flex;
    justify-content: flex-end;
    flex-shrink: 0;
    flex: 1 1 140px;
  }

  .setting-control.row {
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .setting-control.row .number {
    width: 90px;
  }

  .select {
    background: var(--color-bg-input);
    border: 1px solid var(--color-border);
    color: var(--color-text);
    border-radius: 4px;
    padding: 6px 8px;
    font-size: 13px;
    min-width: 120px;
  }

  .number {
    width: 110px;
    background: var(--color-bg-input);
    border: 1px solid var(--color-border);
    color: var(--color-text);
    border-radius: 4px;
    padding: 6px 8px;
    font-size: 13px;
  }

  .checkbox {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--color-text);
    user-select: none;
  }

  .field {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex: 0 1 auto;
  }

  .field-label {
    font-size: 12px;
    color: var(--color-text-secondary);
  }

  .select:focus-visible,
  .number:focus-visible,
  .checkbox input:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 1px;
  }
</style>
