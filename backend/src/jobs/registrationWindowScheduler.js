/**
 * Registration opening and closing job.
 *
 * SCRUM-177 (AC1), SCRUM-237. Registration opens and closes when a time
 * passes, with no write to notice it. process_registration_window_notices()
 * (042) announces every event whose window is not what was last announced,
 * through the same handler the registration flows use, so a change already
 * announced by a flow is never announced again here.
 *
 * Same shape as the waiting-list promotion job: one call a minute from the API
 * process, the first on start so a boundary passed while the API was down is
 * caught up. The database decides with its own clock, the one registering
 * reads, so a notice never disagrees with whether Register works. A tick that
 * arrives while the previous call is still waiting is skipped; a failed call,
 * or a failed event inside one, is logged and retried on the next tick.
 *
 * Takes an optional client, resolved lazily, so tests never need credentials.
 */

import { resolveClient } from '../config/resolveClient.js';

/** Once a minute: a window is announced within a minute of its boundary. */
export const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Run process_registration_window_notices() once.
 *
 * @param {object} [options]
 * @param {object} [options.client]
 * @param {object} [options.logger]  console by default
 * @returns {Promise<number|null>} how many notices were sent, or null when the
 *          call failed (it is logged, never thrown)
 */
export async function runRegistrationWindowNoticesOnce({ client, logger = console } = {}) {
  try {
    const db = await resolveClient(client);
    const { data, error } = await db.rpc('process_registration_window_notices');
    if (error) throw error;

    const notified = typeof data?.notified === 'number' ? data.notified : 0;
    const failures = Array.isArray(data?.failures) ? data.failures : [];
    for (const failure of failures) {
      logger.error(`Registration window notice failed for event ${failure.eventRequestId}:`, failure.message);
    }
    if (notified > 0) {
      logger.info(`Registration window: ${notified} notification(s) sent`);
    }
    return notified;
  } catch (err) {
    logger.error('Registration window notices failed:', err?.message ?? err);
    return null;
  }
}

/**
 * Start the timer. Runs once straight away, then every intervalMs.
 *
 * @param {object} [options]
 * @param {number} [options.intervalMs]  defaults to DEFAULT_INTERVAL_MS
 * @param {object} [options.client]
 * @param {object} [options.logger]
 * @returns {() => void} stop: clears the timer
 */
export function startRegistrationWindowScheduler({
  intervalMs = DEFAULT_INTERVAL_MS,
  client,
  logger = console,
} = {}) {
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      await runRegistrationWindowNoticesOnce({ client, logger });
    } finally {
      running = false;
    }
  }

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();

  return function stop() {
    clearInterval(timer);
  };
}
