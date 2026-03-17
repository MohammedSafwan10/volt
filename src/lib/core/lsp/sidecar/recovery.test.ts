import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLspRecoveryController } from './recovery';

describe('LSP recovery controller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  it('schedules bounded restarts with backoff', async () => {
    const restart = vi.fn(async () => {});
    const controller = createLspRecoveryController({
      source: 'typescript',
      restart,
      baseDelayMs: 100,
      maxDelayMs: 500,
      maxAttempts: 2,
      windowMs: 1000,
    });

    expect(controller.schedule('transport exit')).toBe(true);
    expect(controller.schedule('another exit')).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    expect(restart).toHaveBeenCalledTimes(1);

    expect(controller.schedule('second exit')).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(restart).toHaveBeenCalledTimes(2);

    expect(controller.schedule('third exit')).toBe(false);
  });

  it('resets attempts when requested', async () => {
    const restart = vi.fn(async () => {});
    const controller = createLspRecoveryController({
      source: 'yaml',
      restart,
      baseDelayMs: 50,
      maxAttempts: 1,
      windowMs: 1000,
    });

    expect(controller.schedule('exit')).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(restart).toHaveBeenCalledTimes(1);

    expect(controller.schedule('exit again')).toBe(false);
    controller.reset();
    expect(controller.schedule('after reset')).toBe(true);
  });
});
