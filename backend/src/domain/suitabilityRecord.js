/**
 * The suitability record a booking request carries to Venue Staff.
 *
 * SCRUM-188 AC7: "The suitability result, including any criterion the
 * coordinator chose to override, is attached to the booking request so that
 * Venue Staff can see it."
 *
 * create_booking_request (030, then 040) already stores the result the check
 * gave as bookings.suitability_result, and suitability_overridden = true when
 * the coordinator confirmed an unsuitable venue. What was missing is a reading
 * of those two columns that Venue Staff can rely on: which criteria were
 * overridden is not stored as such, so it is derived here, once, rather than
 * by each screen that shows it (the venue's bookings list now, SCRUM-258's
 * approve/reject next).
 *
 * Tolerant by design. Rows from before SCRUM-190 store no `checked`, rows from
 * before 030 store no result at all, and the column is jsonb, so nothing in
 * the schema guarantees its shape. A row that cannot be read as a result is
 * reported as `suitability: null` -- "never judged" -- rather than guessed at,
 * because a guessed "suitable" in front of the person approving the booking
 * is the one wrong answer this record must not give.
 *
 * Deliberately free of imports, database calls and framework code -- pure data
 * and pure functions, the same shape as domain/bookingStatus.js.
 */


/**
 * The stored result as { suitable, criteria, checked }, or null when it is
 * missing or malformed (see the header).
 *
 * `checked` -- the period, attendance and requirement codes the check judged
 * (SCRUM-190) -- is null for a row stored before it was recorded, so the
 * screen can say "not recorded" rather than show an empty assessment.
 *
 * @param {*} result  bookings.suitability_result as stored
 * @returns {{suitable: boolean, criteria: object[], checked: object|null}|null}
 */
function readResult(result) {
  if (
    typeof result !== 'object' ||
    result === null ||
    typeof result.suitable !== 'boolean' ||
    !Array.isArray(result.criteria)
  ) {
    return null;
  }
  const { checked } = result;
  return {
    suitable: result.suitable,
    criteria: result.criteria,
    checked: typeof checked === 'object' && checked !== null && !Array.isArray(checked)
      ? checked
      : null,
  };
}


/**
 * AC7's "any criterion the coordinator chose to override": the names of the
 * criteria the stored result did not meet, when the coordinator requested the
 * venue anyway.
 *
 * Only when overridden is true. create_booking_request refuses an unsuitable
 * venue unless the coordinator confirms (step 8), so an unmet criterion on a
 * row that was not overridden was not overridden by anyone -- naming it here
 * would put words in the coordinator's mouth. Compared with `=== false`, as
 * venueSuitabilityService's unmetOf does, so an entry with no verdict is not
 * reported as one the coordinator overrode.
 *
 * @param {*} result         bookings.suitability_result as stored
 * @param {*} overridden     bookings.suitability_overridden as stored
 * @returns {string[]}       criterion names in the order the result gave them;
 *                           [] when not overridden or nothing can be read
 */
export function overriddenCriteria(result, overridden) {
  if (overridden !== true) return [];
  if (typeof result !== 'object' || result === null || !Array.isArray(result.criteria)) {
    return [];
  }
  return result.criteria
    .filter((entry) => typeof entry === 'object' && entry !== null && entry.met === false)
    .map((entry) => entry.criterion);
}


/**
 * One bookings row's suitability record, in the camelCase the API returns.
 *
 * overriddenCriteria is derived from the same normalised result, so a row
 * whose result is unreadable reports [] even if it is marked overridden: the
 * screen shows "overridden" from suitabilityOverridden and cannot name
 * criteria nobody can read.
 *
 * @param {{suitability_result?: *, suitability_overridden?: *}} row  snake_case
 * @returns {{suitability: {suitable: boolean, criteria: object[], checked: object|null}|null,
 *            suitabilityOverridden: boolean, overriddenCriteria: string[]}}
 */
export function toSuitabilityRecord(row) {
  const suitability = readResult(row?.suitability_result);
  const suitabilityOverridden = row?.suitability_overridden === true;
  return {
    suitability,
    suitabilityOverridden,
    overriddenCriteria: overriddenCriteria(suitability, suitabilityOverridden),
  };
}
