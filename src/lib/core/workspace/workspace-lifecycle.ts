import { invoke } from '@tauri-apps/api/core';

export interface WorkspaceActivationContext {
  rootPath: string;
  previousRootPath: string | null;
  reuseExistingWorkspace?: boolean;
}

export interface WorkspaceTeardownContext {
  previousRootPath: string | null;
  removePersistence: boolean;
  clearFileTree: boolean;
  preserveVisualState?: boolean;
}

export interface WorkspaceServiceHooks {
  id: string;
  teardown?: (context: WorkspaceTeardownContext) => Promise<void> | void;
  activate?: (context: WorkspaceActivationContext) => Promise<void> | void;
}

export interface WorkspaceState {
  activeRootPath: string | null;
  persistedRootPath?: string | null;
  recentProjects: string[];
}

export interface WorkspaceOpenResult {
  opened: boolean;
  activeRootPath: string | null;
  previousRootPath: string | null;
  unchanged: boolean;
  recentProjects: string[];
  message: string | null;
}

export interface WorkspaceCloseResult {
  closed: boolean;
  activeRootPath: string | null;
  previousRootPath: string | null;
  recentProjects: string[];
}

export interface WorkspaceRefreshResult {
  refreshed: boolean;
  activeRootPath: string | null;
  recentProjects: string[];
  message: string | null;
}

export class WorkspaceLifecycleManager {
  private hooks: WorkspaceServiceHooks[] = [];
  private lastState: WorkspaceState | null = null;

  register(hooks: WorkspaceServiceHooks): void {
    this.hooks.push(hooks);
  }

  async getState(): Promise<WorkspaceState> {
    const state = await invoke<WorkspaceState>('workspace_get_state');
    this.lastState = state;
    return state;
  }

  getPersistedRootPath(): string | null {
    return this.lastState?.persistedRootPath ?? null;
  }

  async open(rootPath: string, currentRootPath: string | null): Promise<WorkspaceOpenResult> {
    const result = await invoke<WorkspaceOpenResult>('workspace_open', {
      request: {
        path: rootPath,
        currentRootPath,
      },
    });
    this.lastState = {
      activeRootPath: result.activeRootPath,
      persistedRootPath: result.opened ? result.activeRootPath : this.lastState?.persistedRootPath ?? null,
      recentProjects: result.recentProjects,
    };
    return result;
  }

  async refresh(currentRootPath: string | null): Promise<WorkspaceRefreshResult> {
    const result = await invoke<WorkspaceRefreshResult>('workspace_refresh', {
      request: {
        currentRootPath,
      },
    });
    this.lastState = {
      activeRootPath: result.activeRootPath,
      persistedRootPath: result.activeRootPath ?? this.lastState?.persistedRootPath ?? null,
      recentProjects: result.recentProjects,
    };
    return result;
  }

  async clearPersistedRootPath(): Promise<void> {
    await invoke<WorkspaceCloseResult>('workspace_close', {
      request: {
        currentRootPath: null,
        removePersistence: true,
      },
    });
    this.lastState = {
      activeRootPath: null,
      persistedRootPath: null,
      recentProjects: this.lastState?.recentProjects ?? [],
    };
  }

  async teardown(context: WorkspaceTeardownContext): Promise<WorkspaceCloseResult> {
    for (const hooks of this.hooks) {
      if (!hooks.teardown) continue;
      await hooks.teardown(context);
    }

    const result = await invoke<WorkspaceCloseResult>('workspace_close', {
      request: {
        currentRootPath: context.previousRootPath,
        removePersistence: context.removePersistence,
      },
    });
    this.lastState = {
      activeRootPath: result.activeRootPath,
      persistedRootPath: context.removePersistence ? null : this.lastState?.persistedRootPath ?? null,
      recentProjects: result.recentProjects,
    };
    return result;
  }

  async activate(context: WorkspaceActivationContext): Promise<void> {
    for (const hooks of this.hooks) {
      if (!hooks.activate) continue;
      await hooks.activate(context);
    }
  }
}
