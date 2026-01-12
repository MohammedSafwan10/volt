<script lang="ts">
	import { onMount } from 'svelte';
	import { terminalStore } from '$lib/stores/terminal.svelte';
	import TerminalView from './TerminalView.svelte';

	let createError = $state<string | null>(null);
	let isCreating = $state(false);

	// Create first terminal only once when component mounts
	onMount(() => {
		if (terminalStore.sessions.length === 0) {
			void createFirstTerminal();
		}
	});

	async function createFirstTerminal(): Promise<void> {
		if (isCreating) return;
		isCreating = true;
		createError = null;
		
		try {
			const session = await terminalStore.createTerminal();
			if (!session) {
				createError = 'Failed to create terminal session';
			}
		} catch (err) {
			createError = err instanceof Error ? err.message : 'Unknown error';
			console.error('[TerminalTabs] Failed to create terminal:', err);
		} finally {
			isCreating = false;
		}
	}

	async function handleNewTerminal(): Promise<void> {
		await createFirstTerminal();
	}
</script>

<div class="terminal-tabs-container">
	<!-- Terminal views -->
	<div class="terminals-container">
		{#each terminalStore.sessions as session (session.id)}
			<TerminalView
				{session}
				active={session.id === terminalStore.activeTerminalId}
			/>
		{/each}

		{#if terminalStore.sessions.length === 0}
			<div class="no-terminals">
				{#if isCreating}
					<p>Creating terminal...</p>
				{:else if createError}
					<p class="error-text">Error: {createError}</p>
					<button class="create-btn" onclick={handleNewTerminal}>
						Retry
					</button>
				{:else}
					<p>No terminals open</p>
					<button class="create-btn" onclick={handleNewTerminal}>
						Create Terminal
					</button>
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.terminal-tabs-container {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--color-bg);
	}

	.terminals-container {
		flex: 1;
		position: relative;
		overflow: hidden;
	}

	.no-terminals {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		gap: 12px;
		color: var(--color-text-secondary);
	}

	.no-terminals p {
		font-size: 13px;
		margin: 0;
	}

	.no-terminals .error-text {
		color: var(--color-error);
	}

	.create-btn {
		padding: 6px 12px;
		font-size: 12px;
		color: var(--color-text);
		background: color-mix(in srgb, var(--color-accent) 18%, var(--color-surface0));
		border: 1px solid color-mix(in srgb, var(--color-accent) 35%, var(--color-border));
		border-radius: 8px;
		cursor: pointer;
		transition: opacity 0.1s ease;
	}

	.create-btn:hover {
		opacity: 0.9;
	}
</style>
