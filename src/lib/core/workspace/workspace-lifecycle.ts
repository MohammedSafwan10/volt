export interface WorkspaceActivationContext {
  rootPath: string;
}

export interface WorkspaceTeardownContext {
  previousRootPath: string | null;
  removePersistence: boolean;
  clearFileTree: boolean;
}

export interface WorkspaceServiceHooks {
  id: string;
  teardown?: (context: WorkspaceTeardownContext) => Promise<void> | void;
  activate?: (context: WorkspaceActivationContext) => Promise<void> | void;
}

export class WorkspaceLifecycleManager {
  private hooks: WorkspaceServiceHooks[] = [];

  register(hooks: WorkspaceServiceHooks): void {
    this.hooks.push(hooks);
  }

  async teardown(context: WorkspaceTeardownContext): Promise<void> {
    for (const hooks of this.hooks) {
      if (!hooks.teardown) continue;
      await hooks.teardown(context);
    }
  }

  async activate(context: WorkspaceActivationContext): Promise<void> {
    for (const hooks of this.hooks) {
      if (!hooks.activate) continue;
      await hooks.activate(context);
    }
  }
}
