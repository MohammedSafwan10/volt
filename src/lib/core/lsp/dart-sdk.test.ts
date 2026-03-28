import { beforeEach, describe, expect, it, vi } from 'vitest';

const runCommandMock = vi.fn();
const getEnvVarMock = vi.fn();
const getFileInfoMock = vi.fn();

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: vi.fn(async () => 'windows'),
}));

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: vi.fn(async () => 'C:\\Users\\User'),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, payload?: Record<string, unknown>) => {
    if (command === 'run_command') {
      return runCommandMock(payload?.command, payload?.args);
    }
    if (command === 'get_env_var') {
      return getEnvVarMock(payload?.name);
    }
    if (command === 'get_file_info') {
      return getFileInfoMock(payload?.path);
    }
    throw new Error(`Unexpected command: ${command}`);
  }),
}));

describe('dart sdk detection', () => {
  beforeEach(() => {
    runCommandMock.mockReset();
    getEnvVarMock.mockReset();
    getFileInfoMock.mockReset();
    vi.resetModules();

    getEnvVarMock.mockResolvedValue(null);
    getFileInfoMock.mockRejectedValue(new Error('missing'));
  });

  it('prefers configured Flutter SDK roots over PATH detection', async () => {
    const configuredFlutterRoot = 'D:\\sdks\\flutter';
    getFileInfoMock.mockImplementation(async (path?: unknown) => {
      if (path === `${configuredFlutterRoot}\\bin\\flutter.bat`) return {};
      if (path === `${configuredFlutterRoot}\\bin\\cache\\dart-sdk\\bin\\dart.exe`) return {};
      throw new Error('missing');
    });

    runCommandMock.mockImplementation(async (command?: unknown, args?: unknown) => {
      const key = `${String(command)} ${(args as string[] | undefined)?.join(' ') ?? ''}`;
      if (key === `${configuredFlutterRoot}\\bin\\flutter.bat --version --machine`) {
        return {
          exit_code: 0,
          stdout: JSON.stringify({ frameworkVersion: '3.29.0' }),
          stderr: '',
        };
      }
      if (key === `${configuredFlutterRoot}\\bin\\cache\\dart-sdk\\bin\\dart.exe --version`) {
        return {
          exit_code: 0,
          stdout: '',
          stderr: 'Dart SDK version: 3.7.0 (stable)',
        };
      }
      if (key === 'where dart') {
        return {
          exit_code: 0,
          stdout: 'C:\\Windows\\dart.exe',
          stderr: '',
        };
      }
      if (key === 'where flutter') {
        return {
          exit_code: 0,
          stdout: 'C:\\Windows\\flutter.bat',
          stderr: '',
        };
      }
      throw new Error(`Unexpected execution: ${key}`);
    });

    const { clearDartSdkCache, detectDartSdk } = await import('./dart-sdk');
    clearDartSdkCache();

    const sdk = await detectDartSdk({
      flutterSdkRoot: configuredFlutterRoot,
      dartSdkRoot: '',
    });

    expect(sdk).not.toBeNull();
    expect(sdk?.dartPath).toBe(`${configuredFlutterRoot}\\bin\\cache\\dart-sdk\\bin\\dart.exe`);
    expect(sdk?.flutterPath).toBe(`${configuredFlutterRoot}\\bin\\flutter.bat`);
    expect(sdk?.detectionSource).toBe('settings:flutter');
    expect(sdk?.version).toBe('3.7.0');
    expect(sdk?.flutterVersion).toBe('3.29.0');
  });

  it('returns a specific issue when configured Flutter root is invalid', async () => {
    const configuredFlutterRoot = 'D:\\broken\\flutter';

    const { clearDartSdkCache, detectDartSdk } = await import('./dart-sdk');
    clearDartSdkCache();

    const sdk = await detectDartSdk({
      flutterSdkRoot: configuredFlutterRoot,
      dartSdkRoot: '',
    });

    expect(sdk).toBeNull();

    const { getLastDartSdkDetectionIssue } = await import('./dart-sdk');
    expect(getLastDartSdkDetectionIssue()).toContain(configuredFlutterRoot);
    expect(getLastDartSdkDetectionIssue()).toContain('Flutter SDK root');
  });

  it('prefers a valid Flutter SDK over an invalid PATH-level dart executable', async () => {
    const flutterExecutable = 'C:\\src\\flutter\\bin\\flutter.bat';
    const flutterBundledDart = 'C:\\src\\flutter\\bin\\cache\\dart-sdk\\bin\\dart.exe';

    getFileInfoMock.mockImplementation(async (path?: unknown) => {
      if (path === flutterExecutable) return {};
      if (path === flutterBundledDart) return {};
      throw new Error('missing');
    });

    runCommandMock.mockImplementation(async (command?: unknown, args?: unknown) => {
      const key = `${String(command)} ${(args as string[] | undefined)?.join(' ') ?? ''}`;
      if (key === 'where dart') {
        return {
          exit_code: 0,
          stdout: 'C:\\fluttr\\flutter\\bin\\dart',
          stderr: '',
        };
      }
      if (key === 'where flutter') {
        return {
          exit_code: 0,
          stdout: flutterExecutable,
          stderr: '',
        };
      }
      if (key === 'C:\\fluttr\\flutter\\bin\\dart --version') {
        return {
          exit_code: 0,
          stdout: '',
          stderr: 'not dart output',
        };
      }
      if (key === `${flutterExecutable} --version --machine`) {
        return {
          exit_code: 0,
          stdout: JSON.stringify({ frameworkVersion: '3.30.0' }),
          stderr: '',
        };
      }
      if (key === `${flutterBundledDart} --version`) {
        return {
          exit_code: 0,
          stdout: '',
          stderr: 'Dart SDK version: 3.8.0 (stable)',
        };
      }
      throw new Error(`Unexpected execution: ${key}`);
    });

    const { clearDartSdkCache, detectDartSdk } = await import('./dart-sdk');
    clearDartSdkCache();

    const sdk = await detectDartSdk();

    expect(sdk).not.toBeNull();
    expect(sdk?.dartPath).toBe(flutterBundledDart);
    expect(sdk?.flutterPath).toBe(flutterExecutable);
    expect(sdk?.detectionSource).toBe('flutter-bundled-dart');
  });

  it('exposes the resolved Flutter SDK root from the validated executable path', async () => {
    const flutterExecutable = 'C:\\fluttr\\flutter\\bin\\flutter.bat';
    const flutterBundledDart = 'C:\\fluttr\\flutter\\bin\\cache\\dart-sdk\\bin\\dart.exe';

    getFileInfoMock.mockImplementation(async (path?: unknown) => {
      if (path === flutterExecutable) return {};
      if (path === flutterBundledDart) return {};
      throw new Error('missing');
    });

    runCommandMock.mockImplementation(async (command?: unknown, args?: unknown) => {
      const key = `${String(command)} ${(args as string[] | undefined)?.join(' ') ?? ''}`;
      if (key === 'where dart') {
        return { exit_code: 0, stdout: flutterBundledDart, stderr: '' };
      }
      if (key === 'where flutter') {
        return { exit_code: 0, stdout: flutterExecutable, stderr: '' };
      }
      if (key === `${flutterBundledDart} --version`) {
        return {
          exit_code: 0,
          stdout: '',
          stderr: 'Dart SDK version: 3.11.4 (stable)',
        };
      }
      if (key === `${flutterExecutable} --version --machine`) {
        return {
          exit_code: 0,
          stdout: JSON.stringify({ frameworkVersion: '3.41.6' }),
          stderr: '',
        };
      }
      throw new Error(`Unexpected execution: ${key}`);
    });

    const { clearDartSdkCache, detectDartSdk } = await import('./dart-sdk');
    clearDartSdkCache();

    const sdk = await detectDartSdk();

    expect(sdk?.flutterPath).toBe(flutterExecutable);
    expect(sdk?.flutterSdkRoot).toBe('C:\\fluttr\\flutter');
  });
});
