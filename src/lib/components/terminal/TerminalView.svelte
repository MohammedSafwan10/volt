<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import type { Terminal } from '@xterm/xterm';
	import type { FitAddon } from '@xterm/addon-fit';
	import type { WebLinksAddon } from '@xterm/addon-web-links';
	import { loadXterm, createTerminal, createFitAddon, createWebLinksAddon, isXtermLoaded } from '$lib/services/terminal-loader';
	import type { TerminalSession } from '$lib/services/terminal-client';
	import { open } from '@tauri-apps/plugin-shell';

	interface Props {
		session: TerminalSession;
		active?: boolean;
	}

	let { session, active = false }: Props = $props();

	let containerRef: HTMLDivElement | undefined = $state();
	let terminal: Terminal | null = $state(null);
	let fitAddon: FitAddon | null = $state(null);
	let webLinksAddon: WebLinksAddon | null = $state(null);

	let resizeObserver: ResizeObserver | null = null;
	let writeBuffer: string[] = [];
	let flushScheduled = false;
	let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	let lastSentCols = 0;
	let lastSentRows = 0;
	let pendingCols = 0;
	let pendingRows = 0;

	/**
	 * Batch writes to xterm for performance
	 */
	function scheduleFlush(): void {
		if (flushScheduled || !terminal) return;
		flushScheduled = true;
		requestAnimationFrame(() => {
			if (terminal && writeBuffer.length > 0) {
				terminal.write(writeBuffer.join(''));
				writeBuffer = [];
			}
			flushScheduled = false;
		});
	}

	/**
	 * Write data to terminal with batching
	 */
	function writeToTerminal(data: string): void {
		writeBuffer.push(data);
		scheduleFlush();
	}

	/**
	 * Fit terminal to container and notify backend
	 */
	async function fitTerminal(): Promise<void> {
		if (!fitAddon || !terminal || !containerRef) return;

		try {
			fitAddon.fit();
			const { cols, rows } = terminal;
			if (cols > 0 && rows > 0) {
				pendingCols = cols;
				pendingRows = rows;
				if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
				resizeDebounceTimer = setTimeout(() => {
					resizeDebounceTimer = null;
					if (pendingCols === lastSentCols && pendingRows === lastSentRows) return;
					lastSentCols = pendingCols;
					lastSentRows = pendingRows;
					void session.resize(pendingCols, pendingRows);
				}, 75);
			}
		} catch {
			// Ignore fit errors during transitions
		}
	}

	/**
	 * Initialize xterm instance
	 */
	async function initTerminal(): Promise<void> {
		if (!containerRef) return;

		// Load xterm lazily
		if (!isXtermLoaded()) {
			await loadXterm();
		}

		// Create terminal and addons
		terminal = createTerminal();
		fitAddon = createFitAddon();
		// WebLinksAddon with handler to open URLs via Tauri shell
		webLinksAddon = createWebLinksAddon((_event: MouseEvent, uri: string) => {
			void open(uri);
		});

		terminal.loadAddon(fitAddon);
		terminal.loadAddon(webLinksAddon);
		terminal.open(containerRef);

		// Handle Ctrl+C: copy if selection exists, otherwise send SIGINT
		terminal.attachCustomKeyEventHandler((event) => {
			if (event.ctrlKey && event.key === 'c' && event.type === 'keydown') {
				if (terminal?.hasSelection()) {
					const selection = terminal.getSelection();
					void navigator.clipboard.writeText(selection);
					terminal.clearSelection();
					return false; // Prevent sending to shell
				}
			}
			// Ctrl+V: paste from clipboard
			if (event.ctrlKey && event.key === 'v' && event.type === 'keydown') {
				void navigator.clipboard.readText().then((text) => {
					void session.write(text);
				});
				return false;
			}
			return true; // Allow default handling
		});

		// Set up input handler to backend
		terminal.onData((data) => {
			void session.write(data);
		});

		// Initial fit - do it immediately
		await fitTerminal();

		// Set up resize observer
		resizeObserver = new ResizeObserver(() => {
			void fitTerminal();
		});
		resizeObserver.observe(containerRef);

		// Now set up data handler from backend AFTER terminal is ready
		// This ensures buffered data is written to a fully initialized terminal
		session.onData((data) => {
			writeToTerminal(data);
		});

		// Re-fit after a short delay to ensure container has final dimensions
		// and send a resize to the backend to trigger prompt redraw
		requestAnimationFrame(() => {
			setTimeout(async () => {
				await fitTerminal();
				// Force a resize notification to backend to ensure prompt is drawn
				if (terminal) {
					const { cols, rows } = terminal;
					if (cols > 0 && rows > 0) {
						await session.resize(cols, rows);
					}
				}
			}, 100);
		});
	}

	let initialized = $state(false);
	let initializing = false;

	async function tryInit(): Promise<void> {
		if (initialized || initializing || !containerRef || !active) return;
		initializing = true;
		try {
			await initTerminal();
			initialized = true;
		} finally {
			initializing = false;
		}
	}

	onMount(() => {
		// Only initialize if active to avoid xterm issues with hidden containers
		if (active) {
			void tryInit();
		}
	});

	onDestroy(() => {
		if (resizeDebounceTimer) {
			clearTimeout(resizeDebounceTimer);
			resizeDebounceTimer = null;
		}
		// Detach the UI consumer (session will buffer output while hidden/unmounted).
		session.onData(null);
		resizeObserver?.disconnect();
		terminal?.dispose();
	});

	// Initialize terminal when it becomes active (if not already initialized)
	$effect(() => {
		if (active && !initialized && containerRef) {
			void tryInit();
		}
	});

	// Focus terminal when it becomes active and is initialized
	$effect(() => {
		if (active && terminal && initialized) {
			terminal.focus();
		}
	});

	// Re-fit when becoming active (in case container size changed)
	$effect(() => {
		if (active && fitAddon && initialized) {
			void fitTerminal();
		}
	});
</script>

<div class="terminal-view" class:active>
	<div
		class="terminal-container"
		bind:this={containerRef}
	></div>
</div>

<style>
	.terminal-view {
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
		background: var(--color-bg);
	}

	.terminal-view:not(.active) {
		display: none;
	}

	.terminal-container {
		flex: 1;
		overflow: hidden;
	}

	/* xterm.js styles */
	:global(.terminal-view .xterm) {
		padding: 8px;
		height: 100%;
	}

	:global(.terminal-view .xterm-viewport) {
		overflow-y: auto !important;
	}

	:global(.terminal-view .xterm-screen) {
		height: 100%;
	}

	/* Clickable links - underline on hover */
	:global(.terminal-view .xterm-link-layer a) {
		text-decoration: underline;
		cursor: pointer;
	}
</style>
