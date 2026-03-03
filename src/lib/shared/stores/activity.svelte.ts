/**
 * Activity Store
 * Tracks recently viewed and edited files to provide historical context to the AI
 */

const MAX_HISTORY = 10;
const STORAGE_KEY = 'volt.activity.history';

interface ActivityItem {
  path: string;
  type: 'view' | 'edit';
  timestamp: number;
}

class ActivityStore {
  history = $state<ActivityItem[]>([]);

  constructor() {
    this.loadHistory();
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
    this.history = [newItem, ...filtered].slice(0, MAX_HISTORY);
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
        this.history = JSON.parse(raw);
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
