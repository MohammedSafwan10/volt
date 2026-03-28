/**
 * Activity Store
 * Tracks recently viewed and edited files to provide historical context to the AI
 */

import { writable, type Writable } from 'svelte/store';

const MAX_HISTORY = 10;
const STORAGE_KEY = 'volt.activity.history';

interface ActivityItem {
  path: string;
  type: 'view' | 'edit';
  timestamp: number;
}

class ActivityStore {
  private readonly historyStore: Writable<ActivityItem[]>;
  history: ActivityItem[] = [];

  constructor() {
    this.historyStore = writable<ActivityItem[]>([]);
    this.historyStore.subscribe((value) => {
      this.history = value;
    });
    this.loadHistory();
  }

  private setHistory(next: ActivityItem[]): void {
    this.history = next;
    this.historyStore.set(next);
  }

  /**
   * Record a file view or edit
   */
  recordActivity(path: string, type: 'view' | 'edit'): void {
    const newItem: ActivityItem = {
      path,
      type,
      timestamp: Date.now()
    };

    // Remove existing entry for this path to move it to the top
    const filtered = this.history.filter(item => item.path !== path);
    
    // Add to top and trim
    this.setHistory([newItem, ...filtered].slice(0, MAX_HISTORY));
    this.saveHistory();
  }

  /**
   * Get recently active file paths (unique)
   */
  get recentPaths(): string[] {
    return [...new Set(this.history.map(item => item.path))];
  }

  private loadHistory(): void {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        this.setHistory(JSON.parse(raw));
      }
    } catch {
      // Ignore parse errors
    }
  }

  private saveHistory(): void {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.history));
    } catch {
      // Ignore storage errors
    }
  }
}

export const activityStore = new ActivityStore();
