import {
	createTerminalSession,
	listTerminals,
	killAllTerminals,
	type TerminalInfo,
	TerminalSession
} from '$lib/services/terminal-client';
import { terminalProblemMatcher } from '$lib/services/terminal-problem-matcher';
import { registerCleanup } from '$lib/services/hmr-cleanup';

/**
 * Terminal store for managing terminal sessions
 */
class TerminalStore {
	sessions = $state<TerminalSession[]>([]);
	activeTerminalId = $state<string | null>(null);
	lastError = $state<{ terminalId: string; command: string; output: string } | null>(null);
	private createPromise: Promise<TerminalSession | null> | null = null;
	private aiCreatePromise: Promise<TerminalSession | null> | null = null;
	private sessionLabels = $state<Record<string, string>>({});
	private aiTerminalId = $state<string | null>(null);

	constructor() {
		this.syncWithBackend();
		// Start terminal problem matcher (background service)
		void terminalProblemMatcher.start();
	}

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
			const { projectStore } = await import('./project.svelte');

			// Wait for project restoration to finish if it's currently loading
			// and no explicit cwd was provided.
			if (!cwd) {
				await projectStore.initialized;
			}

			const workingDir = cwd ?? projectStore.rootPath ?? undefined;
			console.log('[TerminalStore] Creating terminal in:', workingDir || '(default)');

			const session = await createTerminalSession(workingDir);
			if (!session) {
				console.error('[TerminalStore] createTerminalSession returned null');
				return null;
			}

			console.log('[TerminalStore] Terminal created:', session.id);

			// Set up exit handler to remove session when terminal exits
			session.onExit(() => {
				console.log('[TerminalStore] Terminal exited:', session.id);
				session.dispose();
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
		// If AI terminal creation is already in-flight, await it
		if (this.aiCreatePromise) {
			console.log('[TerminalStore] AI terminal creation in progress, waiting...');
			return await this.aiCreatePromise;
		}

		// Check for existing AI terminal first
		const existingId = this.aiTerminalId;
		if (existingId) {
			const existing = this.sessions.find((s) => s.id === existingId) ?? null;
			if (existing) {
				console.log('[TerminalStore] Reusing existing AI terminal:', existingId);
				console.log('[TerminalStore] AI terminal output history chars:', existing.getRecentOutput().length);
				this.activeTerminalId = existing.id;
				return existing;
			}
			// AI terminal ID exists but session is gone, clear it
			console.log('[TerminalStore] AI terminal ID exists but session gone, clearing');
			this.aiTerminalId = null;
		}

		// Create new AI terminal with mutex protection
		this.aiCreatePromise = (async () => {
			console.log('[TerminalStore] Creating new AI terminal');
			const session = await this.createTerminal(cwd);
			if (!session) {
				console.error('[TerminalStore] Failed to create AI terminal');
				return null;
			}

			// Wait for terminal to be ready before enabling shell integration
			await session.waitForReady(3000);
			// Extra safety delay for slow shell initialization
			await new Promise((resolve) => setTimeout(resolve, 500));
			await session.enableShellIntegration();

			this.aiTerminalId = session.id;
			this.setSessionLabel(session.id, 'Volt AI');
			console.log('[TerminalStore] AI terminal created and initialized:', session.id);
			return session;
		})();

		try {
			return await this.aiCreatePromise;
		} finally {
			this.aiCreatePromise = null;
		}
	}

	/**
	 * Detach the AI terminal so the next AI command uses a fresh terminal.
	 * Keeps the existing session alive for inspection/cleanup.
	 */
	detachAiTerminal(terminalId: string, label?: string): void {
		if (this.aiTerminalId === terminalId) {
			this.aiTerminalId = null;
		}
		if (label) {
			this.setSessionLabel(terminalId, label);
		}
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
		const didKillAll = await killAllTerminals();
		if (!didKillAll) {
			const promises = this.sessions.map(async (session) => {
				await session.kill();
			});
			await Promise.all(promises);
		}
		for (const session of this.sessions) {
			session.dispose();
		}
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
				session.dispose();
				this.removeSession(session.id);
			}
		}
	}
}

export const terminalStore = new TerminalStore();

// Register HMR cleanup to dispose terminal sessions
registerCleanup('terminal-store', async () => {
	for (const session of terminalStore.sessions) {
		session.dispose();
	}
});
