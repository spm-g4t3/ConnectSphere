/**
 * The timer the minute jobs share (src/jobs/repeatingJob.js), with fake timers.
 * Each scheduler's own tests prove what it runs on it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { startRepeatingJob } from '../../src/jobs/repeatingJob.js';

describe('startRepeatingJob', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('SCRUM177_AC1_runs_on_start_then_every_interval_until_stopped', async () => {
    const runOnce = vi.fn().mockResolvedValue(undefined);
    const stop = startRepeatingJob(runOnce, 1000);

    await vi.advanceTimersByTimeAsync(0);
    expect(runOnce).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(runOnce).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runOnce).toHaveBeenCalledTimes(3);
  });

  it('SCRUM177_AC1_skips_a_tick_while_the_previous_run_is_still_waiting', async () => {
    let release;
    const runOnce = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockResolvedValue(undefined);
    const stop = startRepeatingJob(runOnce, 1000);

    await vi.advanceTimersByTimeAsync(3000);
    expect(runOnce).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runOnce).toHaveBeenCalledTimes(2);
    stop();
  });
});
