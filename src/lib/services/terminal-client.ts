import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

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
	rows?: number
): Promise<TerminalInfo | null> {
	try {
		return await invoke<TerminalInfo>('terminal_create', { cwd, cols, rows });
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

// Global event listeners
// NOTE: Event names use "://" format to match Rust backend emit calls
export async function onTerminalData(callback: (event: TerminalDataEvent) => void): Promise<UnlistenFn> {
	return listen<TerminalDataEvent>('terminal://data', (event) => callback(event.payload));
}

export async function onTerminalExit(callback: (event: TerminalExitEvent) => void): Promise<UnlistenFn> {
	return listen<TerminalExitEvent>('terminal://exit', (event) => callback(event.payload));
}

export async function onTerminalReady(callback: (event: TerminalReadyEvent) => void): Promise<UnlistenFn> {
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

const OSC_633_REGEX = /\x1b\]633;([A-Z])(?:;([^\x07\x1b]*))?\x07|\x1b\]633;([A-Z])(?:;([^\x07\x1b]*))?\x1b\\/g;

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

function decodeOscString(str: string): string {
	if (!str) return '';
	return str.replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Universal PowerShell prompt script (works in 5.1 and Core)
export const POWERSHELL_SHELL_INTEGRATION = [
	'function prompt {',
	'  try {',
	'    $e = [char]27; $a = [char]7; $c = (Get-Location).Path',
	'    Write-Host -NoNewline "$e]633;P;Cwd=$c$a"',
	'    Write-Host -NoNewline "$e]633;A$a"',
	'    $p = "PS $c> "',
	'    Write-Host -NoNewline "$e]633;B$a"',
	'    if ($null -ne $LASTEXITCODE) { Write-Host -NoNewline "$e]633;D;$LASTEXITCODE$a" }',
	'    return $p',
	'  } catch { return "PS > " }',
	'}',
	'Write-Host -NoNewline "$([char]27)]633;P;ShellIntegration=Volt$([char]7)"'
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
	private static readonly MAX_BUFFER_CHARS = 100_000;

	private outputHistory: string[] = [];
	private outputHistoryChars = 0;
	private static readonly MAX_OUTPUT_HISTORY_CHARS = 50_000;

	private cleanOutputHistory: string[] = [];
	private cleanOutputHistoryChars = 0;

	private backendReady = false;
	private readyPromise: Promise<void>;
	private resolveReady: (() => void) | null = null;

	private shellIntegrationEnabled = false;
	private currentCwd: string | null = null;
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

	public get cwd(): string | null {
		return this.currentCwd;
	}

	public async startListening(): Promise<void> {
		this.readyUnlisten = await onTerminalReady((event) => {
			if (event.terminalId === this.id) this.markReady();
		});

		this.dataUnlisten = await onTerminalData((event) => {
			if (event.terminalId === this.id) {
				this.markReady();
				const { events, cleanData } = parseOscSequences(event.data);
				for (const ev of events) this.handleShellIntegrationEvent(ev);

				this.captureToHistory(event.data);
				if (cleanData) {
					this.captureToCleanHistory(cleanData);
					for (const cb of this.commandCompletionCallbacks) cb.outputBuffer.push(cleanData);
				}

				if (this.onDataCallback) this.onDataCallback(event.data);
				else this.bufferData(event.data);
			}
		});

		this.exitUnlisten = await onTerminalExit((event) => {
			if (event.terminalId === this.id && this.onExitCallback) this.onExitCallback(event.code);
		});
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

	private handleShellIntegrationEvent(event: ShellIntegrationEvent): void {
		switch (event.type) {
			case 'property':
				if (event.property?.key === 'ShellIntegration') {
					this.shellIntegrationEnabled = true;
				} else if (event.property?.key === 'Cwd') {
					this.currentCwd = event.property.value;
				}
				break;
			case 'command-finish':
				const exitCode = event.exitCode ?? 0;
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
				break;
		}
	}

	private cleanCommandOutput(output: string): string {
		const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
		let cleaned = output.replace(ansiRegex, '').trim();
		cleaned = cleaned.replace(/\nPS [^\n]+>\s*$/, '');
		cleaned = cleaned.replace(/\n\$\s*$/, '');
		return cleaned;
	}

	private captureToHistory(data: string): void {
		this.outputHistory.push(data);
		this.outputHistoryChars += data.length;
		while (this.outputHistoryChars > TerminalSession.MAX_OUTPUT_HISTORY_CHARS) {
			const removed = this.outputHistory.shift();
			this.outputHistoryChars -= (removed?.length ?? 0);
		}
	}

	private captureToCleanHistory(data: string): void {
		this.cleanOutputHistory.push(data);
		this.cleanOutputHistoryChars += data.length;
		while (this.cleanOutputHistoryChars > TerminalSession.MAX_OUTPUT_HISTORY_CHARS) {
			const removed = this.cleanOutputHistory.shift();
			this.cleanOutputHistoryChars -= (removed?.length ?? 0);
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

	public getRecentOutput(maxChars = 20000): string {
		const full = this.outputHistory.join('');
		return full.length <= maxChars ? full : full.slice(-maxChars);
	}

	public getRecentCleanOutput(maxChars = 10000): string {
		const full = this.cleanOutputHistory.join('');
		return full.length <= maxChars ? full : full.slice(-maxChars);
	}

	public getCleanOutputSince(offset: number): string {
		return this.cleanOutputHistory.join('').slice(offset);
	}

	public async waitForOutput(predicate: (text: string) => boolean, timeoutMs = 10000, startOffset = 0): Promise<string> {
		const startTime = Date.now();
		return new Promise((resolve, reject) => {
			const check = () => {
				const recent = this.outputHistory.join('').slice(startOffset);
				if (predicate(recent)) resolve(recent);
				else if (Date.now() - startTime > timeoutMs) reject(new Error('Timeout'));
				else setTimeout(check, 100);
			};
			check();
		});
	}

	public async enableShellIntegration(): Promise<boolean> {
		if (this.shellIntegrationEnabled) return true;
		if (!this.info.shell.toLowerCase().match(/powershell|pwsh/)) return false;

		// Send the complete integration script in a single line to be safe
		await this.write(POWERSHELL_SHELL_INTEGRATION + '\r\n');

		const start = Date.now();
		while (!this.shellIntegrationEnabled && Date.now() - start < 3000) {
			await new Promise(r => setTimeout(r, 100));
		}
		return this.shellIntegrationEnabled;
	}

	public async executeCommand(command: string, timeoutMs = 300000): Promise<CommandCompletion> {
		if (!this.shellIntegrationEnabled) return this.executeCommandFallback(command, timeoutMs);
		return new Promise((resolve) => {
			const startOffset = this.cleanOutputHistoryChars;
			const tid = setTimeout(() => {
				this.commandCompletionCallbacks = this.commandCompletionCallbacks.filter(c => c.resolve !== resolve);
				resolve({ exitCode: -1, output: this.getCleanOutputSince(startOffset), cwd: this.currentCwd ?? undefined, timedOut: true });
			}, timeoutMs);
			this.commandCompletionCallbacks.push({
				resolve: (res) => { clearTimeout(tid); resolve(res); },
				startTime: Date.now(),
				outputBuffer: [],
				startOffset
			});
			this.write(`\x1b]633;C\x07${command}\r`);
		});
	}

	private async executeCommandFallback(command: string, timeoutMs: number): Promise<CommandCompletion> {
		const sentinel = Math.random().toString(36).substring(2, 12);
		const startOffset = this.outputHistoryChars;
		const capture = `$voltExit = if ($?) { if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 } } else { if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 1 } }`;
		await this.write(`${command}; ${capture}; echo "__VOLT_EXIT_CODE_$voltExit__"; echo "__VOLT_DONE_${sentinel}__"\r`);

		try {
			const raw = await this.waitForOutput(t => t.includes(`__VOLT_DONE_${sentinel}__`), timeoutMs, startOffset);
			const exitMatch = raw.match(/__VOLT_EXIT_CODE_(\d+)__/);
			const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : 0;
			const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
			let cleaned = raw.replace(ansiRegex, '');
			const lines = cleaned.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
			let startIdx = 0;
			for (let i = 0; i < Math.min(lines.length, 5); i++) {
				if (lines[i].includes('$voltExit') || lines[i].includes('__VOLT_DONE_') || lines[i].includes(command.slice(0, 20))) startIdx = i + 1;
			}
			const final = lines.slice(startIdx).filter(l => !l.includes('__VOLT_') && !l.includes('$voltExit') && !l.includes('PS ')).join('\n').trim();
			return { exitCode, output: final || '[Done]', cwd: this.currentCwd ?? undefined, timedOut: false };
		} catch {
			return { exitCode: -1, output: '[Timeout]', timedOut: true };
		}
	}

	public async kill(): Promise<void> { await killTerminal(this.id); this.dispose(); }
	public dispose(): void { this.dataUnlisten?.(); this.exitUnlisten?.(); this.readyUnlisten?.(); }
}

export async function createTerminalSession(cwd?: string, cols?: number, rows?: number): Promise<TerminalSession | null> {
	const info = await createTerminal(cwd, cols, rows);
	if (!info) return null;
	const session = new TerminalSession(info);
	await session.startListening();
	return session;
}
