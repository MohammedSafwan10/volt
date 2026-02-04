/**
 * Cleanup script that runs before `tauri dev`
 * Kills any stale processes that might lock sidecars or build artifacts
 * 
 * This fixes the Windows-specific issue where Ctrl+C doesn't propagate
 * to child processes properly, leaving orphaned Vite/node/esbuild processes.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { access, constants, readdir, rm, stat } from 'fs/promises';
import { join } from 'path';

const execAsync = promisify(exec);

const SIDECAR_PATH = join(process.cwd(), 'src-tauri', 'binaries', 'node-x86_64-pc-windows-msvc.exe');
const MAX_RETRIES = 5;
const RETRY_DELAY = 500;
const CARGO_TARGET_DIR = 'C:/Users/User/.cargo/volt-target';
const BUILD_DIR = join(CARGO_TARGET_DIR, 'debug', 'build');

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

async function safeRemoveDir(path) {
  try {
    await rm(path, { recursive: true, force: true });
    console.log(`[cleanup] Removed: ${path}`);
  } catch (err) {
    console.log(`[cleanup] Failed to remove ${path}: ${err?.message ?? err}`);
  }
}

async function cleanupBuildArtifacts() {
  // Only run when explicitly requested to avoid full rebuilds every time.
  if (process.env.VOLT_CLEAN_TARGET !== '1') return;

  // Remove build output folders that commonly get locked on Windows
  await safeRemoveDir(BUILD_DIR);

  // Remove per-crate build artifacts under .cargo-target/debug/build/volt-*
  try {
    const entries = await readdir(BUILD_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('volt-')) {
        await safeRemoveDir(join(BUILD_DIR, entry.name));
      }
    }
  } catch {
    // Ignore if directory doesn't exist or cannot be read
  }

  // Optional: if target is very broken, allow full cleanup via env var
  if (process.env.VOLT_CLEAN_ALL === '1') {
    await safeRemoveDir(CARGO_TARGET_DIR);
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

  // Cleanup build artifacts that can remain locked on Windows
  await cleanupBuildArtifacts();
  
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
