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
const DEFAULT_CHUNK_SIZE = 25;
const DEFAULT_CHUNK_DELAY = 2;

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
      // Try to open the file from disk first (it's a real file in the project)
      // fullPath is already defined above
      
      // Try to open as real file
      const opened = await editorStore.openFile(fullPath);
      
      if (opened) {
        // File opened successfully - find it using the active file (most reliable)
        // or search with our improved pathsEqual that handles full vs relative paths
        existingFile = editorStore.activeFile ?? 
          editorStore.openFiles.find(f => pathsEqual(f.path, normalizedPath)) ??
          editorStore.openFiles.find(f => pathsEqual(f.path, fullPath));
      }
      
      // If still not found (new file), create virtual file
      if (!existingFile) {
        editorStore.openVirtualFile({
          path: normalizedPath,
          name: filename,
          content: '', // Start empty, we'll stream content
          language,
          readonly: false,
          pinned: false
        });
        existingFile = editorStore.openFiles.find(f => pathsEqual(f.path, normalizedPath));
      }
    } else {
      // Switch to existing file
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
    while (session.position < totalChars && session.active) {
      // Check for abort
      if (session.abortController.signal.aborted) {
        session.active = false;
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
      
      // Auto-scroll to keep cursor visible - but only if user hasn't scrolled away
      if (autoScroll && !session.userScrolledAway) {
        const newLastLine = model.getLineCount();
        editor.revealLine(newLastLine, 1); // Smooth scroll
      }
      
      // Report progress
      const linesWritten = countLines(session.content.slice(0, session.position));
      session.onProgress?.({
        charsWritten: session.position,
        totalChars,
        linesWritten,
        totalLines,
        percent: Math.round((session.position / totalChars) * 100)
      });
      
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
 * Get all active streaming sessions
 */
export function getActiveSessions(): StreamingSession[] {
  return Array.from(activeSessions.values()).filter(s => s.active);
}
