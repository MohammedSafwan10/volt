import {
	createTerminalSession,
	listTerminals,
	type TerminalInfo,
	TerminalSession
} from '$lib/services/terminal-client';
import { projectStore } from './project.svelte';

/**
 * Terminal store for managing terminal sessions
 */
class TerminalStore {
	sessions = $state<TerminalSession[]>([]);
	activeTerminalId = $state<string | null>(null);
	private createPromise: Promise<TerminalSession | null> | null = null;
	private sessionLabels = $state<Record<string, string>>({});
	private aiTerminalId = $state<string | null>(null);

	/**
	 * Get the active terminal session
	 */
	get activeSession(): TerminalSession | null {
		if (!this.activeTerminalId) return null;
		return this.sessions.find((s) => s.id === this.activeTerminalId) ?? null;
	}

	/**
	 * Create a new terminal session
	 */
	async createTerminal(cwd?: string): Promise<TerminalSession | null> {
		// If a terminal creation is already in-flight, await it.
		// This prevents races where callers see `null` and assume terminal creation failed.
		if (this.createPromise) {
			return await this.createPromise;
		}

		this.createPromise = (async () => {
			// Use project root as default cwd
			const workingDir = cwd ?? projectStore.rootPath ?? undefined;

			const session = await createTerminalSession(workingDir);
			if (!session) {
				return null;
			}

			// Set up exit handler to remove session when terminal exits
			session.onExit(() => {
				void session.dispose();
				this.removeSession(session.id);
			});

			// Use spread to trigger reactivity (Svelte 5 $state)
			this.sessions = [...this.sessions, session];
			this.activeTerminalId = session.id;

			return session;
		})();

		try {
			return await this.createPromise;
		} finally {
			this.createPromise = null;
		}
	}

	/**
	 * Assign a user-visible label to a session
	 */
	setSessionLabel(terminalId: string, label: string): void {
		if (!terminalId) return;
		this.sessionLabels = { ...this.sessionLabels, [terminalId]: label };
	}

	getSessionLabel(terminalId: string): string | undefined {
		return this.sessionLabels[terminalId];
	}

	/**
	 * Get or create the dedicated AI terminal session.
	 * This avoids running AI commands in a user's interactive terminal state.
	 */
	async getOrCreateAiTerminal(cwd?: string): Promise<TerminalSession | null> {
		const existingId = this.aiTerminalId;
		if (existingId) {
			const existing = this.sessions.find((s) => s.id === existingId) ?? null;
			if (existing) {
				this.activeTerminalId = existing.id;
				return existing;
			}
		}

		const session = await this.createTerminal(cwd);
		if (!session) return null;
		this.aiTerminalId = session.id;
		this.setSessionLabel(session.id, 'Volt AI');
		return session;
	}

	/**
	 * Set the active terminal
	 */
	setActive(terminalId: string): void {
		const session = this.sessions.find((s) => s.id === terminalId);
		if (session) {
			this.activeTerminalId = terminalId;
		}
	}

	/**
	 * Kill and remove a terminal session
	 */
	async killTerminal(terminalId: string): Promise<void> {
		const session = this.sessions.find((s) => s.id === terminalId);
		if (!session) return;

		await session.kill();
		await session.dispose();
		this.removeSession(terminalId);
	}

	/**
	 * Remove a session from the store (internal)
	 */
	private removeSession(terminalId: string): void {
		// Use filter to trigger reactivity (Svelte 5 $state)
		this.sessions = this.sessions.filter((s) => s.id !== terminalId);
		if (this.sessionLabels[terminalId]) {
			const next = { ...this.sessionLabels };
			delete next[terminalId];
			this.sessionLabels = next;
		}
		if (this.aiTerminalId === terminalId) {
			this.aiTerminalId = null;
		}

		// Update active terminal if needed
		if (this.activeTerminalId === terminalId) {
			this.activeTerminalId = this.sessions.length > 0 ? this.sessions[0].id : null;
		}
	}

	/**
	 * Kill all terminals
	 */
	async killAll(): Promise<void> {
		const promises = this.sessions.map(async (session) => {
			await session.kill();
			await session.dispose();
		});
		await Promise.all(promises);
		this.sessions = [];
		this.activeTerminalId = null;
	}

	/**
	 * Sync with backend terminal list (useful on app startup)
	 */
	async syncWithBackend(): Promise<void> {
		const backendTerminals = await listTerminals();
		const backendIds = new Set(backendTerminals.map((t) => t.terminalId));

		// Remove sessions that no longer exist in backend
		for (const session of [...this.sessions]) {
			if (!backendIds.has(session.id)) {
				await session.dispose();
				this.removeSession(session.id);
			}
		}
	}
}

export const terminalStore = new TerminalStore();
