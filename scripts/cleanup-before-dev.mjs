/**
 * Cleanup script that runs before `tauri dev`
 * Kills any stale processes that might lock sidecars or build artifacts
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function killByPattern(pattern) {
  try {
    // PowerShell: find and kill processes matching path pattern
    await execAsync(
      `powershell -Command "Get-Process | Where-Object { $_.Path -like '*${pattern}*' } | Stop-Process -Force -ErrorAction SilentlyContinue"`,
      { windowsHide: true }
    );
    console.log(`[cleanup] Killed processes matching: ${pattern}`);
  } catch {
    // No matching processes - that's fine
  }
}

async function main() {
  console.log('[cleanup] Killing stale processes before dev...');
  
  // Kill processes by path patterns (catches node.exe in target folder, volt.exe, sidecars)
  await killByPattern('volt\\\\src-tauri\\\\target');  // Any process from target folder
  await killByPattern('volt\\\\src-tauri\\\\binaries'); // Any sidecar
  await killByPattern('volt.exe');                     // Main app
  
  // Small delay to ensure file handles are released
  await new Promise(r => setTimeout(r, 500));
  
  console.log('[cleanup] Done');
}

main();
