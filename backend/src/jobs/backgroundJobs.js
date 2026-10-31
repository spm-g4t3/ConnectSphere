/**
 * The API process's background jobs, started from app.js. Kept here rather
 * than in app.js (excluded from coverage) so which jobs run, and the switch
 * that turns each off, are tested.
 *
 * None runs when NODE_ENV is 'test'. Each has its own *_JOB=off switch.
 */

import { startVenueHoldExpiryScheduler } from './venueHoldExpiryScheduler.js';
import { startWaitlistPromotionScheduler } from './waitlistPromotionScheduler.js';
import { startRegistrationWindowScheduler } from './registrationWindowScheduler.js';

const STARTERS = {
  venueHoldExpiry: startVenueHoldExpiryScheduler,
  waitlistPromotion: startWaitlistPromotionScheduler,
  registrationWindow: startRegistrationWindowScheduler,
};

/**
 * @param {object} [options]
 * @param {object} [options.env]       process.env by default
 * @param {object} [options.starters]  the start functions, replaceable in tests
 * @returns {string[]} the names of the jobs started
 */
export function startBackgroundJobs({ env = process.env, starters = STARTERS } = {}) {
  if (env.NODE_ENV === 'test') return [];
  const started = [];

  // SCRUM-491 (AC7, AC8): mark lapsed venue holds expired and notify their
  // coordinators. A lapsed hold already occupies nothing without this.
  // VENUE_HOLD_REMINDER_HOURS sets how long before expiry the coordinator is
  // warned; anything but a positive number falls back to the job's default.
  if (env.VENUE_HOLD_EXPIRY_JOB !== 'off') {
    const reminderLeadHours = Number(env.VENUE_HOLD_REMINDER_HOURS);
    starters.venueHoldExpiry(
      Number.isFinite(reminderLeadHours) && reminderLeadHours > 0 ? { reminderLeadHours } : {},
    );
    started.push('venueHoldExpiry');
  }

  // SCRUM-460 (AC3): registration can reopen when its opening time passes,
  // with no write to promote anyone, so hand out freed places.
  if (env.WAITLIST_PROMOTION_JOB !== 'off') {
    starters.waitlistPromotion();
    started.push('waitlistPromotion');
  }

  // SCRUM-177 (AC1): announce registration opening and closing when only a
  // time has passed.
  if (env.REGISTRATION_WINDOW_JOB !== 'off') {
    starters.registrationWindow();
    started.push('registrationWindow');
  }

  return started;
}
