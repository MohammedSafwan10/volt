/**
 * Search tool handlers - workspace_search, find_files
 */

import { invoke } from '@tauri-apps/api/core';
import { projectStore } from '$lib/stores/project.svelte';
import { truncateOutput, type ToolResult } from '../utils';

/**
 * Search workspace for text/regex patterns
 * Kiro-style: shows 2 lines of context around each match
 */
export async function handleWorkspaceSearch(args: Record<string, unknown>): Promise<ToolResult> {
  const query = String(args.query);
  const includePattern = args.includePattern ? String(args.includePattern) : '';
  const excludePattern = args.excludePattern ? String(args.excludePattern) : '';
  const caseSensitive = Boolean(args.caseSensitive);
  const workspaceRoot = projectStore.rootPath || '';
  
  try {
    const result = await invoke<{
      files: Array<{
        path: string;
        matches: Array<{ line: number; lineContent: string }>;
      }>;
      totalMatches: number;
      truncated: boolean;
    }>('workspace_search', {
      options: {
        query,
        rootPath: workspaceRoot,
        useRegex: true,
        caseSensitive,
        includePatterns: includePattern ? [includePattern] : [],
        excludePatterns: excludePattern 
          ? [excludePattern, 'node_modules/**', '.git/**', 'target/**', 'dist/**'] 
          : ['node_modules/**', '.git/**', 'target/**', 'dist/**'],
        maxResults: 50,
        requestId: Date.now()
      }
    });

    if (result.totalMatches === 0) {
      return { success: true, output: `No matches for "${query}"` };
    }

    // Format output with context (Kiro-style)
    const lines: string[] = [];
    lines.push(`Found ${result.totalMatches} matches in ${result.files.length} files\n`);
    
    for (const file of result.files.slice(0, 10)) {
      const relativePath = file.path.replace(workspaceRoot, '').replace(/^[/\\]/, '');
      lines.push(`${relativePath}`);
      
      // Get file content for context
      let fileLines: string[] = [];
      try {
        const content = await invoke<string>('read_file', { path: file.path });
        fileLines = content.split('\n');
      } catch {
        // If can't read file, show matches without context
      }
      
      for (const match of file.matches.slice(0, 5)) {
        const lineNum = match.line;
        const padding = String(lineNum + 2).length;
        
        if (fileLines.length > 0) {
          // Show 2 lines before (context)
          for (let i = Math.max(0, lineNum - 3); i < lineNum - 1; i++) {
            const num = String(i + 1).padStart(padding, ' ');
            const content = (fileLines[i] || '').slice(0, 100);
            lines.push(`  ${num}│${content}`);
          }
          
          // Show matching line (highlighted)
          const num = String(lineNum).padStart(padding, ' ');
          const content = match.lineContent.trim().slice(0, 100);
          lines.push(`  ${num}│${content}  ← match`);
          
          // Show 2 lines after (context)
          for (let i = lineNum; i < Math.min(fileLines.length, lineNum + 2); i++) {
            const num = String(i + 1).padStart(padding, ' ');
            const content = (fileLines[i] || '').slice(0, 100);
            lines.push(`  ${num}│${content}`);
          }
          lines.push('');
        } else {
          // No context available
          const num = String(lineNum).padStart(4, ' ');
          lines.push(`  ${num}│${match.lineContent.trim().slice(0, 100)}`);
        }
      }
      
      if (file.matches.length > 5) {
        lines.push(`  ... +${file.matches.length - 5} more matches\n`);
      }
    }
    
    if (result.files.length > 10) {
      lines.push(`\n... and ${result.files.length - 10} more files`);
    }

    const { text, truncated } = truncateOutput(lines.join('\n'));
    return { success: true, output: text, truncated };
    
  } catch (err) {
    return { success: false, error: `Search failed: ${err}` };
  }
}

/**
 * Find files by name (fuzzy search)
 */
export async function handleFindFiles(args: Record<string, unknown>): Promise<ToolResult> {
  const query = String(args.query);
  const workspaceRoot = projectStore.rootPath || '';
  
  try {
    const results = await invoke<Array<{
      path: string;
      score: number;
    }>>('find_files', {
      pattern: query,
      rootPath: workspaceRoot,
      maxResults: 20
    });
    
    if (results.length === 0) {
      return { success: true, output: `No files matching "${query}"` };
    }
    
    const lines = results.map(r => {
      const relativePath = r.path.replace(workspaceRoot, '').replace(/^[/\\]/, '');
      return relativePath;
    });
    
    return { 
      success: true, 
      output: `Found ${results.length} files:\n${lines.join('\n')}` 
    };
    
  } catch (err) {
    return { success: false, error: `Find failed: ${err}` };
  }
}
