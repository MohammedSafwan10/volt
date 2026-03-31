import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { registerCleanup } from '$core/services/hmr-cleanup';

/**
 * Terminal session info returned from Rust backend
 */
export interface TerminalInfo {
	terminalId: string;
	shell: string;
	cwd: string;
	cols: number;
	rows: number;
}

/**
 * Terminal data event payload
 */
export interface TerminalDataEvent {
	terminalId: string;
	data: string;
}

/**
 * Terminal exit event payload
 */
export interface TerminalExitEvent {
	terminalId: string;
	code: number | null;
}

/**
 * Terminal ready event payload
 */
export interface TerminalReadyEvent {
	terminalId: string;
}

/**
 * Create a new raw terminal via Tauri invoke
 */
export async function createTerminal(
	cwd?: string,
	cols?: number,
	rows?: number,
	ai = false,
): Promise<TerminalInfo | null> {
	try {
		return await invoke<TerminalInfo>('terminal_create', { cwd, cols, rows, ai });
	} catch (error) {
		console.error('Terminal create error:', error);
		return null;
	}
}

/**
 * Write data to a terminal via Tauri invoke
 */
export async function writeTerminal(terminalId: string, data: string): Promise<boolean> {
	try {
		await invoke('terminal_write', { terminalId, data });
		return true;
	} catch (error) {
		console.error('Terminal write error:', error);
		return false;
	}
}

/**
 * Resize a terminal via Tauri invoke
 */
export async function resizeTerminal(terminalId: string, cols: number, rows: number): Promise<boolean> {
	try {
		await invoke('terminal_resize', { terminalId, cols, rows });
		return true;
	} catch (error) {
		console.error('Terminal resize error:', error);
		return false;
	}
}

/**
 * Kill a terminal via Tauri invoke
 */
export async function killTerminal(terminalId: string): Promise<boolean> {
	try {
		await invoke('terminal_kill', { terminalId });
		return true;
	} catch (error) {
		console.error('Terminal kill error:', error);
		return false;
	}
}

/**
 * List all active terminals via Tauri invoke
 */
export async function listTerminals(): Promise<TerminalInfo[]> {
	try {
		return await invoke<TerminalInfo[]>('terminal_list');
	} catch (error) {
		console.error('Terminal list error:', error);
		return [];
	}
}

/**
 * Read backend scrollback for an active terminal.
 * Used to rehydrate terminal output after frontend reload/HMR.
 */
export async function getTerminalScrollback(
	terminalId: string,
	maxChars = 250_000
): Promise<string> {
	try {
		return await invoke<string>('terminal_get_scrollback', { terminalId, maxChars });
	} catch (error) {
		console.error('Terminal scrollback error:', error);
		return '';
	}
}

/**
 * Kill all terminals via Tauri invoke
 */
export async function killAllTerminals(): Promise<boolean> {
	try {
		await invoke('terminal_kill_all');
		return true;
	} catch (error) {
		console.error('Terminal kill all error:', error);
		return false;
	}
}

// Global event dispatcher to prevent race conditions
const sessionRegistry = new Map<string, TerminalSession>();
const pendingEvents = new Map<string, Array<{ type: string; payload: any }>>();

/**
 * Start global listeners immediately to capture all terminal events
 */
type TerminalListenerState = {
	started: boolean;
	startPromise: Promise<void> | null;
	unlisteners: UnlistenFn[];
};

const globalScope = globalThis as typeof globalThis & {
	__voltTerminalListeners?: TerminalListenerState;
};

function getTerminalListenerState(): TerminalListenerState {
	if (!globalScope.__voltTerminalListeners) {
		globalScope.__voltTerminalListeners = {
			started: false,
			startPromise: null,
			unlisteners: []
		};
	}
	return globalScope.__voltTerminalListeners;
}

async function startGlobalListeners() {
	if (typeof window === 'undefined') return;
	const state = getTerminalListenerState();
	if (state.started) return;
	if (state.startPromise) return state.startPromise;

	state.startPromise = (async () => {
		const [unlistenData, unlistenExit, unlistenReady] = await Promise.all([
			listen<TerminalDataEvent>('terminal://data', (event) => {
				const session = sessionRegistry.get(event.payload.terminalId);
				if (session) {
					session.handleDataEvent(event.payload);
				} else {
					const events = pendingEvents.get(event.payload.terminalId) || [];
					events.push({ type: 'data', payload: event.payload });
					pendingEvents.set(event.payload.terminalId, events);
				}
			}),
			listen<TerminalExitEvent>('terminal://exit', (event) => {
				const session = sessionRegistry.get(event.payload.terminalId);
				if (session) {
					session.handleExitEvent(event.payload);
				} else {
					const events = pendingEvents.get(event.payload.terminalId) || [];
					events.push({ type: 'exit', payload: event.payload });
					pendingEvents.set(event.payload.terminalId, events);
				}
			}),
			listen<TerminalReadyEvent>('terminal://ready', (event) => {
				const session = sessionRegistry.get(event.payload.terminalId);
				if (session) {
					session.handleReadyEvent(event.payload);
				} else {
					const events = pendingEvents.get(event.payload.terminalId) || [];
					events.push({ type: 'ready', payload: event.payload });
					pendingEvents.set(event.payload.terminalId, events);
				}
			})
		]);

		state.unlisteners = [unlistenData, unlistenExit, unlistenReady];
		state.started = true;
		state.startPromise = null;
	})().catch((error) => {
		state.startPromise = null;
		state.started = false;
		console.error('[TerminalClient] Failed to start global listeners:', error);
	});

	return state.startPromise;
}

async function stopGlobalListeners(): Promise<void> {
	const state = getTerminalListenerState();
	for (const unlisten of state.unlisteners) {
		try {
			unlisten();
		} catch {
			// ignore
		}
	}
	state.unlisteners = [];
	state.started = false;
	state.startPromise = null;
}

// Kick off global listeners
void startGlobalListeners();
registerCleanup('terminal-client-events', () => stopGlobalListeners());

export async function onTerminalData(
	callback: (event: TerminalDataEvent) => void
): Promise<UnlistenFn> {
	if (typeof window === 'undefined') return () => {};
	return listen<TerminalDataEvent>('terminal://data', (event) => callback(event.payload));
}

export async function onTerminalExit(
	callback: (event: TerminalExitEvent) => void
): Promise<UnlistenFn> {
	if (typeof window === 'undefined') return () => {};
	return listen<TerminalExitEvent>('terminal://exit', (event) => callback(event.payload));
}

export async function onTerminalReady(
	callback: (event: TerminalReadyEvent) => void
): Promise<UnlistenFn> {
	if (typeof window === 'undefined') return () => {};
	return listen<TerminalReadyEvent>('terminal://ready', (event) => callback(event.payload));
}

// ============================================================================
// OSC 633 Shell Integration
// ============================================================================

export interface ShellIntegrationEvent {
	type: 'prompt-start' | 'prompt-end' | 'command-start' | 'command-finish' | 'command-line' | 'property';
	exitCode?: number;
	command?: string;
	property?: { key: string; value: string };
}

export interface CommandCompletion {
	exitCode: number;
	output: string;
	cwd?: string;
	timedOut: boolean;
}

export const POWERSHELL_SHELL_INTEGRATION_IDENTITY = 'Volt/2';

const OSC_633_REGEX = /\x1b\]633;([A-Z])(?:;([^\x07\x1b]*))?\x07|\x1b\]633;([A-Z])(?:;([^\x07\x1b]*))?\x1b\\/g;
const OSC_GENERIC_REGEX = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function stripTerminalArtifacts(data: string): string {
	if (!data) return '';
	let cleaned = data;

	// Remove OSC control sequences (633 + any other OSC payload)
	cleaned = cleaned.replace(OSC_633_REGEX, '');
	cleaned = cleaned.replace(OSC_GENERIC_REGEX, '');

	// Remove fallback sentinels and helper variable noise
	cleaned = cleaned
		.replace(/__VOLT_EXIT_CODE_\d+__/g, '')
		.replace(/__VOLT_DONE_[A-Za-z0-9]+__/g, '')
		.replace(/^\s*\$voltExit\s*=.*$/gm, '')
		.replace(/\$voltExit\s*=\s*if\s*\(\$\?\)[\s\S]*?__VOLT_DONE_[A-Za-z0-9]+__/g, '');

	// Remove leaked plain-text cursor query marker while preserving real ESC[6n control queries.
	// Stripping ESC[6n would prevent xterm from answering DSR and can freeze prompt rendering.
	cleaned = cleaned.replace(/(?<!\x1b)\[6n/g, '');

	// Remove any line that still contains raw shell integration markers
	cleaned = cleaned
		.replace(/^.*\]633;.*$/gm, '')
		.replace(/^.*ShellIntegration=Volt.*$/gmi, '')
		.replace(/^.*function prompt \{.*$/gmi, '')
		.replace(/^.*Write-Host -NoNewline.*$/gmi, '')
		.replace(/^.*\$e = \[char\]27.*$/gmi, '')
		.replace(/^.*catch \{ return "PS > " \}.*$/gmi, '')
		.replace(/^\s*>>\s*$/gm, '');

	return cleaned;
}

function parseOscSequences(data: string): { events: ShellIntegrationEvent[]; cleanData: string } {
	const events: ShellIntegrationEvent[] = [];
	let cleanData = data;

	let match;
	while ((match = OSC_633_REGEX.exec(data)) !== null) {
		const code = match[1] || match[3];
		const params = match[2] || match[4] || '';

		switch (code) {
			case 'A': events.push({ type: 'prompt-start' }); break;
			case 'B': events.push({ type: 'prompt-end' }); break;
			case 'C': events.push({ type: 'command-start' }); break;
			case 'D': events.push({ type: 'command-finish', exitCode: params ? parseInt(params, 10) : undefined }); break;
			case 'E': events.push({ type: 'command-line', command: decodeOscString(params) }); break;
			case 'P':
				const parts = params.split('=');
				if (parts.length >= 2) {
					events.push({ type: 'property', property: { key: parts[0], value: decodeOscString(parts.slice(1).join('=')) } });
				}
				break;
		}
	}

	cleanData = data.replace(OSC_633_REGEX, '');
	return { events, cleanData };
}

import {
	inferTerminalCommandFailure,
	normalizeCommandForTerminalShell,
} from './terminal-command-safety';

function decodeOscString(str: string): string {
	if (!str) return '';
	return str.replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Universal PowerShell prompt script (works in 5.1 and Core)
export const POWERSHELL_SHELL_INTEGRATION = [
	'function prompt {',
	'  try {',
	'    $e = [char]27; $a = [char]7; $c = (Get-Location).Path;',
	'    Write-Host -NoNewline "$e]633;P;Cwd=$c$a";',
	'    Write-Host -NoNewline "$e]633;A$a";',
	'    $p = "PS $c> ";',
	'    Write-Host -NoNewline "$e]633;B$a";',
	'    $voltExit = if ($?) { if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 } } else { if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 1 } };',
	'    Write-Host -NoNewline "$e]633;D;$voltExit$a";',
	'    return $p;',
	'  } catch { return "PS > " }',
	'};',
	`Write-Host -NoNewline "$([char]27)]633;P;ShellIntegration=${POWERSHELL_SHELL_INTEGRATION_IDENTITY}$([char]7)";`,
	'Write-Host -NoNewline "$([char]27)]633;P;Cwd=$((Get-Location).Path)$([char]7)"'
].join(' ');

/**
 * Terminal session manager
 */
export class TerminalSession {
	public info: TerminalInfo;
	private dataUnlisten: UnlistenFn | null = null;
	private exitUnlisten: UnlistenFn | null = null;
	private readyUnlisten: UnlistenFn | null = null;
	private onDataCallback: ((data: string) => void) | null = null;
	private onExitCallback: ((code: number | null) => void) | null = null;

	private dataBuffer: string[] = [];
	private dataBufferChars = 0;
	private static readonly MAX_BUFFER_CHARS = 1_000_000;

	private outputHistory: string[] = [];
	private outputHistoryChars = 0;
	private static readonly MAX_OUTPUT_HISTORY_CHARS = 1_000_000;
	private outputStartOffset = 0;
	private outputEndOffset = 0;

	private cleanOutputHistory: string[] = [];
	private cleanOutputHistoryChars = 0;
	private cleanOutputStartOffset = 0;
	private cleanOutputEndOffset = 0;

	private backendReady = false;
	private readyPromise: Promise<void>;
	private resolveReady: (() => void) | null = null;

	private shellIntegrationEnabled = false;
	private shellIntegrationIdentityValue: string | null = null;
	private shellIntegrationBootstrapPending = false;
	private currentCwd: string | null = null;
	private lastCommandStartedAt: number | null = null;
	private lastCommandFinishedAt: number | null = null;
	private commandCompletionCallbacks: Array<{
		resolve: (result: CommandCompletion) => void;
		startTime: number;
		outputBuffer: string[];
		startOffset: number;
	}> = [];

	constructor(info: TerminalInfo) {
		this.info = info;
		this.currentCwd = info.cwd;
		this.readyPromise = new Promise((resolve) => {
			this.resolveReady = resolve;
		});
	}

	public get id(): string { return this.info.terminalId; }

	public get hasShellIntegration(): boolean {
		return this.shellIntegrationEnabled;
	}

	public get shellIntegrationIdentity(): string | null {
		return this.shellIntegrationIdentityValue;
	}

	public get cwd(): string | null {
		return this.currentCwd;
	}

	public getLastCommandStartedAt(): number | null {
		return this.lastCommandStartedAt;
	}

	public getLastCommandFinishedAt(): number | null {
		return this.lastCommandFinishedAt;
	}

	public async startListening(): Promise<void> {
		// Register with global dispatcher
		sessionRegistry.set(this.id, this);

		// Flush any pending events that arrived before we started listening
		const events = pendingEvents.get(this.id);
		if (events) {
			pendingEvents.delete(this.id);
			for (const event of events) {
				if (event.type === 'data') this.handleDataEvent(event.payload);
				else if (event.type === 'exit') this.handleExitEvent(event.payload);
				else if (event.type === 'ready') this.handleReadyEvent(event.payload);
			}
		}
	}

	public handleDataEvent(payload: TerminalDataEvent): void {
		this.markReady();
		const suppressBootstrapEcho = this.shellIntegrationBootstrapPending;
		const { events, cleanData } = parseOscSequences(payload.data);
		const batchHasExplicitCommandFinish = events.some((event) => event.type === 'command-finish');

		this.captureToHistory(payload.data);
		if (cleanData) {
			const sanitized = stripTerminalArtifacts(cleanData);
			if (sanitized && !suppressBootstrapEcho) {
				this.captureToCleanHistory(sanitized);
				for (const cb of this.commandCompletionCallbacks) cb.outputBuffer.push(sanitized);
			}
		}

		const filteredDisplay = stripTerminalArtifacts(cleanData);

		if (filteredDisplay && !suppressBootstrapEcho) {
			if (this.onDataCallback) this.onDataCallback(filteredDisplay);
			else this.bufferData(filteredDisplay);
		}

		for (const ev of events) {
			this.handleShellIntegrationEvent(ev, {
				batchHasExplicitCommandFinish,
			});
		}
	}

	/**
	 * Rehydrate in-memory buffers from backend scrollback after reload/HMR.
	 */
	public hydrateScrollback(rawData: string): void {
		if (!rawData) return;
		this.handleDataEvent({ terminalId: this.id, data: rawData });
	}

	public handleExitEvent(payload: TerminalExitEvent): void {
		if (this.commandCompletionCallbacks.length > 0) {
			this.resolvePendingCommandCompletions(payload.code ?? 1);
		}
		if (this.onExitCallback) this.onExitCallback(payload.code);
	}

	public handleReadyEvent(payload: TerminalReadyEvent): void {
		this.markReady();
	}

	private markReady(): void {
		if (this.backendReady) return;
		this.backendReady = true;
		this.resolveReady?.();
	}

	public async waitForReady(timeoutMs = 5000): Promise<boolean> {
		if (this.backendReady) return true;
		const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(this.backendReady), timeoutMs));
		return Promise.race([this.readyPromise.then(() => true), timeout]);
	}

	public async write(data: string): Promise<boolean> {
		return writeTerminal(this.id, data);
	}

	public async resize(cols: number, rows: number): Promise<boolean> {
		const success = await resizeTerminal(this.id, cols, rows);
		if (success) {
			this.info.cols = cols;
			this.info.rows = rows;
		}
		return success;
	}

	public onData(callback: ((data: string) => void) | null): void {
		this.onDataCallback = callback;
		if (callback && this.dataBuffer.length > 0) {
			callback(this.dataBuffer.join(''));
			this.dataBuffer = [];
			this.dataBufferChars = 0;
		}
	}

	public onExit(callback: (code: number | null) => void): void {
		this.onExitCallback = callback;
	}

	private handleShellIntegrationEvent(
		event: ShellIntegrationEvent,
		context: { batchHasExplicitCommandFinish: boolean } = { batchHasExplicitCommandFinish: false },
	): void {
		switch (event.type) {
			case 'property':
				if (event.property?.key === 'ShellIntegration') {
					this.shellIntegrationEnabled = true;
					this.shellIntegrationIdentityValue = event.property.value;
					this.shellIntegrationBootstrapPending = false;
				} else if (event.property?.key === 'Cwd') {
					this.currentCwd = event.property.value;
				}
				break;
			case 'command-start':
				this.lastCommandStartedAt = Date.now();
				this.lastCommandFinishedAt = null;
				break;
			case 'command-finish':
				this.resolvePendingCommandCompletions(event.exitCode ?? 0);
				break;
			case 'prompt-end':
				// PowerShell built-ins can complete without publishing an explicit D marker.
				// When the prompt returns while a command is pending, treat that as completion.
				if (
					this.commandCompletionCallbacks.length > 0 &&
					!context.batchHasExplicitCommandFinish
				) {
					this.resolvePendingCommandCompletions(0);
				}
				break;
		}
	}

	private resolvePendingCommandCompletions(exitCode: number): void {
		this.lastCommandFinishedAt = Date.now();
		const callbacks = [...this.commandCompletionCallbacks];
		this.commandCompletionCallbacks = [];
		for (const cb of callbacks) {
			cb.resolve({
				exitCode,
				output: this.cleanCommandOutput(cb.outputBuffer.join('')),
				cwd: this.currentCwd ?? undefined,
				timedOut: false
			});
		}
	}

	private cleanCommandOutput(output: string): string {
		const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
		let cleaned = output.replace(ansiRegex, '');
		cleaned = stripTerminalArtifacts(cleaned).trim();
		cleaned = cleaned.replace(/\r/g, '');
		cleaned = cleaned.replace(/\nPS [^\n]+>\s*$/, '');
		cleaned = cleaned.replace(/\n\$\s*$/, '');
		return cleaned;
	}

	private captureToHistory(data: string): void {
		this.outputHistory.push(data);
		this.outputHistoryChars += data.length;
		this.outputEndOffset += data.length;
		while (this.outputHistoryChars > TerminalSession.MAX_OUTPUT_HISTORY_CHARS) {
			const removed = this.outputHistory.shift();
			const removedLen = removed?.length ?? 0;
			this.outputHistoryChars -= removedLen;
			this.outputStartOffset += removedLen;
		}
	}

	private captureToCleanHistory(data: string): void {
		this.cleanOutputHistory.push(data);
		this.cleanOutputHistoryChars += data.length;
		this.cleanOutputEndOffset += data.length;
		while (this.cleanOutputHistoryChars > TerminalSession.MAX_OUTPUT_HISTORY_CHARS) {
			const removed = this.cleanOutputHistory.shift();
			const removedLen = removed?.length ?? 0;
			this.cleanOutputHistoryChars -= removedLen;
			this.cleanOutputStartOffset += removedLen;
		}
	}

	private bufferData(data: string): void {
		this.dataBuffer.push(data);
		this.dataBufferChars += data.length;
		while (this.dataBufferChars > TerminalSession.MAX_BUFFER_CHARS) {
			const removed = this.dataBuffer.shift();
			this.dataBufferChars -= (removed?.length ?? 0);
		}
	}

	private getRecentSegments(chunks: string[], maxChars: number): string {
		if (maxChars <= 0 || chunks.length === 0) return '';
		let remaining = maxChars;
		const selected: string[] = [];
		for (let i = chunks.length - 1; i >= 0 && remaining > 0; i--) {
			const chunk = chunks[i];
			if (!chunk) continue;
			if (chunk.length <= remaining) {
				selected.push(chunk);
				remaining -= chunk.length;
				continue;
			}
			selected.push(chunk.slice(-remaining));
			remaining = 0;
		}
		return selected.reverse().join('');
	}

	private sliceHistoryFromOffset(
		chunks: string[],
		historyStartOffset: number,
		offset: number,
		maxChars: number
	): string {
		if (chunks.length === 0) return '';
		const normalizedOffset = Number.isFinite(offset) ? Math.max(0, offset) : 0;
		let absoluteCursor = historyStartOffset;
		const collected: string[] = [];
		for (const chunk of chunks) {
			if (!chunk) continue;
			const chunkStart = absoluteCursor;
			const chunkEnd = chunkStart + chunk.length;
			absoluteCursor = chunkEnd;
			if (chunkEnd <= normalizedOffset) continue;
			const localStart = Math.max(0, normalizedOffset - chunkStart);
			collected.push(chunk.slice(localStart));
		}
		let text = collected.join('');
		if (text.length > maxChars) {
			text = text.slice(-maxChars);
		}
		return text;
	}

	public getRecentOutput(maxChars = 20000): string {
		return this.getRecentSegments(this.outputHistory, maxChars);
	}

	public getRecentCleanOutput(maxChars = 10000): string {
		return this.getRecentSegments(this.cleanOutputHistory, maxChars);
	}

	public getOutputCursor(): number {
		return this.outputEndOffset;
	}

	public getOutputCharCount(): number {
		return this.outputHistoryChars;
	}

	public readOutputSince(
		offset: number,
		maxChars = 200_000
	): { text: string; nextOffset: number; truncatedBeforeOffset: boolean } {
		const normalizedOffset = Number.isFinite(offset) ? Math.max(0, offset) : 0;
		const startOffset = Math.max(normalizedOffset, this.outputStartOffset);
		const text = this.sliceHistoryFromOffset(
			this.outputHistory,
			this.outputStartOffset,
			startOffset,
			maxChars
		);
		return {
			text,
			nextOffset: this.outputEndOffset,
			truncatedBeforeOffset: normalizedOffset < this.outputStartOffset
		};
	}

	public getCleanOutputCursor(): number {
		return this.cleanOutputEndOffset;
	}

	public readCleanOutputSince(
		offset: number,
		maxChars = 200_000
	): { text: string; nextOffset: number; truncatedBeforeOffset: boolean } {
		const normalizedOffset = Number.isFinite(offset) ? Math.max(0, offset) : 0;
		const startOffset = Math.max(normalizedOffset, this.cleanOutputStartOffset);
		const text = this.sliceHistoryFromOffset(
			this.cleanOutputHistory,
			this.cleanOutputStartOffset,
			startOffset,
			maxChars
		);
		return {
			text,
			nextOffset: this.cleanOutputEndOffset,
			truncatedBeforeOffset: normalizedOffset < this.cleanOutputStartOffset
		};
	}

	public getCleanOutputSince(offset: number): string {
		return this.readCleanOutputSince(offset, Number.POSITIVE_INFINITY).text;
	}

	public async waitForOutput(predicate: (text: string) => boolean, timeoutMs = 10000, startOffset = 0): Promise<string> {
		const startTime = Date.now();
		return new Promise((resolve, reject) => {
			const check = () => {
				const recent = this.readOutputSince(startOffset).text;
				if (predicate(recent)) resolve(recent);
				else if (Date.now() - startTime > timeoutMs) reject(new Error('Timeout'));
				else setTimeout(check, 100);
			};
			check();
		});
	}

	public async enableShellIntegration(): Promise<boolean> {
		if (
			this.shellIntegrationEnabled &&
			this.shellIntegrationIdentityValue === POWERSHELL_SHELL_INTEGRATION_IDENTITY
		) {
			return true;
		}
		if (!this.info.shell.toLowerCase().match(/powershell|pwsh/)) return false;

		// Send the complete integration script in a single line to be safe
		this.shellIntegrationBootstrapPending = true;
		await this.write(POWERSHELL_SHELL_INTEGRATION + '\r\n');

		const start = Date.now();
		while (!this.shellIntegrationEnabled && Date.now() - start < 3000) {
			await new Promise(r => setTimeout(r, 100));
		}
		if (!this.shellIntegrationEnabled) {
			this.shellIntegrationBootstrapPending = false;
		}
		return this.shellIntegrationEnabled;
	}

	public async executeCommand(command: string, timeoutMs = 300000): Promise<CommandCompletion> {
		const normalizedCommand = normalizeCommandForTerminalShell(command, this.info.shell);
		if (!this.shellIntegrationEnabled) return this.executeCommandFallback(normalizedCommand, timeoutMs);
		return new Promise((resolve) => {
			const startOffset = this.getCleanOutputCursor();
			this.lastCommandStartedAt = Date.now();
			this.lastCommandFinishedAt = null;
			let tid: ReturnType<typeof setTimeout> | null = null;
			if (timeoutMs > 0) {
				tid = setTimeout(() => {
					this.commandCompletionCallbacks = this.commandCompletionCallbacks.filter(c => c.resolve !== resolve);
					void this.write('\u0003');
					resolve({ exitCode: -1, output: this.getCleanOutputSince(startOffset), cwd: this.currentCwd ?? undefined, timedOut: true });
				}, timeoutMs);
			}
			this.commandCompletionCallbacks.push({
				resolve: (res) => { if (tid) clearTimeout(tid); resolve(res); },
				startTime: Date.now(),
				outputBuffer: [],
				startOffset
			});
			this.write(`\x1b]633;C\x07${normalizedCommand}\r`);
		});
	}

	private async executeCommandFallback(command: string, timeoutMs: number): Promise<CommandCompletion> {
		const sentinel = Math.random().toString(36).substring(2, 12);
		const startOffset = this.getOutputCursor();
		const capture = `$voltExit = if ($?) { if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 } } else { if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 1 } }`;
		await this.write(`${command}; ${capture}; echo "__VOLT_EXIT_CODE_$voltExit__"; echo "__VOLT_DONE_${sentinel}__"\r`);

		try {
			const effectiveTimeout = timeoutMs > 0 ? timeoutMs : Number.POSITIVE_INFINITY;
			const raw = await this.waitForOutput((t) => {
				if (t.includes(`__VOLT_DONE_${sentinel}__`)) return true;
				return Boolean(
					inferTerminalCommandFailure({
						shell: this.info.shell,
						command,
						exitCode: 0,
						timedOut: false,
						output: stripTerminalArtifacts(t),
					}),
				);
			}, effectiveTimeout, startOffset);
			const exitMatch = raw.match(/__VOLT_EXIT_CODE_(\d+)__/);
			const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : 0;
			const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
			let cleaned = raw.replace(ansiRegex, '');
			cleaned = stripTerminalArtifacts(cleaned);
			const lines = cleaned.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
			let startIdx = 0;
			for (let i = 0; i < Math.min(lines.length, 5); i++) {
				if (lines[i].includes('$voltExit') || lines[i].includes('__VOLT_DONE_') || lines[i].includes(command.slice(0, 20))) startIdx = i + 1;
			}
			const final = lines.slice(startIdx).filter(l => !l.includes('__VOLT_') && !l.includes('$voltExit') && !l.includes('PS ')).join('\n').trim();
			const inferredFailure = inferTerminalCommandFailure({
				shell: this.info.shell,
				command,
				exitCode,
				timedOut: false,
				output: final || cleaned,
			});
			if (inferredFailure) {
				return {
					exitCode: inferredFailure.exitCode,
					output: final || cleaned || inferredFailure.reason,
					cwd: this.currentCwd ?? undefined,
					timedOut: false,
				};
			}
			return { exitCode, output: final || '[Done]', cwd: this.currentCwd ?? undefined, timedOut: false };
		} catch {
			const raw = this.readOutputSince(startOffset).text;
			const cleaned = stripTerminalArtifacts(raw);
			const inferredFailure = inferTerminalCommandFailure({
				shell: this.info.shell,
				command,
				exitCode: 0,
				timedOut: false,
				output: cleaned,
			});
			if (inferredFailure) {
				return {
					exitCode: inferredFailure.exitCode,
					output: cleaned || inferredFailure.reason,
					cwd: this.currentCwd ?? undefined,
					timedOut: false,
				};
			}
			return { exitCode: -1, output: '[Timeout]', timedOut: true };
		}
	}

	public async kill(): Promise<void> {
		await killTerminal(this.id);
		this.dispose();
	}

	public dispose(): void {
		sessionRegistry.delete(this.id);
		pendingEvents.delete(this.id);
		this.dataUnlisten?.();
		this.exitUnlisten?.();
		this.readyUnlisten?.();
	}
}

export async function createTerminalSession(cwd?: string, cols?: number, rows?: number, ai = false): Promise<TerminalSession | null> {
	const info = await createTerminal(cwd, cols, rows, ai);
	if (!info) return null;
	const session = new TerminalSession(info);
	await session.startListening();
	return session;
}

/**
 * Rehydrate a session object from an already-running backend terminal.
 * Used after frontend reload/HMR so existing terminals remain visible/controllable.
 */
export async function createTerminalSessionFromInfo(info: TerminalInfo): Promise<TerminalSession> {
	const session = new TerminalSession(info);
	await session.startListening();
	const scrollback = await getTerminalScrollback(info.terminalId);
	if (scrollback) {
		session.hydrateScrollback(scrollback);
	}
	return session;
}
