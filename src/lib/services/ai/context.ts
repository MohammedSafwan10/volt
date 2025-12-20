/**
 * Smart Context Service
 * Automatically gathers relevant IDE state (files, selection, tabs) for AI requests
 */

import { editorStore } from '$lib/stores/editor.svelte';
import { projectStore } from '$lib/stores/project.svelte';
import { assistantStore } from '$lib/stores/assistant.svelte';
import { activityStore } from '$lib/stores/activity.svelte';
import { readFile } from '$lib/services/file-system';

export interface SmartContext {
  activeFile?: {
    path: string;
    content: string;
    selection?: string;
  };
  relatedFiles: Array<{
    path: string;
    content: string;
    reason: string;
  }>;
  recentFiles: string[];
  openTabs: string[];
  openTabsContent?: Array<{
    path: string;
    content: string;
    isDirty: boolean;
  }>;
  workspaceRoot?: string;
}

/**
 * Resolve dependencies from file content (regex-based)
 */
function resolveDependencies(content: string, currentPath: string): string[] {
  const deps = new Set<string>();
  
  // Regex for JS/TS imports: import ... from './path' or import './path'
  const importRegex = /(?:import|export)\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g;
  // Regex for require: require('./path')
  const requireRegex = /require\(['"]([^'"]+)['"]\)/g;
  // Regex for CSS imports: @import './path'
  const cssRegex = /@import\s+['"]([^'"]+)['"]/g;

  let match;
  while ((match = importRegex.exec(content)) !== null) {
    if (match[1].startsWith('.')) deps.add(match[1]);
  }
  while ((match = requireRegex.exec(content)) !== null) {
    if (match[1].startsWith('.')) deps.add(match[1]);
  }
  while ((match = cssRegex.exec(content)) !== null) {
    if (match[1].startsWith('.')) deps.add(match[1]);
  }

  const results: string[] = [];
  const dir = currentPath.substring(0, currentPath.lastIndexOf('/') + 1) || 
              currentPath.substring(0, currentPath.lastIndexOf('\\') + 1) || '';
  const sep = currentPath.includes('\\') ? '\\' : '/';

  for (const dep of deps) {
    // Basic relative path resolution
    let cleanDep = dep;
    // Append common extensions if missing
    if (!cleanDep.split('/').pop()?.includes('.')) {
      // Guessing extension - simplified
      if (currentPath.endsWith('.ts')) cleanDep += '.ts';
      else if (currentPath.endsWith('.svelte')) cleanDep += '.svelte';
      else cleanDep += '.js';
    }

    // This is a naive join, but works for simple cases
    let resolved = dir + cleanDep.replace(/\//g, sep);
    // Remove ./ and handle ../
    resolved = resolved.replace(/[/\\]\.\//g, sep);
    // (A more robust path resolver would be better, but this is a start)
    results.push(resolved);
  }

  return results;
}

/**
 * Gather current IDE state into a formatted context block
 */
export async function getSmartContext(): Promise<SmartContext> {
  const activeFile = editorStore.activeFile;
  const relatedFiles: SmartContext['relatedFiles'] = [];
  
  // Collect all open tabs with their content
  // Prioritize: Active File -> Recent Tabs -> Other Tabs
  // Total limit: ~100k chars to stay well within 1M token limit but avoid noise
  const MAX_CONTEXT_CHARS = 100_000;
  let currentChars = 0;

  const openTabsContent: Array<{ path: string; content: string; isDirty: boolean }> = [];
  
  // 1. Active File (Highest Priority)
  if (activeFile) {
    currentChars += activeFile.content.length;
    
    // Find files imported by the active file
    const depPaths = resolveDependencies(activeFile.content, activeFile.path);
    
    // Read contents of the top 3 dependencies
    for (const path of depPaths.slice(0, 3)) {
      const openFile = editorStore.openFiles.find(f => f.path === path);
      if (openFile) {
        relatedFiles.push({ path, content: openFile.content, reason: 'Imported by active file' });
        currentChars += openFile.content.length;
      } else {
        try {
          const content = await readFile(path);
          if (content) {
            relatedFiles.push({ path, content, reason: 'Imported by active file' });
            currentChars += content.length;
          }
        } catch {
          // Ignore
        }
      }
    }
  }

  // 2. Other Open Tabs
  // Sort by recently active? We don't have that timestamp in editorStore easily, 
  // but the order in openFiles usually reflects opening order.
  // We'll iterate and add until full.
  for (const file of editorStore.openFiles) {
    if (file.path === activeFile?.path) continue; // Already handled
    
    if (currentChars + file.content.length < MAX_CONTEXT_CHARS) {
      openTabsContent.push({
        path: file.path,
        content: file.content,
        isDirty: file.content !== file.originalContent
      });
      currentChars += file.content.length;
    } else {
      // If we can't fit the whole file, maybe add a truncated version?
      // For now, just skip to keep context clean.
      break; 
    }
  }
  
  return {
    activeFile: activeFile ? {
      path: activeFile.path,
      content: activeFile.content,
    } : undefined,
    relatedFiles,
    recentFiles: activityStore.recentPaths,
    openTabs: editorStore.openFiles.map(f => f.path), // List of paths for reference
    openTabsContent, // New field with actual content
    workspaceRoot: projectStore.rootPath ?? undefined
  };
}

/**
 * Format the smart context into a string for the AI prompt
 */
export function formatSmartContext(context: SmartContext): string {
  let output = '<smart_context>\n';

  if (context.workspaceRoot) {
    output += `Workspace Root: ${context.workspaceRoot}\n`;
  }

  if (context.activeFile) {
    output += `\n[Active File: ${context.activeFile.path}]\n`;
    output += '```\n';
    output += context.activeFile.content;
    output += '\n```\n';
  }

  if (context.openTabsContent && context.openTabsContent.length > 0) {
    output += '\n[Other Open Files]\n';
    for (const file of context.openTabsContent) {
      output += `\nFile: ${file.path} ${file.isDirty ? '(Unsaved)' : ''}\n`;
      output += '```\n';
      output += file.content;
      output += '\n```\n';
    }
  }

  if (context.relatedFiles.length > 0) {
    output += '\n[Related Files (Dependencies)]\n';
    for (const file of context.relatedFiles) {
      // Avoid duplicating if it's already in Open Files
      if (context.openTabsContent?.some((f: { path: string }) => f.path === file.path)) continue;

      output += `\nFile: ${file.path} (${file.reason})\n`;
      output += '```\n';
      const lines = file.content.split('\n');
      output += lines.slice(0, 100).join('\n') + (lines.length > 100 ? '\n... [Truncated] ...' : '') + '\n';
      output += '```\n';
    }
  }

  if (context.recentFiles.length > 0) {
    output += '\n[Recent Activity (Last viewed/edited)]\n';
    output += context.recentFiles.filter(p => 
      p !== context.activeFile?.path && 
      !context.openTabsContent?.some((f: { path: string }) => f.path === p)
    ).slice(0, 5).join('\n') + '\n';
  }

  output += '</smart_context>';
  return output;
}
