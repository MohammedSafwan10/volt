/**
 * Cleanup script that runs before `tauri dev`
 * Kills any stale processes that might lock sidecars or build artifacts
 * 
 * This fixes the Windows-specific issue where Ctrl+C doesn't propagate
 * to child processes properly, leaving orphaned Vite/node/esbuild processes.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { access, constants, readdir, rm } from 'fs/promises';
import { join } from 'path';

const execAsync = promisify(exec);

const SIDECAR_PATH = join(process.cwd(), 'src-tauri', 'binaries', 'node-x86_64-pc-windows-msvc.exe');
const PROJECT_ROOT = process.cwd();
const MAX_RETRIES = 5;
const RETRY_DELAY = 500;
const CARGO_TARGET_DIR = join(process.cwd(), '.cargo-target');
const BUILD_DIR = join(CARGO_TARGET_DIR, 'debug', 'build');
const CARGO_DEBUG_DIR = join(CARGO_TARGET_DIR, 'debug');
const KNOWN_DEV_PORTS = [1420, 1421];

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

function escapeForSingleQuotedPowerShell(value) {
  return String(value).replace(/'/g, "''");
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

async function killNodeProcessesForProject(marker) {
  try {
    const escapedMarker = escapeForSingleQuotedPowerShell(marker);
    const ps = `
      $marker = '${escapedMarker}'
      $killed = 0
      Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
          ($_.CommandLine -like "*$marker*") -or ($_.ExecutablePath -like "*$marker*")
        } |
        ForEach-Object {
          try {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            $killed++
          } catch {}
        }
      $killed
    `.trim().replace(/\r?\n\s*/g, ' ');
    const { stdout } = await execAsync(`powershell -NoProfile -Command "${ps}"`, { windowsHide: true });
    const count = Number(String(stdout).trim()) || 0;
    if (count > 0) {
      console.log(`[cleanup] Killed ${count} project node process(es) matching: ${marker}`);
    }
  } catch {
    // Ignore lookup errors
  }
}

async function canAccessSidecar() {
  try {
    await access(SIDECAR_PATH, constants.W_OK);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      // File doesn't exist, so it's not locked.
      return true;
    }
    return false;
  }
}

async function killByExactExePath(exePath) {
  try {
    // Use Get-Process.Path for simple/robust exact matching.
    const escaped = exePath.replace(/'/g, "''");
    const ps = `@($procs = Get-Process | Where-Object { $_.Path -eq '${escaped}' }); $procs | ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch {} }; ($procs | Measure-Object).Count`;
    const { stdout } = await execAsync(`powershell -NoProfile -Command "${ps}"`, { windowsHide: true });
    const count = Number(String(stdout).trim()) || 0;
    if (count > 0) {
      console.log(`[cleanup] Killed ${count} process(es) by exact path: ${exePath}`);
    }
  } catch {
    // Ignore lookup errors
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

async function forceDeleteFile(filePath, retries = 8, delayMs = 350) {
  for (let i = 0; i < retries; i++) {
    try {
      // Clear readonly/system/hidden flags first on Windows.
      await execAsync(`attrib -R -S -H "${filePath}"`, { windowsHide: true }).catch(() => {});
      await rm(filePath, { force: true });
      console.log(`[cleanup] Removed stale file: ${filePath}`);
      return true;
    } catch (err) {
      const message = err?.message ?? String(err);
      if (i === retries - 1) {
        console.log(`[cleanup] Failed to remove stale file after ${retries} attempts: ${filePath} (${message})`);
        return false;
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
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

async function cleanupTargetSidecars() {
  // Tauri externalBin "binaries/node" is copied to CARGO_TARGET_DIR/debug/node.exe.
  // If that file is left locked by a stale process, tauri-build panics with AccessDenied.
  const candidates = [
    join(CARGO_DEBUG_DIR, 'node.exe'),
    join(CARGO_DEBUG_DIR, 'node-x86_64-pc-windows-msvc.exe'),
    join(CARGO_DEBUG_DIR, 'node-aarch64-pc-windows-msvc.exe'),
  ];

  for (const file of candidates) {
    await forceDeleteFile(file);
  }
}

async function killByPort(port) {
  try {
    const { stdout } = await execAsync('netstat -ano -p tcp', { windowsHide: true });
    const lines = String(stdout).split(/\r?\n/);
    const pids = new Set();
    const localSuffix = `:${Number(port)}`;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (!line.toUpperCase().startsWith('TCP')) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 5) continue;
      const local = parts[1] || '';
      const state = (parts[3] || '').toUpperCase();
      const pid = parts[4] || '';

      // Match both IPv4/IPv6 forms:
      // 127.0.0.1:1420, 0.0.0.0:1420, [::]:1420
      if (!local.endsWith(localSuffix)) continue;
      if (state !== 'LISTENING' && state !== 'ESTABLISHED' && state !== 'CLOSE_WAIT' && state !== 'TIME_WAIT') continue;
      if (!/^\d+$/.test(pid)) continue;
      pids.add(pid);
    }

    let killed = 0;
    for (const pid of pids) {
      try {
        await execAsync(`taskkill /PID ${pid} /T /F`, { windowsHide: true });
        killed++;
      } catch {
        // Ignore if already exited or inaccessible
      }
    }

    if (killed > 0) {
      console.log(`[cleanup] Killed ${killed} process(es) using TCP port ${port}`);
    }
  } catch {
    // Ignore if netstat parsing fails
  }
}

async function main() {
  console.log('[cleanup] Killing stale dev processes...');

  // Kill processes by path patterns
  await killByPattern('.cargo-target');
  await killByPattern('volt\\\\src-tauri\\\\target');
  await killByPattern('volt\\\\src-tauri\\\\binaries');
  await killByPattern('\\\\.cargo\\\\volt-target');
  await killByPattern('volt-target\\\\debug\\\\node');
  await killByPattern('volt.exe');
  await killByExactExePath(join(CARGO_DEBUG_DIR, 'node.exe'));
  await killByExactExePath(join(CARGO_DEBUG_DIR, 'volt.exe'));
  await killNodeProcessesForProject(PROJECT_ROOT);
  for (const port of KNOWN_DEV_PORTS) {
    await killByPort(port);
  }

  // Also kill any orphaned esbuild/vite processes from previous dev sessions
  // These can hold file handles open
  await killByName('esbuild');

  // Wait for file handles to be released
  await new Promise(r => setTimeout(r, 300));

  // Cleanup build artifacts that can remain locked on Windows
  await cleanupBuildArtifacts();
  await cleanupTargetSidecars();

  // Verify sidecar is accessible with retries
  for (let i = 0; i < MAX_RETRIES; i++) {
    if (await canAccessSidecar()) {
      console.log('[cleanup] Sidecar is accessible');
      break;
    }

    if (i < MAX_RETRIES - 1) {
      console.log(`[cleanup] Sidecar still locked, retrying (${i + 1}/${MAX_RETRIES})...`);

      // Retry only with Volt-scoped cleanup paths rather than system-wide Node kills.
      await killByExactExePath(join(CARGO_DEBUG_DIR, 'node.exe'));
      await killNodeProcessesForProject(PROJECT_ROOT);
      for (const port of KNOWN_DEV_PORTS) {
        await killByPort(port);
      }
      await new Promise(r => setTimeout(r, RETRY_DELAY));
    } else {
      console.log('[cleanup] Warning: Sidecar may still be locked');
    }
  }

  console.log('[cleanup] Done');
}

main();
