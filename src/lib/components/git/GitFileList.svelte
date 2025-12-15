<script lang="ts">
	import { UIIcon, type UIIconName } from '$lib/components/ui';
	import type { GitFileChange, FileStatus } from '$lib/services/git';

	interface Props {
		files: GitFileChange[];
		type: 'staged' | 'unstaged' | 'untracked' | 'conflicted';
		onSelect?: (file: GitFileChange) => void;
		onAction?: (file: GitFileChange) => void;
		selectedPath?: string | null;
	}

	let { files, type, onSelect, onAction, selectedPath }: Props = $props();

	function getStatusIcon(status: FileStatus): string {
		switch (status) {
			case 'Modified':
				return 'M';
			case 'Added':
				return 'A';
			case 'Deleted':
				return 'D';
			case 'Renamed':
				return 'R';
			case 'Copied':
				return 'C';
			case 'Untracked':
				return 'U';
			case 'Unmerged':
				return '!';
			case 'TypeChanged':
				return 'T';
			default:
				return '?';
		}
	}

	function getStatusColor(status: FileStatus): string {
		switch (status) {
			case 'Modified':
				return 'var(--color-warning)';
			case 'Added':
			case 'Untracked':
				return 'var(--color-success)';
			case 'Deleted':
				return 'var(--color-error)';
			case 'Renamed':
			case 'Copied':
				return 'var(--color-accent)';
			case 'Unmerged':
				return 'var(--color-error)';
			default:
				return 'var(--color-text-secondary)';
		}
	}

	function getActionIcon(): UIIconName {
		if (type === 'staged') {
			return 'minus'; // Unstage
		}
		return 'plus'; // Stage
	}

	function getActionTitle(): string {
		switch (type) {
			case 'staged':
				return 'Unstage';
			case 'unstaged':
			case 'untracked':
				return 'Stage';
			default:
				return '';
		}
	}

	function getFileName(path: string): string {
		return path.split(/[/\\]/).pop() || path;
	}

	function getDirectory(path: string): string {
		const parts = path.split(/[/\\]/);
		if (parts.length > 1) {
			parts.pop();
			return parts.join('/');
		}
		return '';
	}

	function handleClick(file: GitFileChange): void {
		onSelect?.(file);
	}

	function handleAction(e: MouseEvent, file: GitFileChange): void {
		e.stopPropagation();
		onAction?.(file);
	}
</script>

<div class="file-list" role="list">
	{#each files as file (file.path)}
		<div
			class="file-item"
			class:selected={selectedPath === file.path}
			role="listitem"
		>
			<div
				class="file-content"
				role="button"
				tabindex="0"
				onclick={() => handleClick(file)}
				onkeydown={(e) => e.key === 'Enter' && handleClick(file)}
				title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
			>
				<span class="status-badge" style="color: {getStatusColor(file.status)}">
					{getStatusIcon(file.status)}
				</span>

				<span class="file-info">
					<span class="file-name">
						{#if file.isSubmodule}
							<UIIcon name="folder" size={12} />
						{/if}
						{getFileName(file.path)}
						{#if file.isBinary}
							<span class="badge">binary</span>
						{/if}
					</span>
					{#if getDirectory(file.path)}
						<span class="file-dir">{getDirectory(file.path)}</span>
					{/if}
					{#if file.oldPath}
						<span class="rename-info">{getFileName(file.oldPath)} → {getFileName(file.path)}</span>
					{/if}
				</span>
			</div>

			{#if onAction && type !== 'conflicted'}
				<button
					class="action-btn"
					type="button"
					onclick={(e) => handleAction(e, file)}
					title={getActionTitle()}
				>
					<UIIcon name={getActionIcon()} size={12} />
				</button>
			{/if}
		</div>
	{/each}
</div>

<style>
	.file-list {
		display: flex;
		flex-direction: column;
	}

	.file-item {
		display: flex;
		align-items: center;
		gap: 0;
		background: transparent;
		color: var(--color-text);
		font-size: 12px;
		min-height: 28px;
	}

	.file-item:hover {
		background: var(--color-hover);
	}

	.file-item.selected {
		background: var(--color-active);
	}

	.file-content {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: 1;
		min-width: 0;
		padding: 4px 8px 4px 12px;
		cursor: pointer;
	}

	.status-badge {
		width: 16px;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		text-align: center;
		flex-shrink: 0;
	}

	.file-info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.file-name {
		display: flex;
		align-items: center;
		gap: 4px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file-dir {
		font-size: 10px;
		color: var(--color-text-disabled);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.rename-info {
		font-size: 10px;
		color: var(--color-text-secondary);
		font-style: italic;
	}

	.badge {
		padding: 1px 4px;
		background: var(--color-surface0);
		border-radius: 4px;
		font-size: 9px;
		color: var(--color-text-secondary);
		text-transform: uppercase;
	}

	.action-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		margin-right: 8px;
		border-radius: 4px;
		color: var(--color-text-secondary);
		opacity: 0;
		transition: opacity 0.1s;
		flex-shrink: 0;
	}

	.file-item:hover .action-btn {
		opacity: 1;
	}

	.action-btn:hover {
		background: var(--color-surface0);
		color: var(--color-text);
	}
</style>
