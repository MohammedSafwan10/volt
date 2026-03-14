import { describe, expect, it } from 'vitest';

import { seedToolLoopReadEvidence } from './read-evidence';
import { createToolLoopState } from './tool-loop-state';

describe('read evidence seeding', () => {
  it('treats attached file context and completed reads as valid prior evidence', () => {
    const state = createToolLoopState();

    seedToolLoopReadEvidence(state, [
      {
        id: 'u1',
        role: 'user',
        content: 'fix it',
        timestamp: 1,
        attachments: [
          { id: 'a1', type: 'file', path: 'game.js', content: 'const x = 1;', label: 'game.js' },
        ],
      } as any,
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        timestamp: 2,
        inlineToolCalls: [
          {
            id: 't1',
            name: 'read_file',
            arguments: { path: 'other.js' },
            status: 'completed',
            endTime: 3,
          },
        ],
      } as any,
    ]);

    expect(state.checkFreshRead('game.js', 'read').ok).toBe(true);
    expect(state.checkFreshRead('other.js', 'read').ok).toBe(true);
  });
});
