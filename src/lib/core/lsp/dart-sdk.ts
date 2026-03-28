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
  /** Resolved Flutter SDK root (if available) */
  flutterSdkRoot?: string;
  /** How this SDK was discovered */
  detectionSource:
    | 'settings:flutter'
    | 'settings:dart'
    | 'env:path'
    | 'env:flutter_root'
    | 'env:dart_sdk'
    | 'common-path'
    | 'flutter-bundled-dart';
}

/** Cached SDK info */
let cachedSdkInfo: DartSdkInfo | null = null;
let lastDetectionIssue: string | null = null;

type DetectionOptions = {
  flutterSdkRoot?: string | null;
  dartSdkRoot?: string | null;
};

type DetectionSource = DartSdkInfo['detectionSource'];

type ResolvedExecutable = {
  path: string;
  source: DetectionSource;
};

type VersionedExecutable = ResolvedExecutable & {
  version: string;
};

function normalizeConfiguredRoot(root: string | null | undefined): string | null {
  const trimmed = root?.trim();
  return trimmed ? trimmed : null;
}

function getFlutterExecutableFromRoot(root: string, isWindows: boolean): string {
  return isWindows ? `${root}\\bin\\flutter.bat` : `${root}/bin/flutter`;
}

function getDartExecutableFromRoot(root: string, isWindows: boolean): string {
  return isWindows ? `${root}\\bin\\dart.exe` : `${root}/bin/dart`;
}

function getFlutterSdkRootFromExecutablePath(flutterPath: string): string | null {
  const normalized = flutterPath.replace(/\//g, '\\');
  const suffix = '\\bin\\flutter.bat';
  if (normalized.toLowerCase().endsWith(suffix.toLowerCase())) {
    return normalized.slice(0, -suffix.length);
  }
  return null;
}

function splitCommandOutput(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getFlutterBundledDartCandidates(flutterPath: string, isWindows: boolean): string[] {
  const separator = isWindows ? '\\' : '/';
  const normalized = isWindows
    ? flutterPath.replace(/\//g, '\\')
    : flutterPath.replace(/\\/g, '/');
  const flutterBinIndex = normalized
    .toLowerCase()
    .lastIndexOf(`${separator}bin${separator}`.toLowerCase());
  const sdkRoot =
    flutterBinIndex >= 0
      ? normalized.slice(0, flutterBinIndex)
      : normalized.replace(/[\\/][^\\/]+$/, '').replace(/[\\/]bin$/, '');
  const executableNames = isWindows ? ['dart.exe', 'dart.bat'] : ['dart'];
  return executableNames.map(
    (name) => `${sdkRoot}${separator}bin${separator}cache${separator}dart-sdk${separator}bin${separator}${name}`,
  );
}

async function resolveFirstExistingPath(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function findCommandOnPath(command: string): Promise<string | null> {
  const os = await platform();
  const isWindows = os === 'windows';

  try {
    const result = await runCommand(isWindows ? 'where' : 'which', [command]);
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return null;
    }
    return splitCommandOutput(result.stdout)[0] ?? null;
  } catch {
    return null;
  }
}

async function findFlutterExecutable(
  options?: DetectionOptions,
): Promise<ResolvedExecutable | null> {
  const os = await platform();
  const isWindows = os === 'windows';
  const home = await homeDir();
  const configuredFlutterRoot = normalizeConfiguredRoot(options?.flutterSdkRoot);

  if (configuredFlutterRoot) {
    const configuredFlutterExecutable = getFlutterExecutableFromRoot(configuredFlutterRoot, isWindows);
    if (!(await fileExists(configuredFlutterExecutable))) {
      lastDetectionIssue = `Configured Flutter SDK root does not contain a Flutter executable: ${configuredFlutterRoot}`;
      return null;
    }
    return {
      path: configuredFlutterExecutable,
      source: 'settings:flutter',
    };
  }

  const fromPath = await findCommandOnPath('flutter');
  if (fromPath) {
    return {
      path: fromPath,
      source: 'env:path',
    };
  }

  const commonPaths = isWindows
    ? [
        `${home}\\flutter\\bin\\flutter.bat`,
        `${home}\\development\\flutter\\bin\\flutter.bat`,
        `${home}\\src\\flutter\\bin\\flutter.bat`,
        `C:\\flutter\\bin\\flutter.bat`,
        `C:\\src\\flutter\\bin\\flutter.bat`,
        `D:\\flutter\\bin\\flutter.bat`,
      ]
    : [
        `${home}/flutter/bin/flutter`,
        `${home}/development/flutter/bin/flutter`,
        `${home}/src/flutter/bin/flutter`,
        '/usr/local/flutter/bin/flutter',
        '/opt/flutter/bin/flutter',
      ];

  const flutterRoot = await getEnvVar('FLUTTER_ROOT');
  if (flutterRoot) {
    commonPaths.unshift(getFlutterExecutableFromRoot(flutterRoot, isWindows));
  }
  const resolved = await resolveFirstExistingPath(commonPaths);
  if (!resolved) {
    return null;
  }
  return {
    path: resolved,
    source: flutterRoot && resolved === getFlutterExecutableFromRoot(flutterRoot, isWindows)
      ? 'env:flutter_root'
      : 'common-path',
  };
}

/**
 * Detect Dart SDK installation
 * Returns null if Dart is not installed
 */
export async function detectDartSdk(options?: DetectionOptions): Promise<DartSdkInfo | null> {
  if (cachedSdkInfo) {
    return cachedSdkInfo;
  }

  try {
    lastDetectionIssue = null;
    const resolved = await resolveValidatedDartSdk(options);
    if (!resolved) {
      if (!lastDetectionIssue) {
        lastDetectionIssue = 'Dart SDK not found. Install Flutter or Dart SDK, or configure an SDK path in Settings.';
      }
      return null;
    }

    cachedSdkInfo = {
      dartPath: resolved.dart.path,
      version: resolved.dart.version,
      isFlutterSdk: !!resolved.flutter,
      flutterPath: resolved.flutter?.path,
      flutterVersion: resolved.flutter?.version,
      flutterSdkRoot: resolved.flutter?.path
        ? getFlutterSdkRootFromExecutablePath(resolved.flutter.path) ?? undefined
        : undefined,
      detectionSource: resolved.dart.source,
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
async function findDartExecutable(
  options?: DetectionOptions,
): Promise<ResolvedExecutable | null> {
  const os = await platform();
  const isWindows = os === 'windows';
  const configuredFlutterRoot = normalizeConfiguredRoot(options?.flutterSdkRoot);
  if (configuredFlutterRoot) {
    const flutterExecutable = getFlutterExecutableFromRoot(configuredFlutterRoot, isWindows);
    if (!(await fileExists(flutterExecutable))) {
      lastDetectionIssue = `Configured Flutter SDK root does not contain a Flutter executable: ${configuredFlutterRoot}`;
      return null;
    }

    const bundledCandidates = getFlutterBundledDartCandidates(flutterExecutable, isWindows);
    const bundledDart = await resolveFirstExistingPath(bundledCandidates);
    if (!bundledDart) {
      lastDetectionIssue = `Configured Flutter SDK root does not contain a bundled Dart SDK: ${configuredFlutterRoot}`;
      return null;
    }
    return {
      path: bundledDart,
      source: 'settings:flutter',
    };
  }

  const configuredDartRoot = normalizeConfiguredRoot(options?.dartSdkRoot);
  if (configuredDartRoot) {
    const configuredDartExecutable = getDartExecutableFromRoot(configuredDartRoot, isWindows);
    if (!(await fileExists(configuredDartExecutable))) {
      lastDetectionIssue = `Configured Dart SDK root does not contain a Dart executable: ${configuredDartRoot}`;
      return null;
    }
    return {
      path: configuredDartExecutable,
      source: 'settings:dart',
    };
  }

  const fromPath = await findCommandOnPath('dart');
  if (fromPath) {
    return {
      path: fromPath,
      source: 'env:path',
    };
  }

  const home = await homeDir();
  const commonPaths = isWindows
    ? [
        `${home}\\flutter\\bin\\cache\\dart-sdk\\bin\\dart.exe`,
        `${home}\\development\\flutter\\bin\\cache\\dart-sdk\\bin\\dart.exe`,
        `${home}\\src\\flutter\\bin\\cache\\dart-sdk\\bin\\dart.exe`,
        `C:\\flutter\\bin\\cache\\dart-sdk\\bin\\dart.exe`,
        `C:\\src\\flutter\\bin\\cache\\dart-sdk\\bin\\dart.exe`,
        `D:\\flutter\\bin\\cache\\dart-sdk\\bin\\dart.exe`,
        // Standalone Dart SDK
        `C:\\tools\\dart-sdk\\bin\\dart.exe`,
        `${home}\\.dart\\bin\\dart.exe`,
        // Chocolatey
        `C:\\ProgramData\\chocolatey\\bin\\dart.bat`,
      ]
    : [
        `${home}/flutter/bin/cache/dart-sdk/bin/dart`,
        `${home}/development/flutter/bin/cache/dart-sdk/bin/dart`,
        `${home}/src/flutter/bin/cache/dart-sdk/bin/dart`,
        '/usr/local/flutter/bin/cache/dart-sdk/bin/dart',
        '/opt/flutter/bin/cache/dart-sdk/bin/dart',
        // Standalone Dart SDK
        '/usr/local/dart/bin/dart',
        '/usr/lib/dart/bin/dart',
        `${home}/.dart/bin/dart`,
        '/opt/homebrew/bin/dart',
        '/usr/local/bin/dart',
      ];

  const flutterRoot = await getEnvVar('FLUTTER_ROOT');
  if (flutterRoot) {
    commonPaths.unshift(
      isWindows
        ? `${flutterRoot}\\bin\\cache\\dart-sdk\\bin\\dart.exe`
        : `${flutterRoot}/bin/cache/dart-sdk/bin/dart`,
    );
  }

  const dartSdk = await getEnvVar('DART_SDK');
  if (dartSdk) {
    commonPaths.unshift(
      isWindows
        ? `${dartSdk}\\bin\\dart.exe`
        : `${dartSdk}/bin/dart`,
    );
  }

  const directCandidate = await resolveFirstExistingPath(commonPaths);
  if (directCandidate) {
    const flutterRootCandidate = flutterRoot
      ? isWindows
        ? `${flutterRoot}\\bin\\cache\\dart-sdk\\bin\\dart.exe`
        : `${flutterRoot}/bin/cache/dart-sdk/bin/dart`
      : null;
    const dartSdkCandidate = dartSdk
      ? getDartExecutableFromRoot(dartSdk, isWindows)
      : null;

    return {
      path: directCandidate,
      source:
        flutterRootCandidate && directCandidate === flutterRootCandidate
          ? 'env:flutter_root'
          : dartSdkCandidate && directCandidate === dartSdkCandidate
            ? 'env:dart_sdk'
            : 'common-path',
    };
  }

  const flutterExecutable = await findFlutterExecutable(options);
  if (flutterExecutable) {
    const bundledDart = await resolveFirstExistingPath(
      getFlutterBundledDartCandidates(flutterExecutable.path, isWindows),
    );
    if (bundledDart) {
      return {
        path: bundledDart,
        source: 'flutter-bundled-dart',
      };
    }
  }

  return null;
}

async function validateDartExecutable(
  executable: ResolvedExecutable | null,
  fallbackIssue?: string,
): Promise<VersionedExecutable | null> {
  if (!executable) return null;

  const version = await getDartVersion(executable.path);
  if (!version) {
    lastDetectionIssue = fallbackIssue ?? `Detected Dart executable could not be validated: ${executable.path}`;
    return null;
  }

  return {
    ...executable,
    version,
  };
}

async function resolveValidatedDartSdk(
  options?: DetectionOptions,
): Promise<{
  dart: VersionedExecutable;
  flutter: { path: string; version: string; source: DetectionSource } | null;
} | null> {
  const configuredFlutterRoot = normalizeConfiguredRoot(options?.flutterSdkRoot);
  const configuredDartRoot = normalizeConfiguredRoot(options?.dartSdkRoot);

  const primaryCandidate = await validateDartExecutable(
    await findDartExecutable(options),
    configuredFlutterRoot || configuredDartRoot
      ? lastDetectionIssue ?? undefined
      : undefined,
  );

  if (primaryCandidate) {
    const flutter = await detectFlutterSdk(options);
    return {
      dart: primaryCandidate,
      flutter,
    };
  }

  if (configuredFlutterRoot || configuredDartRoot) {
    return null;
  }

  const flutter = await detectFlutterSdk(options);
  if (!flutter) {
    return null;
  }

  const os = await platform();
  const isWindows = os === 'windows';
  const flutterBundledDart = await resolveFirstExistingPath(
    getFlutterBundledDartCandidates(flutter.path, isWindows),
  );
  const validatedBundledDart = await validateDartExecutable(
    flutterBundledDart
      ? {
          path: flutterBundledDart,
          source: 'flutter-bundled-dart',
        }
      : null,
  );

  if (!validatedBundledDart) {
    return null;
  }

  return {
    dart: validatedBundledDart,
    flutter,
  };
}

/**
 * Get Dart version from executable
 */
async function getDartVersion(dartPath: string): Promise<string | null> {
  try {
    const result = await runCommand(dartPath, ['--version']);
    const output = `${result.stdout}\n${result.stderr}`;
    // Output format: "Dart SDK version: 3.3.0 (stable) ..."
    const match = output.match(/Dart SDK version:\s*(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Detect Flutter SDK (optional, used to enrich Dart SDK info)
 */
async function detectFlutterSdk(
  options?: DetectionOptions,
): Promise<{ path: string; version: string; source: DetectionSource } | null> {
  const resolvedFlutter = await findFlutterExecutable(options);
  if (!resolvedFlutter) {
    return null;
  }

  try {
    const versionResult = await runCommand(resolvedFlutter.path, ['--version', '--machine']);
    if (versionResult.exitCode === 0) {
      try {
        const info = JSON.parse(versionResult.stdout);
        return {
          path: resolvedFlutter.path,
          version: info.frameworkVersion || info.version,
          source: resolvedFlutter.source,
        };
      } catch {
        const match = versionResult.stdout.match(/Flutter\s+(\d+\.\d+\.\d+)/);
        if (match) {
          return {
            path: resolvedFlutter.path,
            version: match[1],
            source: resolvedFlutter.source,
          };
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
  lastDetectionIssue = null;
}

export function getLastDartSdkDetectionIssue(): string | null {
  return lastDetectionIssue;
}

/**
 * Check if Dart is available on the system
 */
export async function isDartAvailable(options?: DetectionOptions): Promise<boolean> {
  const sdk = await detectDartSdk(options);
  return sdk !== null;
}
