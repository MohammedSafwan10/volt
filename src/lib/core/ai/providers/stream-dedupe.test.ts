import { describe, expect, it } from 'vitest';

import { computeNovelStreamText } from './stream-dedupe';

describe('stream dedupe', () => {
  it('passes through normal delta chunks', () => {
    expect(computeNovelStreamText('Hello', '')).toEqual({
      novel: 'Hello',
      nextAccumulated: 'Hello',
    });
  });

  it('drops fully repeated chunks', () => {
    expect(computeNovelStreamText('Hello', 'Hello')).toEqual({
      novel: '',
      nextAccumulated: 'Hello',
    });
  });

  it('extracts novel suffix from cumulative chunks', () => {
    expect(computeNovelStreamText('Hello world', 'Hello')).toEqual({
      novel: ' world',
      nextAccumulated: 'Hello world',
    });
  });
});
