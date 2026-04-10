import { describe, expect, it } from 'vitest';

import { buildPartialToolCallPreview } from './tool-call-previews';

describe('buildPartialToolCallPreview', () => {
  it('creates a live placeholder for streamed file edits before the final tool call arrives', () => {
    const preview = buildPartialToolCallPreview({
      toolCallId: 'tool-1',
      toolName: 'write_file',
      toolArgs: { path: 'storefront/app/cart/page.tsx' },
    });

    expect(preview).toMatchObject({
      id: 'tool-1',
      name: 'write_file',
      arguments: { path: 'storefront/app/cart/page.tsx' },
      status: 'pending',
      meta: {
        partialToolCall: true,
        planningPhase: 'edit',
        liveStatus: 'Writing file...',
      },
    });
  });

  it('preserves an existing placeholder status while streamed arguments are still incomplete', () => {
    const preview = buildPartialToolCallPreview({
      toolCallId: 'tool-2',
      toolName: 'apply_patch',
      toolArgs: { path: 'src/lib/features/assistant/components/ChatInputBar.svelte' },
      existingToolCall: {
        id: 'tool-2',
        name: 'apply_patch',
        arguments: { path: 'src/lib/features/assistant/components/ChatInputBar.svelte' },
        status: 'running',
        meta: {
          textOffset: 42,
          partialToolCall: true,
        },
      },
    });

    expect(preview.status).toBe('running');
    expect(preview.meta).toMatchObject({
      textOffset: 42,
      partialToolCall: true,
      liveStatus: 'Applying patch...',
    });
  });
});
