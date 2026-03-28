import { describe, expect, it } from 'vitest';

import { getFilePillPresentation } from './file-edit-card-presentation';

describe('file-edit card presentation', () => {
  it('keeps the file-specific icon while a file edit is still running', () => {
    const presentation = getFilePillPresentation({
      toolName: 'write_file',
      path: 'src/routes/+page.svelte',
      isRunning: true,
    });

    expect(presentation.filename).toBe('+page.svelte');
    expect(presentation.icon).toBe('svelte');
    expect(presentation.animateIcon).toBe(true);
    expect(presentation.showFilename).toBe(true);
  });

  it('uses folder icon semantics for create_dir while running', () => {
    const presentation = getFilePillPresentation({
      toolName: 'create_dir',
      path: 'src/lib/new-folder',
      isRunning: true,
    });

    expect(presentation.filename).toBe('new-folder');
    expect(presentation.icon).toBe('folder');
    expect(presentation.animateIcon).toBe(true);
  });
});
