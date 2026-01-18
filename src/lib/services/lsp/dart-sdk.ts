/**
 * Dart SDK Detection Service
 * 
 * Detects the Dart/Flutter SDK installation on the user's system.
 * Searches PATH, environment variables, and common installation locations.
 */

import { invoke } from '@tauri-apps/api/core';
import { platform } from '@tauri-apps/plugin-os';
import { homeDir } from '@tauri-apps/api/path';

/** Dart SDK information */
export interface DartSdkInfo {
  /** Full path to the dart executable */
  dartPath: string;
  /** Dart SDK version (e.g., "3.3.0") */
  version: string;
  /** Whether this is part of a Flutter SDK */
  isFlutterSdk: boolean;
  /** Path to Flutter executable (if available) */
  flutterPath?: string;
  /** Flutter SDK version (if available) */
  flutterVersion?: string;
}

/** Cached SDK info */
let cachedSdkInfo: DartSdkInfo | null = null;

/**
 * Detect Dart SDK installation
 * Returns null if Dart is not installed
 */
export async function detectDartSdk(): Promise<DartSdkInfo | null> {
  if (cachedSdkInfo) {
    return cachedSdkInfo;
  }

  try {
    // Try to get Dart version via command
    const dartPath = await findDartExecutable();
    if (!dartPath) {
      return null;
    }

    const version = await getDartVersion(dartPath);
    if (!version) {
      return null;
    }

    // Check if this is part of a Flutter SDK
    const flutterInfo = await detectFlutterSdk();

    cachedSdkInfo = {
      dartPath,
      version,
      isFlutterSdk: !!flutterInfo,
      flutterPath: flutterInfo?.flutterPath,
      flutterVersion: flutterInfo?.version,
    };

    console.log('[Dart SDK] Detected:', cachedSdkInfo);
    return cachedSdkInfo;
  } catch (error) {
    console.error('[Dart SDK] Detection failed:', error);
    return null;
  }
}

/**
 * Find the dart executable in PATH or common locations
 */
async function findDartExecutable(): Promise<string | null> {
  const os = await platform();
  const isWindows = os === 'windows';
  const dartCmd = isWindows ? 'dart.bat' : 'dart';

  // First, try PATH via 'where' (Windows) or 'which' (Unix)
  try {
    const result = await runCommand(isWindows ? 'where' : 'which', [isWindows ? 'dart' : 'dart']);
    if (result.exitCode === 0 && result.stdout.trim()) {
      const path = result.stdout.trim().split('\n')[0].trim();
      if (path) return path;
    }
  } catch {
    // Continue to check common locations
  }

  // Check common installation locations
  const home = await homeDir();
  const commonPaths = isWindows
    ? [
        // Flutter SDK locations
        `${home}\\flutter\\bin\\dart.bat`,
        `${home}\\flutter\\bin\\cache\\dart-sdk\\bin\\dart.bat`,
        `C:\\flutter\\bin\\dart.bat`,
        `C:\\flutter\\bin\\cache\\dart-sdk\\bin\\dart.bat`,
        // Standalone Dart SDK
        `C:\\tools\\dart-sdk\\bin\\dart.bat`,
        `${home}\\.dart\\bin\\dart.bat`,
        // Chocolatey
        `C:\\ProgramData\\chocolatey\\bin\\dart.bat`,
      ]
    : [
        // Flutter SDK locations
        `${home}/flutter/bin/dart`,
        `${home}/flutter/bin/cache/dart-sdk/bin/dart`,
        '/usr/local/flutter/bin/dart',
        // Standalone Dart SDK
        '/usr/local/dart/bin/dart',
        '/usr/lib/dart/bin/dart',
        `${home}/.dart/bin/dart`,
        // Homebrew (macOS)
        '/opt/homebrew/bin/dart',
        '/usr/local/bin/dart',
      ];

  // Check FLUTTER_ROOT environment variable
  const flutterRoot = await getEnvVar('FLUTTER_ROOT');
  if (flutterRoot) {
    commonPaths.unshift(
      isWindows
        ? `${flutterRoot}\\bin\\dart.bat`
        : `${flutterRoot}/bin/dart`
    );
  }

  // Check DART_SDK environment variable
  const dartSdk = await getEnvVar('DART_SDK');
  if (dartSdk) {
    commonPaths.unshift(
      isWindows
        ? `${dartSdk}\\bin\\dart.bat`
        : `${dartSdk}/bin/dart`
    );
  }

  for (const path of commonPaths) {
    if (await fileExists(path)) {
      return path;
    }
  }

  return null;
}

/**
 * Get Dart version from executable
 */
async function getDartVersion(dartPath: string): Promise<string | null> {
  try {
    const result = await runCommand(dartPath, ['--version']);
    // Output format: "Dart SDK version: 3.3.0 (stable) ..."
    const match = result.stdout.match(/Dart SDK version:\s*(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Detect Flutter SDK (optional, used to enrich Dart SDK info)
 */
async function detectFlutterSdk(): Promise<{ flutterPath: string; version: string } | null> {
  const os = await platform();
  const isWindows = os === 'windows';

  try {
    const result = await runCommand(isWindows ? 'where' : 'which', ['flutter']);
    if (result.exitCode === 0 && result.stdout.trim()) {
      const flutterPath = result.stdout.trim().split('\n')[0].trim();
      
      // Get Flutter version
      const versionResult = await runCommand(flutterPath, ['--version', '--machine']);
      if (versionResult.exitCode === 0) {
        try {
          const info = JSON.parse(versionResult.stdout);
          return {
            flutterPath,
            version: info.frameworkVersion || info.version,
          };
        } catch {
          // Try parsing plain text output
          const match = versionResult.stdout.match(/Flutter\s+(\d+\.\d+\.\d+)/);
          if (match) {
            return { flutterPath, version: match[1] };
          }
        }
      }
    }
  } catch {
    // Flutter not found, that's okay
  }

  return null;
}

/**
 * Run a command and capture output
 */
async function runCommand(cmd: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Use Tauri's shell plugin or a custom command
  // For now, we'll use a simplified approach via invoke if available
  try {
    const result = await invoke<{ exit_code: number; stdout: string; stderr: string }>('run_command', {
      command: cmd,
      args,
    });
    return {
      exitCode: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch {
    // Fallback: try using the child process approach
    // This is a placeholder - actual implementation depends on available APIs
    throw new Error('Command execution not available');
  }
}

/**
 * Get environment variable value
 */
async function getEnvVar(name: string): Promise<string | null> {
  try {
    // Use Tauri's env command if available
    const value = await invoke<string | null>('get_env_var', { name });
    return value;
  } catch {
    // Fallback for browser context
    return null;
  }
}

/**
 * Check if a file exists
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await invoke('get_file_info', { path });
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear cached SDK info (useful when user installs Dart mid-session)
 */
export function clearDartSdkCache(): void {
  cachedSdkInfo = null;
}

/**
 * Check if Dart is available on the system
 */
export async function isDartAvailable(): Promise<boolean> {
  const sdk = await detectDartSdk();
  return sdk !== null;
}
