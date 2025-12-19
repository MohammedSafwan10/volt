import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { showToast } from '$lib/stores/toast.svelte';
import { logOutput } from '$lib/stores/output.svelte';

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
 * Terminal error types from Rust backend
 */
interface TerminalError {
	type:
		| 'NotFound'
		| 'CreateFailed'
		| 'WriteFailed'
		| 'ResizeFailed'
		| 'KillFailed'
		| 'AlreadyKilled'
		| 'IoError';
	terminal_id?: string;
	message?: string;
}

/**
 * Create a new terminal session
 */
export async function createTerminal(
	cwd?: string,
	cols?: number,
	rows?: number
): Promise<TerminalInfo | null> {
	try {
		logOutput('Terminal', `Creating terminal in ${cwd || 'default directory'}`);
		const info = await invoke<TerminalInfo>('terminal_create', { cwd, cols, rows });
		logOutput('Terminal', `Terminal created: ${info.terminalId} (${info.shell})`);
		return info;
	} catch (error) {
		const err = error as TerminalError;
		const message = err.message || 'Failed to create terminal';
		logOutput('Terminal', `Error creating terminal: ${message}`);
		showToast({ message, type: 'error' });
		return null;
	}
}


/**
 * Write data to a terminal
 */
export async function writeTerminal(terminalId: string, data: string): Promise<boolean> {
	try {
		await invoke('terminal_write', { terminalId, data });
		return true;
	} catch (error) {
		const err = error as TerminalError;
		if (err.type === 'AlreadyKilled') {
			// Terminal was killed, don't show error
			return false;
		}
		console.error('Terminal write error:', error);
		return false;
	}
}

/**
 * Resize a terminal
 */
export async function resizeTerminal(
	terminalId: string,
	cols: number,
	rows: number
): Promise<boolean> {
	try {
		await invoke('terminal_resize', { terminalId, cols, rows });
		return true;
	} catch (error) {
		const err = error as TerminalError;
		if (err.type === 'AlreadyKilled' || err.type === 'NotFound') {
			// Terminal was killed or not found, don't show error
			return false;
		}
		console.error('Terminal resize error:', error);
		return false;
	}
}

/**
 * Kill a terminal
 */
export async function killTerminal(terminalId: string): Promise<boolean> {
	try {
		logOutput('Terminal', `Killing terminal: ${terminalId}`);
		await invoke('terminal_kill', { terminalId });
		logOutput('Terminal', `Terminal killed: ${terminalId}`);
		return true;
	} catch (error) {
		const err = error as TerminalError;
		if (err.type === 'AlreadyKilled' || err.type === 'NotFound') {
			// Already killed or not found, consider success
			logOutput('Terminal', `Terminal already killed or not found: ${terminalId}`);
			return true;
		}
		const message = err.message || 'Failed to kill terminal';
		logOutput('Terminal', `Error killing terminal: ${message}`);
		showToast({ message, type: 'error' });
		console.error('Terminal kill error:', error);
		return false;
	}
}

/**
 * List all active terminals
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
 * Subscribe to terminal data events
 */
export async function onTerminalData(
	callback: (event: TerminalDataEvent) => void
): Promise<UnlistenFn> {
	return listen<TerminalDataEvent>('terminal://data', (event) => {
		callback(event.payload);
	});
}

/**
 * Subscribe to terminal exit events
 */
export async function onTerminalExit(
	callback: (event: TerminalExitEvent) => void
): Promise<UnlistenFn> {
	return listen<TerminalExitEvent>('terminal://exit', (event) => {
		callback(event.payload);
	});
}

/**
 * Subscribe to terminal ready events
 */
export async function onTerminalReady(
	callback: (event: TerminalReadyEvent) => void
): Promise<UnlistenFn> {
	return listen<TerminalReadyEvent>('terminal://ready', (event) => {
		callback(event.payload);
	});
}

/**
 * Terminal session manager for a single terminal instance
 * Handles event subscriptions and cleanup
 */
export class TerminalSession {
	public info: TerminalInfo;
	private dataUnlisten: UnlistenFn | null = null;
	private exitUnlisten: UnlistenFn | null = null;
	private readyUnlisten: UnlistenFn | null = null;
	private onDataCallback: ((data: string) => void) | null = null;
	private onExitCallback: ((code: number | null) => void) | null = null;
	// Buffer for data that arrives while no UI consumer is attached.
	private dataBuffer: string[] = [];
	private dataBufferChars = 0;
	private static readonly MAX_BUFFER_CHARS = 100_000;
	
	// Output history buffer for AI tool access (always captures)
	private outputHistory: string[] = [];
	private outputHistoryChars = 0;
	private static readonly MAX_OUTPUT_HISTORY_CHARS = 50_000;

	// Backend readiness handshake
	private backendReady = false;
	private readyPromise: Promise<void>;
	private resolveReady: (() => void) | null = null;

	constructor(info: TerminalInfo) {
		this.info = info;
		this.readyPromise = new Promise((resolve) => {
			this.resolveReady = resolve;
		});
	}

	private markReady(): void {
		if (this.backendReady) return;
		this.backendReady = true;
		this.resolveReady?.();
		this.resolveReady = null;
	}

	get id(): string {
		return this.info.terminalId;
	}

	/**
	 * Start listening for terminal events
	 */
	async startListening(): Promise<void> {
		this.readyUnlisten = await onTerminalReady((event) => {
			if (event.terminalId === this.info.terminalId) {
				this.markReady();
			}
		});

		this.dataUnlisten = await onTerminalData((event) => {
			if (event.terminalId === this.info.terminalId) {
				// If we receive any data, the terminal is effectively ready.
				this.markReady();
				// Always capture to output history (for AI tools)
				this.captureToHistory(event.data);
				
				if (this.onDataCallback) {
					this.onDataCallback(event.data);
				} else {
					this.bufferData(event.data);
				}
			}
		});

		this.exitUnlisten = await onTerminalExit((event) => {
			if (event.terminalId === this.info.terminalId && this.onExitCallback) {
				this.onExitCallback(event.code);
			}
		});
	}

	/**
	 * Wait until the backend indicates the terminal is ready.
	 * Falls back to "first output" readiness if the ready event is missed.
	 */
	async waitForReady(timeoutMs = 2000): Promise<boolean> {
		if (this.backendReady) return true;
		return await Promise.race([
			this.readyPromise.then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(this.backendReady), timeoutMs))
		]);
	}

	private bufferData(data: string): void {
		this.dataBuffer.push(data);
		this.dataBufferChars += data.length;
		while (this.dataBufferChars > TerminalSession.MAX_BUFFER_CHARS && this.dataBuffer.length > 0) {
			const removed = this.dataBuffer.shift();
			this.dataBufferChars -= removed?.length ?? 0;
		}
	}
	
	/**
	 * Capture data to output history (for AI tool access)
	 */
	private captureToHistory(data: string): void {
		this.outputHistory.push(data);
		this.outputHistoryChars += data.length;
		while (this.outputHistoryChars > TerminalSession.MAX_OUTPUT_HISTORY_CHARS && this.outputHistory.length > 0) {
			const removed = this.outputHistory.shift();
			this.outputHistoryChars -= removed?.length ?? 0;
		}
	}
	
	/**
	 * Get recent output from the terminal (for AI tools)
	 * @param maxChars Maximum characters to return
	 */
	getRecentOutput(maxChars = 10000): string {
		const fullOutput = this.outputHistory.join('');
		if (fullOutput.length <= maxChars) {
			return fullOutput;
		}
		return fullOutput.slice(-maxChars);
	}
	
	/**
	 * Clear output history
	 */
	clearOutputHistory(): void {
		this.outputHistory = [];
		this.outputHistoryChars = 0;
	}
	
	/**
	 * Wait for output matching a pattern or timeout
	 * Useful for waiting for command completion
	 */
	async waitForOutput(
		predicate: (output: string) => boolean,
		timeoutMs = 30000
	): Promise<string> {
		const startOutput = this.getRecentOutput();
		const startLen = startOutput.length;
		
		return new Promise((resolve) => {
			const startTime = Date.now();
			let checkCount = 0;
			
			const checkOutput = () => {
				checkCount++;
				const currentOutput = this.getRecentOutput();
				const newOutput = currentOutput.slice(startLen);
				
				if (predicate(newOutput)) {
					resolve(newOutput);
					return;
				}
				
				if (Date.now() - startTime > timeoutMs) {
					// On timeout, return whatever output we have (not an error message)
					resolve(newOutput || '');
					return;
				}
				
				// Check every 100ms
				setTimeout(checkOutput, 100);
			};
			
			// Start checking after a small delay to let initial output arrive
			setTimeout(checkOutput, 50);
		});
	}

	/**
	 * Set callback for terminal data.
	 * - Pass a function to attach a consumer and flush buffered data.
	 * - Pass null to detach the consumer and start buffering again.
	 */
	onData(callback: ((data: string) => void) | null): void {
		this.onDataCallback = callback;
		if (!callback) return;
		if (this.dataBuffer.length === 0) return;
		const buffered = this.dataBuffer.join('');
		this.dataBuffer = [];
		this.dataBufferChars = 0;
		callback(buffered);
	}

	/**
	 * Set callback for terminal exit
	 */
	onExit(callback: (code: number | null) => void): void {
		this.onExitCallback = callback;
	}

	/**
	 * Write data to the terminal
	 */
	async write(data: string): Promise<boolean> {
		return writeTerminal(this.info.terminalId, data);
	}

	/**
	 * Resize the terminal
	 */
	async resize(cols: number, rows: number): Promise<boolean> {
		const success = await resizeTerminal(this.info.terminalId, cols, rows);
		if (success) {
			this.info.cols = cols;
			this.info.rows = rows;
		}
		return success;
	}

	/**
	 * Kill the terminal
	 */
	async kill(): Promise<boolean> {
		return killTerminal(this.info.terminalId);
	}

	/**
	 * Clean up event listeners
	 */
	async dispose(): Promise<void> {
		if (this.dataUnlisten) {
			this.dataUnlisten();
			this.dataUnlisten = null;
		}
		if (this.exitUnlisten) {
			this.exitUnlisten();
			this.exitUnlisten = null;
		}
		if (this.readyUnlisten) {
			this.readyUnlisten();
			this.readyUnlisten = null;
		}
		this.onDataCallback = null;
		this.onExitCallback = null;
	}
}

/**
 * Create a new terminal session with event handling
 */
export async function createTerminalSession(
	cwd?: string,
	cols?: number,
	rows?: number
): Promise<TerminalSession | null> {
	const info = await createTerminal(cwd, cols, rows);
	if (!info) {
		return null;
	}

	const session = new TerminalSession(info);
	await session.startListening();
	return session;
}
