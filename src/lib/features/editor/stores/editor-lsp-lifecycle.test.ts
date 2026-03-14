import { describe, expect, it, vi } from 'vitest';

import {
  notifyEditorDidClose,
  notifyEditorDidSave,
  type EditorLifecycleTarget,
} from './editor-lsp-lifecycle';

describe('editor LSP lifecycle routing', () => {
  it('routes save notifications to matching sidecars', async () => {
    const htmlSave = vi.fn(async () => undefined);
    const cssSave = vi.fn(async () => undefined);
    const errorSpy = vi.fn();
    const targets: EditorLifecycleTarget[] = [
      { matches: (path) => path.endsWith('.html'), save: htmlSave },
      { matches: (path) => path.endsWith('.css'), save: cssSave },
    ];

    notifyEditorDidSave('c:/repo/index.html', '<div />', targets, errorSpy);
    notifyEditorDidSave('c:/repo/app.css', '.a {}', targets, errorSpy);

    await Promise.resolve();

    expect(htmlSave).toHaveBeenCalledWith('c:/repo/index.html', '<div />');
    expect(cssSave).toHaveBeenCalledWith('c:/repo/app.css', '.a {}');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('routes close notifications and surfaces async failures through handler', async () => {
    const closeSpy = vi.fn(async () => undefined);
    const failingClose = vi.fn(async () => {
      throw new Error('boom');
    });
    const errorSpy = vi.fn();
    const targets: EditorLifecycleTarget[] = [
      { matches: (path) => path.endsWith('.svelte'), close: closeSpy },
      { matches: (path) => path.endsWith('.html'), close: failingClose },
    ];

    notifyEditorDidClose('c:/repo/component.svelte', targets, errorSpy);
    notifyEditorDidClose('c:/repo/index.html', targets, errorSpy);

    await Promise.resolve();
    await Promise.resolve();

    expect(closeSpy).toHaveBeenCalledWith('c:/repo/component.svelte');
    expect(failingClose).toHaveBeenCalledWith('c:/repo/index.html');
    expect(errorSpy).toHaveBeenCalledWith('didClose c:/repo/index.html', expect.any(Error));
  });
});
