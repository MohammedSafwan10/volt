<script lang="ts">
	import { UIIcon } from '$lib/components/ui';
	import type { GitBranch } from '$lib/services/git';

	interface Props {
		branches: GitBranch[];
		currentBranch: string | null;
		loading: boolean;
		onSelect: (branch: string) => void;
		onClose: () => void;
	}

	let { branches, currentBranch, loading, onSelect, onClose }: Props = $props();

	let searchQuery = $state('');

	const filteredBranches = $derived.by(() => {
		if (!searchQuery.trim()) return branches;
		const query = searchQuery.toLowerCase();
		return branches.filter((b) => b.name.toLowerCase().includes(query));
	});

	const localBranches = $derived(filteredBranches.filter((b) => !b.isRemote));
	const remoteBranches = $derived(filteredBranches.filter((b) => b.isRemote));

	function handleSelect(branch: GitBranch): void {
		if (branch.name !== currentBranch) {
			onSelect(branch.name);
		}
	}

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
		}
	}

	function handleBackdropClick(e: MouseEvent): void {
		if (e.target === e.currentTarget) {
			onClose();
		}
	}
</script>

<div
	class="backdrop"
	role="presentation"
	onclick={handleBackdropClick}
	onkeydown={handleKeydown}
	tabindex="-1"
>
	<div class="picker" role="dialog" aria-label="Switch branch">
		<div class="picker-header">
			<!-- svelte-ignore a11y_autofocus -->
			<input
				type="text"
				class="search-input"
				placeholder="Search branches..."
				bind:value={searchQuery}
				autofocus
			/>
		</div>

		<div class="picker-content">
			{#if loading}
				<div class="loading">
					<div class="spinner"></div>
					<span>Loading branches...</span>
				</div>
			{:else if filteredBranches.length === 0}
				<div class="empty">No branches found</div>
			{:else}
				{#if localBranches.length > 0}
					<div class="branch-group">
						<div class="group-header">Local Branches</div>
						{#each localBranches as branch (branch.name)}
							<button
								class="branch-item"
								class:current={branch.isCurrent}
								type="button"
								onclick={() => handleSelect(branch)}
							>
								<UIIcon name="git-branch" size={14} />
								<span class="branch-name">{branch.name}</span>
								{#if branch.isCurrent}
									<UIIcon name="check" size={14} />
								{/if}
							</button>
						{/each}
					</div>
				{/if}

				{#if remoteBranches.length > 0}
					<div class="branch-group">
						<div class="group-header">Remote Branches</div>
						{#each remoteBranches as branch (branch.name)}
							<button
								class="branch-item"
								class:current={branch.isCurrent}
								type="button"
								onclick={() => handleSelect(branch)}
							>
								<UIIcon name="cloud" size={14} />
								<span class="branch-name">{branch.name}</span>
								{#if branch.isCurrent}
									<UIIcon name="check" size={14} />
								{/if}
							</button>
						{/each}
					</div>
				{/if}
			{/if}
		</div>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 1000;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding-top: 100px;
		background: color-mix(in srgb, var(--color-bg) 40%, transparent);
		backdrop-filter: blur(4px);
	}

	.picker {
		width: min(400px, calc(100vw - 32px));
		max-height: 400px;
		background: var(--color-bg-elevated, var(--color-bg-panel));
		border: 1px solid var(--color-border);
		border-radius: 10px;
		box-shadow: var(--shadow-elevated, 0 10px 32px rgba(0, 0, 0, 0.35));
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.picker-header {
		padding: 12px;
		border-bottom: 1px solid var(--color-border);
	}

	.search-input {
		width: 100%;
		padding: 8px 12px;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		color: var(--color-text);
		font-size: 13px;
	}

	.search-input:focus {
		outline: none;
		border-color: var(--color-accent);
	}

	.search-input::placeholder {
		color: var(--color-text-disabled);
	}

	.picker-content {
		flex: 1;
		overflow-y: auto;
	}

	.loading,
	.empty {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 24px;
		color: var(--color-text-secondary);
		font-size: 13px;
	}

	.spinner {
		width: 16px;
		height: 16px;
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

	.branch-group {
		padding: 8px 0;
	}

	.group-header {
		padding: 4px 12px;
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: var(--color-text-secondary);
	}

	.branch-item {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 8px 12px;
		background: transparent;
		border: none;
		color: var(--color-text);
		font-size: 13px;
		text-align: left;
		cursor: pointer;
	}

	.branch-item:hover {
		background: var(--color-hover);
	}

	.branch-item.current {
		color: var(--color-accent);
	}

	.branch-name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
