import { describe, expect, it, vi } from 'vitest';

import { WorkspaceLifecycleManager } from './workspace-lifecycle';

describe('WorkspaceLifecycleManager', () => {
  it('runs teardown and activation hooks in registration order', async () => {
    const calls: string[] = [];
    const manager = new WorkspaceLifecycleManager();

    manager.register({
      id: 'first',
      teardown: async () => { calls.push('teardown:first'); },
      activate: async () => { calls.push('activate:first'); },
    });
    manager.register({
      id: 'second',
      teardown: async () => { calls.push('teardown:second'); },
      activate: async () => { calls.push('activate:second'); },
    });

    await manager.teardown({ previousRootPath: 'c:/old', removePersistence: false, clearFileTree: false });
    await manager.activate({ rootPath: 'c:/new' });

    expect(calls).toEqual([
      'teardown:first',
      'teardown:second',
      'activate:first',
      'activate:second',
    ]);
  });
});
