/**
 * Waiting-list promotion job.
 *
 * SCRUM-460 (AC3, AC5). Every write that can free a place promotes at once,
 * but registration can also reopen with no write: its opening time simply
 * passes. A place freed while it was closed would then sit empty until the
 * next registration write. process_waitlist_promotions() (037) hands such
 * places to the people waiting, and notifies them, once registration is open.
 *
 * Same shape as the venue hold expiry job: one call a minute from the API
 * process. The function is idempotent -- it recounts free places under the
 * event lock -- so two API processes running it, or a repeated run, do no harm.
 * A tick that arrives while the previous call is still waiting is skipped, a
 * failed call is logged and the timer carries on, and the interval is unref'd.
 *
 * app.js starts it unless NODE_ENV is 'test' or WAITLIST_PROMOTION_JOB is 'off'.
 *
 * Takes an optional client, resolved lazily, so tests never need credentials.
 */

import { resolveClient } from '../config/resolveClient.js';

/** Once a minute: a reopened place is handed out within a minute of opening. */
export const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Run process_waitlist_promotions() once.
 *
 * @param {object} [options]
 * @param {object} [options.client]
 * @param {object} [options.logger]  console by default
 * @returns {Promise<number|null>} how many attendees were promoted, or null
 *          when the call failed (it is logged, never thrown)
 */
export async function runWaitlistPromotionsOnce({ client, logger = console } = {}) {
  try {
    const db = await resolveClient(client);
    const { data, error } = await db.rpc('process_waitlist_promotions');
    if (error) throw error;

    const promoted = typeof data === 'number' ? data : 0;
    if (promoted > 0) {
      logger.info(`Waitlist promotion: ${promoted} attendee(s) promoted`);
    }
    return promoted;
  } catch (err) {
    logger.error('Waitlist promotion failed:', err?.message ?? err);
    return null;
  }
}

/**
 * Start the timer. Runs once straight away, so places that opened while the
 * API was down are handed out on start-up, then every intervalMs.
 *
 * @param {object} [options]
 * @param {number} [options.intervalMs]  defaults to DEFAULT_INTERVAL_MS
 * @param {object} [options.client]
 * @param {object} [options.logger]
 * @returns {() => void} stop: clears the timer
 */
export function startWaitlistPromotionScheduler({
  intervalMs = DEFAULT_INTERVAL_MS,
  client,
  logger = console,
} = {}) {
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      await runWaitlistPromotionsOnce({ client, logger });
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
