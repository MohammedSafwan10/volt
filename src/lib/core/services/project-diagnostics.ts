import { invoke } from '@tauri-apps/api/core';
import { problemsStore, type Problem } from '$shared/stores/problems.svelte';
import {
    clearIndex,
    getAllFiles,
    getIndexedRoot,
    indexProject,
    isIndexReady,
    isIndexing,
} from '$core/services/file-index';
import { startProjectWideAnalysis as startCssAnalysis } from '$core/lsp/css-sidecar';
import { startProjectWideAnalysis as startHtmlAnalysis } from '$core/lsp/html-sidecar';
import { startProjectWideAnalysis as startTsAnalysis } from '$core/lsp/typescript-sidecar';
import { startProjectWideAnalysis as startSvelteAnalysis } from '$core/lsp/svelte-sidecar';
import { startProjectWideAnalysis as startEslintAnalysis } from '$core/lsp/eslint-sidecar';
import {
    startDartLsp,
    startProjectWideAnalysis as startDartAnalysis,
} from '$core/lsp/dart-sidecar';
import { getStaleSourceFiles } from '$core/services/diagnostics-source-utils';
import { waitForProjectDiagnosticsDelay } from '$core/services/project-diagnostics-timing';

interface SystemCapabilities {
    os_name?: string;
}

interface CommandResult {
    exit_code: number;
    stdout: string;
    stderr: string;
}

interface DiagnosticsRunToken {
    id: number;
    rootPath: string;
}

interface LspProjectDiagnosticsPlan {
    action: 'run' | 'delay' | 'queued' | 'noop';
    runId: number | null;
    rootPath: string | null;
    delayMs: number;
    staggerMs: number;
    sidecars: SidecarKey[];
    staleSources: string[];
    freshSources: string[];
}

type SidecarKey = 'css' | 'html' | 'typescript' | 'svelte' | 'eslint' | 'dart';

async function getSystemInfo(): Promise<SystemCapabilities> {
    return invoke('get_system_info');
}

/**
 * Run project-wide diagnostics (TypeScript, ESLint, etc.)
 * This runs independent of the LSP to catch build/compilation errors across the entire project.
 */
export class ProjectDiagnostics {
    private isWindows = false;
    private eslintBuildFiles = new Set<string>();
    private activeRunToken: DiagnosticsRunToken | null = null;
    private isRunning = false;
    private pendingRoot: string | null = null;

    constructor() {
        this.checkPlatform();
    }

    reset(): void {
        this.eslintBuildFiles.clear();
        this.activeRunToken = null;
        this.isRunning = false;
        this.pendingRoot = null;
        void invoke('lsp_reset_project_diagnostics_scheduler').catch((error) => {
            console.warn('[ProjectDiagnostics] Failed to reset backend scheduler:', error);
        });
    }

    private isRunCurrent(token: DiagnosticsRunToken): boolean {
        return this.activeRunToken?.id === token.id;
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
        if (this.isRunning) {
            this.pendingRoot = rootPath;
            return;
        }

        this.isRunning = true;
        // Ensure platform detection is finished
        try {
            await this.checkPlatform();

            if (this.pendingRoot && this.pendingRoot !== rootPath) {
                return;
            }

            const requestedSidecars = await this.getRequestedSidecars(rootPath);
            const plan = await invoke<LspProjectDiagnosticsPlan | null>(
                'lsp_begin_project_diagnostics_managed',
                {
                    rootPath,
                    sidecars: requestedSidecars,
                },
            );

            if (!plan || this.handleSchedulerPlan(plan)) {
                return;
            }

            if (plan.action !== 'run' || plan.runId === null) {
                return;
            }

            const runToken = { id: plan.runId, rootPath };
            this.activeRunToken = runToken;

            console.log('[ProjectDiagnostics] Starting project-wide analysis...');

            // Run detections in parallel
            // NOTE: We skip runTscDiagnostics here because tsc-watcher.ts handles
            // real-time TypeScript errors via `tsc --watch`. Running both would cause duplicates.
            try {
                await Promise.allSettled([
                    // this.runTscDiagnostics(rootPath), // Handled by tsc-watcher.ts
                    this.runEslintDiagnostics(rootPath, runToken),
                    this.runLspDiagnostics(rootPath, runToken, plan),
                ]);
            } finally {
                if (this.activeRunToken?.id === runToken.id) {
                    this.activeRunToken = null;
                }
                console.log('[ProjectDiagnostics] Analysis complete.');

                const followUp = await invoke<LspProjectDiagnosticsPlan | null>(
                    'lsp_complete_project_diagnostics_managed',
                    {
                        runId: runToken.id,
                        sidecars: requestedSidecars,
                    },
                );
                if (followUp) {
                    if (followUp.action === 'run' && followUp.runId !== null && followUp.rootPath) {
                        this.applySchedulerSourceFreshness(followUp);
                        this.pendingRoot = followUp.rootPath;
                    } else {
                        this.handleSchedulerPlan(followUp);
                    }
                }
            }
        } finally {
            this.isRunning = false;
            if (this.pendingRoot) {
                const nextRoot = this.pendingRoot;
                this.pendingRoot = null;
                await this.runDiagnostics(nextRoot);
            }
        }
    }

    /**
     * Trigger background analysis in LSP sidecars for non-build project types
     * (HTML, CSS, standalone JS) - and now Dart/Flutter (LSP only)
     */
    private async getRequestedSidecars(rootPath: string): Promise<SidecarKey[]> {
        const sidecars: SidecarKey[] = ['css', 'html', 'typescript', 'svelte', 'eslint'];
        if (await this.fileExists(rootPath, 'pubspec.yaml')) {
            sidecars.push('dart');
        }
        return sidecars;
    }

    private handleSchedulerPlan(plan: LspProjectDiagnosticsPlan): boolean {
        this.applySchedulerSourceFreshness(plan);
        return plan.action !== 'run';
    }

    private applySchedulerSourceFreshness(plan: LspProjectDiagnosticsPlan): void {
        for (const source of plan.freshSources) {
            problemsStore.markSourceFresh(source);
        }
        for (const source of plan.staleSources) {
            problemsStore.markSourceStale(source);
        }
    }

    private async runLspDiagnostics(
        rootPath: string,
        token: DiagnosticsRunToken,
        plan: LspProjectDiagnosticsPlan,
    ): Promise<void> {
        try {
            if (!this.isRunCurrent(token)) return;

            // Ensure index is ready for THIS root path
            const currentIndexedRoot = getIndexedRoot();
            if (rootPath && (currentIndexedRoot !== rootPath || !isIndexReady() || isIndexing())) {
                console.log('[ProjectDiagnostics] Waiting for file index to be ready for', rootPath);
                await indexProject(rootPath);
                if (!this.isRunCurrent(token)) return;
            }

            let allFiles = getAllFiles();
            console.log(`[ProjectDiagnostics] Index ready. Found ${allFiles.length} files in ${rootPath}`);

            // If index returned 0 files but project exists, force re-index without cache
            if (allFiles.length === 0 && rootPath) {
                console.log('[ProjectDiagnostics] Index returned 0 files - forcing re-index without cache...');
                await clearIndex(true); // Clear backend cache
                await indexProject(rootPath, false); // Re-index without using cache
                if (!this.isRunCurrent(token)) return;
                allFiles = getAllFiles();
                console.log(`[ProjectDiagnostics] Re-index complete. Found ${allFiles.length} files`);
            }

            console.log('[ProjectDiagnostics] Starting background LSP analysis discovery...');

            const analysisSteps: Array<{ key: SidecarKey; start: () => Promise<void> }> = [
                { key: 'css', start: () => startCssAnalysis() },
                { key: 'html', start: () => startHtmlAnalysis() },
                { key: 'typescript', start: () => startTsAnalysis() },
                { key: 'svelte', start: () => startSvelteAnalysis() },
                { key: 'eslint', start: () => startEslintAnalysis() },
            ];

            // Specific check for Dart projects to start LSP and run analysis
            if (plan.sidecars.includes('dart')) {
                console.log('[ProjectDiagnostics] Detected Dart/Flutter project. Starting Dart LSP...');
                analysisSteps.push({
                    key: 'dart',
                    start: async () => {
                        await startDartLsp(rootPath);
                        await startDartAnalysis();
                    },
                });
            }

            if (!this.isRunCurrent(token)) return;

            for (const analysis of analysisSteps.filter(({ key }) => plan.sidecars.includes(key))) {
                if (!this.isRunCurrent(token)) return;
                problemsStore.markSourceFresh(this.getProblemsSourceForSidecar(analysis.key));
                await this.startSidecarAnalysis(analysis.key, analysis.start, token);
                if (!this.isRunCurrent(token)) return;
                await waitForProjectDiagnosticsDelay(plan.staggerMs);
            }

            console.log('[ProjectDiagnostics] Background LSP analysis discovery complete.');
        } catch (e) {
            console.warn('[ProjectDiagnostics] Failed to trigger LSP analysis:', e);
        }
    }

    private async noteSidecarFailure(sidecar: SidecarKey, error: unknown): Promise<boolean> {
        const typedError = error as { type?: string; message?: string } | undefined;
        const type = typedError?.type ?? '';
        const message = typedError?.message ?? String(error ?? '');

        if (type === 'ServerAlreadyRunning') {
            console.log(`[ProjectDiagnostics] ${sidecar} sidecar already running, continuing`);
            return true;
        }

        const cooledDown = await invoke<boolean>(
            'lsp_note_project_diagnostics_sidecar_failure',
            {
                sidecar,
                errorType: type || null,
                message,
            },
        );
        if (cooledDown) {
            console.warn(
                `[ProjectDiagnostics] ${sidecar} sidecar unavailable; backend scheduler delayed retries`,
                error,
            );
        }
        return cooledDown;
    }

    private async startSidecarAnalysis(
        sidecar: SidecarKey,
        start: () => Promise<void>,
        token: DiagnosticsRunToken,
    ): Promise<void> {
        if (!this.isRunCurrent(token)) {
            return;
        }

        try {
            await start();
        } catch (error) {
            if (await this.noteSidecarFailure(sidecar, error)) {
                problemsStore.markSourceStale(this.getProblemsSourceForSidecar(sidecar));
                return;
            }
            throw error;
        }
    }

    private getProblemsSourceForSidecar(sidecar: SidecarKey): string {
        switch (sidecar) {
            case 'typescript':
                return 'typescript';
            case 'eslint':
                return 'eslint';
            default:
                return sidecar;
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

            // Parse both stdout and stderr (tsc can output to either)
            const fullOutput = result.stdout + '\n' + result.stderr;
            this.parseTscOutput(fullOutput, rootPath);
            
            // Log for debugging
            if (result.exit_code !== 0) {
                console.log('[ProjectDiagnostics] tsc exited with code:', result.exit_code);
            }

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

        let matchCount = 0;
        for (const line of lines) {
            const match = line.trim().match(regex);
            if (match) {
                matchCount++;
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

        // Log results
        const totalProblems = Object.values(problemsByFile).reduce((sum, p) => sum + p.length, 0);
        console.log(`[ProjectDiagnostics] Parsed ${matchCount} tsc errors from ${lines.length} lines`);

        // Update store
        for (const [path, problems] of Object.entries(problemsByFile)) {
            problemsStore.setProblemsForFile(path, problems, 'tsc (build)');
        }
    }

    /**
     * Run ESLint for project-wide linting
     */
    private async runEslintDiagnostics(rootPath: string, token: DiagnosticsRunToken): Promise<void> {
        try {
            if (!this.isRunCurrent(token)) return;

            // Check for eslint config
            const hasConfig = await Promise.race([
                this.fileExists(rootPath, '.eslintrc.json'),
                this.fileExists(rootPath, '.eslintrc.js'),
                this.fileExists(rootPath, 'eslint.config.js')
            ]);

            if (!this.isRunCurrent(token)) return;
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

            if (!this.isRunCurrent(token)) return;

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

            const nextFiles = new Set<string>();

            for (const result of (json as EslintResult[])) {
                // Fix path separators if needed or ensure absolute
                const filePath = this.resolveAbsolutePath(rootPath, result.filePath);
                nextFiles.add(filePath);
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

            for (const filePath of getStaleSourceFiles(this.eslintBuildFiles, nextFiles)) {
                problemsStore.clearProblemsForFile(filePath, 'eslint (build)');
            }

            this.eslintBuildFiles = nextFiles;

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
        let result: string;
        
        // If already absolute, just normalize separators
        if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
            result = path.replace(/\\/g, '/');
        } else {
            const sep = this.isWindows ? '\\' : '/';
            const abs = `${root}${sep}${path.replace(/\//g, sep)}`;
            result = abs.replace(/\\/g, '/');
        }
        
        // Lowercase drive letter for Windows path consistency with Monaco
        if (result.match(/^[A-Z]:/)) {
            result = result[0].toLowerCase() + result.slice(1);
        }
        
        return result;
    }
}

export const projectDiagnostics = new ProjectDiagnostics();
