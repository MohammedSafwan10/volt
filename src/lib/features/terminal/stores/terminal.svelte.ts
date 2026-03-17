import {
	createTerminalSession,
	createTerminalSessionFromInfo,
	listTerminals,
	killAllTerminals,
	TerminalSession
} from '$features/terminal/services/terminal-client';
import { terminalProblemMatcher } from '$features/terminal/services/terminal-problem-matcher';
import { registerCleanup } from '$core/services/hmr-cleanup';
import { projectStore } from '$shared/stores/project.svelte';

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
	private syncPromise: Promise<void> | null = null;
	private startupSyncComplete = false;

	private normalizeCwd(path: string | null | undefined): string | null {
		if (!path) return null;
		const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
		return /^[A-Za-z]:/.test(normalized) ? normalized.toLowerCase() : normalized;
	}

	private resolveDesiredCwd(cwd?: string): string | undefined {
		return cwd ?? projectStore.rootPath ?? undefined;
	}

	constructor() {
		void this.syncWithBackendRetry(5, 250);
		// Start terminal problem matcher (background service)
		void terminalProblemMatcher.start();
	}

	private async syncWithBackendRetry(
		maxAttempts = 3,
		baseDelayMs = 200,
	): Promise<void> {
		if (this.syncPromise) {
			await this.syncPromise;
			return;
		}

		this.syncPromise = (async () => {
			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
				try {
					await this.syncWithBackend();
					// If we found sessions, no need for more retries.
					if (this.sessions.length > 0) break;
				} catch (err) {
					console.warn('[TerminalStore] syncWithBackend attempt failed:', attempt, err);
				}

				if (attempt < maxAttempts) {
					const delay = baseDelayMs * attempt;
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
		})();

		try {
			await this.syncPromise;
		} finally {
			this.syncPromise = null;
			this.startupSyncComplete = true;
		}
	}

	async ensureSynced(): Promise<void> {
		if (this.startupSyncComplete) {
			await this.syncWithBackend();
			return;
		}
		await this.syncWithBackendRetry(4, 250);
	}

	private attachSession(session: TerminalSession, makeActive = false): void {
		// Avoid duplicate attachment
		if (this.sessions.some((s) => s.id === session.id)) {
			if (makeActive) this.activeTerminalId = session.id;
			return;
		}

		// Set up exit handler to remove session when terminal exits
		session.onExit(() => {
			console.log('[TerminalStore] Terminal exited:', session.id);
			session.dispose();
			this.removeSession(session.id);
		});

		this.sessions = [...this.sessions, session];
		if (makeActive || !this.activeTerminalId) {
			this.activeTerminalId = session.id;
		}
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
			// Before creating a new session, reconcile with backend in case we are
			// just after reload and missed rehydration.
			await this.ensureSynced();

			// Wait for project restoration to finish if it's currently loading
			// and no explicit cwd was provided.
			if (!cwd) {
				await projectStore.initialized;
			}

			const workingDir = this.resolveDesiredCwd(cwd);
			console.log('[TerminalStore] Creating terminal in:', workingDir || '(default)');

			const session = await createTerminalSession(workingDir);
			if (!session) {
				console.error('[TerminalStore] createTerminalSession returned null');
				return null;
			}

			console.log('[TerminalStore] Terminal created:', session.id);
			this.attachSession(session, true);

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
		const desiredCwd = this.resolveDesiredCwd(cwd);
		const desiredCwdNormalized = this.normalizeCwd(desiredCwd);
		const existingId = this.aiTerminalId;
		if (existingId) {
			const existing = this.sessions.find((s) => s.id === existingId) ?? null;
			if (existing) {
				const existingCwdNormalized = this.normalizeCwd(existing.cwd || existing.info.cwd);
				const cwdMatches =
					!desiredCwdNormalized ||
					existingCwdNormalized === desiredCwdNormalized;
				if (cwdMatches) {
					console.log('[TerminalStore] Reusing existing AI terminal:', existingId);
					console.log('[TerminalStore] AI terminal output history chars:', existing.getRecentOutput().length);
					this.activeTerminalId = existing.id;
					return existing;
				}
				console.log(
					'[TerminalStore] Replacing AI terminal due to cwd mismatch:',
					existing.cwd || existing.info.cwd,
					'->',
					desiredCwd,
				);
				this.aiTerminalId = null;
			}
			// AI terminal ID exists but session is gone, clear it
			else {
				console.log('[TerminalStore] AI terminal ID exists but session gone, clearing');
				this.aiTerminalId = null;
			}
		}

		// Create new AI terminal with mutex protection
		this.aiCreatePromise = (async () => {
			console.log('[TerminalStore] Creating new AI terminal');
			const session = await this.createTerminal(desiredCwd);
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
	 * Stop terminal sessions whose cwd is inside the target path.
	 * Helps Windows release file handles before deleting large folders.
	 */
	async stopSessionsInPath(targetPath: string): Promise<number> {
		if (!targetPath) return 0;
		const normalize = (p: string): string => {
			const n = p.replace(/\\/g, '/').replace(/\/+$/, '');
			return /^[A-Za-z]:/.test(n) ? n.toLowerCase() : n;
		};
		const target = normalize(targetPath);
		let stopped = 0;
		const snapshot = [...this.sessions];

		for (const session of snapshot) {
			const cwdRaw = session.cwd || session.info.cwd || '';
			if (!cwdRaw) continue;
			const cwd = normalize(cwdRaw);
			if (cwd === target || cwd.startsWith(target + '/')) {
				try {
					await this.killTerminal(session.id);
					stopped++;
				} catch (err) {
					console.warn('[TerminalStore] Failed to stop terminal in path:', cwdRaw, err);
				}
			}
		}

		return stopped;
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

		// Rehydrate missing backend terminals after reload/HMR.
		const knownIds = new Set(this.sessions.map((s) => s.id));
		for (const info of backendTerminals) {
			if (knownIds.has(info.terminalId)) continue;
			try {
				const restored = await createTerminalSessionFromInfo(info);
				this.attachSession(restored, this.sessions.length === 0);
			} catch (err) {
				console.warn('[TerminalStore] Failed to rehydrate terminal:', info.terminalId, err);
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
