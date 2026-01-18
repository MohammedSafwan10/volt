/**
 * XML Language Server (LemMinX) Detection Service
 * 
 * Detects LemMinX installation on the user's system.
 * Supports:
 * - Pre-built native binaries (no Java needed)
 * - JAR file with Java runtime
 * - Manual installation paths
 */

import { invoke } from '@tauri-apps/api/core';
import { platform, arch } from '@tauri-apps/plugin-os';
import { homeDir, appDataDir } from '@tauri-apps/api/path';

/** XML LSP information */
export interface XmlLspInfo {
  /** Full path to the lemminx executable/jar */
  serverPath: string;
  /** Type of server (binary or jar) */
  serverType: 'binary' | 'jar';
  /** Version string if available */
  version?: string;
  /** Java path if using jar */
  javaPath?: string;
}

/** Cached LSP info */
let cachedLspInfo: XmlLspInfo | null = null;

/**
 * Detect LemMinX XML Language Server installation
 * Returns null if not installed
 */
export async function detectXmlLsp(): Promise<XmlLspInfo | null> {
  if (cachedLspInfo) {
    return cachedLspInfo;
  }

  try {
    // First, try to find native binary
    const binaryPath = await findLemminxBinary();
    if (binaryPath) {
      cachedLspInfo = {
        serverPath: binaryPath,
        serverType: 'binary',
      };
      console.log('[XML LSP] Detected binary:', cachedLspInfo);
      return cachedLspInfo;
    }

    // Then try jar with Java
    const jarInfo = await findLemminxJar();
    if (jarInfo) {
      cachedLspInfo = jarInfo;
      console.log('[XML LSP] Detected JAR:', cachedLspInfo);
      return cachedLspInfo;
    }

    return null;
  } catch (error) {
    console.error('[XML LSP] Detection failed:', error);
    return null;
  }
}

/**
 * Find the LemMinX native binary
 */
async function findLemminxBinary(): Promise<string | null> {
  const os = await platform();
  const architecture = await arch();
  const isWindows = os === 'windows';
  const isMac = os === 'macos';
  
  // Binary name varies by platform
  const binaryName = isWindows ? 'lemminx-win32.exe' : (isMac ? 'lemminx-osx-x86_64' : 'lemminx-linux');
  
  // Check common locations
  const home = await homeDir();
  const appData = await appDataDir().catch(() => null);
  
  const commonPaths = isWindows
    ? [
        // vscode-xml extension location
        `${home}\\.vscode\\extensions\\redhat.vscode-xml-*\\server\\lemminx-win32.exe`,
        `${home}\\AppData\\Local\\Programs\\lemminx\\lemminx.exe`,
        `${home}\\.lemminx\\lemminx.exe`,
        // Our app's data directory
        appData ? `${appData}\\lemminx\\lemminx-win32.exe` : null,
      ]
    : isMac
    ? [
        `${home}/.vscode/extensions/redhat.vscode-xml-*/server/lemminx-osx-${architecture === 'aarch64' ? 'aarch_64' : 'x86_64'}`,
        `${home}/.lemminx/lemminx-osx-x86_64`,
        '/usr/local/bin/lemminx',
        appData ? `${appData}/lemminx/lemminx-osx-x86_64` : null,
      ]
    : [
        `${home}/.vscode/extensions/redhat.vscode-xml-*/server/lemminx-linux`,
        `${home}/.lemminx/lemminx-linux`,
        '/usr/local/bin/lemminx',
        appData ? `${appData}/lemminx/lemminx-linux` : null,
      ];

  for (const path of commonPaths) {
    if (!path) continue;
    
    // Handle wildcard paths
    if (path.includes('*')) {
      const resolvedPath = await resolveWildcardPath(path);
      if (resolvedPath) {
        return resolvedPath;
      }
    } else if (await fileExists(path)) {
      return path;
    }
  }

  return null;
}

/**
 * Find LemMinX JAR and Java runtime
 */
async function findLemminxJar(): Promise<XmlLspInfo | null> {
  const os = await platform();
  const isWindows = os === 'windows';
  const home = await homeDir();

  // Check for JAR
  const jarPaths = [
    `${home}/.lemminx/org.eclipse.lemminx-uber.jar`,
    `${home}/.lemminx/lemminx.jar`,
    isWindows
      ? `${home}\\AppData\\Local\\Programs\\lemminx\\lemminx.jar`
      : '/usr/local/share/lemminx/lemminx.jar',
  ];

  let jarPath: string | null = null;
  for (const path of jarPaths) {
    if (await fileExists(path)) {
      jarPath = path;
      break;
    }
  }

  if (!jarPath) {
    return null;
  }

  // Check for Java
  const javaPath = await findJava();
  if (!javaPath) {
    console.warn('[XML LSP] Found JAR but Java not available');
    return null;
  }

  return {
    serverPath: jarPath,
    serverType: 'jar',
    javaPath,
  };
}

/**
 * Find Java executable
 */
async function findJava(): Promise<string | null> {
  const os = await platform();
  const isWindows = os === 'windows';

  // Check JAVA_HOME first
  const javaHome = await getEnvVar('JAVA_HOME');
  if (javaHome) {
    const javaPath = isWindows
      ? `${javaHome}\\bin\\java.exe`
      : `${javaHome}/bin/java`;
    if (await fileExists(javaPath)) {
      return javaPath;
    }
  }

  // Try PATH
  try {
    const result = await runCommand(
      isWindows ? 'where' : 'which',
      ['java']
    );
    if (result.exitCode === 0 && result.stdout.trim()) {
      return result.stdout.trim().split('\n')[0].trim();
    }
  } catch {
    // Java not in PATH
  }

  return null;
}

/**
 * Check if XML Language Server is available
 */
export async function isXmlLspAvailable(): Promise<boolean> {
  const info = await detectXmlLsp();
  return info !== null;
}

/**
 * Clear cached LSP info
 */
export function clearXmlLspCache(): void {
  cachedLspInfo = null;
}

/**
 * Get the command and args to start LemMinX
 */
export async function getLemminxCommand(): Promise<{ command: string; args: string[] } | null> {
  const info = await detectXmlLsp();
  if (!info) return null;

  if (info.serverType === 'binary') {
    return {
      command: info.serverPath,
      args: [],
    };
  } else if (info.serverType === 'jar' && info.javaPath) {
    return {
      command: info.javaPath,
      args: ['-jar', info.serverPath],
    };
  }

  return null;
}

/**
 * Get installation instructions
 */
export function getInstallInstructions(): string {
  return `XML Language Server (LemMinX) not found.

Option 1: Install VS Code XML extension (recommended)
  - The binary is bundled with redhat.vscode-xml extension

Option 2: Download binary manually
  - Get from: https://download.jboss.org/jbosstools/vscode/stable/lemminx-binary/
  - Place in ~/.lemminx/

Option 3: Use JAR with Java 11+
  - Download: https://repo.eclipse.org/content/repositories/lemminx-releases/
  - Place JAR in ~/.lemminx/

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

async function getEnvVar(name: string): Promise<string | null> {
  try {
    const value = await invoke<string | null>('get_env_var', { name });
    return value || null;
  } catch {
    return null;
  }
}

async function resolveWildcardPath(pattern: string): Promise<string | null> {
  // Simple wildcard resolution for extension directories
  const parts = pattern.split('*');
  if (parts.length !== 2) return null;

  const [prefix, suffix] = parts;
  const dir = prefix.substring(0, prefix.lastIndexOf('/') > 0 ? prefix.lastIndexOf('/') : prefix.lastIndexOf('\\'));
  const filePrefix = prefix.substring(prefix.lastIndexOf('/') > 0 ? prefix.lastIndexOf('/') + 1 : prefix.lastIndexOf('\\') + 1);

  try {
    const entries = await invoke<string[]>('list_dir', { path: dir });
    for (const entry of entries) {
      if (entry.startsWith(filePrefix)) {
        const fullPath = `${dir}/${entry}${suffix}`;
        if (await fileExists(fullPath)) {
          return fullPath;
        }
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  return null;
}
