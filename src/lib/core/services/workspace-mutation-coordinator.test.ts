import { describe, expect, it, vi } from 'vitest';

vi.mock('./file-service', () => ({
  fileService: {
    read: vi.fn(),
    write: vi.fn(),
    subscribeAll: vi.fn(() => () => {}),
  },
}));

import { createStagedDocumentService } from './staged-document-service';
import type { FileBackend } from './workspace-mutation-coordinator';
import { createWorkspaceMutationCoordinator } from './workspace-mutation-coordinator';

function createFileBackend(overrides: Partial<FileBackend>): FileBackend {
  return {
    read: vi.fn().mockResolvedValue(null),
    write: vi.fn().mockResolvedValue({ success: true, newVersion: 1 }),
    ...overrides,
  };
}

describe('workspace-mutation-coordinator', () => {
  it('does not access fileService during module import for the default coordinator', async () => {
    vi.resetModules();

    vi.doMock('./file-service', () => ({
      get fileService() {
        throw new Error('fileService accessed during import');
      },
    }));

    const module = await import('./workspace-mutation-coordinator');

    expect(module.workspaceMutationCoordinator.stagedDocuments).toBeDefined();
  });

  it('stages then commits a write intent', async () => {
    const staged = createStagedDocumentService();
    const backend = createFileBackend({
      read: vi.fn().mockResolvedValue({
        path: 'src/app.ts',
        content: 'before',
        version: 1,
        diskVersion: 1,
        isDirty: false,
        lastModified: 1,
      }),
      write: vi.fn().mockResolvedValue({ success: true, newVersion: 2 }),
    });

    const coordinator = createWorkspaceMutationCoordinator({
      stagedDocuments: staged,
      fileBackend: backend,
    });

    const result = await coordinator.run({
      type: 'write',
      path: 'src/app.ts',
      content: 'after',
    });

    expect(result.success).toBe(true);
    expect(backend.read).toHaveBeenCalledWith('src/app.ts', true);
    expect(backend.write).toHaveBeenCalledWith('src/app.ts', 'after', {
      expectedVersion: 1,
      createIfMissing: false,
      source: 'ai',
    });
    expect(staged.get('src/app.ts')).toMatchObject({
      state: 'committed',
      phase: 'finalize',
      committedContent: 'after',
      stagedContent: 'after',
      version: 2,
      diagnosticsBasis: 'committed_disk',
      diagnosticsFreshness: 'fresh',
      beforeState: {
        path: 'src/app.ts',
        kind: 'file',
        exists: true,
        content: 'before',
        version: 1,
      },
      afterState: {
        path: 'src/app.ts',
        kind: 'file',
        exists: true,
        content: 'after',
        version: 2,
      },
    });
  });

  it('records the prepare phase before commit for write intents', async () => {
    const staged = createStagedDocumentService();
    const backend = createFileBackend({
      read: vi.fn().mockResolvedValue({
        path: 'src/app.ts',
        content: 'before',
        version: 1,
        diskVersion: 1,
        isDirty: false,
        lastModified: 1,
      }),
      write: vi.fn().mockImplementation(async () => {
        expect(staged.selectors.mutationPhase('src/app.ts')).toBe('commit');
        return { success: true, newVersion: 2 };
      }),
    });
    const phaseListener = vi.fn();

    staged.subscribe(phaseListener, {
      selector: (records) => records.find((record) => record.path === 'src/app.ts')?.phase ?? null,
      emitImmediately: false,
    });

    const coordinator = createWorkspaceMutationCoordinator({
      stagedDocuments: staged,
      fileBackend: backend,
    });

    await coordinator.run({
      type: 'write',
      path: 'src/app.ts',
      content: 'after',
    });

    expect(phaseListener).toHaveBeenCalledWith('prepare');
    expect(phaseListener).toHaveBeenCalledWith('commit');
  });

  it('runs projection hooks for create-if-missing writes before finalize', async () => {
    const staged = createStagedDocumentService();
    const backend = createFileBackend({
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockResolvedValue({ success: true, newVersion: 1 }),
    });
    const refreshTree = vi.fn().mockResolvedValue(undefined);
    const syncContentMutation = vi.fn().mockImplementation(async () => {
      expect(staged.selectors.mutationPhase('src/new.ts')).toBe('project');
    });

    const coordinator = createWorkspaceMutationCoordinator({
      stagedDocuments: staged,
      fileBackend: backend,
      projections: {
        refreshTree,
        syncContentMutation,
      },
    });

    const result = await coordinator.run({
      type: 'write',
      path: 'src/new.ts',
      content: 'after',
      createIfMissing: true,
      relativePath: 'src/new.ts',
      sync: {
        normalizedPath: 'src/new.ts',
        firstChangedLine: 2,
        lastChangedLine: 4,
      },
    });

    expect(result.success).toBe(true);
    expect(refreshTree).toHaveBeenCalledTimes(1);
    expect(syncContentMutation).toHaveBeenCalledWith('src/new.ts', 'after', {
      normalizedPath: 'src/new.ts',
      relativePath: 'src/new.ts',
      firstChangedLine: 2,
      lastChangedLine: 4,
    });
    expect(staged.get('src/new.ts')).toMatchObject({
      state: 'committed',
      phase: 'finalize',
    });
  });

  it('fails write intents when projection hooks fail', async () => {
    const staged = createStagedDocumentService();
    const backend = createFileBackend({
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockResolvedValue({ success: true, newVersion: 1 }),
    });

    const coordinator = createWorkspaceMutationCoordinator({
      stagedDocuments: staged,
      fileBackend: backend,
      projections: {
        refreshTree: vi.fn().mockRejectedValue(new Error('tree refresh failed')),
      },
    });

    const result = await coordinator.run({
      type: 'write',
      path: 'src/new.ts',
      content: 'after',
      createIfMissing: true,
      sync: {
        normalizedPath: 'src/new.ts',
      },
    });

    expect(result).toEqual({
      success: false,
      error: 'tree refresh failed',
    });
    expect(staged.get('src/new.ts')).toMatchObject({
      state: 'failed',
      phase: 'finalize',
      error: 'tree refresh failed',
      failure: {
        kind: 'projection',
        message: 'tree refresh failed',
        phase: 'project',
      },
    });
  });

  it('retains failed state when backend write fails', async () => {
    const staged = createStagedDocumentService();
    const backend = createFileBackend({
      read: vi.fn().mockResolvedValue({
        path: 'src/app.ts',
        content: 'before',
        version: 1,
        diskVersion: 1,
        isDirty: false,
        lastModified: 1,
      }),
      write: vi.fn().mockResolvedValue({ success: false, error: 'permission denied' }),
    });

    const coordinator = createWorkspaceMutationCoordinator({
      stagedDocuments: staged,
      fileBackend: backend,
    });

    const result = await coordinator.run({
      type: 'write',
      path: 'src/app.ts',
      content: 'after',
    });

    expect(result).toEqual({
      success: false,
      error: 'permission denied',
    });
    expect(staged.get('src/app.ts')).toMatchObject({
      state: 'failed',
      phase: 'finalize',
      error: 'permission denied',
      diagnosticsFreshness: 'stale',
      failure: {
        kind: 'commit',
        message: 'permission denied',
        phase: 'commit',
      },
    });
  });

  it('stages structural delete intents', async () => {
    const staged = createStagedDocumentService();
    const backend = createFileBackend({
      read: vi.fn().mockResolvedValue({
        path: 'src/old.ts',
        content: 'legacy',
        version: 4,
        diskVersion: 4,
        isDirty: false,
        lastModified: 1,
      }),
      deletePath: vi.fn().mockResolvedValue({ success: true }),
    });

    const coordinator = createWorkspaceMutationCoordinator({
      stagedDocuments: staged,
      fileBackend: backend,
    });

    const result = await coordinator.run({
      type: 'delete',
      path: 'src/old.ts',
    });

    expect(result.success).toBe(true);
    expect(backend.deletePath).toHaveBeenCalledWith('src/old.ts');
    expect(staged.get('src/old.ts')).toMatchObject({
      state: 'committed',
      phase: 'finalize',
      committedContent: null,
      stagedContent: null,
      structuralMutation: {
        kind: 'delete',
        previousPath: 'src/old.ts',
      },
      beforeState: {
        path: 'src/old.ts',
        kind: 'file',
        exists: true,
        content: 'legacy',
        version: 4,
      },
      afterState: {
        path: 'src/old.ts',
        kind: 'file',
        exists: false,
        content: null,
        version: 4,
      },
    });
  });

  it('fails delete preflight when target is missing', async () => {
    const staged = createStagedDocumentService();
    const backend = createFileBackend({
      read: vi.fn().mockResolvedValue(null),
      deletePath: vi.fn(),
    });

    const coordinator = createWorkspaceMutationCoordinator({
      stagedDocuments: staged,
      fileBackend: backend,
    });

    const result = await coordinator.run({
      type: 'delete',
      path: 'src/missing.ts',
    });

    expect(result).toEqual({
      success: false,
      error: 'delete target missing',
    });
    expect(backend.deletePath).not.toHaveBeenCalled();
    expect(staged.get('src/missing.ts')).toMatchObject({
      state: 'failed',
      phase: 'finalize',
      error: 'delete target missing',
      failure: {
        kind: 'preflight',
        message: 'delete target missing',
        phase: 'prepare',
      },
    });
  });

  it('stages structural create_dir intents', async () => {
    const staged = createStagedDocumentService();
    const backend = createFileBackend({
      createDir: vi.fn().mockResolvedValue({ success: true }),
    });

    const coordinator = createWorkspaceMutationCoordinator({
      stagedDocuments: staged,
      fileBackend: backend,
    });

    const result = await coordinator.run({
      type: 'create_dir',
      path: 'src/new-dir',
    });

    expect(result.success).toBe(true);
    expect(backend.createDir).toHaveBeenCalledWith('src/new-dir');
    expect(staged.get('src/new-dir')).toMatchObject({
      kind: 'directory',
      state: 'committed',
      structuralMutation: {
        kind: 'create',
        nextPath: 'src/new-dir',
      },
      afterState: {
        path: 'src/new-dir',
        kind: 'directory',
        exists: true,
      },
    });
  });

  it('fails create_dir when backend support is unavailable', async () => {
    const staged = createStagedDocumentService();
    const backend = createFileBackend({
      read: vi.fn(),
      write: vi.fn(),
    });

    const coordinator = createWorkspaceMutationCoordinator({
      stagedDocuments: staged,
      fileBackend: backend,
    });

    const result = await coordinator.run({
      type: 'create_dir',
      path: 'src/unsupported-dir',
    });

    expect(result).toEqual({
      success: false,
      error: 'create_dir is not supported by the current backend',
    });
    expect(staged.get('src/unsupported-dir')).toMatchObject({
      state: 'failed',
      phase: 'finalize',
      error: 'create_dir is not supported by the current backend',
      failure: {
        kind: 'preflight',
        message: 'create_dir is not supported by the current backend',
        phase: 'prepare',
      },
    });
  });

  it('stages structural rename intents', async () => {
    const staged = createStagedDocumentService();
    const backend = createFileBackend({
      read: vi
        .fn()
        .mockResolvedValueOnce({
          path: 'src/old-name.ts',
          content: 'legacy',
          version: 5,
          diskVersion: 5,
          isDirty: false,
          lastModified: 1,
        })
        .mockResolvedValueOnce(null),
      renamePath: vi.fn().mockResolvedValue({ success: true }),
    });

    const coordinator = createWorkspaceMutationCoordinator({
      stagedDocuments: staged,
      fileBackend: backend,
    });

    const result = await coordinator.run({
      type: 'rename',
      oldPath: 'src/old-name.ts',
      newPath: 'src/new-name.ts',
    });

    expect(result.success).toBe(true);
    expect(backend.renamePath).toHaveBeenCalledWith('src/old-name.ts', 'src/new-name.ts');
    expect(staged.get('src/new-name.ts')).toMatchObject({
      path: 'src/new-name.ts',
      state: 'committed',
      phase: 'finalize',
      previousPath: 'src/old-name.ts',
      nextPath: 'src/new-name.ts',
      structuralMutation: {
        kind: 'rename',
        previousPath: 'src/old-name.ts',
        nextPath: 'src/new-name.ts',
      },
      beforeState: {
        path: 'src/old-name.ts',
        kind: 'file',
        exists: true,
        content: 'legacy',
        version: 5,
      },
      afterState: {
        path: 'src/new-name.ts',
        kind: 'file',
        exists: true,
        content: 'legacy',
        version: 5,
      },
    });
  });

  it('fails rename when backend support is unavailable', async () => {
    const staged = createStagedDocumentService();
    const backend = createFileBackend({
      read: vi.fn(),
      write: vi.fn(),
    });

    const coordinator = createWorkspaceMutationCoordinator({
      stagedDocuments: staged,
      fileBackend: backend,
    });

    const result = await coordinator.run({
      type: 'rename',
      oldPath: 'src/old-name.ts',
      newPath: 'src/new-name.ts',
    });

    expect(result).toEqual({
      success: false,
      error: 'rename is not supported by the current backend',
    });
    expect(staged.get('src/new-name.ts')).toMatchObject({
      state: 'failed',
      phase: 'finalize',
      previousPath: 'src/old-name.ts',
      nextPath: 'src/new-name.ts',
      error: 'rename is not supported by the current backend',
      failure: {
        kind: 'preflight',
        message: 'rename is not supported by the current backend',
        phase: 'prepare',
      },
    });
  });

  it('fails rename preflight when target already exists', async () => {
    const staged = createStagedDocumentService();
    const backend = createFileBackend({
      read: vi
        .fn()
        .mockResolvedValueOnce({
          path: 'src/old-name.ts',
          content: 'legacy',
          version: 5,
          diskVersion: 5,
          isDirty: false,
          lastModified: 1,
        })
        .mockResolvedValueOnce({
          path: 'src/new-name.ts',
          content: 'occupied',
          version: 6,
          diskVersion: 6,
          isDirty: false,
          lastModified: 1,
        }),
      renamePath: vi.fn(),
    });

    const coordinator = createWorkspaceMutationCoordinator({
      stagedDocuments: staged,
      fileBackend: backend,
    });

    const result = await coordinator.run({
      type: 'rename',
      oldPath: 'src/old-name.ts',
      newPath: 'src/new-name.ts',
    });

    expect(result).toEqual({
      success: false,
      error: 'rename target already exists',
    });
    expect(backend.renamePath).not.toHaveBeenCalled();
    expect(staged.get('src/new-name.ts')).toMatchObject({
      state: 'failed',
      phase: 'finalize',
      error: 'rename target already exists',
      failure: {
        kind: 'preflight',
        message: 'rename target already exists',
        phase: 'prepare',
      },
      previousPath: 'src/old-name.ts',
      nextPath: 'src/new-name.ts',
    });
  });

  it('fails rename preflight when source is missing', async () => {
    const staged = createStagedDocumentService();
    const backend = createFileBackend({
      read: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null),
      renamePath: vi.fn(),
    });

    const coordinator = createWorkspaceMutationCoordinator({
      stagedDocuments: staged,
      fileBackend: backend,
    });

    const result = await coordinator.run({
      type: 'rename',
      oldPath: 'src/missing-name.ts',
      newPath: 'src/new-name.ts',
    });

    expect(result).toEqual({
      success: false,
      error: 'rename source missing',
    });
    expect(backend.renamePath).not.toHaveBeenCalled();
    expect(staged.get('src/new-name.ts')).toMatchObject({
      state: 'failed',
      phase: 'finalize',
      error: 'rename source missing',
      failure: {
        kind: 'preflight',
        message: 'rename source missing',
        phase: 'prepare',
      },
      previousPath: 'src/missing-name.ts',
      nextPath: 'src/new-name.ts',
      beforeState: {
        path: 'src/missing-name.ts',
        kind: 'file',
        exists: false,
      },
      afterState: {
        path: 'src/new-name.ts',
        kind: 'file',
        exists: false,
      },
    });
  });

  it('returns the finalized record for successful write intents', async () => {
    const staged = createStagedDocumentService();
    const backend = createFileBackend({
      read: vi.fn().mockResolvedValue({
        path: 'src/app.ts',
        content: 'before',
        version: 1,
        diskVersion: 1,
        isDirty: false,
        lastModified: 1,
      }),
      write: vi.fn().mockResolvedValue({ success: true, newVersion: 2 }),
    });

    const coordinator = createWorkspaceMutationCoordinator({
      stagedDocuments: staged,
      fileBackend: backend,
    });

    const result = await coordinator.run({
      type: 'write',
      path: 'src/app.ts',
      content: 'after',
      createIfMissing: true,
    });

    expect(result).toMatchObject({
      success: true,
      record: {
        path: 'src/app.ts',
        state: 'committed',
        committedContent: 'after',
        stagedContent: 'after',
        version: 2,
      },
    });
  });
});
