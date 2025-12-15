<script lang="ts">
	import { gitStore } from '$lib/stores/git.svelte';
	import { projectStore } from '$lib/stores/project.svelte';
	import { showToast } from '$lib/stores/toast.svelte';
	import { uiStore } from '$lib/stores/ui.svelte';
	import { terminalStore } from '$lib/stores/terminal.svelte';
	import { UIIcon } from '$lib/components/ui';
	import GitFileList from './GitFileList.svelte';
	import GitDiffView from './GitDiffView.svelte';
	import GitBranchPicker from './GitBranchPicker.svelte';
	import ConfirmModal from '$lib/components/ui/ConfirmModal.svelte';

	// Branch switch confirmation
	let showBranchWarning = $state(false);
	let pendingBranch = $state<string | null>(null);

	// Branch picker
	let showBranchPicker = $state(false);

	// Expanded commit message editor
	let isCommitExpanded = $state(false);
	let expandedTextarea: HTMLTextAreaElement | null = $state(null);

	// Safe.directory helper (run in terminal)
	let showRunSafeDirConfirm = $state(false);
	let pendingSafeDirCmd = $state('');

	// Initialize git store when project changes
	$effect(() => {
		const rootPath = projectStore.rootPath;
		if (rootPath) {
			gitStore.init(rootPath);
		} else {
			gitStore.reset();
		}
	});

	// Focus expanded textarea when opened
	$effect(() => {
		if (isCommitExpanded && expandedTextarea) {
			expandedTextarea.focus();
			// Move cursor to end
			expandedTextarea.selectionStart = expandedTextarea.value.length;
		}
	});

	async function handleCommit(): Promise<void> {
		isCommitExpanded = false;
		await gitStore.commitChanges();
	}

	async function handleStageAll(): Promise<void> {
		await gitStore.stageAllChanges();
	}

	async function handleUnstageAll(): Promise<void> {
		await gitStore.unstageAllChanges();
	}

	async function handleRefresh(): Promise<void> {
		await gitStore.refreshNow();
	}

	async function handleBranchSelect(branch: string): Promise<void> {
		showBranchPicker = false;
		const result = await gitStore.switchToBranch(branch);

		if (result.hasChanges) {
			pendingBranch = branch;
			showBranchWarning = true;
		}
	}

	function handleBranchWarningCancel(): void {
		showBranchWarning = false;
		pendingBranch = null;
	}

	function handleKeydown(e: KeyboardEvent): void {
		// Ctrl+Enter to commit
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			if (gitStore.canCommit) {
				handleCommit();
			}
			return;
		}
		// Escape to close expanded view
		if (e.key === 'Escape' && isCommitExpanded) {
			e.preventDefault();
			isCommitExpanded = false;
		}
	}

	function handleExpandedBackdropClick(e: MouseEvent): void {
		if (e.target === e.currentTarget) {
			isCommitExpanded = false;
		}
	}

	function requestRunSafeDir(cmd: string): void {
		pendingSafeDirCmd = cmd.trim();
		if (!pendingSafeDirCmd) return;
		showRunSafeDirConfirm = true;
	}

	function cancelRunSafeDir(): void {
		showRunSafeDirConfirm = false;
		pendingSafeDirCmd = '';
	}

	async function confirmRunSafeDir(): Promise<void> {
		const cmd = pendingSafeDirCmd.trim();
		showRunSafeDirConfirm = false;
		pendingSafeDirCmd = '';
		if (!cmd) return;

		uiStore.openBottomPanelTab('terminal');
		// Ensure the integrated terminal gets keyboard focus even if it was already the active tab.
		setTimeout(() => window.dispatchEvent(new Event('volt:terminal-focus')), 0);
		let session = terminalStore.activeSession;
		if (!session) {
			session = await terminalStore.createTerminal(projectStore.rootPath ?? undefined);
		}
		if (!session) {
			showToast({ message: 'Failed to open terminal', type: 'error' });
			return;
		}

		const ok = await session.write(`${cmd}\r`);
		if (!ok) {
			showToast({ message: 'Failed to send command to terminal', type: 'error' });
			return;
		}
		setTimeout(() => window.dispatchEvent(new Event('volt:terminal-focus')), 0);
		showToast({ message: 'Command sent to terminal', type: 'success' });
	}
</script>

<div class="git-panel" role="region" aria-label="Source Control">
	{#if !projectStore.rootPath}
		<div class="empty-state">
			<UIIcon name="folder" size={48} />
			<p>Open a folder to use source control</p>
		</div>
	{:else if !gitStore.isRepo}
		<div class="empty-state">
			<UIIcon name="git-branch" size={48} />
			<p>This folder is not a Git repository</p>
			<span class="hint">Run <code>git init</code> in the terminal to initialize</span>
		</div>
	{:else if gitStore.loading && !gitStore.status}
		<div class="loading-state">
			<div class="spinner"></div>
			<p>Loading...</p>
		</div>
	{:else if gitStore.error}
		<div class="error-state">
			<UIIcon name="error" size={24} />
			{#if gitStore.error.includes('git config')}
				{@const safeDirCmd = ((gitStore.error.split('\n')[1] || gitStore.error) ?? '').trim()}
				<p class="error-title">Repository Ownership Issue</p>
				<p class="error-hint">Git detected this folder has different ownership. Run this command in terminal:</p>
				<textarea
					class="error-command"
					readonly
					rows="2"
					spellcheck="false"
					onclick={(e) => (e.currentTarget as HTMLTextAreaElement).select()}
				>{safeDirCmd}</textarea>
				<div class="error-actions">
					<button
						class="copy-btn"
						type="button"
						onclick={async () => {
							if (!safeDirCmd) return;
							try {
								await navigator.clipboard.writeText(safeDirCmd);
								showToast({ message: 'Command copied to clipboard', type: 'success' });
							} catch {
								showToast({ message: 'Failed to copy command', type: 'error' });
							}
						}}
					>
						<UIIcon name="copy" size={12} />
						Copy Command
					</button>
					<button class="run-btn" type="button" onclick={() => requestRunSafeDir(safeDirCmd)}>
						<UIIcon name="terminal" size={12} />
						Run in Terminal
					</button>
				</div>
			{:else}
				<p>{gitStore.error}</p>
			{/if}
			<button class="retry-btn" type="button" onclick={handleRefresh}>
				Retry
			</button>
		</div>
	{:else}
		<!-- Branch selector -->
		<div class="branch-section">
			<button
				class="branch-btn"
				type="button"
				onclick={() => {
					gitStore.loadBranches();
					showBranchPicker = true;
				}}
				title="Switch branch"
			>
				<UIIcon name="git-branch" size={14} />
				<span class="branch-name">{gitStore.currentBranch ?? 'No branch'}</span>
				<UIIcon name="chevron-down" size={12} />
			</button>

			<button
				class="icon-btn"
				type="button"
				onclick={handleRefresh}
				title="Refresh"
				disabled={gitStore.loading}
			>
				<UIIcon name="refresh" size={14} />
			</button>
		</div>

		<!-- Commit section -->
		<div class="commit-section">
			<div class="commit-input-wrapper">
				<textarea
					class="commit-input"
					placeholder="Commit message (Ctrl+Enter to commit)"
					bind:value={gitStore.commitMessage}
					onkeydown={handleKeydown}
					rows="3"
				></textarea>
				<button
					class="expand-btn"
					type="button"
					onclick={() => (isCommitExpanded = true)}
					title="Expand commit message (full editor)"
				>
					<UIIcon name="expand-all" size={12} />
				</button>
			</div>

			<div class="commit-actions">
				<button
					class="commit-btn"
					type="button"
					onclick={handleCommit}
					disabled={!gitStore.canCommit}
					title={gitStore.hasConflicts ? 'Resolve conflicts first' : 'Commit staged changes'}
				>
					<UIIcon name="check" size={14} />
					Commit
				</button>
			</div>
		</div>

		{#if gitStore.hasConflicts}
			<div class="conflict-warning">
				<UIIcon name="warning" size={14} />
				<span>Merge conflicts detected. Resolve before committing.</span>
			</div>
		{/if}

		<!-- Changes sections -->
		<div class="changes-container">
			<!-- Staged changes -->
			{#if gitStore.stagedCount > 0}
				<div class="changes-section">
					<div class="section-header">
						<span class="section-title">Staged Changes</span>
						<span class="count">{gitStore.stagedCount}</span>
						<button
							class="section-action"
							type="button"
							onclick={handleUnstageAll}
							title="Unstage all"
						>
							<UIIcon name="minus" size={12} />
						</button>
					</div>
					<GitFileList
						files={gitStore.status?.staged ?? []}
						type="staged"
						onSelect={(f) => gitStore.selectFile(f)}
						onAction={(f) => gitStore.unstage(f.path)}
						selectedPath={gitStore.selectedFile?.path}
					/>
				</div>
			{/if}

			<!-- Unstaged changes -->
			{#if gitStore.unstagedCount > 0}
				<div class="changes-section">
					<div class="section-header">
						<span class="section-title">Changes</span>
						<span class="count">{gitStore.unstagedCount}</span>
						<button
							class="section-action"
							type="button"
							onclick={handleStageAll}
							title="Stage all"
						>
							<UIIcon name="plus" size={12} />
						</button>
					</div>
					<GitFileList
						files={gitStore.status?.unstaged ?? []}
						type="unstaged"
						onSelect={(f) => gitStore.selectFile(f)}
						onAction={(f) => gitStore.stage(f.path)}
						selectedPath={gitStore.selectedFile?.path}
					/>
				</div>
			{/if}

			<!-- Untracked files -->
			{#if gitStore.untrackedCount > 0}
				<div class="changes-section">
					<div class="section-header">
						<span class="section-title">Untracked</span>
						<span class="count">{gitStore.untrackedCount}</span>
						<button
							class="section-action"
							type="button"
							onclick={handleStageAll}
							title="Stage all"
						>
							<UIIcon name="plus" size={12} />
						</button>
					</div>
					<GitFileList
						files={gitStore.status?.untracked ?? []}
						type="untracked"
						onSelect={(f) => gitStore.selectFile(f)}
						onAction={(f) => gitStore.stage(f.path)}
						selectedPath={gitStore.selectedFile?.path}
					/>
				</div>
			{/if}

			<!-- Conflicted files -->
			{#if gitStore.conflictedCount > 0}
				<div class="changes-section conflicts">
					<div class="section-header">
						<span class="section-title">Merge Conflicts</span>
						<span class="count conflict">{gitStore.conflictedCount}</span>
					</div>
					<GitFileList
						files={gitStore.status?.conflicted ?? []}
						type="conflicted"
						onSelect={(f) => gitStore.selectFile(f)}
						selectedPath={gitStore.selectedFile?.path}
					/>
				</div>
			{/if}

			<!-- No changes -->
			{#if gitStore.totalChanges === 0}
				<div class="no-changes">
					<UIIcon name="check" size={24} />
					<p>No changes</p>
				</div>
			{/if}
		</div>

		<!-- Diff view (if file selected) -->
		{#if gitStore.selectedFile}
			<GitDiffView
				file={gitStore.selectedFile}
				diff={gitStore.diff}
				loading={gitStore.diffLoading}
				onClose={() => gitStore.clearSelection()}
			/>
		{/if}
	{/if}
</div>

<ConfirmModal
	open={showRunSafeDirConfirm}
	title="Run Git Command"
	message="This will run a git config command in the integrated terminal (updates your global safe.directory). Only proceed if you trust this repository."
	confirmLabel="Run"
	cancelLabel="Cancel"
	onConfirm={confirmRunSafeDir}
	onCancel={cancelRunSafeDir}
/>

<!-- Branch picker modal -->
{#if showBranchPicker}
	<GitBranchPicker
		branches={gitStore.branches}
		currentBranch={gitStore.currentBranch}
		loading={gitStore.branchesLoading}
		onSelect={handleBranchSelect}
		onClose={() => (showBranchPicker = false)}
	/>
{/if}

<!-- Uncommitted changes warning -->
<ConfirmModal
	open={showBranchWarning}
	title="Uncommitted Changes"
	message="You have uncommitted changes. Commit or stash them before switching branches."
	confirmLabel="OK"
	cancelLabel=""
	onConfirm={handleBranchWarningCancel}
	onCancel={handleBranchWarningCancel}
/>

<!-- Expanded commit message editor -->
{#if isCommitExpanded}
	<div
		class="expanded-backdrop"
		role="presentation"
		onclick={handleExpandedBackdropClick}
		onkeydown={handleKeydown}
		tabindex="-1"
	>
		<div class="expanded-editor" role="dialog" aria-label="Commit message editor">
			<div class="expanded-header">
				<span class="expanded-title">Commit Message</span>
				<button
					class="expanded-close"
					type="button"
					onclick={() => (isCommitExpanded = false)}
					title="Close (Escape)"
				>
					<UIIcon name="close" size={14} />
				</button>
			</div>
			<textarea
				class="expanded-textarea"
				placeholder="Enter commit message...&#10;&#10;First line is the summary.&#10;Leave a blank line, then add detailed description."
				bind:value={gitStore.commitMessage}
				bind:this={expandedTextarea}
				onkeydown={handleKeydown}
			></textarea>
			<div class="expanded-footer">
				<span class="expanded-hint">Ctrl+Enter to commit • Escape to close</span>
				<button
					class="commit-btn"
					type="button"
					onclick={handleCommit}
					disabled={!gitStore.canCommit}
				>
					<UIIcon name="check" size={14} />
					Commit
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.git-panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
		position: relative;
	}

	.empty-state,
	.loading-state,
	.error-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 12px;
		padding: 24px;
		color: var(--color-text-secondary);
		text-align: center;
	}

	.empty-state p,
	.loading-state p,
	.error-state p {
		margin: 0;
		font-size: 13px;
	}

	.hint {
		font-size: 11px;
		color: var(--color-text-disabled);
	}

	.hint code {
		background: var(--color-surface0);
		padding: 2px 6px;
		border-radius: 4px;
		font-family: var(--font-mono);
	}

	.spinner {
		width: 24px;
		height: 24px;
		border: 2px solid var(--color-border);
		border-top-color: var(--color-accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.error-title {
		font-weight: 600;
		color: var(--color-text);
		margin: 0;
	}

	.error-hint {
		font-size: 11px;
		margin: 0;
	}

	.error-command {
		display: block;
		width: 100%;
		padding: 8px 12px;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--color-text);
		word-break: break-all;
		resize: none;
		text-align: left;
		max-width: 100%;
	}

	.error-actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.copy-btn {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		background: var(--color-accent);
		border: none;
		border-radius: 6px;
		color: var(--color-bg);
		font-size: 12px;
		cursor: pointer;
	}

	.copy-btn:hover {
		filter: brightness(1.1);
	}

	.run-btn {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		background: var(--color-surface0);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		color: var(--color-text);
		font-size: 12px;
		cursor: pointer;
	}

	.run-btn:hover {
		background: var(--color-hover);
	}

	.retry-btn {
		padding: 6px 12px;
		background: var(--color-surface0);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		color: var(--color-text);
		font-size: 12px;
		cursor: pointer;
	}

	.retry-btn:hover {
		background: var(--color-hover);
	}

	.branch-section {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 8px 12px;
		border-bottom: 1px solid var(--color-border);
	}

	.branch-btn {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 8px;
		background: var(--color-surface0);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		color: var(--color-text);
		font-size: 12px;
		cursor: pointer;
		flex: 1;
		min-width: 0;
	}

	.branch-btn:hover {
		background: var(--color-hover);
	}

	.branch-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: left;
	}

	.icon-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: 6px;
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	.icon-btn:hover {
		background: var(--color-hover);
		color: var(--color-text);
	}

	.icon-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.commit-section {
		padding: 12px;
		border-bottom: 1px solid var(--color-border);
	}

	.commit-input-wrapper {
		margin-bottom: 8px;
		position: relative;
	}

	.commit-input {
		width: 100%;
		padding: 8px;
		padding-right: 28px;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		color: var(--color-text);
		font-size: 12px;
		font-family: inherit;
		resize: none;
		height: 60px;
		overflow-y: auto;
	}

	.commit-input:focus {
		outline: none;
		border-color: var(--color-accent);
	}

	.commit-input::placeholder {
		color: var(--color-text-disabled);
	}

	.expand-btn {
		position: absolute;
		top: 4px;
		right: 4px;
		width: 20px;
		height: 20px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		color: var(--color-text-secondary);
		opacity: 0.6;
		transition: opacity 0.1s, background 0.1s;
	}

	.commit-input-wrapper:hover .expand-btn,
	.expand-btn:focus {
		opacity: 1;
	}

	.expand-btn:hover {
		background: var(--color-hover);
		color: var(--color-text);
	}

	.commit-actions {
		display: flex;
		gap: 8px;
	}

	.commit-btn {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		background: var(--color-accent);
		border: none;
		border-radius: 6px;
		color: var(--color-bg);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		flex: 1;
		justify-content: center;
	}

	.commit-btn:hover:not(:disabled) {
		filter: brightness(1.1);
	}

	.commit-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.conflict-warning {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		background: color-mix(in srgb, var(--color-warning) 15%, transparent);
		border-bottom: 1px solid var(--color-border);
		color: var(--color-warning);
		font-size: 11px;
	}

	.changes-container {
		flex: 1;
		overflow-y: auto;
	}

	.changes-section {
		border-bottom: 1px solid var(--color-border);
	}

	.changes-section.conflicts {
		background: color-mix(in srgb, var(--color-error) 5%, transparent);
	}

	.section-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		background: var(--color-bg-header);
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: var(--color-text-secondary);
	}

	.section-title {
		flex: 1;
	}

	.count {
		padding: 2px 6px;
		background: var(--color-surface0);
		border-radius: 10px;
		font-size: 10px;
		font-weight: 600;
	}

	.count.conflict {
		background: var(--color-error);
		color: var(--color-bg);
	}

	.section-action {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		border-radius: 4px;
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	.section-action:hover {
		background: var(--color-hover);
		color: var(--color-text);
	}

	.no-changes {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 32px;
		color: var(--color-text-disabled);
	}

	.no-changes p {
		margin: 0;
		font-size: 13px;
	}

	/* Expanded commit message editor */
	.expanded-backdrop {
		position: fixed;
		inset: 0;
		z-index: 2000;
		display: flex;
		align-items: center;
		justify-content: center;
		background: color-mix(in srgb, var(--color-bg) 60%, transparent);
		backdrop-filter: blur(8px);
	}

	.expanded-editor {
		width: min(600px, calc(100vw - 48px));
		height: min(400px, calc(100vh - 100px));
		display: flex;
		flex-direction: column;
		background: var(--color-bg-elevated, var(--color-bg-panel));
		border: 1px solid var(--color-border);
		border-radius: 12px;
		box-shadow: var(--shadow-elevated, 0 16px 48px rgba(0, 0, 0, 0.4));
		overflow: hidden;
	}

	.expanded-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 16px;
		border-bottom: 1px solid var(--color-border);
		background: var(--color-bg-header);
	}

	.expanded-title {
		font-size: 13px;
		font-weight: 600;
	}

	.expanded-close {
		width: 28px;
		height: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 6px;
		color: var(--color-text-secondary);
	}

	.expanded-close:hover {
		background: var(--color-hover);
		color: var(--color-text);
	}

	.expanded-textarea {
		flex: 1;
		width: 100%;
		padding: 16px;
		background: var(--color-bg);
		border: none;
		color: var(--color-text);
		font-size: 13px;
		font-family: inherit;
		line-height: 1.6;
		resize: none;
	}

	.expanded-textarea:focus {
		outline: none;
	}

	.expanded-textarea::placeholder {
		color: var(--color-text-disabled);
	}

	.expanded-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 16px;
		border-top: 1px solid var(--color-border);
		background: var(--color-bg-header);
	}

	.expanded-hint {
		font-size: 11px;
		color: var(--color-text-secondary);
	}
</style>
