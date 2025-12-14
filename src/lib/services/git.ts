import { invoke } from '@tauri-apps/api/core';

/**
 * Get the current git branch name for a directory
 * @param path - The directory path to check
 * @returns The branch name or null if not a git repo
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
 * @param path - The directory path to check
 * @returns True if the directory is a git repo
 */
export async function isGitRepo(path: string): Promise<boolean> {
	try {
		return await invoke<boolean>('is_git_repo', { path });
	} catch {
		return false;
	}
}
