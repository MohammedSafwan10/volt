/**
 * Command registry for the command palette
 * Defines all available commands with their actions and shortcuts
 */

export interface Command {
  /** Unique identifier for the command */
  id: string;
  /** Display label */
  label: string;
  /** Category for grouping */
  category: 'File' | 'Edit' | 'View' | 'Go' | 'Terminal' | 'Help';
  /** Keyboard shortcut (for display) */
  shortcut?: string;
  /** Action to execute */
  action: () => void | Promise<void>;
  /** Whether the command is currently available */
  enabled?: () => boolean;
}

export interface CommandWithMeta extends Command {
  /** Whether this is a recently used command */
  isRecent?: boolean;
}

const RECENT_COMMANDS_KEY = 'volt.recentCommands';
const MAX_RECENT_COMMANDS = 5;

// Command registry - will be populated by the store
let commands: Command[] = [];

// Recently used command IDs
let recentCommandIds: string[] = [];

/**
 * Load recent commands from localStorage
 */
function loadRecentCommands(): void {
  if (typeof window === 'undefined') return;
  try {
    const stored = localStorage.getItem(RECENT_COMMANDS_KEY);
    if (stored) {
      recentCommandIds = JSON.parse(stored);
    }
  } catch {
    // Ignore errors
  }
}

/**
 * Save recent commands to localStorage
 */
function saveRecentCommands(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(recentCommandIds));
  } catch {
    // Ignore errors
  }
}

/**
 * Add a command to recent list
 */
export function addToRecent(commandId: string): void {
  // Remove if already exists
  recentCommandIds = recentCommandIds.filter((id) => id !== commandId);
  // Add to front
  recentCommandIds = [commandId, ...recentCommandIds].slice(0, MAX_RECENT_COMMANDS);
  saveRecentCommands();
}

/**
 * Get recent command IDs
 */
export function getRecentCommandIds(): string[] {
  return recentCommandIds;
}

/**
 * Register commands with the palette
 */
export function registerCommands(newCommands: Command[]): void {
  commands = newCommands;
  loadRecentCommands();
}

/**
 * Get all registered commands
 */
export function getCommands(): Command[] {
  return commands.filter((cmd) => !cmd.enabled || cmd.enabled());
}

/**
 * Get recent commands
 */
export function getRecentCommands(): CommandWithMeta[] {
  const availableCommands = getCommands();
  const recent: CommandWithMeta[] = [];

  for (const id of recentCommandIds) {
    const cmd = availableCommands.find((c) => c.id === id);
    if (cmd) {
      recent.push({ ...cmd, isRecent: true });
    }
  }

  return recent;
}

/**
 * Simple fuzzy search implementation
 * Returns a score (higher is better match), or -1 if no match
 */
function fuzzyScore(query: string, text: string): number {
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();

  // Exact match gets highest score
  if (textLower === queryLower) return 1000;

  // Starts with query gets high score
  if (textLower.startsWith(queryLower))
    return 500 + (queryLower.length / textLower.length) * 100;

  // Contains query as substring
  if (textLower.includes(queryLower))
    return 200 + (queryLower.length / textLower.length) * 100;

  // Fuzzy character matching
  let queryIndex = 0;
  let score = 0;
  let consecutiveBonus = 0;

  for (let i = 0; i < textLower.length && queryIndex < queryLower.length; i++) {
    if (textLower[i] === queryLower[queryIndex]) {
      score += 10 + consecutiveBonus;
      consecutiveBonus += 5; // Bonus for consecutive matches
      queryIndex++;
    } else {
      consecutiveBonus = 0;
    }
  }

  // All query characters must be found
  if (queryIndex < queryLower.length) return -1;

  return score;
}

/**
 * Search commands with fuzzy matching
 */
export function searchCommands(query: string): CommandWithMeta[] {
  const availableCommands = getCommands();

  if (!query.trim()) {
    // No query - show recent first, then other commands
    const recent = getRecentCommands();
    const recentIds = new Set(recent.map((c) => c.id));
    const others = availableCommands
      .filter((c) => !recentIds.has(c.id))
      .map((c) => ({ ...c, isRecent: false }));

    return [...recent, ...others];
  }

  const results: Array<{ command: CommandWithMeta; score: number }> = [];

  for (const command of availableCommands) {
    // Search in label and category
    const labelScore = fuzzyScore(query, command.label);
    const categoryScore = fuzzyScore(query, command.category);
    const combinedScore = Math.max(labelScore, categoryScore * 0.5);

    if (combinedScore > 0) {
      const isRecent = recentCommandIds.includes(command.id);
      results.push({
        command: { ...command, isRecent },
        score: combinedScore + (isRecent ? 50 : 0) // Boost recent commands
      });
    }
  }

  // Sort by score (highest first)
  results.sort((a, b) => b.score - a.score);

  return results.map((r) => r.command);
}
