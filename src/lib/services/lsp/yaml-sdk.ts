/**
 * YAML Language Server Detection Service
 * 
 * Detects yaml-language-server installation on the user's system.
 * Supports npm global install and common locations.
 */

import { invoke } from '@tauri-apps/api/core';
import { platform } from '@tauri-apps/plugin-os';
import { homeDir } from '@tauri-apps/api/path';

/** YAML LSP information */
export interface YamlLspInfo {
  /** Full path to the yaml-language-server executable */
  serverPath: string;
  /** Version string if available */
  version?: string;
}

/** Cached LSP info */
let cachedLspInfo: YamlLspInfo | null = null;

/**
 * Detect YAML Language Server installation
 * Returns null if not installed
 */
export async function detectYamlLsp(): Promise<YamlLspInfo | null> {
  if (cachedLspInfo) {
    return cachedLspInfo;
  }

  try {
    const serverPath = await findYamlLspExecutable();
    if (!serverPath) {
      return null;
    }

    const version = await getYamlLspVersion(serverPath);

    cachedLspInfo = {
      serverPath,
      version,
    };

    console.log('[YAML LSP] Detected:', cachedLspInfo);
    return cachedLspInfo;
  } catch (error) {
    console.error('[YAML LSP] Detection failed:', error);
    return null;
  }
}

/**
 * Find the yaml-language-server executable
 */
async function findYamlLspExecutable(): Promise<string | null> {
  const os = await platform();
  const isWindows = os === 'windows';
  const cmdName = isWindows ? 'yaml-language-server.cmd' : 'yaml-language-server';

  // First, try PATH via 'where' (Windows) or 'which' (Unix)
  try {
    const result = await runCommand(
      isWindows ? 'where' : 'which',
      [isWindows ? 'yaml-language-server' : 'yaml-language-server']
    );
    if (result.exitCode === 0 && result.stdout.trim()) {
      const path = result.stdout.trim().split('\n')[0].trim();
      if (path) return path;
    }
  } catch {
    // Continue to check common locations
  }

  // Check common npm global installation locations
  const home = await homeDir();
  const commonPaths = isWindows
    ? [
        // npm global on Windows
        `${home}\\AppData\\Roaming\\npm\\yaml-language-server.cmd`,
        // pnpm
        `${home}\\AppData\\Local\\pnpm\\yaml-language-server.cmd`,
        // Yarn global
        `${home}\\AppData\\Local\\Yarn\\bin\\yaml-language-server.cmd`,
        // Volta
        `${home}\\.volta\\bin\\yaml-language-server.cmd`,
      ]
    : [
        // npm global on Unix
        '/usr/local/bin/yaml-language-server',
        '/usr/bin/yaml-language-server',
        `${home}/.npm-global/bin/yaml-language-server`,
        `${home}/.nvm/versions/node/*/bin/yaml-language-server`,
        // pnpm
        `${home}/.local/share/pnpm/yaml-language-server`,
        // Yarn global
        `${home}/.yarn/bin/yaml-language-server`,
        // Volta
        `${home}/.volta/bin/yaml-language-server`,
        // Homebrew (macOS)
        '/opt/homebrew/bin/yaml-language-server',
      ];

  for (const path of commonPaths) {
    // Handle wildcard paths for nvm
    if (path.includes('*')) {
      continue; // Skip wildcard paths for now
    }
    if (await fileExists(path)) {
      return path;
    }
  }

  return null;
}

/**
 * Get YAML LSP version
 */
async function getYamlLspVersion(serverPath: string): Promise<string | undefined> {
  try {
    const result = await runCommand(serverPath, ['--version']);
    if (result.exitCode === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  } catch {
    // Version check failed
  }
  return undefined;
}

/**
 * Check if YAML Language Server is available
 */
export async function isYamlLspAvailable(): Promise<boolean> {
  const info = await detectYamlLsp();
  return info !== null;
}

/**
 * Clear cached LSP info (for testing or refresh)
 */
export function clearYamlLspCache(): void {
  cachedLspInfo = null;
}

/**
 * Get installation instructions
 */
export function getInstallInstructions(): string {
  return `YAML Language Server not found.

Install globally via npm:
  npm install -g yaml-language-server

Or via yarn:
  yarn global add yaml-language-server

After installation, restart the IDE.`;
}

// ========== Utility Functions ==========

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  try {
    const result = await invoke<{ exit_code: number; stdout: string; stderr: string }>('run_command', {
      command,
      args,
    });
    return {
      exitCode: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: String(error),
    };
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await invoke('file_exists', { path });
    return true;
  } catch {
    return false;
  }
}
