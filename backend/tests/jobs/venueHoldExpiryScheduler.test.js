/**
 * Tests for the venue hold expiry job.
 *
 * SCRUM-491 (AC7, AC8). The job calls process_venue_hold_expiry() (040) once
 * on start and then every interval. The function's behaviour -- a hold is
 * expired once and its coordinator notified once -- is proved against a real
 * Postgres in tests/db/venueHoldsDatabase.test.js. These tests prove the
 * timer: it calls the function, never overlaps two calls, logs and carries on
 * after a failure, and stops when asked. Fake timers, a fake client and a
 * fake logger, so nothing waits and no credentials are read.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  runVenueHoldExpiryOnce,
  startVenueHoldExpiryScheduler,
  DEFAULT_INTERVAL_MS,
} from '../../src/jobs/venueHoldExpiryScheduler.js';


const fakeLogger = () => ({ info: vi.fn(), error: vi.fn() });
const clientAnswering = (...results) => {
  const rpc = vi.fn();
  for (const result of results) rpc.mockResolvedValueOnce(result);
  return { rpc };
};


describe('runVenueHoldExpiryOnce', () => {
  it('SCRUM491_AC8_calls_process_venue_hold_expiry_and_logs_what_it_expired', async () => {
    const client = clientAnswering({ data: 2, error: null });
    const logger = fakeLogger();

    expect(await runVenueHoldExpiryOnce({ client, logger })).toBe(2);
    expect(client.rpc).toHaveBeenCalledWith('process_venue_hold_expiry');
    expect(logger.info).toHaveBeenCalledWith('Venue hold expiry: 2 hold(s) expired');
  });

  it('stays quiet when nothing expired', async () => {
    const logger = fakeLogger();
    expect(await runVenueHoldExpiryOnce({ client: clientAnswering({ data: 0, error: null }), logger })).toBe(0);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('reads a non-number answer as nothing expired', async () => {
    const logger = fakeLogger();
    expect(await runVenueHoldExpiryOnce({ client: clientAnswering({ data: null, error: null }), logger })).toBe(0);
  });

  it('logs a database error and returns null, never throwing', async () => {
    const logger = fakeLogger();
    const client = clientAnswering({ data: null, error: { message: 'down' } });

    expect(await runVenueHoldExpiryOnce({ client, logger })).toBeNull();
    expect(logger.error).toHaveBeenCalledWith('Venue hold expiry failed:', 'down');
  });

  it('logs a thrown error without a message as itself', async () => {
    const logger = fakeLogger();
    const client = { rpc: vi.fn().mockRejectedValue('plain') };

    expect(await runVenueHoldExpiryOnce({ client, logger })).toBeNull();
    expect(logger.error).toHaveBeenCalledWith('Venue hold expiry failed:', 'plain');
  });

  it('defaults to the console logger', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await runVenueHoldExpiryOnce({ client: clientAnswering({ data: 1, error: null }) });
      expect(spy).toHaveBeenCalledWith('Venue hold expiry: 1 hold(s) expired');
    } finally {
      spy.mockRestore();
    }
  });

  it('imports the real client lazily when none is passed', async () => {
    const client = clientAnswering({ data: 0, error: null });
    vi.doMock('../../src/config/supabaseClient.js', () => ({ supabase: client, default: client }));
    try {
      expect(await runVenueHoldExpiryOnce({ logger: fakeLogger() })).toBe(0);
      expect(client.rpc).toHaveBeenCalledWith('process_venue_hold_expiry');
    } finally {
      vi.doUnmock('../../src/config/supabaseClient.js');
    }
  });
});


describe('startVenueHoldExpiryScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs once a minute by default', () => {
    expect(DEFAULT_INTERVAL_MS).toBe(60_000);
  });

  it('SCRUM491_AC7_runs_on_start_then_every_interval_until_stopped', async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: 0, error: null }) };
    const stop = startVenueHoldExpiryScheduler({ intervalMs: 1000, client, logger: fakeLogger() });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.rpc).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(client.rpc).toHaveBeenCalledTimes(4);

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.rpc).toHaveBeenCalledTimes(4);
  });

  it('never runs two calls at once', async () => {
    let release;
    const client = {
      rpc: vi.fn().mockImplementationOnce(
        () => new Promise((resolve) => { release = () => resolve({ data: 0, error: null }); }),
      ).mockResolvedValue({ data: 0, error: null }),
    };
    const stop = startVenueHoldExpiryScheduler({ intervalMs: 1000, client, logger: fakeLogger() });

    // The first call is still waiting through three ticks: none of them starts another.
    await vi.advanceTimersByTimeAsync(3000);
    expect(client.rpc).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.rpc).toHaveBeenCalledTimes(2);
    stop();
  });

  it('carries on after a failed call', async () => {
    const logger = fakeLogger();
    const client = {
      rpc: vi.fn()
        .mockResolvedValueOnce({ data: null, error: { message: 'down' } })
        .mockResolvedValue({ data: 1, error: null }),
    };
    const stop = startVenueHoldExpiryScheduler({ intervalMs: 1000, client, logger });

    await vi.advanceTimersByTimeAsync(1000);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('Venue hold expiry: 1 hold(s) expired');
    stop();
  });

  it('uses the defaults when given nothing, and never keeps Node alive', async () => {
    // Real timers here, so the spy wraps Node's own setInterval.
    vi.useRealTimers();
    const client = { rpc: vi.fn().mockResolvedValue({ data: 0, error: null }) };
    vi.doMock('../../src/config/supabaseClient.js', () => ({ supabase: client, default: client }));
    const unref = vi.fn();
    const realSetInterval = globalThis.setInterval;
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation((fn, ms) => {
      const timer = realSetInterval(fn, ms);
      const realUnref = timer.unref.bind(timer);
      unref.mockImplementation(() => realUnref());
      timer.unref = unref;
      return timer;
    });
    try {
      const stop = startVenueHoldExpiryScheduler();
      expect(spy).toHaveBeenCalledWith(expect.any(Function), DEFAULT_INTERVAL_MS);
      expect(unref).toHaveBeenCalled();
      await vi.waitFor(() => expect(client.rpc).toHaveBeenCalledTimes(1));
      stop();
    } finally {
      spy.mockRestore();
      vi.doUnmock('../../src/config/supabaseClient.js');
    }
  });
});
