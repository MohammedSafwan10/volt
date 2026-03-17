import { problemsStore, type Problem } from '$shared/stores/problems.svelte';
import { onTerminalData, onTerminalExit } from './terminal-client';

let resolveProjectRootPath: (() => string | null) | null = null;

export function setTerminalProblemMatcherProjectRootResolver(
  resolver: (() => string | null) | null
): void {
  resolveProjectRootPath = resolver;
}

/**
 * TerminalProblemMatcher - Parses terminal output for errors and warnings
 * Pipes matched problems to the problemsStore
 */
interface TerminalProblemInfo {
    file: string;
    line: number;
    column: number;
    severity: Problem['severity'];
    message: string;
    code?: string;
}

interface TerminalProblemGroup {
    filePath: string;
    source: string;
    problems: Problem[];
}

export class TerminalProblemMatcher {
    private unlisten: (() => void) | null = null;
    private unlistenExit: (() => void) | null = null;
    private buffer = new Map<string, string>(); // terminalId -> partial line buffer
    private bufferFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private problemsByTerminal = new Map<string, Map<string, TerminalProblemGroup>>();
    private static readonly BUFFER_FLUSH_MS = 100;

    // Common error patterns
    private patterns = [
        // Flutter/Dart Error: lib/main.dart:45:13: Error: Message
        {
            regex: /^(.+?):(\d+):(\d+): (Error|Warning): (.+)$/,
            source: 'terminal (flutter)',
            map: (match: RegExpMatchArray) => ({
                file: match[1],
                line: parseInt(match[2]),
                column: parseInt(match[3]),
                severity: match[4].toLowerCase() === 'error' ? 'error' : 'warning',
                message: match[5]
            })
        },
        // Dart Analysis style: error: Message (code at lib/main.dart:45)
        {
            regex: /^(error|warning|info): (.+?) \((.+?) at (.+?):(\d+)\)$/,
            source: 'terminal (dart)',
            map: (match: RegExpMatchArray) => ({
                file: match[4],
                line: parseInt(match[5]),
                column: 1,
                severity: match[1] === 'error' ? 'error' : (match[1] === 'warning' ? 'warning' : 'info'),
                message: match[2],
                code: match[3]
            })
        },
        // Standard GCC/Clang style: path/to/file:line:col: error: message
        {
            regex: /^(.+?):(\d+):(\d+): (error|warning): (.+)$/,
            source: 'terminal',
            map: (match: RegExpMatchArray) => ({
                file: match[1],
                line: parseInt(match[2]),
                column: parseInt(match[3]),
                severity: match[4] as any,
                message: match[5]
            })
        }
    ];

    /**
     * Start listening to terminal data
     */
    async start(): Promise<void> {
        if (this.unlisten) return;

        const unlistenFn = await onTerminalData((event) => {
            void this.handleData(event.terminalId, event.data);
        });

        const unlistenExitFn = await onTerminalExit((event) => {
            void this.handleTerminalExit(event.terminalId);
        });

        this.unlisten = () => {
            unlistenFn();
        };
        this.unlistenExit = () => {
            unlistenExitFn();
        };
    }

    /**
     * Stop listening
     */
    stop(): void {
        if (this.unlisten) {
            this.unlisten();
            this.unlisten = null;
        }
        if (this.unlistenExit) {
            this.unlistenExit();
            this.unlistenExit = null;
        }
    }

    private async handleData(terminalId: string, data: string): Promise<void> {
        // Concatenate with existing buffer for this terminal
        let currentBuffer = (this.buffer.get(terminalId) || '') + data;

        // Split by lines
        const lines = currentBuffer.split(/\r?\n/);

        // Keep the last partial line in the buffer
        if (!data.endsWith('\n') && !data.endsWith('\r')) {
            this.buffer.set(terminalId, lines.pop() || '');
            this.scheduleBufferFlush(terminalId);
        } else {
            this.clearBuffer(terminalId);
        }

        // Process completed lines
        for (const line of lines) {
            await this.processLine(terminalId, line.trim());
        }
    }

    private async processLine(terminalId: string, line: string): Promise<boolean> {
        // Strip ANSI escape codes
        const cleanLine = line.replace(/\x1B\[[0-9;]*[mK]/g, '');

        for (const pattern of this.patterns) {
            const match = cleanLine.match(pattern.regex);
            if (match) {
                const info = pattern.map(match);
                await this.addProblem(terminalId, info, pattern.source);
                return true;
            }
        }

        return false;
    }

    private scheduleBufferFlush(terminalId: string): void {
        const existing = this.bufferFlushTimers.get(terminalId);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(() => {
            void this.flushBuffer(terminalId);
        }, TerminalProblemMatcher.BUFFER_FLUSH_MS);

        this.bufferFlushTimers.set(terminalId, timer);
    }

    private async flushBuffer(terminalId: string): Promise<void> {
        const buffered = this.buffer.get(terminalId);
        if (!buffered) return;
        const matched = await this.processLine(terminalId, buffered.trim());
        if (matched) {
            this.clearBuffer(terminalId);
        }
    }

    private async handleTerminalExit(terminalId: string): Promise<void> {
        await this.flushBuffer(terminalId);
        this.clearBuffer(terminalId);
        this.clearTerminalProblems(terminalId);
    }

    private clearBuffer(terminalId: string): void {
        this.buffer.delete(terminalId);
        const timer = this.bufferFlushTimers.get(terminalId);
        if (timer) clearTimeout(timer);
        this.bufferFlushTimers.delete(terminalId);
    }

    private groupKey(filePath: string, source: string): string {
        return `${source}::${filePath}`;
    }

    private problemFingerprint(problem: Pick<Problem, 'file' | 'line' | 'column' | 'endLine' | 'endColumn' | 'severity' | 'source' | 'code' | 'message'>): string {
        return [
            problem.file,
            problem.line,
            problem.column,
            problem.endLine,
            problem.endColumn,
            problem.severity,
            problem.source,
            problem.code ?? '',
            problem.message.trim(),
        ].join('|');
    }

    private getTerminalGroups(terminalId: string): Map<string, TerminalProblemGroup> {
        let groups = this.problemsByTerminal.get(terminalId);
        if (!groups) {
            groups = new Map<string, TerminalProblemGroup>();
            this.problemsByTerminal.set(terminalId, groups);
        }
        return groups;
    }

    private syncProblemsForFile(filePath: string, source: string): void {
        const fingerprints = new Set<string>();
        const aggregated: Problem[] = [];

        for (const groups of this.problemsByTerminal.values()) {
            const group = groups.get(this.groupKey(filePath, source));
            if (!group) continue;
            for (const problem of group.problems) {
                const fingerprint = this.problemFingerprint(problem);
                if (fingerprints.has(fingerprint)) continue;
                fingerprints.add(fingerprint);
                aggregated.push(problem);
            }
        }

        if (aggregated.length === 0) {
            problemsStore.clearProblemsForFile(filePath, source);
            return;
        }

        problemsStore.setProblemsForFile(filePath, aggregated, source);
    }

    private clearTerminalProblems(terminalId: string): void {
        const groups = this.problemsByTerminal.get(terminalId);
        if (!groups) return;

        this.problemsByTerminal.delete(terminalId);

        for (const group of groups.values()) {
            this.syncProblemsForFile(group.filePath, group.source);
        }
    }

    private async addProblem(terminalId: string, info: TerminalProblemInfo, source: string): Promise<void> {
        const rootPath = resolveProjectRootPath?.() ?? null;
        if (!rootPath) return;

        // Resolve absolute path if relative
        let filePath = info.file;
        if (!filePath.startsWith('/') && !/^[a-zA-Z]:/.test(filePath)) {
            filePath = `${rootPath}/${filePath.replace(/\\/g, '/')}`;
        }
        filePath = filePath.replace(/\\/g, '/');

        const fileName = filePath.split(/[/\\]/).pop() || filePath;

        const problem: Problem = {
            id: `terminal-${terminalId}-${filePath}-${info.line}-${info.column}-${info.severity}-${info.code ?? ''}-${info.message}`,
            file: filePath,
            fileName,
            line: info.line,
            column: info.column,
            endLine: info.line,
            endColumn: info.column + 1,
            message: info.message,
            severity: info.severity,
            source: source,
            code: info.code
        };

        const key = this.groupKey(filePath, source);
        const groups = this.getTerminalGroups(terminalId);
        const existing = groups.get(key) || { filePath, source, problems: [] };
        const fingerprint = this.problemFingerprint(problem);

        if (!existing.problems.some((p) => this.problemFingerprint(p) === fingerprint)) {
            existing.problems = [...existing.problems, problem];
            groups.set(key, existing);
            this.syncProblemsForFile(filePath, source);
        }
    }
    /**
     * Clear all tracked problems and buffers
     */
    clear(): void {
        this.buffer.clear();
        for (const timer of this.bufferFlushTimers.values()) {
            clearTimeout(timer);
        }
        this.bufferFlushTimers.clear();

        const cleared = new Set<string>();
        for (const groups of this.problemsByTerminal.values()) {
            for (const entry of groups.values()) {
                const key = this.groupKey(entry.filePath, entry.source);
                if (cleared.has(key)) continue;
                cleared.add(key);
                problemsStore.clearProblemsForFile(entry.filePath, entry.source);
            }
        }
        this.problemsByTerminal.clear();
    }
}

export const terminalProblemMatcher = new TerminalProblemMatcher();
