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

export interface TerminalSnapshot {
	info: TerminalInfo;
	scrollback: string;
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
	shellIntegrationIdentity?: string | null;
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

export async function interruptTerminal(terminalId: string): Promise<boolean> {
	try {
		await invoke('terminal_interrupt', { terminalId });
		return true;
	} catch (error) {
		console.error('Terminal interrupt error:', error);
		return false;
	}
}

export async function listTerminalSnapshots(maxChars = 250_000): Promise<TerminalSnapshot[]> {
	try {
		return await invoke<TerminalSnapshot[]>('terminal_list_snapshots', { maxChars });
	} catch (error) {
		console.error('Terminal list snapshots error:', error);
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

export async function waitForTerminalShellIntegration(
	terminalId: string,
	timeoutMs = 3000,
): Promise<string | null> {
	try {
		return await invoke<string | null>('terminal_wait_for_shell_integration', {
			terminalId,
			timeoutMs,
		});
	} catch (error) {
		console.error('Terminal shell integration wait error:', error);
		return null;
	}
}

interface NativeCommandCompletion {
	exitCode: number;
	output: string;
	cwd?: string;
	timedOut: boolean;
}

export async function executeTerminalCommandFallback(
	terminalId: string,
	command: string,
	timeoutMs: number,
): Promise<NativeCommandCompletion | null> {
	try {
		return await invoke<NativeCommandCompletion>('terminal_execute_command_fallback', {
			terminalId,
			command,
			timeoutMs,
		});
	} catch (error) {
		console.error('Terminal fallback command error:', error);
		return null;
	}
}

export async function scheduleTerminalInterrupt(
	terminalId: string,
	delayMs: number,
	token: number,
): Promise<boolean> {
	try {
		return await invoke<boolean>('terminal_schedule_interrupt', {
			terminalId,
			delayMs,
			token,
		});
	} catch (error) {
		console.error('Terminal schedule interrupt error:', error);
		return false;
	}
}

export async function cancelScheduledTerminalInterrupt(
	terminalId: string,
	token: number,
): Promise<void> {
	try {
		await invoke('terminal_cancel_scheduled_interrupt', {
			terminalId,
			token,
		});
	} catch (error) {
		console.error('Terminal cancel interrupt error:', error);
	}
}

export async function waitForTerminalOutput(
	terminalId: string,
	startOffset: number,
	timeoutMs = 10000,
): Promise<string | null> {
	try {
		return await invoke<string | null>('terminal_wait_for_output', {
			terminalId,
			startOffset,
			timeoutMs,
		});
	} catch (error) {
		console.error('Terminal wait for output error:', error);
		return null;
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

function isUnavailableEventBridgeError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? '');
	return (
		message.includes("transformCallback") ||
		message.includes("__TAURI_INTERNALS__") ||
		message.includes("window.__TAURI_INTERNALS__")
	);
}

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
		if (isUnavailableEventBridgeError(error)) {
			return;
		}
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

/**
 * Comprehensive ANSI/VT escape sequence regex.
 * Covers:
 *  - CSI sequences including private-mode (e.g. \x1b[?25l, \x1b[93m, \x1b[0m, \x1b[K, \x1b[H, \x1b[2J)
 *  - OSC sequences (already handled by the specific regexes above, but catch stragglers)
 *  - Single-character escape sequences (e.g. \x1b7, \x1b8, \x1bM, \x1b=, \x1b>)
 *  - DCS sequences (\x1bP...\x1b\\)
 *  - APC/PM/SOS sequences
 */
const ANSI_FULL_REGEX = /[\x1b\x9b][\[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-nqry=><~lhm]|[\x1b]\[[\?]?[0-9;]*[a-zA-Z]|[\x1b][PX^_][^\x1b]*\x1b\\|[\x1b][^\x1b\[\]PX^_]/g;

/**
 * Collapse carriage-return overwrites within each line.
 * When the shell re-renders a line interactively it writes partial text,
 * then \r, then the complete text.  Only the final segment after the last \r
 * should survive.
 */
function collapseCarriageReturns(data: string): string {
	return data.split('\n').map(line => {
		if (!line.includes('\r')) return line;
		// Keep only the content after the last \r (which is the final rendering)
		const segments = line.split('\r');
		// The last non-empty segment is the final render of the line
		for (let i = segments.length - 1; i >= 0; i--) {
			if (segments[i].length > 0) return segments[i];
		}
		return '';
	}).join('\n');
}

/**
 * Simulate backspace characters (\\x08) within each line.
 * PowerShell's interactive rendering writes characters then backspaces
 * to overwrite them (e.g. writing 'W' then \\x08 to replace it).
 * This processes each line like a real terminal screen buffer would.
 */
function simulateBackspaces(data: string): string {
	return data.split('\n').map(line => {
		if (!line.includes('\x08')) return line;
		const chars: string[] = [];
		for (const ch of line) {
			if (ch === '\x08') {
				chars.pop(); // delete previous character
			} else {
				chars.push(ch);
			}
		}
		return chars.join('');
	}).join('\n');
}

/**
 * DISPLAY-SAFE stripping — only removes Volt/shell-integration artifacts.
 * Keeps ALL ANSI escape sequences intact so xterm.js can render colors,
 * cursor positioning, and prompt styling correctly.
 *
 * Use this for data flowing to xterm.js (onDataCallback / bufferData).
 */
function stripForDisplay(data: string): string {
	if (!data) return '';
	let cleaned = data;

	// Remove OSC control sequences (633 + any other OSC payload)
	// xterm doesn't need these — they're our shell integration protocol
	cleaned = cleaned.replace(OSC_633_REGEX, '');
	cleaned = cleaned.replace(OSC_GENERIC_REGEX, '');

	// Remove fallback sentinels and helper variable noise
	cleaned = cleaned
		.replace(/__VOLT_EXIT_CODE_\d+__/g, '')
		.replace(/__VOLT_DONE_[A-Za-z0-9]+__/g, '')
		.replace(/^\s*\$voltExit\s*=.*$/gm, '')
		.replace(/\$voltExit\s*=\s*if\s*\(\$\?\)[\s\S]*?__VOLT_DONE_[A-Za-z0-9]+__/g, '');

	// Remove leaked plain-text cursor query marker while preserving real ESC[6n control queries.
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

/**
 * AGGRESSIVE stripping for AI-consumed output.
 * Removes ALL ANSI escape sequences, collapses carriage-return overwrites,
 * strips PowerShell prompts, and collapses blank lines.
 *
 * Use this for cleanOutputHistory, commandCompletionCallbacks, and
 * anywhere the AI agent reads terminal output.
 *
 * This is the equivalent of reading from xterm.js's buffer API (plain text)
 * rather than from the raw PTY byte stream.
 */
function sanitizeForAI(data: string): string {
	if (!data) return '';
	let cleaned = data;

	// Remove OSC control sequences (633 + any other OSC payload)
	cleaned = cleaned.replace(OSC_633_REGEX, '');
	cleaned = cleaned.replace(OSC_GENERIC_REGEX, '');

	// Remove ALL ANSI/CSI escape sequences (colors, cursor movement, private mode, etc.)
	cleaned = cleaned.replace(ANSI_FULL_REGEX, '');

	// Collapse carriage-return line overwrites (partial re-renders from the shell)
	cleaned = collapseCarriageReturns(cleaned);

	// Simulate backspace characters: PowerShell uses \x08 to overwrite
	// characters interactively, leaving noise like "W\b" or "PathX\b\b\b\b"
	cleaned = simulateBackspaces(cleaned);

	// Remove fallback sentinels and helper variable noise
	cleaned = cleaned
		.replace(/__VOLT_EXIT_CODE_\d+__/g, '')
		.replace(/__VOLT_DONE_[A-Za-z0-9]+__/g, '')
		.replace(/^\s*\$voltExit\s*=.*$/gm, '')
		.replace(/\$voltExit\s*=\s*if\s*\(\$\?\)[\s\S]*?__VOLT_DONE_[A-Za-z0-9]+__/g, '');

	// Remove leaked plain-text cursor query marker
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

	// Remove all PowerShell prompt lines (not just trailing ones)
	cleaned = cleaned.replace(/^PS [^\n>]+>\s*$/gm, '');

	// Collapse excessive blank lines (3+ newlines → 2)
	cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

	return cleaned;
}

/**
 * Kept as a convenience alias for backwards compatibility.
 * For new code, prefer sanitizeForAI() for AI output and stripForDisplay() for xterm.
 */
function stripTerminalArtifacts(data: string): string {
	return sanitizeForAI(data);
}

function stripTrailingPowerShellPrompt(data: string): string {
	if (!data) return data;
	let cleaned = data;
	// Collapse carriage returns
	cleaned = collapseCarriageReturns(cleaned);
	// Remove standalone \r that may still linger
	cleaned = cleaned.replace(/\r/g, '');
	// Strip ALL PowerShell prompt lines, not only trailing ones
	cleaned = cleaned.replace(/^PS [^\n>]+>\s*$/gm, '');
	// Strip trailing prompt specifically (may have partial match)
	cleaned = cleaned.replace(/(?:^|\n)PS [^\n>]+>\s*$/g, '');
	cleaned = cleaned.replace(/(?:^|\n)>>\s*$/g, '');
	// Collapse excessive blank lines
	cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
	return cleaned.trim();
}

function filterFallbackOutputLines(lines: string[], command: string): string[] {
	const normalizedCommand = command.trim();
	const collapsedCommand = normalizedCommand.replace(/\s+/g, ' ');
	const commandPrefix = collapsedCommand.slice(0, 20);
	const promptLikeLine = /^(?:PS [^>]+>\s*|>>\s*)$/;

	return lines.filter((line) => {
		const trimmed = line.trim();
		if (!trimmed) return false;
		if (promptLikeLine.test(trimmed)) return false;
		if (trimmed.includes('__VOLT_')) return false;
		if (trimmed.includes('$voltExit')) return false;
		if (normalizedCommand && trimmed === normalizedCommand) return false;
		if (collapsedCommand && trimmed.replace(/\s+/g, ' ') === collapsedCommand) return false;
		if (commandPrefix && trimmed.includes(commandPrefix)) return false;
		return true;
	});
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
 * Minimal interface for the subset of the xterm.js Terminal API we need.
 * Using an interface avoids importing the full @xterm/xterm module here
 * (which would break the lazy-loading pattern in terminal-loader.ts).
 */
export interface XtermBufferReader {
	buffer: {
		active: {
			length: number;
			baseY: number;
			cursorY: number;
			getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
		};
	};
}

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

	private dataListeners = new Set<(data: string) => void>();
	private commandFinishListeners = new Set<(exitCode: number) => void>();

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

	/**
	 * Reference to the xterm.js Terminal instance (set by TerminalView when mounted).
	 * When available, we read clean output directly from xterm's rendered buffer
	 * rather than regex-cleaning raw PTY bytes — this is the production-ready
	 * approach used by VSCode and other professional terminal emulators.
	 */
	private xtermRef: XtermBufferReader | null = null;

	/**
	 * The xterm buffer line index at the time the xterm ref was attached.
	 * Used to know how far back we can reliably read from the buffer.
	 */
	private xtermBaselineY = 0;

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

	/**
	 * Attach the xterm.js Terminal instance so we can read from its rendered buffer.
	 * Called by TerminalView when it mounts and initializes xterm.
	 */
	public setXtermRef(term: XtermBufferReader): void {
		this.xtermRef = term;
		// Record how many lines are already in the buffer at attach time
		const buf = term.buffer.active;
		this.xtermBaselineY = buf.baseY + buf.cursorY;
	}

	/**
	 * Detach the xterm.js reference (e.g. when TerminalView unmounts).
	 */
	public clearXtermRef(): void {
		this.xtermRef = null;
	}

	/**
	 * Read clean, rendered text from xterm.js's internal buffer.
	 *
	 * This is the production-ready approach: xterm.js has already processed
	 * EVERY ANSI escape sequence, backspace, carriage return, cursor movement,
	 * and line wrap into a clean cell-based screen buffer — exactly what the
	 * user sees on screen. We just read it out line-by-line.
	 *
	 * Returns null if xterm is not attached (caller should fall back to
	 * sanitizeForAI-based cleanOutputHistory).
	 */
	private readXtermBuffer(): string | null {
		if (!this.xtermRef) return null;
		try {
			const buf = this.xtermRef.buffer.active;
			const lines: string[] = [];
			// Read from line 0 up to and including the cursor line
			const lastLine = buf.baseY + buf.cursorY;
			for (let i = 0; i <= lastLine && i < buf.length; i++) {
				const line = buf.getLine(i);
				if (line) {
					lines.push(line.translateToString(true));
				}
			}
			// Join and strip PowerShell prompts (xterm buffer still shows them)
			let text = lines.join('\n');
			text = text.replace(/^PS [^\n>]+>\s*$/gm, '');
			// Remove Volt sentinels that might appear
			text = text.replace(/__VOLT_EXIT_CODE_\d+__/g, '');
			text = text.replace(/__VOLT_DONE_[A-Za-z0-9]+__/g, '');
			// Collapse excessive blank lines
			text = text.replace(/\n{3,}/g, '\n\n');
			return text;
		} catch {
			// If xterm buffer access fails for any reason, fall back gracefully
			return null;
		}
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
			// Aggressive stripping for AI — no ANSI, no prompts, no carriage-return ghosts
			const sanitized = sanitizeForAI(cleanData);
			if (sanitized && !suppressBootstrapEcho) {
				this.captureToCleanHistory(sanitized);
				for (const cb of this.commandCompletionCallbacks) cb.outputBuffer.push(sanitized);
			}
		}

		// Light stripping for xterm display — keeps ANSI escape codes intact
		// so xterm.js can render colors, cursor position, and prompt styling
		const filteredDisplay = stripForDisplay(cleanData);

		if (filteredDisplay && !suppressBootstrapEcho) {
			if (this.onDataCallback) this.onDataCallback(filteredDisplay);
			else this.bufferData(filteredDisplay);
		}

		// Notify registered data listeners (used by execute strategies)
		for (const listener of this.dataListeners) {
			try { listener(payload.data); } catch { /* ignore listener errors */ }
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
		if (payload.shellIntegrationIdentity) {
			this.shellIntegrationEnabled = true;
			this.shellIntegrationIdentityValue = payload.shellIntegrationIdentity;
			this.shellIntegrationBootstrapPending = false;
		}
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

	public async interrupt(): Promise<boolean> {
		return interruptTerminal(this.id);
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

	/**
	 * Register a data listener that receives every data event.
	 * Returns an unsubscribe function.
	 */
	public addDataListener(callback: (data: string) => void): () => void {
		this.dataListeners.add(callback);
		return () => { this.dataListeners.delete(callback); };
	}

	/**
	 * Register a one-shot or persistent listener for command-finish events.
	 * Returns an unsubscribe function.
	 */
	public onCommandFinish(callback: (exitCode: number) => void): () => void {
		this.commandFinishListeners.add(callback);
		return () => { this.commandFinishListeners.delete(callback); };
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
			case 'command-finish': {
				const finishCode = event.exitCode ?? 0;
				this.resolvePendingCommandCompletions(finishCode);
				// Notify registered command-finish listeners (used by execute strategies)
				for (const listener of this.commandFinishListeners) {
					try { listener(finishCode); } catch { /* ignore listener errors */ }
				}
				break;
			}
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
		let cleaned = output.replace(ANSI_FULL_REGEX, '');
		cleaned = stripTerminalArtifacts(cleaned);
		cleaned = cleaned.replace(/\n\$\s*$/, '');
		return stripTrailingPowerShellPrompt(cleaned);
	}

	private finalizeFallbackCommandResult(
		command: string,
		completion: NativeCommandCompletion,
	): CommandCompletion {
		let cleaned = completion.output.replace(ANSI_FULL_REGEX, '');
		cleaned = stripTerminalArtifacts(cleaned);
		const lines = cleaned.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
		let startIdx = 0;
		for (let i = 0; i < Math.min(lines.length, 5); i++) {
			if (
				lines[i].includes('$voltExit') ||
				lines[i].includes('__VOLT_DONE_') ||
				lines[i].includes(command.slice(0, 20))
			) {
				startIdx = i + 1;
			}
		}
		const final = filterFallbackOutputLines(lines.slice(startIdx), command).join('\n').trim();
		const inferredFailure = inferTerminalCommandFailure({
			shell: this.info.shell,
			command,
			exitCode: completion.exitCode,
			timedOut: completion.timedOut,
			output: final || stripTrailingPowerShellPrompt(cleaned),
		});
		if (inferredFailure) {
			return {
				exitCode: inferredFailure.exitCode,
				output: final || stripTrailingPowerShellPrompt(cleaned) || inferredFailure.reason,
				cwd: completion.cwd ?? this.currentCwd ?? undefined,
				timedOut: completion.timedOut,
			};
		}
		return {
			exitCode: completion.exitCode,
			output: final || (completion.timedOut ? '[Timeout]' : '[Done]'),
			cwd: completion.cwd ?? this.currentCwd ?? undefined,
			timedOut: completion.timedOut,
		};
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
		// Prefer xterm buffer (fully rendered, zero artifacts)
		const xtermText = this.readXtermBuffer();
		if (xtermText !== null) {
			return xtermText.length > maxChars ? xtermText.slice(-maxChars) : xtermText;
		}
		// Fallback: regex-cleaned history (tests / headless)
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
		// Prefer xterm buffer when available — it's the rendered screen,
		// already processed by xterm.js (no ANSI, no backspace artifacts).
		const xtermText = this.readXtermBuffer();
		if (xtermText !== null) {
			// The xterm buffer gives us the full rendered screen.
			// We still use the offset cursors so the coordinator can track
			// what has already been read vs what's new.
			const finalText = xtermText.length > maxChars
				? xtermText.slice(-maxChars)
				: xtermText;
			return {
				text: finalText,
				nextOffset: this.cleanOutputEndOffset,
				truncatedBeforeOffset: false
			};
		}

		// Fallback: regex-cleaned history (tests / headless / xterm not yet mounted)
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

	public async waitForAnyOutput(startOffset = 0, timeoutMs = 10000): Promise<string> {
		const output = await waitForTerminalOutput(this.id, startOffset, timeoutMs);
		if (output === null) {
			throw new Error('Timeout');
		}
		return output;
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
		const identity = await waitForTerminalShellIntegration(this.id, 3000);
		if (identity) {
			this.shellIntegrationEnabled = true;
			this.shellIntegrationIdentityValue = identity;
			this.shellIntegrationBootstrapPending = false;
			return true;
		}
		if (!this.shellIntegrationEnabled) {
			this.shellIntegrationBootstrapPending = false;
		}
		return this.shellIntegrationEnabled;
	}

	public async executeCommand(command: string, timeoutMs = 300000): Promise<CommandCompletion> {
		const normalizedCommand = normalizeCommandForTerminalShell(command, this.info.shell);
		if (!this.shellIntegrationEnabled) return this.executeCommandFallback(normalizedCommand, timeoutMs);
		const startOffset = this.getCleanOutputCursor();
		const timeoutToken =
			timeoutMs > 0 ? Math.floor(Date.now() * 1000 + Math.random() * 1000) : null;
		const completionPromise = new Promise<CommandCompletion>((resolve) => {
			this.lastCommandStartedAt = Date.now();
			this.lastCommandFinishedAt = null;
			this.commandCompletionCallbacks.push({
				resolve: (res) => {
					if (timeoutToken !== null) {
						void cancelScheduledTerminalInterrupt(this.id, timeoutToken);
					}
					resolve(res);
				},
				startTime: Date.now(),
				outputBuffer: [],
				startOffset
			});
			this.write(`\x1b]633;C\x07${normalizedCommand}\r`);
		});

		if (timeoutToken === null) {
			return completionPromise;
		}

		const timeoutPromise = scheduleTerminalInterrupt(this.id, timeoutMs, timeoutToken).then(
			(triggered) => {
				if (!triggered) {
					return new Promise<CommandCompletion>(() => {});
				}
				this.commandCompletionCallbacks = this.commandCompletionCallbacks.filter(
					(callback) => callback.startOffset !== startOffset,
				);
				return {
					exitCode: -1,
					output: this.getCleanOutputSince(startOffset),
					cwd: this.currentCwd ?? undefined,
					timedOut: true,
				};
			},
		);

		return Promise.race([completionPromise, timeoutPromise]);
	}

	private async executeCommandFallback(command: string, timeoutMs: number): Promise<CommandCompletion> {
		const completion = await executeTerminalCommandFallback(this.id, command, timeoutMs);
		if (!completion) {
			return { exitCode: -1, output: '[Timeout]', timedOut: true };
		}
		return this.finalizeFallbackCommandResult(command, completion);
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

export async function createTerminalSessionFromSnapshot(
	snapshot: TerminalSnapshot,
): Promise<TerminalSession> {
	const session = new TerminalSession(snapshot.info);
	await session.startListening();
	if (snapshot.scrollback) {
		session.hydrateScrollback(snapshot.scrollback);
	}
	return session;
}
