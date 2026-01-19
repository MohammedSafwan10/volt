import { invoke } from '@tauri-apps/api/core';
import { problemsStore, type Problem } from '$lib/stores/problems.svelte';

interface SystemCapabilities {
    os_name?: string;
}

interface CommandResult {
    exit_code: number;
    stdout: string;
    stderr: string;
}

async function getSystemInfo(): Promise<SystemCapabilities> {
    return invoke('get_system_info');
}

/**
 * Run project-wide diagnostics (TypeScript, ESLint, etc.)
 * This runs independent of the LSP to catch build/compilation errors across the entire project.
 */
export class ProjectDiagnostics {
    private isWindows = false;

    constructor() {
        this.checkPlatform();
    }

    private async checkPlatform() {
        try {
            const info = await getSystemInfo();
            this.isWindows = info.os_name?.toLowerCase().includes('windows') ?? false;
        } catch {
            this.isWindows = navigator.userAgent.toLowerCase().includes('windows');
        }
    }

    /**
     * Run diagnostics for a project
     */
    async runDiagnostics(rootPath: string): Promise<void> {
        console.log('[ProjectDiagnostics] Starting project-wide analysis...');

        // Run detections in parallel
        await Promise.allSettled([
            this.runTscDiagnostics(rootPath),
            this.runEslintDiagnostics(rootPath),
            this.runFlutterDiagnostics(rootPath)
        ]);

        console.log('[ProjectDiagnostics] Analysis complete.');
    }

    /**
     * Run Flutter/Dart analysis
     */
    private async runFlutterDiagnostics(rootPath: string): Promise<void> {
        try {
            if (!await this.fileExists(rootPath, 'pubspec.yaml')) {
                return;
            }

            console.log('[ProjectDiagnostics] Running flutter analyze...');

            const cmd = this.isWindows ? 'flutter.bat' : 'flutter';
            // --machine outputs format: SEVERITY|TYPE|CODE|FILE|LINE|COL|LENGTH|MESSAGE
            const args = ['analyze', '--machine'];

            const result = await invoke<CommandResult>('run_command', {
                command: cmd,
                args,
                cwd: rootPath
            });

            this.parseFlutterOutput(result.stdout, rootPath);

        } catch (e) {
            console.warn('[ProjectDiagnostics] Failed to run flutter analyze:', e);
        }
    }

    /**
     * Parse flutter analyze --machine output
     */
    private parseFlutterOutput(output: string, rootPath: string): void {
        const lines = output.split('\n');
        const problemsByFile: Record<string, Problem[]> = {};

        for (const line of lines) {
            if (!line.trim() || !line.includes('|')) continue;

            // Format: SEVERITY|TYPE|CODE|FILE|LINE|COL|LENGTH|MESSAGE
            const parts = line.split('|');
            if (parts.length < 8) continue;

            const [severityStr, type, code, filePath, lineStr, colStr, lengthStr, message] = parts;

            // Resolve absolute path. Flutter sometimes returns absolute, sometimes relative.
            const fullPath = this.resolveAbsolutePath(rootPath, filePath);

            const lineNum = parseInt(lineStr, 10);
            const colNum = parseInt(colStr, 10);

            const problem: Problem = {
                id: `flutter-${fullPath}-${lineNum}-${colNum}-${code}`,
                file: fullPath,
                fileName: fullPath.split(/[/\\]/).pop() || fullPath,
                line: lineNum,
                column: colNum,
                endLine: lineNum,
                endColumn: colNum + 1, // approximate
                severity: severityStr === 'ERROR' ? 'error' : (severityStr === 'WARNING' ? 'warning' : 'info'),
                message: message.trim(),
                code: code,
                source: 'flutter analyze'
            };

            if (!problemsByFile[fullPath]) {
                problemsByFile[fullPath] = [];
            }
            problemsByFile[fullPath].push(problem);
        }

        // Update store
        for (const [path, problems] of Object.entries(problemsByFile)) {
            problemsStore.setProblemsForFile(path, problems, 'flutter analyze');
        }
    }

    private resolveAbsolutePath(root: string, filePath: string): string {
        // parsing incoming path
        let normalizedPath = filePath;
        if (this.isWindows) {
            // Handle drive letters if present, e.g. C:\...
            if (/^[a-zA-Z]:/.test(filePath)) {
                return filePath.replace(/\//g, '\\');
            }
        } else {
            if (filePath.startsWith('/')) {
                return filePath;
            }
        }

        return this.resolvePath(root, filePath);
    }

    /**
     * Run TypeScript compiler (tsc) for project-wide type checking
     */
    private async runTscDiagnostics(rootPath: string): Promise<void> {
        try {
            // Check for tsconfig.json
            if (!await this.fileExists(rootPath, 'tsconfig.json')) {
                return;
            }

            console.log('[ProjectDiagnostics] Running tsc...');

            // Construct command
            const cmd = this.isWindows ? 'npx.cmd' : 'npx';
            const args = ['--no-install', 'tsc', '--noemit', '--pretty', 'false'];

            const result = await invoke<CommandResult>('run_command', {
                command: cmd,
                args,
                cwd: rootPath
            });

            this.parseTscOutput(result.stdout, rootPath);

        } catch (e) {
            console.warn('[ProjectDiagnostics] Failed to run tsc:', e);
        }
    }

    /**
     * Parse tsc output and populate problems store
     * Format: FILE(LINE,COL): error CODE: MESSAGE
     */
    private parseTscOutput(output: string, rootPath: string): void {
        const lines = output.split('\n');
        const problemsByFile: Record<string, Problem[]> = {};

        // Regex for tsc output (default format)
        // Example: src/index.ts(1,5): error TS2322: Type '...'
        const regex = /^(.+?)\((\d+),(\d+)\): (error|warning|info) (TS\d+): (.+)$/;

        for (const line of lines) {
            const match = line.trim().match(regex);
            if (match) {
                const [_, relativePath, lineStr, colStr, severityStr, code, message] = match;

                const path = this.resolvePath(rootPath, relativePath);
                const lineNum = parseInt(lineStr, 10);
                const colNum = parseInt(colStr, 10);

                const problem: Problem = {
                    id: `tsc-${path}-${lineNum}-${colNum}`,
                    file: path,
                    fileName: relativePath.split(/[/\\]/).pop() || relativePath,
                    line: lineNum,
                    column: colNum,
                    endLine: lineNum, // tsc doesn't give range, assume single line
                    endColumn: colNum + 1,
                    severity: severityStr === 'error' ? 'error' : 'warning',
                    message: message.trim(),
                    code,
                    source: 'tsc (build)'
                };

                if (!problemsByFile[path]) {
                    problemsByFile[path] = [];
                }
                problemsByFile[path].push(problem);
            }
        }

        // Update store
        for (const [path, problems] of Object.entries(problemsByFile)) {
            problemsStore.setProblemsForFile(path, problems, 'tsc (build)');
        }
    }

    /**
     * Run ESLint for project-wide linting
     */
    private async runEslintDiagnostics(rootPath: string): Promise<void> {
        try {
            // Check for eslint config
            const hasConfig = await Promise.race([
                this.fileExists(rootPath, '.eslintrc.json'),
                this.fileExists(rootPath, '.eslintrc.js'),
                this.fileExists(rootPath, 'eslint.config.js')
            ]);

            if (!hasConfig) return;

            console.log('[ProjectDiagnostics] Running eslint...');

            const cmd = this.isWindows ? 'npx.cmd' : 'npx';
            // Use JSON formatter for easy parsing
            const args = ['--no-install', 'eslint', '.', '--format', 'json'];

            const result = await invoke<CommandResult>('run_command', {
                command: cmd,
                args,
                cwd: rootPath
            });

            // ESLint returns exit code 1 if errors found, which is fine.
            this.parseEslintOutput(result.stdout, rootPath);

        } catch (e) {
            console.warn('[ProjectDiagnostics] Failed to run eslint:', e);
        }
    }

    /**
     * Parse ESLint JSON output
     */
    private parseEslintOutput(jsonStr: string, rootPath: string): void {
        try {
            // Find start of JSON array (ignore potential text before)
            const jsonStart = jsonStr.indexOf('[');
            if (jsonStart === -1) return;

            const json = JSON.parse(jsonStr.slice(jsonStart));

            // Type for ESLint JSON output
            interface EslintResult {
                filePath: string;
                messages: Array<{
                    ruleId: string;
                    severity: number; // 1 = warning, 2 = error
                    message: string;
                    line: number;
                    column: number;
                    endLine?: number;
                    endColumn?: number;
                }>;
            }

            for (const result of (json as EslintResult[])) {
                // Fix path separators if needed or ensure absolute
                const filePath = result.filePath;
                const problems: Problem[] = result.messages.map((msg, idx) => ({
                    id: `eslint-${filePath}-${msg.line}-${msg.column}-${idx}`,
                    file: filePath,
                    fileName: filePath.split(/[/\\]/).pop() || filePath,
                    line: msg.line,
                    column: msg.column,
                    endLine: msg.endLine || msg.line,
                    endColumn: msg.endColumn || msg.column + 1,
                    severity: msg.severity === 2 ? 'error' : 'warning',
                    message: `${msg.message} (${msg.ruleId})`,
                    code: msg.ruleId,
                    source: 'eslint (build)'
                }));

                problemsStore.setProblemsForFile(filePath, problems, 'eslint (build)');
            }

        } catch (e) {
            console.warn('Failed to parse eslint output:', e);
        }
    }

    private async fileExists(root: string, filename: string): Promise<boolean> {
        try {
            const info = await invoke<any>('get_file_info', { path: `${root}/${filename}` });
            return !!info;
        } catch {
            return false;
        }
    }

    private resolvePath(root: string, relative: string): string {
        const sep = this.isWindows ? '\\' : '/';
        return `${root}${sep}${relative.replace(/\//g, sep)}`;
    }
}

export const projectDiagnostics = new ProjectDiagnostics();
