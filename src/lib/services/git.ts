import { invoke } from '@tauri-apps/api/core';
import { showToast } from '$lib/stores/toast.svelte';

// ============================================================================
// Types
// ============================================================================

export type FileStatus =
	| 'Modified'
	| 'Added'
	| 'Deleted'
	| 'Renamed'
	| 'Copied'
	| 'Untracked'
	| 'Ignored'
	| 'Unmerged'
	| 'TypeChanged';

export interface GitFileChange {
	path: string;
	oldPath: string | null;
	status: FileStatus;
	staged: boolean;
	isBinary: boolean;
	isSubmodule: boolean;
}

export interface GitStatus {
	branch: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	staged: GitFileChange[];
	unstaged: GitFileChange[];
	untracked: GitFileChange[];
	conflicted: GitFileChange[];
	hasConflicts: boolean;
}

export interface GitBranch {
	name: string;
	isCurrent: boolean;
	isRemote: boolean;
	upstream: string | null;
}

export interface DiffHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	content: string;
}

export interface GitDiff {
	path: string;
	oldPath: string | null;
	isBinary: boolean;
	hunks: DiffHunk[];
	additions: number;
	deletions: number;
	truncated: boolean;
}

// Git error types from Rust
export type GitErrorType =
	| 'GitNotInstalled'
	| 'NotARepository'
	| 'PermissionDenied'
	| 'IndexLocked'
	| 'MergeConflicts'
	| 'UncommittedChanges'
	| 'BranchNotFound'
	| 'CommandFailed'
	| 'ParseError'
	| 'DubiousOwnership'
	| 'Cancelled';

export interface GitError {
	type: GitErrorType;
	path?: string;
	branch?: string;
	message?: string;
}

// ============================================================================
// Error Handling
// ============================================================================

function isGitError(error: unknown): error is GitError {
	return typeof error === 'object' && error !== null && 'type' in error;
}

function getErrorMessage(error: unknown): string {
	if (isGitError(error)) {
		switch (error.type) {
			case 'GitNotInstalled':
				return 'Git is not installed. Please install Git to use source control features.';
			case 'NotARepository':
				return 'This folder is not a Git repository.';
			case 'PermissionDenied':
				return 'Permission denied. Check file permissions.';
			case 'IndexLocked':
				return 'Git index is locked. Another Git process may be running.';
			case 'MergeConflicts':
				return 'Merge conflicts exist. Resolve conflicts before continuing.';
			case 'UncommittedChanges':
				return 'You have uncommitted changes. Commit or stash them first.';
			case 'BranchNotFound':
				return `Branch "${error.branch}" not found.`;
			case 'DubiousOwnership':
				return `Repository ownership issue. Run this in terminal:\ngit config --global --add safe.directory "${error.path?.replace(/\\/g, '/')}"`;
			case 'Cancelled':
				return '';
			case 'CommandFailed':
				return error.message || 'Git command failed.';
			case 'ParseError':
				return 'Failed to parse Git output.';
			default:
				return 'An unknown Git error occurred.';
		}
	}
	if (typeof error === 'string') {
		return error;
	}
	return 'An unexpected error occurred.';
}

// ============================================================================
// Cancellation
// ============================================================================

export async function cancelGitOperation(opId: string): Promise<boolean> {
	try {
		return await invoke<boolean>('git_cancel', { opId });
	} catch {
		return false;
	}
}

// ============================================================================
// Basic Git Functions (existing)
// ============================================================================

/**
 * Get the current git branch name for a directory
 */
export async function getGitBranch(path: string): Promise<string | null> {
	try {
		return await invoke<string | null>('get_git_branch', { path });
	} catch {
		return null;
	}
}

/**
 * Check if a directory is a git repository
 */
export async function isGitRepo(path: string): Promise<boolean> {
	try {
		return await invoke<boolean>('is_git_repo', { path });
	} catch {
		return false;
	}
}

// ============================================================================
// Git Status
// ============================================================================

/**
 * Get full git status for a repository
 * Returns { status, error } to allow UI to show detailed error info
 */
export async function getGitStatus(
	path: string,
	opId?: string
): Promise<{ status: GitStatus | null; error: string | null }> {
	try {
		const status = await invoke<GitStatus>('git_status', { path, opId });
		return { status, error: null };
	} catch (error) {
		if (isGitError(error) && error.type === 'Cancelled') {
			return { status: null, error: null };
		}
		const msg = getErrorMessage(error);
		// Don't show toast for "not a repo" or "dubious ownership" - UI handles these
		if (
			!isGitError(error) ||
			(error.type !== 'NotARepository' && error.type !== 'DubiousOwnership')
		) {
			if (msg) showToast({ message: msg, type: 'error' });
		}
		return { status: null, error: msg };
	}
}

// ============================================================================
// Staging
// ============================================================================

/**
 * Stage a single file
 */
export async function stageFile(path: string, filePath: string): Promise<boolean> {
	try {
		await invoke('git_stage_file', { path, filePath });
		return true;
	} catch (error) {
		showToast({ message: getErrorMessage(error), type: 'error' });
		return false;
	}
}

/**
 * Stage all files
 */
export async function stageAll(path: string): Promise<boolean> {
	try {
		await invoke('git_stage_all', { path });
		return true;
	} catch (error) {
		showToast({ message: getErrorMessage(error), type: 'error' });
		return false;
	}
}

/**
 * Unstage a single file
 */
export async function unstageFile(path: string, filePath: string): Promise<boolean> {
	try {
		await invoke('git_unstage_file', { path, filePath });
		return true;
	} catch (error) {
		showToast({ message: getErrorMessage(error), type: 'error' });
		return false;
	}
}

/**
 * Unstage all files
 */
export async function unstageAll(path: string): Promise<boolean> {
	try {
		await invoke('git_unstage_all', { path });
		return true;
	} catch (error) {
		showToast({ message: getErrorMessage(error), type: 'error' });
		return false;
	}
}

// ============================================================================
// Commit
// ============================================================================

/**
 * Commit staged changes
 */
export async function commit(path: string, message: string): Promise<string | null> {
	try {
		const hash = await invoke<string>('git_commit', { path, message });
		showToast({ message: 'Changes committed successfully', type: 'success' });
		return hash;
	} catch (error) {
		showToast({ message: getErrorMessage(error), type: 'error' });
		return null;
	}
}

// ============================================================================
// Branches
// ============================================================================

/**
 * Get list of all branches
 */
export async function listBranches(path: string): Promise<GitBranch[]> {
	try {
		return await invoke<GitBranch[]>('git_list_branches', { path });
	} catch (error) {
		showToast({ message: getErrorMessage(error), type: 'error' });
		return [];
	}
}

/**
 * Switch to a different branch
 */
export async function switchBranch(path: string, branch: string): Promise<boolean> {
	try {
		await invoke('git_switch_branch', { path, branch });
		showToast({ message: `Switched to branch "${branch}"`, type: 'success' });
		return true;
	} catch (error) {
		showToast({ message: getErrorMessage(error), type: 'error' });
		return false;
	}
}

/**
 * Check if there are uncommitted changes
 */
export async function hasUncommittedChanges(path: string): Promise<boolean> {
	try {
		return await invoke<boolean>('git_has_uncommitted_changes', { path });
	} catch {
		return false;
	}
}

// ============================================================================
// Diff
// ============================================================================

/**
 * Get diff for a specific file
 */
export async function getDiff(
	path: string,
	filePath: string,
	staged: boolean,
	opId?: string
): Promise<GitDiff | null> {
	try {
		return await invoke<GitDiff>('git_diff_file', { path, filePath, staged, opId });
	} catch (error) {
		if (isGitError(error) && error.type === 'Cancelled') {
			return null;
		}
		const msg = getErrorMessage(error);
		if (msg) showToast({ message: msg, type: 'error' });
		return null;
	}
}

// ============================================================================
// Discard
// ============================================================================

/**
 * Discard changes to a file
 */
export async function discardFile(path: string, filePath: string): Promise<boolean> {
	try {
		await invoke('git_discard_file', { path, filePath });
		showToast({ message: 'Changes discarded', type: 'info' });
		return true;
	} catch (error) {
		showToast({ message: getErrorMessage(error), type: 'error' });
		return false;
	}
}
