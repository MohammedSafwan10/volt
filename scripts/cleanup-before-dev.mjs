/**
 * Cleanup script that runs before `tauri dev`
 * Kills any stale processes that might lock sidecars or build artifacts
 * 
 * This fixes the Windows-specific issue where Ctrl+C doesn't propagate
 * to child processes properly, leaving orphaned Vite/node/esbuild processes.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { access, constants } from 'fs/promises';
import { join } from 'path';

const execAsync = promisify(exec);

const SIDECAR_PATH = join(process.cwd(), 'src-tauri', 'binaries', 'node-x86_64-pc-windows-msvc.exe');
const MAX_RETRIES = 5;
const RETRY_DELAY = 500;

async function killByPattern(pattern) {
  try {
    await execAsync(
      `powershell -Command "Get-Process | Where-Object { $_.Path -like '*${pattern}*' } | Stop-Process -Force -ErrorAction SilentlyContinue"`,
      { windowsHide: true }
    );
    console.log(`[cleanup] Killed processes matching: ${pattern}`);
  } catch {
    // No matching processes
  }
}

async function killByName(name) {
  try {
    await execAsync(
      `powershell -Command "Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"`,
      { windowsHide: true }
    );
  } catch {
    // Process not running
  }
}

async function canAccessSidecar() {
  try {
    await access(SIDECAR_PATH, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log('[cleanup] Killing stale dev processes...');
  
  // Kill processes by path patterns
  await killByPattern('volt\\\\src-tauri\\\\target');
  await killByPattern('volt\\\\src-tauri\\\\binaries');
  await killByPattern('volt.exe');
  
  // Also kill any orphaned esbuild/vite processes from previous dev sessions
  // These can hold file handles open
  await killByName('esbuild');
  
  // Wait for file handles to be released
  await new Promise(r => setTimeout(r, 300));
  
  // Verify sidecar is accessible with retries
  for (let i = 0; i < MAX_RETRIES; i++) {
    if (await canAccessSidecar()) {
      console.log('[cleanup] Sidecar is accessible');
      break;
    }
    
    if (i < MAX_RETRIES - 1) {
      console.log(`[cleanup] Sidecar still locked, retrying (${i + 1}/${MAX_RETRIES})...`);
      
      // More aggressive kill on retry
      await killByPattern('node');
      await new Promise(r => setTimeout(r, RETRY_DELAY));
    } else {
      console.log('[cleanup] Warning: Sidecar may still be locked');
    }
  }
  
  console.log('[cleanup] Done');
}

main();
