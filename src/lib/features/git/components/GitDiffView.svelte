<script lang="ts">
	import { UIIcon } from '$shared/components/ui';
	import type { GitFileChange, GitDiff } from '$features/git/services/git';

	interface Props {
		file: GitFileChange;
		diff: GitDiff | null;
		loading: boolean;
		onClose: () => void;
	}

	let { file, diff, loading, onClose }: Props = $props();

	function getFileName(path: string): string {
		return path.split(/[/\\]/).pop() || path;
	}
</script>

<div class="diff-view" role="dialog" aria-label="Diff view">
	<div class="diff-header">
		<div class="diff-title">
			<span class="file-name">{getFileName(file.path)}</span>
			{#if diff}
				<span class="diff-stats">
					<span class="additions">+{diff.additions}</span>
					<span class="deletions">-{diff.deletions}</span>
				</span>
			{/if}
		</div>
		<button class="close-btn" type="button" onclick={onClose} title="Close">
			<UIIcon name="close" size={14} />
		</button>
	</div>

	<div class="diff-content">
		{#if loading}
			<div class="loading">
				<div class="spinner"></div>
				<span>Loading diff...</span>
			</div>
		{:else if !diff}
			<div class="empty">No diff available</div>
		{:else if diff.isBinary}
			<div class="binary-notice">
				<UIIcon name="file" size={24} />
				<p>Binary file differs</p>
			</div>
		{:else if diff.hunks.length === 0}
			<div class="empty">No changes</div>
		{:else}
			{#if diff.truncated}
				<div class="truncated-notice">
					<UIIcon name="warning" size={14} />
					<span>Diff truncated due to size. View full file for complete changes.</span>
				</div>
			{/if}

			<div class="hunks">
				{#each diff.hunks as hunk, i}
					<div class="hunk">
						<div class="hunk-header">
							@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
						</div>
						<pre class="hunk-content">{#each hunk.content.split('\n') as line}{#if line}<span
										class="diff-line"
										class:addition={line.startsWith('+')}
										class:deletion={line.startsWith('-')}
										class:context={!line.startsWith('+') && !line.startsWith('-')}
									>{line}</span>{/if}
{/each}</pre>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	.diff-view {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		background: var(--color-bg);
		z-index: 100;
		outline: none;
	}

	.diff-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 12px;
		background: var(--color-bg-header);
		border-bottom: 1px solid var(--color-border);
	}

	.diff-title {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}

	.file-name {
		font-size: 12px;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.diff-stats {
		display: flex;
		gap: 8px;
		font-size: 11px;
		font-family: var(--font-mono);
	}

	.additions {
		color: var(--color-success);
	}

	.deletions {
		color: var(--color-error);
	}

	.close-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border-radius: 4px;
		color: var(--color-text-secondary);
	}

	.close-btn:hover {
		background: var(--color-hover);
		color: var(--color-text);
	}

	.diff-content {
		flex: 1;
		overflow: auto;
	}

	.loading,
	.empty,
	.binary-notice {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 12px;
		height: 100%;
		color: var(--color-text-secondary);
		font-size: 13px;
	}

	.spinner {
		width: 20px;
		height: 20px;
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

	.truncated-notice {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		background: color-mix(in srgb, var(--color-warning) 15%, transparent);
		color: var(--color-warning);
		font-size: 11px;
	}

	.hunks {
		font-family: var(--font-mono);
		font-size: 12px;
		line-height: 1.5;
	}

	.hunk {
		border-bottom: 1px solid var(--color-border);
	}

	.hunk-header {
		padding: 4px 12px;
		background: var(--color-surface0);
		color: var(--color-text-secondary);
		font-size: 11px;
	}

	.hunk-content {
		margin: 0;
		padding: 0;
		white-space: pre-wrap;
		word-break: break-all;
		user-select: text;
		cursor: default;
		caret-color: transparent;
	}

	.diff-line {
		display: block;
		padding: 0 12px;
		min-height: 1.5em;
	}

	.diff-line.addition {
		background: color-mix(in srgb, var(--color-success) 15%, transparent);
		color: var(--color-success);
	}

	.diff-line.deletion {
		background: color-mix(in srgb, var(--color-error) 15%, transparent);
		color: var(--color-error);
	}

	.diff-line.context {
		color: var(--color-text-secondary);
	}
</style>
