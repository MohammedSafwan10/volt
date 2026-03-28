/**
 * Lazy loader for xterm.js
 * Only loads xterm when terminal is first opened
 */

import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { WebLinksAddon } from '@xterm/addon-web-links';

type XtermTheme = NonNullable<ConstructorParameters<typeof Terminal>[0]>['theme'];
type TerminalOptions = ConstructorParameters<typeof Terminal>[0] & {
	bellStyle?: 'none' | 'sound' | 'visual';
};

let xtermModule: typeof import('@xterm/xterm') | null = null;
let fitAddonModule: typeof import('@xterm/addon-fit') | null = null;
let webLinksAddonModule: typeof import('@xterm/addon-web-links') | null = null;
let loadingPromise: Promise<void> | null = null;

/**
 * Check if xterm is loaded
 */
export function isXtermLoaded(): boolean {
	return xtermModule !== null && fitAddonModule !== null && webLinksAddonModule !== null;
}

/**
 * Load xterm.js and addons lazily
 */
export async function loadXterm(): Promise<void> {
	if (isXtermLoaded()) return;

	if (loadingPromise) {
		await loadingPromise;
		return;
	}

	loadingPromise = (async () => {
		const [xterm, fitAddon, webLinksAddon] = await Promise.all([
			import('@xterm/xterm'),
			import('@xterm/addon-fit'),
			import('@xterm/addon-web-links')
		]);

		xtermModule = xterm;
		fitAddonModule = fitAddon;
		webLinksAddonModule = webLinksAddon;
	})();

	await loadingPromise;
}

function readCssVar(name: string, fallback: string): string {
	try {
		if (typeof window === 'undefined' || typeof document === 'undefined') return fallback;
		const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
		return v || fallback;
	} catch {
		return fallback;
	}
}

export function getTerminalTheme(): XtermTheme {
	// Provide sensible fallbacks so this is safe very early in app startup.
	const background = readCssVar('--color-bg', '#1e1e2e');
	const foreground = readCssVar('--color-text', '#cdd6f4');
	const cursor = readCssVar('--color-text', '#cdd6f4');
	// Use a more subtle selection color (semi-transparent)
	const selectionBackground = readCssVar('--color-surface1', '#45475a');

	return {
		background,
		foreground,
		cursor,
		cursorAccent: background,
		selectionBackground,
		selectionForeground: foreground,
		// Use selectionInactiveBackground for when terminal loses focus
		selectionInactiveBackground: readCssVar('--color-surface0', '#313244'),
		black: readCssVar('--color-surface1', '#45475a'),
		red: readCssVar('--color-red', '#f38ba8'),
		green: readCssVar('--color-green', '#a6e3a1'),
		yellow: readCssVar('--color-yellow', '#f9e2af'),
		blue: readCssVar('--color-blue', '#89b4fa'),
		magenta: readCssVar('--color-pink', '#f5c2e7'),
		cyan: readCssVar('--color-teal', '#94e2d5'),
		white: readCssVar('--color-text', '#cdd6f4'),
		brightBlack: readCssVar('--color-surface2', '#585b70'),
		brightRed: readCssVar('--color-red', '#f38ba8'),
		brightGreen: readCssVar('--color-green', '#a6e3a1'),
		brightYellow: readCssVar('--color-yellow', '#f9e2af'),
		brightBlue: readCssVar('--color-blue', '#89b4fa'),
		brightMagenta: readCssVar('--color-pink', '#f5c2e7'),
		brightCyan: readCssVar('--color-teal', '#94e2d5'),
		brightWhite: readCssVar('--color-text', '#cdd6f4')
	};
}

/**
 * Create a new Terminal instance
 */
export function buildTerminalOptions(
	options?: ConstructorParameters<typeof Terminal>[0]
): TerminalOptions {
	return {
		cursorBlink: true,
		cursorStyle: 'block',
		fontSize: 13,
		fontFamily: 'Consolas, "Courier New", monospace',
		scrollback: 5000,
		convertEol: true,
		bellStyle: 'none',
		smoothScrollDuration: 0,
		fastScrollModifier: 'alt',
		minimumContrastRatio: 1,
		theme: getTerminalTheme(),
		allowProposedApi: true,
		...options
	};
}

/**
 * Create a new Terminal instance
 */
export function createTerminal(options?: ConstructorParameters<typeof Terminal>[0]): Terminal {
	if (!xtermModule) {
		throw new Error('xterm not loaded. Call loadXterm() first.');
	}

	const terminalOptions = buildTerminalOptions(options);

	return new xtermModule.Terminal(terminalOptions);
}

/**
 * Create a new FitAddon instance
 */
export function createFitAddon(): FitAddon {
	if (!fitAddonModule) {
		throw new Error('xterm-addon-fit not loaded. Call loadXterm() first.');
	}

	return new fitAddonModule.FitAddon();
}

/**
 * Create a new WebLinksAddon instance for clickable URLs
 * @param handler - Called when a link is activated (clicked)
 */
export function createWebLinksAddon(
	handler?: (event: MouseEvent, uri: string) => void
): WebLinksAddon {
	if (!webLinksAddonModule) {
		throw new Error('xterm-addon-web-links not loaded. Call loadXterm() first.');
	}

	return new webLinksAddonModule.WebLinksAddon(handler);
}
