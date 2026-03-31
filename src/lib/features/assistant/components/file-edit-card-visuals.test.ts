import { describe, expect, it } from 'vitest';

import { getFileEditStatusVisual } from './file-edit-card-visuals';

describe('file edit card visuals', () => {
  it('hides the leading status icon for create_dir so the folder pill is not duplicated', () => {
    expect(
      getFileEditStatusVisual({
        toolName: 'create_dir',
        isFailed: false,
      }),
    ).toEqual({
      statusIcon: 'folder',
      showStatusIndicator: false,
    });
  });

  it('keeps destructive delete actions visually distinct from the file pill', () => {
    expect(
      getFileEditStatusVisual({
        toolName: 'delete_file',
        isFailed: false,
      }),
    ).toEqual({
      statusIcon: 'trash',
      showStatusIndicator: true,
    });
  });

  it('surfaces failed structural edits with an error icon', () => {
    expect(
      getFileEditStatusVisual({
        toolName: 'create_dir',
        isFailed: true,
      }),
    ).toEqual({
      statusIcon: 'error',
      showStatusIndicator: true,
    });
  });
});
