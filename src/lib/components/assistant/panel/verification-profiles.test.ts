import { describe, expect, it } from 'vitest';

import { shouldRunAfterFileEdits } from './verification-profiles';

describe('verification-profiles', () => {
  it('defers only verification tools after file edits', () => {
    expect(shouldRunAfterFileEdits('get_diagnostics')).toBe(true);
    expect(shouldRunAfterFileEdits('lsp_get_hover')).toBe(true);

    expect(shouldRunAfterFileEdits('read_file')).toBe(false);
    expect(shouldRunAfterFileEdits('read_code')).toBe(false);
    expect(shouldRunAfterFileEdits('workspace_search')).toBe(false);
    expect(shouldRunAfterFileEdits('get_active_file')).toBe(false);
  });
});
