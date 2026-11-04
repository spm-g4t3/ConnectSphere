/**
 * Venue hold expiry job.
 *
 * SCRUM-491 (AC7, AC8). A tentative hold occupies nothing once its expiry
 * passes, at once and with no job at all: venue_occupancy_conflicts() (040)
 * only counts holds whose expires_at is still ahead. What the job adds is the
 * record and the notice: process_venue_hold_expiry() marks each lapsed hold
 * 'expired' and tells the holding event's assigned coordinator, once, naming
 * the event, the venue and the expiry.
 *
 * An in-process timer, the agreed choice for this story: one call a minute
 * from the API process, no extra infrastructure. process_venue_hold_expiry()
 * is idempotent -- a hold is expired once and notified about once -- so two
 * API processes running it, or a run repeated after a crash, do no harm.
 *
 * Rules the timer keeps:
 *  - It never runs two calls at once in this process. A tick that arrives
 *    while the previous call is still waiting is skipped, not queued.
 *  - A failed call is logged and the timer carries on. A database blip must
 *    not take the API down, and the next tick will catch up.
 *  - The interval is unref'd, so it never keeps Node alive on its own.
 *
 * app.js starts it unless NODE_ENV is 'test' or VENUE_HOLD_EXPIRY_JOB is
 * 'off' (useful for demonstrating AC7 without the job), and sets the reminder
 * lead time from VENUE_HOLD_REMINDER_HOURS.
 *
 * Takes an optional client, resolved lazily, so tests never need credentials.
 */

import { resolveClient } from '../config/resolveClient.js';

/** Once a minute: the job is cheap, and the notice is not urgent to the second. */
export const DEFAULT_INTERVAL_MS = 60_000;

/** Warn a coordinator a day before a hold lapses unless configured otherwise. */
export const DEFAULT_REMINDER_LEAD_HOURS = 24;

/**
 * Run process_venue_hold_expiry() once.
 *
 * @param {object} [options]
 * @param {object} [options.client]
 * @param {object} [options.logger]  console by default
 * @returns {Promise<number|null>} how many holds were expired, or null when
 *          the call failed (it is logged, never thrown)
 */
export async function runVenueHoldExpiryOnce({ client, logger = console } = {}) {
  try {
    const db = await resolveClient(client);
    const { data, error } = await db.rpc('process_venue_hold_expiry');
    if (error) throw error;

    const expired = typeof data === 'number' ? data : 0;
    if (expired > 0) {
      logger.info(`Venue hold expiry: ${expired} hold(s) expired`);
    }
    return expired;
  } catch (err) {
    logger.error('Venue hold expiry failed:', err?.message ?? err);
    return null;
  }
}

/**
 * Run process_venue_hold_reminders() once.
 *
 * @param {object} [options]
 * @param {number} [options.leadHours]  defaults to DEFAULT_REMINDER_LEAD_HOURS
 * @param {object} [options.client]
 * @param {object} [options.logger]  console by default
 * @returns {Promise<number|null>} how many reminders were written, or null when
 *          the call failed (it is logged, never thrown)
 */
export async function runVenueHoldRemindersOnce({
  leadHours = DEFAULT_REMINDER_LEAD_HOURS,
  client,
  logger = console,
} = {}) {
  try {
    const db = await resolveClient(client);
    const { data, error } = await db.rpc('process_venue_hold_reminders', {
      p_lead_time: `${leadHours} hours`,
    });
    if (error) throw error;

    const reminded = typeof data === 'number' ? data : 0;
    if (reminded > 0) {
      logger.info(`Venue hold reminders: ${reminded} hold(s) expiring soon`);
    }
    return reminded;
  } catch (err) {
    logger.error('Venue hold reminders failed:', err?.message ?? err);
    return null;
  }
}

/**
 * Start the timer. Runs once straight away, so holds that lapsed while the
 * API was down are recorded on start-up, then every intervalMs.
 *
 * @param {object} [options]
 * @param {number} [options.intervalMs]  defaults to DEFAULT_INTERVAL_MS
 * @param {number} [options.reminderLeadHours]  defaults to DEFAULT_REMINDER_LEAD_HOURS
 * @param {object} [options.client]
 * @param {object} [options.logger]
 * @returns {() => void} stop: clears the timer
 */
export function startVenueHoldExpiryScheduler({
  intervalMs = DEFAULT_INTERVAL_MS,
  reminderLeadHours = DEFAULT_REMINDER_LEAD_HOURS,
  client,
  logger = console,
} = {}) {
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      await runVenueHoldExpiryOnce({ client, logger });
      await runVenueHoldRemindersOnce({ leadHours: reminderLeadHours, client, logger });
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
