/**
 * Is an event open for registration at this instant? Pure, so the browse query
 * and SCRUM-22's check share one answer.
 *
 * Half-open, like venue occupancy: the window is [opens, closes), and an event
 * starting exactly now is no longer listed. A close time that was never set
 * means open until the Organiser closes registration by hand; one that is set
 * but unreadable never counts as open. Instants are compared, never
 * calendar dates, so no time zone is involved. The tickets give no boundary
 * for "has not passed"; if the team reads it as closes >= now, change this and
 * the filters in openEventService.js.
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
