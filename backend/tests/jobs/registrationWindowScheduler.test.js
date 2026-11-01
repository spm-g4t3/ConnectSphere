/**
 * Tests for the registration opening and closing job.
 *
 * SCRUM-177 (AC1), SCRUM-237. The job calls process_registration_window_notices()
 * (053) once on start and then every interval. What that function announces,
 * and when, is proved against Postgres in
 * tests/db/scrum237RegistrationWindowJobDatabase.test.js. These tests prove the
 * timer and the logging, with fake timers, a fake client and a fake logger.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  runRegistrationWindowNoticesOnce,
  startRegistrationWindowScheduler,
  DEFAULT_INTERVAL_MS,
} from '../../src/jobs/registrationWindowScheduler.js';

const fakeLogger = () => ({ info: vi.fn(), error: vi.fn() });
const answer = (notified, failures = []) => ({ data: { notified, events: notified ? 1 : 0, failures }, error: null });
const clientAnswering = (...results) => {
  const rpc = vi.fn();
  for (const result of results) rpc.mockResolvedValueOnce(result);
  return { rpc };
};

describe('runRegistrationWindowNoticesOnce', () => {
  it('SCRUM177_AC1_calls_process_registration_window_notices_and_logs_what_it_sent', async () => {
    const client = clientAnswering(answer(3));
    const logger = fakeLogger();

    expect(await runRegistrationWindowNoticesOnce({ client, logger })).toBe(3);
    expect(client.rpc).toHaveBeenCalledWith('process_registration_window_notices');
    expect(logger.info).toHaveBeenCalledWith('Registration window: 3 notification(s) sent');
  });

  it('SCRUM177_AC1_stays_quiet_when_nothing_was_due', async () => {
    const logger = fakeLogger();
    expect(await runRegistrationWindowNoticesOnce({ client: clientAnswering(answer(0)), logger })).toBe(0);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('SCRUM177_AC1_logs_each_event_that_failed_and_still_counts_the_rest', async () => {
    const logger = fakeLogger();
    const client = clientAnswering(answer(2, [{ eventRequestId: 'e1', message: 'deadlock' }]));

    expect(await runRegistrationWindowNoticesOnce({ client, logger })).toBe(2);
    expect(logger.error).toHaveBeenCalledWith('Registration window notice failed for event e1:', 'deadlock');
  });

  it('SCRUM177_AC1_reads_an_unexpected_answer_as_nothing_sent', async () => {
    const logger = fakeLogger();
    expect(await runRegistrationWindowNoticesOnce({ client: clientAnswering({ data: null, error: null }), logger })).toBe(0);
    expect(await runRegistrationWindowNoticesOnce({ client: clientAnswering({ data: { notified: 'x' }, error: null }), logger })).toBe(0);
  });

  it('SCRUM177_AC1_logs_a_database_error_and_returns_null_never_throwing', async () => {
    const logger = fakeLogger();
    const client = clientAnswering({ data: null, error: { message: 'down' } });

    expect(await runRegistrationWindowNoticesOnce({ client, logger })).toBeNull();
    expect(logger.error).toHaveBeenCalledWith('Registration window notices failed:', 'down');
  });

  it('SCRUM177_AC1_logs_a_thrown_error_without_a_message_as_itself', async () => {
    const logger = fakeLogger();
    const client = { rpc: vi.fn().mockRejectedValue('boom') };

    expect(await runRegistrationWindowNoticesOnce({ client, logger })).toBeNull();
    expect(logger.error).toHaveBeenCalledWith('Registration window notices failed:', 'boom');
  });

  it('SCRUM177_AC1_defaults_to_the_console_logger', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await runRegistrationWindowNoticesOnce({ client: clientAnswering(answer(1)) });
      expect(spy).toHaveBeenCalledWith('Registration window: 1 notification(s) sent');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('startRegistrationWindowScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('SCRUM177_AC1_runs_once_a_minute_by_default', () => {
    expect(DEFAULT_INTERVAL_MS).toBe(60_000);
  });

  it('SCRUM177_AC1_runs_on_start_to_catch_up_after_downtime_then_every_interval_until_stopped', async () => {
    const client = { rpc: vi.fn().mockResolvedValue(answer(0)) };
    const stop = startRegistrationWindowScheduler({ intervalMs: 1000, client, logger: fakeLogger() });

    await vi.advanceTimersByTimeAsync(0);
    expect(client.rpc).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(client.rpc).toHaveBeenCalledTimes(4);

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.rpc).toHaveBeenCalledTimes(4);
  });

  it('SCRUM177_AC1_never_runs_two_calls_at_once', async () => {
    let release;
    const client = {
      rpc: vi.fn().mockImplementationOnce(
        () => new Promise((resolve) => { release = () => resolve(answer(0)); }),
      ).mockResolvedValue(answer(0)),
    };
    const stop = startRegistrationWindowScheduler({ intervalMs: 1000, client, logger: fakeLogger() });

    await vi.advanceTimersByTimeAsync(3000);
    expect(client.rpc).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.rpc).toHaveBeenCalledTimes(2);
    stop();
  });

  it('SCRUM177_AC1_retries_on_the_next_tick_after_a_failed_call', async () => {
    const logger = fakeLogger();
    const client = {
      rpc: vi.fn()
        .mockResolvedValueOnce({ data: null, error: { message: 'down' } })
        .mockResolvedValue(answer(2)),
    };
    const stop = startRegistrationWindowScheduler({ intervalMs: 1000, client, logger });

    await vi.advanceTimersByTimeAsync(1000);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('Registration window: 2 notification(s) sent');
    stop();
  });

  it('SCRUM177_AC1_uses_the_defaults_when_given_nothing_and_never_keeps_node_alive', async () => {
    vi.useRealTimers();
    const client = { rpc: vi.fn().mockResolvedValue(answer(0)) };
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
      const stop = startRegistrationWindowScheduler();
      expect(spy).toHaveBeenCalledWith(expect.any(Function), DEFAULT_INTERVAL_MS);
      expect(unref).toHaveBeenCalled();
      await vi.waitFor(() => expect(client.rpc).toHaveBeenCalledWith('process_registration_window_notices'));
      stop();
    } finally {
      spy.mockRestore();
      vi.doUnmock('../../src/config/supabaseClient.js');
    }
  });
});
