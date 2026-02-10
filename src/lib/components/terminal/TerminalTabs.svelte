<script lang="ts">
	import { onMount } from 'svelte';
	import { terminalStore } from '$lib/stores/terminal.svelte';
	import { UIIcon } from '$lib/components/ui';
	import TerminalView from './TerminalView.svelte';

	let createError = $state<string | null>(null);
	let isCreating = $state(false);
	let railWidth = $state(160);
	let resizing = false;
	let layoutRef: HTMLDivElement | undefined = $state();

	const RAIL_WIDTH_KEY = 'volt.terminal.railWidth';
	const RAIL_MIN_WIDTH = 132;
	const RAIL_MAX_WIDTH = 280;
	const RAIL_DEFAULT_WIDTH = 160;

	// Create first terminal only once when component mounts
	onMount(() => {
		try {
			const storedWidth = localStorage.getItem(RAIL_WIDTH_KEY);
			if (storedWidth) {
				const parsed = Number(storedWidth);
				if (Number.isFinite(parsed)) {
					railWidth = Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_MAX_WIDTH, parsed));
				}
			}
		} catch {
			// ignore storage errors
		}

		if (terminalStore.sessions.length === 0) {
			void createFirstTerminal();
		}

		return () => {
			window.removeEventListener('mousemove', handleResizeMove);
			window.removeEventListener('mouseup', stopResize);
		};
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

	function getTerminalLabel(sessionId: string, index: number): string {
		const labeled = terminalStore.getSessionLabel(sessionId);
		if (labeled) return labeled;
		const session = terminalStore.sessions.find((s) => s.id === sessionId);
		if (!session) return `terminal ${index + 1}`;
		const shellName = session.info.shell.split(/[/\\]/).pop() || 'terminal';
		return `${shellName} ${index + 1}`;
	}

	function startResize(e: MouseEvent): void {
		e.preventDefault();
		resizing = true;
		window.addEventListener('mousemove', handleResizeMove);
		window.addEventListener('mouseup', stopResize);
	}

	function handleResizeMove(e: MouseEvent): void {
		if (!resizing) return;
		const rect = layoutRef?.getBoundingClientRect();
		if (!rect) return;
		const localRight = rect.right;
		const next = localRight - e.clientX;
		const dynamicMax = Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_MAX_WIDTH, rect.width - 140));
		railWidth = Math.max(RAIL_MIN_WIDTH, Math.min(dynamicMax, next));
	}

	function stopResize(): void {
		if (!resizing) return;
		resizing = false;
		window.removeEventListener('mousemove', handleResizeMove);
		window.removeEventListener('mouseup', stopResize);
		try {
			localStorage.setItem(RAIL_WIDTH_KEY, String(railWidth));
		} catch {
			// ignore storage errors
		}
	}

	const showRail = $derived(terminalStore.sessions.length > 1);
</script>

<div class="terminal-tabs-container">
	<div
		class="terminals-layout"
		class:has-rail={showRail}
		style={`--terminal-rail-width: ${railWidth}px;`}
		bind:this={layoutRef}
	>
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

		{#if showRail}
			<button
				class="rail-resizer"
				onmousedown={startResize}
				ondblclick={() => {
					railWidth = RAIL_DEFAULT_WIDTH;
					try {
						localStorage.setItem(RAIL_WIDTH_KEY, String(RAIL_DEFAULT_WIDTH));
					} catch {
						// ignore storage errors
					}
				}}
				aria-label="Resize terminal list"
				title="Drag to resize. Double-click to reset."
				type="button"
			></button>
			<aside class="terminal-rail" aria-label="Terminal sessions">

				{#each terminalStore.sessions as session, idx (session.id)}
					<div
						class="rail-item"
						class:active={session.id === terminalStore.activeTerminalId}
						title={getTerminalLabel(session.id, idx)}
					>
						<button
							class="rail-select"
							onclick={() => terminalStore.setActive(session.id)}
							type="button"
							aria-label={`Activate ${getTerminalLabel(session.id, idx)}`}
						>
							<UIIcon name="terminal" size={13} />
							<span class="rail-label">{getTerminalLabel(session.id, idx)}</span>
						</button>
						<button
							class="rail-kill"
							onclick={() => void terminalStore.killTerminal(session.id)}
							type="button"
							aria-label={`Close ${getTerminalLabel(session.id, idx)}`}
						>
							<UIIcon name="close" size={12} />
						</button>
					</div>
				{/each}
			</aside>
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

	.terminals-layout {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
	}

	.terminals-layout.has-rail {
		grid-template-columns: minmax(0, 1fr) 4px var(--terminal-rail-width, 160px);
	}

	.terminals-container {
		flex: 1;
		position: relative;
		overflow: hidden;
		min-width: 0;
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

	.terminal-rail {
		border-left: 1px solid color-mix(in srgb, var(--color-border) 80%, transparent);
		background: color-mix(in srgb, var(--color-bg-sidebar) 82%, var(--color-bg));
		padding: 6px 4px;
		display: flex;
		flex-direction: column;
		gap: 4px;
		overflow-y: auto;
		overflow-x: hidden;
	}

	.rail-resizer {
		cursor: col-resize;
		background: transparent;
		position: relative;
	}

	.rail-resizer:hover::after {
		content: '';
		position: absolute;
		left: 1px;
		top: 0;
		bottom: 0;
		width: 2px;
		background: color-mix(in srgb, var(--color-accent) 55%, transparent);
	}

	.rail-item {
		display: flex;
		align-items: center;
		gap: 2px;
		border-radius: 4px;
		padding: 1px;
		min-height: 26px;
	}

	.rail-item.active {
		background: color-mix(in srgb, var(--color-accent) 16%, transparent);
	}

	.rail-select {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 6px;
		height: 24px;
		padding: 0 6px;
		border-radius: 4px;
		color: var(--color-text);
		text-align: left;
	}

	.rail-select:hover {
		background: color-mix(in srgb, var(--color-hover) 85%, transparent);
	}

	.rail-label {
		font-size: 11px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.rail-kill {
		width: 20px;
		height: 20px;
		display: grid;
		place-items: center;
		border-radius: 4px;
		color: var(--color-text-secondary);
		opacity: 0;
		transition: opacity 0.12s ease, background-color 0.12s ease, color 0.12s ease;
	}

	.rail-item:hover .rail-kill {
		opacity: 1;
	}

	.rail-kill:hover {
		color: var(--color-error);
		background: color-mix(in srgb, var(--color-error) 20%, transparent);
	}
</style>
