/**
 * Git state store using Svelte 5 runes
 * Manages git status, staging, commits, and branches with debouncing and cancellation
 */

import {
	getGitStatus,
	cancelGitOperation,
	stageFile,
	stageAll,
	unstageFile,
	unstageAll,
	commit,
	listBranches,
	switchBranch,
	hasUncommittedChanges,
	getDiff,
	discardFile,
	isGitRepo,
	type GitStatus,
	type GitBranch,
	type GitDiff,
	type GitFileChange
} from '$lib/services/git';

// Debounce delay for status refresh (ms)
const STATUS_DEBOUNCE_MS = 300;

// Cache duration for status (ms)
const STATUS_CACHE_MS = 1000;

class GitStore {
	// Repository state
	isRepo = $state(false);
	rootPath = $state<string | null>(null);

	// Status
	status = $state<GitStatus | null>(null);
	loading = $state(false);
	error = $state<string | null>(null);

	// Branches
	branches = $state<GitBranch[]>([]);
	branchesLoading = $state(false);

	// Diff viewer
	selectedFile = $state<GitFileChange | null>(null);
	diff = $state<GitDiff | null>(null);
	diffLoading = $state(false);

	// Commit message
	commitMessage = $state('');

	// Internal state for debouncing/cancellation
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private lastRefreshTime = 0;
	private isRefreshing = false;
	private statusOpId: string | null = null;
	private diffOpId: string | null = null;

	// Derived values using $derived for proper Svelte 5 reactivity
	stagedCount = $derived(this.status?.staged.length ?? 0);
	unstagedCount = $derived(this.status?.unstaged.length ?? 0);
	untrackedCount = $derived(this.status?.untracked.length ?? 0);
	conflictedCount = $derived(this.status?.conflicted.length ?? 0);
	totalChanges = $derived(
		(this.status?.staged.length ?? 0) +
			(this.status?.unstaged.length ?? 0) +
			(this.status?.untracked.length ?? 0) +
			(this.status?.conflicted.length ?? 0)
	);
	currentBranch = $derived(this.status?.branch ?? null);
	hasConflicts = $derived(this.status?.hasConflicts ?? false);
	canCommit = $derived(
		(this.status?.staged.length ?? 0) > 0 &&
			this.commitMessage.trim().length > 0 &&
			!(this.status?.hasConflicts ?? false)
	);

	/**
	 * Initialize git store for a project
	 */
	async init(projectPath: string): Promise<void> {
		this.rootPath = projectPath;
		this.reset();

		// Check if it's a git repo
		this.isRepo = await isGitRepo(projectPath);

		if (this.isRepo) {
			await this.refresh();
		}
	}

	/**
	 * Reset store state
	 */
	reset(): void {
		this.cancelPendingRefresh();
		this.status = null;
		this.branches = [];
		this.selectedFile = null;
		this.diff = null;
		this.commitMessage = '';
		this.error = null;
		this.loading = false;
		this.branchesLoading = false;
		this.diffLoading = false;
	}

	/**
	 * Cancel any pending refresh operations
	 */
	private cancelPendingRefresh(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		if (this.statusOpId) {
			void cancelGitOperation(this.statusOpId);
			this.statusOpId = null;
		}
	}

	/**
	 * Refresh git status with debouncing
	 */
	async refresh(force = false): Promise<void> {
		if (!this.rootPath || !this.isRepo) return;

		// Cancel any pending refresh
		this.cancelPendingRefresh();

		// Check cache (unless forced)
		const now = Date.now();
		if (!force && now - this.lastRefreshTime < STATUS_CACHE_MS) {
			return;
		}

		// Debounce rapid refreshes
		return new Promise((resolve) => {
			this.refreshTimer = setTimeout(async () => {
				await this.doRefresh();
				resolve();
			}, STATUS_DEBOUNCE_MS);
		});
	}

	/**
	 * Immediate refresh (no debounce)
	 */
	async refreshNow(): Promise<void> {
		if (!this.rootPath || !this.isRepo) return;
		this.cancelPendingRefresh();
		await this.doRefresh();
	}

	/**
	 * Internal refresh implementation
	 */
	private async doRefresh(): Promise<void> {
		if (!this.rootPath) return;
		
		// If already refreshing, wait for it to complete instead of skipping
		if (this.isRefreshing) {
			// Wait a bit and check again
			await new Promise((resolve) => setTimeout(resolve, 100));
			if (this.isRefreshing) return; // Still refreshing, skip
		}

		this.isRefreshing = true;
		this.loading = true;
		this.error = null;

		// Cancel any previous in-flight status command and start a new op.
		if (this.statusOpId) {
			void cancelGitOperation(this.statusOpId);
		}
		this.statusOpId = crypto.randomUUID();
		const opId = this.statusOpId;

		try {
			const result = await getGitStatus(this.rootPath, opId);

			// Ignore stale responses
			if (this.statusOpId !== opId) return;

			if (result.status) {
				// Use assignment to trigger Svelte reactivity
				this.status = { ...result.status };
				this.lastRefreshTime = Date.now();
				this.error = null;
			} else {
				this.error = result.error || 'Failed to get git status';
			}
		} catch (e) {
			if (this.statusOpId === opId) {
				this.error = e instanceof Error ? e.message : 'Unknown error';
			}
		} finally {
			if (this.statusOpId === opId) {
				this.statusOpId = null;
				this.loading = false;
				this.isRefreshing = false;
			}
		}
	}

	/**
	 * Load branches
	 */
	async loadBranches(): Promise<void> {
		if (!this.rootPath || !this.isRepo) return;

		this.branchesLoading = true;
		try {
			this.branches = await listBranches(this.rootPath);
		} finally {
			this.branchesLoading = false;
		}
	}

	/**
	 * Stage a file
	 */
	async stage(filePath: string): Promise<boolean> {
		if (!this.rootPath) return false;

		const success = await stageFile(this.rootPath, filePath);
		if (success) {
			await this.refreshNow();
		}
		return success;
	}

	/**
	 * Stage all changes
	 */
	async stageAllChanges(): Promise<boolean> {
		if (!this.rootPath) return false;

		const success = await stageAll(this.rootPath);
		if (success) {
			await this.refreshNow();
		}
		return success;
	}

	/**
	 * Unstage a file
	 */
	async unstage(filePath: string): Promise<boolean> {
		if (!this.rootPath) return false;

		const success = await unstageFile(this.rootPath, filePath);
		if (success) {
			await this.refreshNow();
		}
		return success;
	}

	/**
	 * Unstage all changes
	 */
	async unstageAllChanges(): Promise<boolean> {
		if (!this.rootPath) return false;

		const success = await unstageAll(this.rootPath);
		if (success) {
			await this.refreshNow();
		}
		return success;
	}

	/**
	 * Commit staged changes
	 */
	async commitChanges(): Promise<boolean> {
		if (!this.rootPath || !this.canCommit) return false;

		const hash = await commit(this.rootPath, this.commitMessage);
		if (hash) {
			this.commitMessage = '';
			// Force immediate refresh bypassing cache and isRefreshing guard
			this.lastRefreshTime = 0;
			this.isRefreshing = false;
			await this.doRefresh();
			return true;
		}
		return false;
	}

	/**
	 * Switch branch (with uncommitted changes check)
	 */
	async switchToBranch(branch: string): Promise<{ success: boolean; hasChanges: boolean }> {
		if (!this.rootPath) return { success: false, hasChanges: false };

		// Check for uncommitted changes first
		const hasChanges = await hasUncommittedChanges(this.rootPath);
		if (hasChanges) {
			return { success: false, hasChanges: true };
		}

		const success = await switchBranch(this.rootPath, branch);
		if (success) {
			await this.refreshNow();
			await this.loadBranches();
		}
		return { success, hasChanges: false };
	}

	/**
	 * Select a file to view diff
	 */
	async selectFile(file: GitFileChange): Promise<void> {
		if (!this.rootPath) return;

		// Cancel any in-flight diff request
		if (this.diffOpId) {
			void cancelGitOperation(this.diffOpId);
			this.diffOpId = null;
		}

		this.selectedFile = file;
		this.diffLoading = true;
		this.diffOpId = crypto.randomUUID();
		const opId = this.diffOpId;

		try {
			this.diff = await getDiff(this.rootPath, file.path, file.staged, opId);
		} finally {
			if (this.diffOpId === opId) {
				this.diffLoading = false;
				this.diffOpId = null;
			}
		}
	}

	/**
	 * Clear selected file
	 */
	clearSelection(): void {
		if (this.diffOpId) {
			void cancelGitOperation(this.diffOpId);
			this.diffOpId = null;
		}
		this.selectedFile = null;
		this.diff = null;
	}

	/**
	 * Discard changes to a file
	 */
	async discard(filePath: string): Promise<boolean> {
		if (!this.rootPath) return false;

		const success = await discardFile(this.rootPath, filePath);
		if (success) {
			await this.refreshNow();
			// Clear selection if discarded file was selected
			if (this.selectedFile?.path === filePath) {
				this.clearSelection();
			}
		}
		return success;
	}

	/**
	 * Set commit message
	 */
	setCommitMessage(message: string): void {
		this.commitMessage = message;
	}
}

// Singleton instance
export const gitStore = new GitStore();
