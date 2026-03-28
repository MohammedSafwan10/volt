import { describe, expect, it } from 'vitest';

import {
  projectDiagnosticsState,
  projectTreeMutationState,
} from './staged-document-projections';
import {
  createStagedDocumentService,
  type DiagnosticsBasis,
  type DiagnosticsFreshness,
  type MutationPhase,
  type StagedResourceState,
} from './staged-document-service';

describe('staged-document-service', () => {
  it('tracks staged_modified to committed transitions for file content', () => {
    const service = createStagedDocumentService();

    service.stage({
      path: 'src/app.ts',
      kind: 'file',
      state: 'staged_modified',
      phase: 'stage',
      committedContent: 'before',
      stagedContent: 'after',
      version: 3,
    });

    service.finalizeSuccess('src/app.ts', {
      committedContent: 'after',
      version: 4,
    });

    expect(service.get('src/app.ts')).toMatchObject({
      state: 'committed' satisfies StagedResourceState,
      phase: 'finalize' satisfies MutationPhase,
      committedContent: 'after',
      stagedContent: 'after',
      version: 4,
    });
  });

  it('retains failure metadata when a staged mutation fails', () => {
    const service = createStagedDocumentService();

    service.stage({
      path: 'src/app.ts',
      kind: 'file',
      state: 'staged_modified',
      phase: 'commit',
      committedContent: 'before',
      stagedContent: 'after',
      version: 3,
    });

    service.finalizeFailure('src/app.ts', {
      kind: 'commit',
      message: 'disk write failed',
      phase: 'commit',
      code: 'EACCES',
      retryable: false,
      details: {
        operation: 'write',
      },
    });

    expect(service.get('src/app.ts')).toMatchObject({
      state: 'failed',
      phase: 'finalize',
      error: 'disk write failed',
      failure: {
        kind: 'commit',
        message: 'disk write failed',
        phase: 'commit',
        code: 'EACCES',
        retryable: false,
        details: {
          operation: 'write',
        },
      },
      committedContent: 'before',
      stagedContent: 'after',
    });
  });

  it('supports structural staged_delete state', () => {
    const service = createStagedDocumentService();

    service.stage({
      path: 'src/obsolete.ts',
      kind: 'file',
      state: 'staged_delete',
      phase: 'stage',
      committedContent: 'legacy',
      stagedContent: null,
      version: 5,
    });

    expect(service.get('src/obsolete.ts')).toMatchObject({
      state: 'staged_delete',
      committedContent: 'legacy',
      stagedContent: null,
    });
  });

  it('supports selector subscriptions for consumers', () => {
    const service = createStagedDocumentService();
    const selected: number[] = [];

    const unsubscribe = service.subscribe(
      (count: number) => {
        selected.push(count);
      },
      {
        selector: (records) =>
          records.filter((record) => record.state === 'staged_modified').length,
        equality: (left, right) => left === right,
      },
    );

    service.stage({
      path: 'src/a.ts',
      kind: 'file',
      state: 'staged_modified',
      phase: 'stage',
      committedContent: 'before',
      stagedContent: 'after',
    });
    service.stage({
      path: 'src/b.ts',
      kind: 'file',
      state: 'staged_modified',
      phase: 'stage',
      committedContent: 'before',
      stagedContent: 'after',
    });

    unsubscribe();
    service.clear('src/b.ts');

    expect(selected).toEqual([0, 1, 2]);
    expect(service.selectors.byPath('src/a.ts')?.state).toBe('staged_modified');
  });

  it('makes diagnostics basis and freshness transitions explicit', () => {
    const service = createStagedDocumentService();

    service.stage({
      path: 'src/diag.ts',
      kind: 'file',
      state: 'staged_modified',
      phase: 'stage',
      committedContent: 'before',
      stagedContent: 'after',
      diagnosticsBasis: 'staged_tool_output',
      diagnosticsFreshness: 'pending',
    });
    service.setPhase('src/diag.ts', 'project');
    service.updateDiagnostics('src/diag.ts', {
      basis: 'editor_buffer',
      freshness: 'fresh',
    });

    expect(service.selectors.mutationPhase('src/diag.ts')).toBe('project');
    expect(service.selectors.diagnostics('src/diag.ts')).toEqual({
      basis: 'editor_buffer' satisfies DiagnosticsBasis,
      freshness: 'fresh' satisfies DiagnosticsFreshness,
    });

    service.finalizeFailure('src/diag.ts', 'projection lag');

    expect(service.selectors.diagnostics('src/diag.ts')).toEqual({
      basis: 'editor_buffer',
      freshness: 'stale',
    });
  });

  it('preserves before and after metadata across success finalization', () => {
    const service = createStagedDocumentService();

    service.stage({
      path: 'src/meta.ts',
      kind: 'file',
      state: 'staged_modified',
      phase: 'commit',
      committedContent: 'before',
      stagedContent: 'after',
      beforeState: {
        path: 'src/meta.ts',
        kind: 'file',
        exists: true,
        content: 'before',
        version: 1,
      },
      afterState: {
        path: 'src/meta.ts',
        kind: 'file',
        exists: true,
        content: 'after',
        version: 2,
      },
      meta: {
        beforeContent: 'before',
        afterContent: 'after',
      },
    });

    service.finalizeSuccess('src/meta.ts', {
      committedContent: 'after',
    });

    expect(service.get('src/meta.ts')).toMatchObject({
      committedContent: 'after',
      stagedContent: 'after',
      beforeState: {
        path: 'src/meta.ts',
        kind: 'file',
        exists: true,
        content: 'before',
        version: 1,
      },
      afterState: {
        path: 'src/meta.ts',
        kind: 'file',
        exists: true,
        content: 'after',
        version: 2,
      },
      meta: {
        beforeContent: 'before',
        afterContent: 'after',
      },
    });
  });

  it('supports structural resources including staged_new directories and rename metadata', () => {
    const service = createStagedDocumentService();

    service.stageStructuralMutation({
      path: 'src/new-dir',
      kind: 'directory',
      mutation: {
        kind: 'create',
        nextPath: 'src/new-dir',
      },
      afterState: {
        path: 'src/new-dir',
        kind: 'directory',
        exists: true,
      },
      meta: {
        operation: 'create_dir',
      },
    });
    service.stageStructuralMutation({
      path: 'src/original.ts',
      kind: 'file',
      mutation: {
        kind: 'rename',
        previousPath: 'src/original.ts',
        nextPath: 'src/renamed.ts',
      },
      beforeState: {
        path: 'src/original.ts',
        kind: 'file',
        exists: true,
        content: 'original',
        version: 1,
      },
      afterState: {
        path: 'src/renamed.ts',
        kind: 'file',
        exists: true,
        content: 'renamed',
        version: 2,
      },
      meta: {
        operation: 'rename',
      },
    });

    expect(service.selectors.structural()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'src/new-dir',
          kind: 'directory',
          state: 'staged_new',
          nextPath: 'src/new-dir',
            structuralMutation: {
              kind: 'create',
              nextPath: 'src/new-dir',
            },
        }),
        expect.objectContaining({
          path: 'src/renamed.ts',
          previousPath: 'src/original.ts',
          nextPath: 'src/renamed.ts',
          structuralMutation: {
            kind: 'rename',
            previousPath: 'src/original.ts',
            nextPath: 'src/renamed.ts',
          },
          meta: {
            operation: 'rename',
          },
        }),
      ]),
    );
  });

  it('models structural deletes as first-class staged mutations', () => {
    const service = createStagedDocumentService();

    service.stageStructuralMutation({
      path: 'src/remove.ts',
      kind: 'file',
      mutation: {
        kind: 'delete',
        previousPath: 'src/remove.ts',
      },
      beforeState: {
        path: 'src/remove.ts',
        kind: 'file',
        exists: true,
        content: 'legacy',
        version: 7,
      },
      afterState: {
        path: 'src/remove.ts',
        kind: 'file',
        exists: false,
        content: null,
        version: 7,
      },
    });

    expect(service.get('src/remove.ts')).toMatchObject({
      state: 'staged_delete',
      structuralMutation: {
        kind: 'delete',
        previousPath: 'src/remove.ts',
      },
      beforeState: {
        path: 'src/remove.ts',
        exists: true,
      },
      afterState: {
        path: 'src/remove.ts',
        exists: false,
      },
    });
  });

  it('models mutation phases through the full lifecycle', () => {
    const service = createStagedDocumentService();

    service.stage({
      path: 'src/lifecycle.ts',
      kind: 'file',
      state: 'staged_modified',
      phase: 'prepare',
      committedContent: 'before',
      stagedContent: 'after',
    });
    service.setPhase('src/lifecycle.ts', 'stage');
    service.setPhase('src/lifecycle.ts', 'commit');
    service.setPhase('src/lifecycle.ts', 'project');
    service.finalizeSuccess('src/lifecycle.ts', {
      committedContent: 'after',
      diagnosticsBasis: 'committed_disk',
      diagnosticsFreshness: 'fresh',
    });

    expect(service.get('src/lifecycle.ts')).toMatchObject({
      state: 'committed',
      phase: 'finalize',
      committedContent: 'after',
      stagedContent: 'after',
      diagnosticsBasis: 'committed_disk',
      diagnosticsFreshness: 'fresh',
    });
  });
});

describe('staged-document-projections', () => {
  it('projects staged_modified files into tree overlay state', () => {
    const result = projectTreeMutationState([
      {
        path: 'src/app.ts',
        kind: 'file',
        state: 'staged_modified',
        phase: 'project',
      },
    ]);

    expect(result['src/app.ts']).toMatchObject({
      state: 'staged_modified',
      kind: 'file',
    });
  });

  it('throws when tree overlay projection receives duplicate paths', () => {
    expect(() =>
      projectTreeMutationState([
        {
          path: 'src/app.ts',
          kind: 'file',
          state: 'staged_modified',
          phase: 'project',
        },
        {
          path: 'src/app.ts',
          kind: 'file',
          state: 'committed',
          phase: 'finalize',
        },
      ]),
    ).toThrowError('projectTreeMutationState received duplicate record paths: src/app.ts');
  });


  it('projects staged_modified into tree overlay while diagnostics stay pending', () => {
    const service = createStagedDocumentService();

    service.stage({
      path: 'src/pending.ts',
      kind: 'file',
      state: 'staged_modified',
      phase: 'project',
      diagnosticsBasis: 'staged_tool_output',
      diagnosticsFreshness: 'pending',
    });

    const overlay = projectTreeMutationState(service.list());
    const diagnostics = projectDiagnosticsState(service.get('src/pending.ts'));

    expect(overlay['src/pending.ts']).toMatchObject({
      kind: 'file',
      state: 'staged_modified',
    });
    expect(diagnostics).toEqual({
      basis: 'staged_tool_output',
      freshness: 'pending',
    });
  });

  it('does not present failed mutation as committed', () => {
    const service = createStagedDocumentService();

    service.stage({
      path: 'src/failure.ts',
      kind: 'file',
      state: 'staged_modified',
      phase: 'commit',
      committedContent: 'before',
      stagedContent: 'after',
    });
    service.finalizeFailure('src/failure.ts', 'boom');

    expect(projectTreeMutationState(service.list())['src/failure.ts']).toMatchObject({
      state: 'failed',
    });
    expect(service.get('src/failure.ts')).toMatchObject({
      state: 'failed',
      committedContent: 'before',
    });
  });

  it('projects explicit diagnostics basis and freshness', () => {
    const result = projectDiagnosticsState({
      path: 'src/app.ts',
      kind: 'file',
      state: 'failed',
      phase: 'finalize',
      diagnosticsBasis: 'staged_tool_output',
      diagnosticsFreshness: 'pending',
    });

    expect(result).toEqual({
      basis: 'staged_tool_output',
      freshness: 'pending',
    });
  });
});
