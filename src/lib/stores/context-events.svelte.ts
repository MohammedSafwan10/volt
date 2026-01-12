/**
 * Context Events Store
 * Tracks real-time context gathering activities for UI display
 */

export interface ContextActivity {
  id: string;
  type: 'search' | 'read' | 'analyze' | 'index';
  message: string;
  status: 'active' | 'done';
  timestamp: number;
}

export interface ContextStats {
  filesFound: number;
  symbolsIndexed: number;
  budgetUsed: number;
}

class ContextEventsStore {
  activities = $state<ContextActivity[]>([]);
  isGathering = $state(false);
  stats = $state<ContextStats>({ filesFound: 0, symbolsIndexed: 0, budgetUsed: 0 });

  private idCounter = 0;

  /** Start a new context gathering session */
  startGathering() {
    this.activities = [];
    this.isGathering = true;
    this.stats = { filesFound: 0, symbolsIndexed: 0, budgetUsed: 0 };
  }

  /** End the context gathering session */
  endGathering(finalStats: ContextStats) {
    this.isGathering = false;
    this.stats = finalStats;
    // Mark all active items as done
    this.activities = this.activities.map(a => ({ ...a, status: 'done' as const }));
  }

  /** Add a new activity */
  addActivity(type: ContextActivity['type'], message: string): string {
    const id = `ctx-${++this.idCounter}`;
    const activity: ContextActivity = {
      id,
      type,
      message,
      status: 'active',
      timestamp: Date.now(),
    };
    this.activities = [...this.activities, activity];
    return id;
  }

  /** Mark an activity as done */
  completeActivity(id: string) {
    this.activities = this.activities.map(a =>
      a.id === id ? { ...a, status: 'done' as const } : a
    );
  }

  /** Update stats during gathering */
  updateStats(partial: Partial<ContextStats>) {
    this.stats = { ...this.stats, ...partial };
  }

  /** Clear all activities */
  clear() {
    this.activities = [];
    this.isGathering = false;
    this.stats = { filesFound: 0, symbolsIndexed: 0, budgetUsed: 0 };
  }

  // Convenience methods for common activities
  searchingWorkspace(query: string): string {
    return this.addActivity('search', `Searching for "${query}"`);
  }

  analyzingIntent(intentType: string): string {
    return this.addActivity('analyze', `Detected intent: ${intentType}`);
  }

  readingFile(filename: string): string {
    return this.addActivity('read', `Reading ${filename}`);
  }

  indexingSymbols(count: number): string {
    return this.addActivity('index', `Found ${count} symbols`);
  }

  foundRelevantFile(filename: string, reason: string): string {
    return this.addActivity('search', `${filename} - ${reason}`);
  }

  analyzingImports(filename: string): string {
    return this.addActivity('analyze', `Analyzing imports in ${filename}`);
  }
}

export const contextEventsStore = new ContextEventsStore();
