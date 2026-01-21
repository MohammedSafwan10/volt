import { problemsStore, type Problem } from '$lib/stores/problems.svelte';
import { onTerminalData } from './terminal-client';

/**
 * TerminalProblemMatcher - Parses terminal output for errors and warnings
 * Pipes matched problems to the problemsStore
 */
class TerminalProblemMatcher {
    private unlisten: (() => void) | null = null;
    private buffer = new Map<string, string>(); // terminalId -> partial line buffer

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
            this.handleData(event.terminalId, event.data);
        });

        this.unlisten = () => {
            unlistenFn();
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
    }

    private async handleData(terminalId: string, data: string): Promise<void> {
        // Concatenate with existing buffer for this terminal
        let currentBuffer = (this.buffer.get(terminalId) || '') + data;

        // Split by lines
        const lines = currentBuffer.split(/\r?\n/);

        // Keep the last partial line in the buffer
        if (!data.endsWith('\n') && !data.endsWith('\r')) {
            this.buffer.set(terminalId, lines.pop() || '');
        } else {
            this.buffer.delete(terminalId);
        }

        // Process completed lines
        for (const line of lines) {
            await this.processLine(line.trim());
        }
    }

    private async processLine(line: string): Promise<void> {
        // Strip ANSI escape codes
        const cleanLine = line.replace(/\x1B\[[0-9;]*[mK]/g, '');

        for (const pattern of this.patterns) {
            const match = cleanLine.match(pattern.regex);
            if (match) {
                const info = pattern.map(match);
                await this.addProblem(info, pattern.source);
                break;
            }
        }
    }

    private async addProblem(info: any, source: string): Promise<void> {
        const { projectStore } = await import('$lib/stores/project.svelte');
        const rootPath = projectStore.rootPath;
        if (!rootPath) return;

        // Resolve absolute path if relative
        let filePath = info.file;
        if (!filePath.startsWith('/') && !/^[a-zA-Z]:/.test(filePath)) {
            filePath = `${rootPath}/${filePath.replace(/\\/g, '/')}`;
        }
        filePath = filePath.replace(/\\/g, '/');

        const fileName = filePath.split(/[/\\]/).pop() || filePath;

        const problem: Problem = {
            id: `terminal-${filePath}-${info.line}-${info.column}-${info.message.substring(0, 20)}`,
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

        // Add to problems store
        // We accumulate terminal problems rather than replacing the whole file's problems
        // because multiple terminal commands might report different errors.
        // However, this might lead to duplicates if the same command runs twice.
        // For now, we'll replace but with a unique source per terminal run?
        // Actually, let's just use the source name.
        problemsStore.setProblemsForFile(filePath, [problem], source);
    }
    /**
     * Clear all tracked problems and buffers
     */
    clear(): void {
        this.buffer.clear();
        // Clear all problems from terminal sources in the store
        for (const file of problemsStore.filesWithProblems) {
            problemsStore.clearProblemsForFile(file, 'flutter');
            problemsStore.clearProblemsForFile(file, 'dart');
            problemsStore.clearProblemsForFile(file, 'npm');
        }
    }
}

export const terminalProblemMatcher = new TerminalProblemMatcher();
