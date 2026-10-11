/**
 * Is an event open for registration at this instant?
 *
 * SCRUM-495 (AC2, AC4), reading the settings SCRUM-494 defines. Pure data and
 * pure functions, with no imports, like domain/eventRequestStatus.js, so the
 * browse query and SCRUM-22's registration check can share one answer.
 *
 * The boundaries follow the repository's half-open convention (venue occupancy
 * ranges are '[)', and a venue hold is active while expires_at > now()):
 *
 *   - the window is [opens, closes): open at the opening instant, closed at the
 *     closing instant;
 *   - an event is "not yet started" while start > now, so one that starts at
 *     exactly this instant is no longer listed.
 *
 * Everything compares instants, never calendar dates, so no time zone is
 * involved: the columns are timestamptz and the API demands an explicit offset.
 *
 * Unresolved (tickets give no boundary): whether "has not passed" means
 * closes >= now. This takes the half-open reading. If the team decides
 * otherwise, this file and the matching filters in openEventService.js are the
 * two places to change.
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
 * @param {string|Date|null} event.registrationClosesAt
 * @param {string|Date|null} event.startsAt
 * @param {Date} now
 * @returns {boolean} true only when every condition holds; a missing or
 *   unreadable time never counts as open
 */
export function isOpenForRegistration(event, now) {
  const at = now.getTime();
  const opens = toMillis(event.registrationOpensAt);
  const closes = toMillis(event.registrationClosesAt);
  const starts = toMillis(event.startsAt);

  return (
    event.status === STATUS.CONFIRMED &&
    event.registrationEnabled === true &&
    opens <= at &&
    at < closes &&
    at < starts
  );
}
