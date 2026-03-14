import { describe, expect, it } from 'vitest';

import {
  getHealthProbe,
  isResponsiveProtocolError,
} from './health';

describe('lsp sidecar health helpers', () => {
  it('uses a lightweight workspace symbol probe', () => {
    expect(getHealthProbe()).toEqual({
      method: 'workspace/symbol',
      params: { query: '__volt_healthcheck__' },
    });
  });

  it('treats protocol-level method errors as responsive', () => {
    expect(isResponsiveProtocolError(new Error('Method not found'))).toBe(true);
    expect(isResponsiveProtocolError(new Error('Invalid params supplied'))).toBe(true);
    expect(isResponsiveProtocolError(new Error('Unsupported request'))).toBe(true);
    expect(isResponsiveProtocolError(new Error('Transport not connected'))).toBe(false);
  });
});
