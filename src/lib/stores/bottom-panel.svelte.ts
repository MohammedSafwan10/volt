/**
 * Bottom panel store for managing panel tabs and state
 * Handles Problems, Output, and Terminal views
 */

export type BottomPanelTab = 'problems' | 'output' | 'terminal';

class BottomPanelStore {
  activeTab = $state<BottomPanelTab>('terminal');

  /**
   * Set the active tab
   */
  setActiveTab(tab: BottomPanelTab): void {
    this.activeTab = tab;
  }

  /**
   * Check if a specific tab is active
   */
  isActive(tab: BottomPanelTab): boolean {
    return this.activeTab === tab;
  }
}

// Singleton instance
export const bottomPanelStore = new BottomPanelStore();
