/**
 * Cleanup script that runs before `tauri dev`
 * Kills any stale processes that might lock sidecars or build artifacts
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const PROCESSES_TO_KILL = [
  'node-x86_64-pc-windows-msvc.exe',
  'volt.exe',
];

async function killProcess(name) {
  try {
    // PowerShell command that works silently
    await execAsync(
      `powershell -Command "Get-Process -Name '${name.replace('.exe', '')}' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"`,
      { windowsHide: true }
    );
    console.log(`[cleanup] Killed ${name}`);
  } catch {
    // Process not running - that's fine
  }
}

async function main() {
  console.log('[cleanup] Killing stale processes before dev...');
  
  await Promise.all(PROCESSES_TO_KILL.map(killProcess));
  
  // Small delay to ensure file handles are released
  await new Promise(r => setTimeout(r, 500));
  
  console.log('[cleanup] Done');
}

main();
