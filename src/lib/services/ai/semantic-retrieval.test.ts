import { describe, expect, it } from 'vitest';

import { scoreHybridSnippet } from './semantic-retrieval';

describe('semantic-retrieval', () => {
  it('boosts touched and active snippets over plain semantic score', () => {
    const base = scoreHybridSnippet({
      lexicalScore: 0.3,
      semanticScore: 0.5,
      isTouched: false,
      isActive: false,
      isDiagnostics: false,
    });

    const boosted = scoreHybridSnippet({
      lexicalScore: 0.3,
      semanticScore: 0.5,
      isTouched: true,
      isActive: true,
      isDiagnostics: false,
    });

    expect(boosted).toBeGreaterThan(base);
  });

  it('applies diagnostics boost deterministically', () => {
    const withoutDiag = scoreHybridSnippet({
      lexicalScore: 0.4,
      semanticScore: 0.4,
      isTouched: false,
      isActive: false,
      isDiagnostics: false,
    });
    const withDiag = scoreHybridSnippet({
      lexicalScore: 0.4,
      semanticScore: 0.4,
      isTouched: false,
      isActive: false,
      isDiagnostics: true,
    });

    expect(withDiag).toBeGreaterThan(withoutDiag);
  });
});
