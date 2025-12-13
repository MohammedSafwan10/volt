<script lang="ts">
	import { onMount } from 'svelte';
	import { terminalStore } from '$lib/stores/terminal.svelte';
	import type { TerminalSession } from '$lib/services/terminal-client';
	import TerminalView from './TerminalView.svelte';

	// Create first terminal only once when component mounts (not on every reactive update)
	onMount(() => {
		if (terminalStore.sessions.length === 0) {
			void terminalStore.createTerminal();
		}
	});

	function handleNewTerminal(): void {
		void terminalStore.createTerminal();
	}

	function handleKillTerminal(terminalId: string): void {
		void terminalStore.killTerminal(terminalId);
	}

	function handleTabClick(terminalId: string): void {
		terminalStore.setActive(terminalId);
	}

	function handleTabMiddleClick(e: MouseEvent, terminalId: string): void {
		if (e.button === 1) {
			e.preventDefault();
			void terminalStore.killTerminal(terminalId);
		}
	}

	function getTerminalLabel(session: TerminalSession, index: number): string {
		// Extract shell name from path
		const shell = session.info.shell;
		const shellName = shell.split(/[/\\]/).pop() || 'terminal';
		return `${shellName} ${index + 1}`;
	}
</script>

<div class="terminal-tabs-container">
	<!-- Tab bar -->
	<div class="tabs-bar">
		<div class="tabs-scroll">
			{#each terminalStore.sessions as session, index (session.id)}
				<div
					class="tab"
					class:active={session.id === terminalStore.activeTerminalId}
					onclick={() => handleTabClick(session.id)}
					onmousedown={(e) => handleTabMiddleClick(e, session.id)}
					onkeydown={(e) => e.key === 'Enter' && handleTabClick(session.id)}
					title={session.info.cwd}
					role="tab"
					tabindex="0"
					aria-selected={session.id === terminalStore.activeTerminalId}
				>
					<span class="tab-label">{getTerminalLabel(session, index)}</span>
					<button
						class="tab-close"
						onclick={(e) => {
							e.stopPropagation();
							handleKillTerminal(session.id);
						}}
						aria-label="Kill terminal"
					>
						✕
					</button>
				</div>
			{/each}
		</div>

		<div class="tabs-actions">
			<button
				class="action-btn"
				onclick={handleNewTerminal}
				title="New Terminal"
				aria-label="New Terminal"
			>
				+
			</button>
		</div>
	</div>

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
				<p>No terminals open</p>
				<button class="create-btn" onclick={handleNewTerminal}>
					Create Terminal
				</button>
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

	.tabs-bar {
		display: flex;
		align-items: center;
		background: var(--color-bg-header);
		border-bottom: 1px solid var(--color-border);
		min-height: 28px;
	}

	.tabs-scroll {
		display: flex;
		flex: 1;
		overflow-x: auto;
		scrollbar-width: none;
	}

	.tabs-scroll::-webkit-scrollbar {
		display: none;
	}

	.tab {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 8px;
		font-size: 12px;
		color: var(--color-text-secondary);
		background: transparent;
		border: none;
		border-right: 1px solid var(--color-border);
		cursor: pointer;
		white-space: nowrap;
		transition: background 0.1s ease;
	}

	.tab:hover {
		background: var(--color-hover);
		color: var(--color-text);
	}

	.tab.active {
		background: var(--color-bg);
		color: var(--color-text);
	}

	.tab-label {
		max-width: 120px;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.tab-close {
		width: 16px;
		height: 16px;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 10px;
		color: var(--color-text-secondary);
		background: transparent;
		border: none;
		border-radius: 3px;
		cursor: pointer;
		opacity: 0;
		transition: all 0.1s ease;
	}

	.tab:hover .tab-close,
	.tab.active .tab-close {
		opacity: 1;
	}

	.tab-close:hover {
		background: var(--color-error);
		color: white;
	}

	.tabs-actions {
		display: flex;
		align-items: center;
		padding: 0 4px;
	}

	.action-btn {
		width: 24px;
		height: 24px;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 16px;
		color: var(--color-text-secondary);
		background: transparent;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		transition: all 0.1s ease;
	}

	.action-btn:hover {
		background: var(--color-hover);
		color: var(--color-text);
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

	.create-btn {
		padding: 6px 12px;
		font-size: 12px;
		color: var(--color-text);
		background: var(--color-accent);
		border: none;
		border-radius: 4px;
		cursor: pointer;
		transition: opacity 0.1s ease;
	}

	.create-btn:hover {
		opacity: 0.9;
	}
</style>
