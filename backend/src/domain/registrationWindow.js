/**
 * Is an event open for registration at an instant? The window is [opens,
 * closes) and compared as instants, so an event starting now is not listed and
 * no time zone is involved. A null close time stays open until closed by hand.
 */
import { STATUS } from './eventRequestStatus.js';

function toMillis(value) {
  if (value === null || value === undefined) return Number.NaN;
  return new Date(value).getTime();
}

/**
 * @param {object} event
 * @param {string} event.status
 * @param {boolean} event.registrationEnabled
 * @param {string|Date|null} event.registrationOpensAt
 * @param {string|Date|null} event.registrationClosesAt  null: no close time
 * @param {string|Date|null} event.startsAt
 * @param {Date} now
 * @returns {boolean} true only when every condition holds; a missing opening
 *   or start time, or an unreadable time, never counts as open
 */
export function isOpenForRegistration(event, now) {
  const at = now.getTime();
  const opens = toMillis(event.registrationOpensAt);
  const closes =
    event.registrationClosesAt === null || event.registrationClosesAt === undefined
      ? Number.POSITIVE_INFINITY
      : toMillis(event.registrationClosesAt);
  const starts = toMillis(event.startsAt);

  return (
    event.status === STATUS.CONFIRMED &&
    event.registrationEnabled === true &&
    opens <= at &&
    at < closes &&
    at < starts
  );
}
