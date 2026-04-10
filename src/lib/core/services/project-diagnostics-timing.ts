import { invoke } from '@tauri-apps/api/core';

export async function waitForProjectDiagnosticsDelay(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }

  await invoke('lsp_wait_project_diagnostics_delay', { delayMs });
}
