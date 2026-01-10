/**
 * Editor Streaming Service
 * Handles smooth, animated code streaming into Monaco editor
 * Used by AI assistant to show live code generation
 * 
 * Flow:
 * 1. Open file tab in editor (real file, not virtual)
 * 2. Stream content chunk by chunk with visual animation
 * 3. File is saved to disk by the caller after streaming completes
 */

import { loadMonaco } from './monaco-loader';
import { getOrCreateModel, getActiveEditor } from './monaco-models';
import { editorStore } from '$lib/stores/editor.svelte';
import { projectStore } from '$lib/stores/project.svelte';

export interface StreamingSession {
  id: string;
  path: string;
  content: string;
  position: number;
  active: boolean;
  completed: boolean;
  abortController: AbortController;
  userScrolledAway: boolean; // Track if user manually scrolled
  onProgress?: (progress: StreamingProgress) => void;
  onComplete?: () => void;
  onError?: (error: string) => void;
}

export interface StreamingProgress {
  charsWritten: number;
  totalChars: number;
  linesWritten: number;
  totalLines: number;
  percent: number;
}

export interface StreamingOptions {
  chunkSize?: number;
  chunkDelay?: number;
  autoScroll?: boolean;
  onProgress?: (progress: StreamingProgress) => void;
  onComplete?: () => void;
  onError?: (error: string) => void;
}

const activeSessions = new Map<string, StreamingSession>();

// Fast streaming for good UX
const DEFAULT_CHUNK_SIZE = 100;
const DEFAULT_CHUNK_DELAY = 0;

function generateSessionId(): string {
  return `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function countLines(text: string): number {
  if (!text) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const languageMap: Record<string, string> = {
    'js': 'javascript', 'mjs': 'javascript', 'cjs': 'javascript', 'jsx': 'javascript',
    'ts': 'typescript', 'tsx': 'typescript', 'mts': 'typescript', 'cts': 'typescript',
    'html': 'html', 'htm': 'html',
    'css': 'css', 'scss': 'scss', 'sass': 'scss', 'less': 'less',
    'json': 'json', 'jsonc': 'json',
    'yaml': 'yaml', 'yml': 'yaml',
    'md': 'markdown', 'mdx': 'markdown',
    'py': 'python', 'rs': 'rust', 'go': 'go',
    'svelte': 'svelte', 'vue': 'html',
    'sh': 'shell', 'bash': 'shell',
    'sql': 'sql', 'graphql': 'graphql'
  };
  return languageMap[ext] || 'plaintext';
}

/**
 * Normalize path - convert to workspace-relative with forward slashes
 */
function normalizePath(inputPath: string): string {
  let normalized = inputPath.replace(/\\/g, '/');
  
  const workspaceRoot = projectStore.rootPath?.replace(/\\/g, '/');
  if (workspaceRoot && normalized.toLowerCase().startsWith(workspaceRoot.toLowerCase())) {
    normalized = normalized.slice(workspaceRoot.length);
    if (normalized.startsWith('/')) {
      normalized = normalized.slice(1);
    }
  }
  
  return normalized;
}

/**
 * Compare paths - handles both full paths and relative paths
 * Also handles case-insensitivity on Windows
 */
function pathsEqual(a: string, b: string): boolean {
  const normalizedA = a.replace(/\\/g, '/');
  const normalizedB = b.replace(/\\/g, '/');
  
  // Windows is case-insensitive
  const isWindows = typeof navigator !== 'undefined' && 
    (navigator.userAgent?.toLowerCase().includes('windows') || 
     navigator.userAgent?.toLowerCase().includes('win32'));
  
  const compare = (x: string, y: string) => 
    isWindows ? x.toLowerCase() === y.toLowerCase() : x === y;
  
  // Direct match
  if (compare(normalizedA, normalizedB)) {
    return true;
  }
  
  // Check if one ends with the other (handles full path vs relative path)
  // e.g., "C:/project/src/index.html" should match "src/index.html" or "index.html"
  if (isWindows) {
    const lowerA = normalizedA.toLowerCase();
    const lowerB = normalizedB.toLowerCase();
    return lowerA.endsWith('/' + lowerB) || lowerB.endsWith('/' + lowerA);
  } else {
    return normalizedA.endsWith('/' + normalizedB) || normalizedB.endsWith('/' + normalizedA);
  }
}

/**
 * Start streaming content to an editor
 * Opens the file tab, clears content, and streams character by character
 */
export async function startStreaming(
  path: string,
  content: string,
  options: StreamingOptions = {}
): Promise<StreamingSession> {
  const sessionId = generateSessionId();
  
  // Normalize the path - keep it as-is if it's already relative
  // Don't strip too much - we need the full relative path
  let normalizedPath = path.replace(/\\/g, '/');
  
  // If path starts with workspace root, make it relative
  const workspaceRoot = projectStore.rootPath?.replace(/\\/g, '/');
  if (workspaceRoot && normalizedPath.toLowerCase().startsWith(workspaceRoot.toLowerCase())) {
    normalizedPath = normalizedPath.slice(workspaceRoot.length);
    if (normalizedPath.startsWith('/')) {
      normalizedPath = normalizedPath.slice(1);
    }
  }
  
  // Ensure we have a valid path
  if (!normalizedPath || normalizedPath === 'undefined') {
    throw new Error(`Invalid path for streaming: ${path}`);
  }
  
  // Cancel any existing session for this path
  const existingSession = Array.from(activeSessions.values()).find(s => 
    pathsEqual(s.path, normalizedPath)
  );
  if (existingSession) {
    existingSession.abortController.abort();
    activeSessions.delete(existingSession.id);
  }
  
  const session: StreamingSession = {
    id: sessionId,
    path: normalizedPath,
    content,
    position: 0,
    active: true,
    completed: false,
    abortController: new AbortController(),
    userScrolledAway: false,
    onProgress: options.onProgress,
    onComplete: options.onComplete,
    onError: options.onError
  };
  
  activeSessions.set(sessionId, session);
  
  try {
    // Load Monaco first
    const monaco = await loadMonaco();
    
    // Get filename and language
    const filename = normalizedPath.split('/').pop() || 'untitled';
    const language = detectLanguage(filename);
    
    // Build full path for comparison
    const fullPath = workspaceRoot 
      ? `${workspaceRoot}/${normalizedPath}`.replace(/\/+/g, '/')
      : normalizedPath;
    
    // Check if file already exists in editor
    // Try multiple matching strategies since paths can be stored as full or relative
    let existingFile = editorStore.openFiles.find(f => pathsEqual(f.path, normalizedPath)) ??
      editorStore.openFiles.find(f => pathsEqual(f.path, fullPath));
    
    if (!existingFile) {
      // For streaming, ALWAYS create a virtual file first with empty content
      // This avoids the race condition where we open an empty file from disk
      // The streaming will fill in the content, and the caller saves to disk after
      editorStore.openVirtualFile({
        path: normalizedPath,
        name: filename,
        content: '', // Start empty, we'll stream content
        language,
        readonly: false,
        pinned: false
      });
      existingFile = editorStore.openFiles.find(f => pathsEqual(f.path, normalizedPath));
    } else {
      // Switch to existing file and clear its content for streaming
      editorStore.setActiveFile(existingFile.path);
    }
    
    // Update session path to match the actual file path in editor store
    const actualPath = existingFile?.path || normalizedPath;
    session.path = actualPath;
    
    // Wait for editor to be ready - retry a few times
    let editor = getActiveEditor();
    let retries = 0;
    while (!editor && retries < 10) {
      await new Promise(resolve => setTimeout(resolve, 20));
      editor = getActiveEditor();
      retries++;
    }
    
    if (!editor) {
      throw new Error('Editor not available after waiting');
    }
    
    // Get or create the Monaco model for this file
    const modelPath = actualPath;
    const model = await getOrCreateModel({
      path: modelPath,
      content: '', // Start empty
      language
    });
    
    // Clear the model content
    model.setValue('');
    
    // Make sure this model is set on the editor
    if (editor.getModel() !== model) {
      editor.setModel(model);
    }
    
    // Start streaming in background (non-blocking)
    streamContentAsync(session, editor, model, monaco, options);
    
    return session;
  } catch (err) {
    session.active = false;
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    session.onError?.(errorMsg);
    activeSessions.delete(sessionId);
    throw err;
  }
}

/**
 * Async streaming loop - writes content chunk by chunk
 */
async function streamContentAsync(
  session: StreamingSession,
  editor: ReturnType<typeof getActiveEditor>,
  model: Awaited<ReturnType<typeof getOrCreateModel>>,
  monaco: Awaited<ReturnType<typeof loadMonaco>>,
  options: StreamingOptions
): Promise<void> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkDelay = options.chunkDelay ?? DEFAULT_CHUNK_DELAY;
  const autoScroll = options.autoScroll ?? true;
  
  const totalChars = session.content.length;
  const totalLines = countLines(session.content);

  const yieldEveryChunks = chunkDelay === 0 ? 2 : Infinity;
  let chunkCounter = 0;
  let lastProgressAt = 0;
  const progressThrottleMs = 16;
  
  if (!editor) {
    session.active = false;
    session.onError?.('Editor not available');
    return;
  }
  
  // Track scroll listener for cleanup
  let scrollListenerDispose: (() => void) | null = null;
  
  if (autoScroll) {
    // Listen for scroll events to detect when user scrolls away
    const scrollDisposable = editor.onDidScrollChange((e) => {
      if (!session.active) return;
      
      // Only care about vertical scroll changes initiated by user
      if (e.scrollTopChanged) {
        const visibleRanges = editor.getVisibleRanges();
        if (visibleRanges.length > 0) {
          const lastVisibleLine = visibleRanges[visibleRanges.length - 1].endLineNumber;
          const currentLastLine = model.getLineCount();
          
          // If user scrolled more than 5 lines away from the bottom, they want to look at something else
          if (currentLastLine - lastVisibleLine > 5) {
            session.userScrolledAway = true;
          } else {
            // User scrolled back to bottom, resume auto-scroll
            session.userScrolledAway = false;
          }
        }
      }
    });
    
    scrollListenerDispose = () => scrollDisposable.dispose();
  }
  
  try {
    let linesWritten = 0;

    while (session.position < totalChars && session.active) {
      // Check for abort
      if (session.abortController.signal.aborted) {
        session.active = false;
        session.onError?.('Streaming cancelled');
        return;
      }
      
      // Calculate chunk end - try to break at natural points
      let chunkEnd = Math.min(session.position + chunkSize, totalChars);
      
      if (chunkEnd < totalChars) {
        const lookAhead = session.content.slice(session.position, chunkEnd + 15);
        const newlineIdx = lookAhead.indexOf('\n');
        
        // Prefer breaking at newlines for cleaner streaming
        if (newlineIdx > 0 && newlineIdx <= chunkSize + 5) {
          chunkEnd = session.position + newlineIdx + 1;
        }
      }
      
      const chunk = session.content.slice(session.position, chunkEnd);
      
      // Insert chunk at end of document
      const lastLine = model.getLineCount();
      const lastCol = model.getLineMaxColumn(lastLine);
      
      editor.executeEdits('ai-streaming', [{
        range: new monaco.Range(lastLine, lastCol, lastLine, lastCol),
        text: chunk,
        forceMoveMarkers: true
      }]);
      
      session.position = chunkEnd;

      // Update line count incrementally (avoid O(n) slice+count each chunk)
      linesWritten += countLines(chunk);
      
      const now = Date.now();
      if (now - lastProgressAt >= progressThrottleMs) {
        lastProgressAt = now;

        // Auto-scroll to keep cursor visible - but only if user hasn't scrolled away
        if (autoScroll && !session.userScrolledAway) {
          const newLastLine = model.getLineCount();
          editor.revealLine(newLastLine, 1); // Smooth scroll
        }

        // Report progress (throttled)
        session.onProgress?.({
          charsWritten: session.position,
          totalChars,
          linesWritten: Math.min(linesWritten, totalLines),
          totalLines,
          percent: Math.round((session.position / totalChars) * 100)
        });
      }

      // Yield to allow UI paint when delay is 0
      chunkCounter++;
      if (chunkCounter % yieldEveryChunks === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      
      // Small delay for visual effect (yield to UI)
      if (chunkDelay > 0 && session.position < totalChars) {
        await new Promise(resolve => setTimeout(resolve, chunkDelay));
      }
    }
    
    // Mark as completed
    session.active = false;
    session.completed = true;
    
    // Update editor store with final content so it shows as "dirty"
    editorStore.updateContent(session.path, session.content);
    
    // Final progress update
    session.onProgress?.({
      charsWritten: totalChars,
      totalChars,
      linesWritten: totalLines,
      totalLines,
      percent: 100
    });
    
    session.onComplete?.();
  } catch (err) {
    session.active = false;
    const errorMsg = err instanceof Error ? err.message : 'Streaming error';
    session.onError?.(errorMsg);
  } finally {
    // Clean up scroll listener
    scrollListenerDispose?.();
    activeSessions.delete(session.id);
  }
}

/**
 * Cancel a streaming session
 */
export function cancelStreaming(sessionId: string): void {
  const session = activeSessions.get(sessionId);
  if (session) {
    session.abortController.abort();
    session.active = false;
    activeSessions.delete(sessionId);
  }
}

/**
 * Cancel all streaming sessions for a path
 */
export function cancelStreamingForPath(path: string): void {
  const normalizedPath = normalizePath(path);
  for (const [id, session] of activeSessions) {
    if (session.path === normalizedPath) {
      session.abortController.abort();
      session.active = false;
      activeSessions.delete(id);
    }
  }
}

/**
 * Check if a path is currently being streamed to
 */
export function isStreaming(path: string): boolean {
  const normalizedPath = normalizePath(path);
  return Array.from(activeSessions.values()).some(
    s => s.path === normalizedPath && s.active
  );
}

/**
 * Get streaming progress for a path
 */
export function getStreamingProgress(path: string): StreamingProgress | null {
  const normalizedPath = normalizePath(path);
  const session = Array.from(activeSessions.values()).find(
    s => s.path === normalizedPath
  );
  
  if (!session) return null;
  
  const totalChars = session.content.length;
  const totalLines = countLines(session.content);
  const linesWritten = countLines(session.content.slice(0, session.position));
  
  return {
    charsWritten: session.position,
    totalChars,
    linesWritten,
    totalLines,
    percent: Math.round((session.position / totalChars) * 100)
  };
}

/**
 * Start streaming a surgical edit to an editor
 * Replaces originalSnippet with newSnippet progressively
 */
export async function startStreamingEdit(
  path: string,
  originalSnippet: string,
  newSnippet: string,
  options: StreamingOptions = {}
): Promise<StreamingSession> {
  const sessionId = generateSessionId();
  let normalizedPath = normalizePath(path);
  const workspaceRoot = projectStore.rootPath?.replace(/\\/g, '/');
  
  // Normalize logic similar to startStreaming
  if (workspaceRoot && normalizedPath.toLowerCase().startsWith(workspaceRoot.toLowerCase())) {
    normalizedPath = normalizedPath.slice(workspaceRoot.length);
    if (normalizedPath.startsWith('/')) normalizedPath = normalizedPath.slice(1);
  }

  // Cancel existing sessions
  const existingSession = Array.from(activeSessions.values()).find(s => 
    pathsEqual(s.path, normalizedPath)
  );
  if (existingSession) {
    existingSession.abortController.abort();
    activeSessions.delete(existingSession.id);
  }

  const session: StreamingSession = {
    id: sessionId,
    path: normalizedPath,
    content: newSnippet, // We stream the NEW content
    position: 0,
    active: true,
    completed: false,
    abortController: new AbortController(),
    userScrolledAway: false,
    onProgress: options.onProgress,
    onComplete: options.onComplete,
    onError: options.onError
  };

  activeSessions.set(sessionId, session);

  try {
    const monaco = await loadMonaco();
    
    // Open/Find file (reusing logic from startStreaming is hard without refactoring, duplicating slightly for safety)
    const filename = normalizedPath.split('/').pop() || 'untitled';
    const language = detectLanguage(filename);
    const fullPath = workspaceRoot ? `${workspaceRoot}/${normalizedPath}` : normalizedPath;

    let existingFile = editorStore.openFiles.find(f => pathsEqual(f.path, normalizedPath)) ??
      editorStore.openFiles.find(f => pathsEqual(f.path, fullPath));

    if (!existingFile) {
      const opened = await editorStore.openFile(fullPath);
      if (opened) {
        existingFile = editorStore.activeFile ?? 
          editorStore.openFiles.find(f => pathsEqual(f.path, normalizedPath));
      }
    } else {
      editorStore.setActiveFile(existingFile.path);
    }

    const actualPath = existingFile?.path || normalizedPath;
    session.path = actualPath;

    // Wait for editor
    let editor = getActiveEditor();
    let retries = 0;
    while (!editor && retries < 10) {
      await new Promise(resolve => setTimeout(resolve, 20));
      editor = getActiveEditor();
      retries++;
    }

    if (!editor) throw new Error('Editor not available');

    const model = await getOrCreateModel({ path: actualPath, content: '', language }); // Content ignored if exists
    
    // Locate the original snippet
    const modelContent = model.getValue();
    // Normalize line endings for search
    const normalizedModelContent = modelContent.replace(/\r\n/g, '\n');
    const normalizedSnippet = originalSnippet.replace(/\r\n/g, '\n');
    
    const startIndex = normalizedModelContent.indexOf(normalizedSnippet);
    if (startIndex === -1) {
      // Try fuzzy match (trim)
      const trimmedSnippet = normalizedSnippet.trim();
      const trimmedStart = normalizedModelContent.indexOf(trimmedSnippet);
      if (trimmedStart === -1) {
        // Don't fail yet; Monaco regex matching below is more robust.
      }
      // Use the found index
      // Need to map back to Monaco Position. 
      // Monaco's `getPositionAt` works on the model's text (which might be CRLF)
      // If we used normalized search, indices might differ slightly if file matches CRLF.
      // Ideally use model.findMatches() which is safer.
    }

    // Use Monaco's findMatches with Regex to handle CRLF/LF differences
    // Escape the snippet for regex usage
    const escapedSnippet = originalSnippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Replace newlines with a pattern that matches any EOL sequence
    const regexPattern = escapedSnippet.replace(/\n/g, '\\r?\\n');
    
    const matches = model.findMatches(regexPattern, false, true, false, null, true);
    let matchRange: any = null;
    
    if (matches.length > 0) {
      matchRange = matches[0].range;
    } else {
      // Fallback: try finding trimmed version (also with regex)
      const trimmedSnippet = originalSnippet.trim();
      const escapedTrimmed = trimmedSnippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regexTrimmed = escapedTrimmed.replace(/\n/g, '\\r?\\n');
      
      const trimmedMatches = model.findMatches(regexTrimmed, false, true, false, null, true);
      if (trimmedMatches.length > 0) {
        matchRange = trimmedMatches[0].range;
      } else {
         const normalized = trimmedSnippet.replace(/\r\n/g, '\n').trim();
         const parts = normalized.split(/\s+/).filter(Boolean).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
         const whitespaceRegex = parts.join('\\s+');
         const wsMatches = whitespaceRegex
           ? model.findMatches(whitespaceRegex, false, true, false, null, true)
           : [];

         if (wsMatches.length > 0) {
           matchRange = wsMatches[0].range;
         } else {
           // Debug: log what we tried to find
           console.warn('[startStreamingEdit] Snippet not found via regex:', regexPattern.slice(0, 100));
           throw new Error('Original snippet not found in file (visual match failed)');
         }
      }
    }

    // Delete the original range
    editor.executeEdits('ai-streaming-edit', [{
      range: matchRange,
      text: '', // Delete
      forceMoveMarkers: true
    }]);

    // Set cursor to start of deletion
    const startPos = matchRange.getStartPosition();
    editor.setPosition(startPos);
    editor.revealPositionInCenter(startPos);

    // Start streaming new content at this position
    streamEditContentAsync(session, editor, model, monaco, startPos, originalSnippet, options);

    return session;

  } catch (err) {
    session.active = false;
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    session.onError?.(errorMsg);
    activeSessions.delete(sessionId);
    throw err;
  }
}

/**
 * Async loop for streaming edits at a specific position
 */
async function streamEditContentAsync(
  session: StreamingSession,
  editor: ReturnType<typeof getActiveEditor>,
  model: Awaited<ReturnType<typeof getOrCreateModel>>,
  monaco: Awaited<ReturnType<typeof loadMonaco>>,
  startPosition: any, // monaco.Position
  originalSnippet: string,
  options: StreamingOptions
): Promise<void> {
  if (!editor) {
    session.active = false;
    session.onError?.('No active editor available for streaming edit');
    return;
  }

  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkDelay = options.chunkDelay ?? DEFAULT_CHUNK_DELAY;
  
  const totalChars = session.content.length;
  const totalLines = countLines(session.content);

  const yieldEveryChunks = chunkDelay === 0 ? 2 : Infinity;
  let chunkCounter = 0;
  let lastProgressAt = 0;
  const progressThrottleMs = 16;
  
  // Track insertion point
  let currentLine = startPosition.lineNumber;
  let currentColumn = startPosition.column;

  let linesWritten = 0;

  const restoreOriginal = (reason: string): void => {
    try {
      const endPos = new monaco.Position(currentLine, currentColumn);
      const range = new monaco.Range(
        startPosition.lineNumber,
        startPosition.column,
        endPos.lineNumber,
        endPos.column
      );
      editor.executeEdits('ai-streaming-edit-restore', [{
        range,
        text: originalSnippet,
        forceMoveMarkers: true
      }]);
      editorStore.updateContent(session.path, model.getValue());
    } catch (err) {
      console.warn('[streamEditContentAsync] Failed to restore original snippet:', err);
    } finally {
      session.onError?.(reason);
    }
  };

  try {
    while (session.position < totalChars && session.active) {
      if (session.abortController.signal.aborted) {
        session.active = false;
        restoreOriginal('Streaming cancelled');
        return;
      }

      let chunkEnd = Math.min(session.position + chunkSize, totalChars);
      // Nice breaking at newlines
      if (chunkEnd < totalChars) {
        const lookAhead = session.content.slice(session.position, chunkEnd + 15);
        const newlineIdx = lookAhead.indexOf('\n');
        if (newlineIdx > 0 && newlineIdx <= chunkSize + 5) {
          chunkEnd = session.position + newlineIdx + 1;
        }
      }

      const chunk = session.content.slice(session.position, chunkEnd);

      // Insert at current cursor position
      const range = new monaco.Range(currentLine, currentColumn, currentLine, currentColumn);
      
      editor.executeEdits('ai-streaming-edit', [{
        range,
        text: chunk,
        forceMoveMarkers: true
      }]);

      // Update position for next chunk
      // We can rely on Monaco to move the cursor if we set it, or calculate new pos
      // Simplest is to ask model for position after edit? 
      // Actually `executeEdits` doesn't update cursor auto unless we tell it or read back.
      // Better: Update our tracking based on chunk content.
      const chunkLines = chunk.split('\n');
      if (chunkLines.length > 1) {
        currentLine += chunkLines.length - 1;
        currentColumn = chunkLines[chunkLines.length - 1].length + 1;
      } else {
        currentColumn += chunk.length;
      }

      linesWritten += chunkLines.length;

      session.position = chunkEnd;

      const now = Date.now();
      if (now - lastProgressAt >= progressThrottleMs) {
        lastProgressAt = now;

        // Reveal cursor (throttled)
        editor.revealPosition(new monaco.Position(currentLine, currentColumn));

        session.onProgress?.({
          charsWritten: session.position,
          totalChars,
          linesWritten: Math.min(linesWritten, totalLines),
          totalLines,
          percent: Math.round((session.position / totalChars) * 100)
        });
      }

      chunkCounter++;
      if (chunkCounter % yieldEveryChunks === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }

      if (chunkDelay > 0 && session.position < totalChars) {
        await new Promise(resolve => setTimeout(resolve, chunkDelay));
      }
    }

    session.active = false;
    session.completed = true;
    editorStore.updateContent(session.path, model.getValue());
    
    session.onProgress?.({
      charsWritten: totalChars,
      totalChars,
      linesWritten: totalLines,
      totalLines,
      percent: 100
    });
    
    session.onComplete?.();

  } catch (err) {
    session.active = false;
    restoreOriginal(err instanceof Error ? err.message : 'Streaming error');
  } finally {
    activeSessions.delete(session.id);
  }
}
