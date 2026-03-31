import { describe, expect, it } from 'vitest';

import {
  chooseAssistantStreamingFlushMode,
  shouldRenderAssistantStreamingAsPlainText,
} from './assistant-streaming-render-mode';

describe('assistant streaming render mode', () => {
  it('switches large streaming responses to plain text mode', () => {
    expect(
      shouldRenderAssistantStreamingAsPlainText({
        contentLength: 7000,
        streaming: true,
      }),
    ).toBe(true);

    expect(
      shouldRenderAssistantStreamingAsPlainText({
        contentLength: 7000,
        streaming: false,
      }),
    ).toBe(false);
  });

  it('throttles flushes for large plain-text streaming payloads', () => {
    expect(
      chooseAssistantStreamingFlushMode({
        renderedLength: 6400,
        nextLength: 6480,
        streaming: true,
        plainTextMode: true,
        nextContentEndsWithNewline: true,
        nextContentEndsWithFence: false,
      }),
    ).toBe('throttled');
  });

  it('keeps immediate flushes for initial streaming content', () => {
    expect(
      chooseAssistantStreamingFlushMode({
        renderedLength: 0,
        nextLength: 40,
        streaming: true,
        plainTextMode: false,
        nextContentEndsWithNewline: false,
        nextContentEndsWithFence: false,
      }),
    ).toBe('immediate');
  });
});
