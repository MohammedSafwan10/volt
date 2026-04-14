/**
 * Bottom panel store for managing panel tabs and state
 * Handles Problems, Output, and Terminal views
 */

import { stateSnapshotService, type ISnapshotParticipant } from '$core/services/state-snapshot';

export type BottomPanelTab = 'problems' | 'output' | 'terminal' | 'lsp';

interface BottomPanelSnapshot {
  activeTab: BottomPanelTab;
}

class BottomPanelStore implements ISnapshotParticipant {
  activeTab = $state<BottomPanelTab>('terminal');

  readonly snapshotPriority = 0;

  getSnapshot(): BottomPanelSnapshot {
    return { activeTab: this.activeTab };
  }

  restoreSnapshot(data: unknown): void {
    const snap = data as BottomPanelSnapshot;
    if (snap?.activeTab) this.activeTab = snap.activeTab;
  }

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
stateSnapshotService.registerParticipant('bottomPanel', bottomPanelStore);
