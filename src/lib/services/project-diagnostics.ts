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
        // Ensure platform detection is finished
        await this.checkPlatform();

        console.log('[ProjectDiagnostics] Starting project-wide analysis...');

        // Run detections in parallel
        await Promise.allSettled([
            this.runTscDiagnostics(rootPath),
            this.runEslintDiagnostics(rootPath),
            this.runLspDiagnostics(rootPath)
        ]);

        console.log('[ProjectDiagnostics] Analysis complete.');
    }

    /**
     * Trigger background analysis in LSP sidecars for non-build project types
     * (HTML, CSS, standalone JS) - and now Dart/Flutter (LSP only)
     */
    private async runLspDiagnostics(rootPath: string): Promise<void> {
        try {
            const { indexProject, isIndexReady, isIndexing, getIndexedRoot, getAllFiles } = await import('$lib/services/file-index');

            // Ensure index is ready for THIS root path
            const currentIndexedRoot = getIndexedRoot();
            if (rootPath && (currentIndexedRoot !== rootPath || !isIndexReady() || isIndexing())) {
                console.log('[ProjectDiagnostics] Waiting for file index to be ready for', rootPath);
                await indexProject(rootPath);
            }

            const allFiles = getAllFiles();
            console.log(`[ProjectDiagnostics] Index ready. Found ${allFiles.length} files in ${rootPath}`);

            // Use dynamic imports to avoid circular dependencies
            const { startProjectWideAnalysis: startCssAnalysis } = await import('./lsp/css-sidecar');
            const { startProjectWideAnalysis: startHtmlAnalysis } = await import('./lsp/html-sidecar');
            const { startProjectWideAnalysis: startTsAnalysis } = await import('./lsp/typescript-sidecar');
            const { startProjectWideAnalysis: startSvelteAnalysis } = await import('./lsp/svelte-sidecar');
            const { startDartLsp } = await import('./lsp/dart-sidecar');

            console.log('[ProjectDiagnostics] Starting background LSP analysis discovery...');

            const analysisPromises: Promise<any>[] = [
                startCssAnalysis(),
                startHtmlAnalysis(),
                startTsAnalysis(),
                startSvelteAnalysis()
            ];

            // Specific check for Dart projects to start LSP (replaces old CLI runFlutterDiagnostics)
            if (await this.fileExists(rootPath, 'pubspec.yaml')) {
                console.log('[ProjectDiagnostics] Detected Dart/Flutter project. Starting Dart LSP...');
                analysisPromises.push(startDartLsp(rootPath));
            }

            // Start discovery loops
            await Promise.all(analysisPromises);

            console.log('[ProjectDiagnostics] Background LSP analysis discovery complete.');
        } catch (e) {
            console.warn('[ProjectDiagnostics] Failed to trigger LSP analysis:', e);
        }
    }

    private resolveAbsolutePath(root: string, filePath: string): string {
        return this.resolvePath(root, filePath).replace(/\\/g, '/');
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

    private resolvePath(root: string, path: string): string {
        // If already absolute, just normalize separators
        if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
            return path.replace(/\\/g, '/');
        }
        const sep = this.isWindows ? '\\' : '/';
        const abs = `${root}${sep}${path.replace(/\//g, sep)}`;
        return abs.replace(/\\/g, '/');
    }
}

export const projectDiagnostics = new ProjectDiagnostics();
