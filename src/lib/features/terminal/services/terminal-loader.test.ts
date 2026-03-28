import { describe, expect, it } from 'vitest';

import { buildTerminalOptions } from './terminal-loader';

describe('terminal-loader', () => {
  it('uses a block cursor by default', () => {
    const options = buildTerminalOptions();

    expect(options.cursorBlink).toBe(true);
    expect(options.cursorStyle).toBe('block');
  });

  it('preserves explicit option overrides', () => {
    const options = buildTerminalOptions({
      cursorStyle: 'underline',
      fontSize: 15,
    });

    expect(options.cursorStyle).toBe('underline');
    expect(options.fontSize).toBe(15);
  });
});
