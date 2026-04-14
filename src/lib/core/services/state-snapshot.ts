/**
 * State Snapshot Service
 *
 * VS Code–style state preservation across reloads (HMR + manual).
 *
 * Architecture:
 *   - Stores register as ISnapshotParticipant with getSnapshot/restoreSnapshot
 *   - Before reload: snapshot() serializes all participants to sessionStorage
 *   - After reload: restore() rehydrates stores in priority order
 *   - Terminal PTY processes survive in Tauri backend; only the frontend reconnects
 *
 * Storage: sessionStorage (ephemeral — survives reload, cleared on tab close)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ISnapshotParticipant {
  /** Return a JSON-serializable state object */
  getSnapshot(): unknown;
  /** Rehydrate state from a previously snapshotted object */
  restoreSnapshot(data: unknown): void;
  /** Lower priority restores first. Default: 10 */
  readonly snapshotPriority?: number;
}

export type ReloadReason = 'hmr' | 'manual' | 'update';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SNAPSHOT_PREFIX = 'volt.stateSnapshot.';
const RELOAD_REASON_KEY = 'volt.reloadReason';
const RELOAD_TIMESTAMP_KEY = 'volt.reloadTimestamp';
/** Snapshots older than this are considered stale and discarded */
const MAX_SNAPSHOT_AGE_MS = 30_000;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class StateSnapshotService {
  private participants = new Map<string, ISnapshotParticipant>();
  private snapshotTaken = false;

  /**
   * Register a store/service as a snapshot participant.
   * Call this during store construction.
   */
  registerParticipant(id: string, participant: ISnapshotParticipant): void {
    this.participants.set(id, participant);
  }

  /**
   * Unregister a participant (rare — only needed if a store is destroyed).
   */
  unregisterParticipant(id: string): void {
    this.participants.delete(id);
  }

  /**
   * Snapshot all registered participants to sessionStorage.
   * Call this immediately before reload.
   */
  snapshot(): void {
    if (typeof window === 'undefined') return;
    // Guard against double-snapshot (reloadWindow → beforeunload)
    if (this.snapshotTaken) return;
    this.snapshotTaken = true;

    for (const [id, participant] of this.participants) {
      try {
        const data = participant.getSnapshot();
        if (data !== undefined && data !== null) {
          sessionStorage.setItem(SNAPSHOT_PREFIX + id, JSON.stringify(data));
        }
      } catch (err) {
        console.warn(`[StateSnapshot] Failed to snapshot ${id}:`, err);
      }
    }

    sessionStorage.setItem(RELOAD_TIMESTAMP_KEY, String(Date.now()));
  }

  /**
   * Restore all registered participants from sessionStorage.
   * Participants are restored in priority order (lower number = first).
   * Returns true if any state was restored.
   */
  restore(): boolean {
    if (typeof window === 'undefined') return false;
    if (!this.isReload()) return false;

    // Check for stale snapshots
    const ts = Number(sessionStorage.getItem(RELOAD_TIMESTAMP_KEY) || '0');
    if (Date.now() - ts > MAX_SNAPSHOT_AGE_MS) {
      console.info('[StateSnapshot] Stale snapshots detected, skipping restore');
      this.clearSnapshots();
      return false;
    }

    // Sort participants by priority (lower = first)
    const sorted = [...this.participants.entries()].sort(
      ([, a], [, b]) => (a.snapshotPriority ?? 10) - (b.snapshotPriority ?? 10),
    );

    let restoredAny = false;

    for (const [id, participant] of sorted) {
      try {
        const raw = sessionStorage.getItem(SNAPSHOT_PREFIX + id);
        if (raw === null) continue;
        const data = JSON.parse(raw);
        participant.restoreSnapshot(data);
        restoredAny = true;
      } catch (err) {
        console.warn(`[StateSnapshot] Failed to restore ${id}:`, err);
      }
    }

    if (restoredAny) {
      const reason = this.getReloadReason();
      console.info(`[StateSnapshot] State restored after ${reason ?? 'unknown'} reload`);
    }

    // Clear snapshots after restore (one-shot)
    this.clearSnapshots();
    return restoredAny;
  }

  /**
   * Check if the current page load is a reload (vs. fresh open).
   */
  isReload(): boolean {
    if (typeof window === 'undefined') return false;
    return sessionStorage.getItem(RELOAD_REASON_KEY) !== null;
  }

  /**
   * Get the reason for the last reload.
   */
  getReloadReason(): ReloadReason | null {
    if (typeof window === 'undefined') return null;
    return (sessionStorage.getItem(RELOAD_REASON_KEY) as ReloadReason) ?? null;
  }

  /**
   * Set the reload reason. Call this before triggering a reload.
   */
  setReloadReason(reason: ReloadReason): void {
    if (typeof window === 'undefined') return;
    sessionStorage.setItem(RELOAD_REASON_KEY, reason);
  }

  /**
   * Clear all snapshot data from sessionStorage.
   */
  clearSnapshots(): void {
    if (typeof window === 'undefined') return;
    const keysToRemove: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(SNAPSHOT_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      sessionStorage.removeItem(key);
    }
    sessionStorage.removeItem(RELOAD_REASON_KEY);
    sessionStorage.removeItem(RELOAD_TIMESTAMP_KEY);
  }

  /**
   * Trigger a manual reload with state preservation.
   * This is the "Reload Window" command implementation.
   */
  reloadWindow(): void {
    this.setReloadReason('manual');
    this.snapshot();
    window.location.reload();
  }
}

/** Singleton instance */
export const stateSnapshotService = new StateSnapshotService();

// If this module is hot-replaced, invalidate so Vite triggers a full reload.
// A stale singleton would break the entire snapshot/restore chain.
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    import.meta.hot!.invalidate();
  });
}
