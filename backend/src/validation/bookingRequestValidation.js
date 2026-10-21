/**
 * Validation for a venue booking request.
 *
 * SCRUM-252, a subtask of SCRUM-243 (Submit a Venue Booking Request).
 *
 * What the caller sends is only what the coordinator chooses: which event, which
 * venue, an optional layout and setup notes, and whether they confirm a venue
 * that failed the suitability check. Everything else is the server's. The
 * period and the event's requirements come from the stored event, the
 * requester from the token, the suitability result from N10, and the status is
 * always pending. A body that names any of those is not an error; the fields
 * are simply never read, as with the other coordinator routes.
 *
 * A pure module, with no database access. The database stays the backstop for
 * what it alone can know: the layout code against room_layouts, and the notes
 * length against bookings_setup_notes_length (030).
 *
 * SCRUM-190 adds the accessibility and facility codes the coordinator wants
 * the venue judged against. The event stores its requirements as free text,
 * so, as in the venue search, the coordinator picks the codes; the
 * suitability check judges them and stores them in its result. Whether each
 * code exists is checked by the suitability service (assertKnownCodes), for
 * the reason venueValidation.js gives for the search.
 *
 * SCRUM-525 adds an optional expectedAttendance: how many people this venue
 * is for, since one event may now use several venues and each takes its own
 * share. It is the event's attendance rule exactly (eventRequestValidation's
 * checkAttendance): a whole number above zero, with no coercion, so "12" is
 * refused rather than guessed at. Absent means "the event's", and the service
 * fills that in; it is not capped at the event's number, because nothing in
 * the requirements caps it. The only ceiling is MAX_ATTENDANCE, Postgres's
 * integer maximum, above which it could not be stored. The database refuses
 * below 1 again (051).
 */

import { ValidationError } from '../errors.js';
import { isPlausibleId } from './ids.js';
import { createErrorCollector, throwIfInvalid, checkOptionalText } from './collector.js';
import { checkCodeArray } from './venueValidation.js';
import { checkAttendance } from './eventRequestValidation.js';
import { SUITABILITY_CHECK_CRITERIA } from '../domain/venueMatching.js';

/** Mirrors bookings_setup_notes_length in 030. */
export const SETUP_NOTES_MAX_LENGTH = 1000;

/**
 * The shape of room_layouts.code (002): lower-case words joined by underscores.
 * Exported for SCRUM-190's suitability query, which takes the same layout.
 */
export const LAYOUT_CODE_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;

function checkId(errors, field, label, value) {
  if (value === undefined || value === null || value === '') {
    errors.add(field, 'is required');
    return null;
  }
  if (!isPlausibleId(value)) {
    errors.add(field, `must be a valid ${label} id`);
    return null;
  }
  return value.trim().toLowerCase();
}

/**
 * SCRUM-190: the accessibility and facility code lists, each optional.
 *
 * Absent or null is "none asked for" and becomes [], so the suitability check
 * and the stored result always see a list. Anything else goes through
 * venueValidation's checkCodeArray, the rule the event search uses.
 * Exported for venueSuitabilityValidation.js, so the endpoint and the booking
 * request read the lists identically.
 *
 * @param {{add: Function}} errors  a collector
 * @param {object} input
 * @returns {{accessibility: string[], facilities: string[]}}
 */
export function checkOptionalCodeLists(errors, input) {
  const lists = {};
  for (const field of ['accessibility', 'facilities']) {
    const value = input[field];
    lists[field] =
      value === undefined || value === null ? [] : (checkCodeArray(errors, field, value) ?? []);
  }
  return lists;
}

/**
 * SCRUM-193/194 (F2, SCRUM-188 AC7): the criteria the coordinator says they
 * accept the venue does not meet.
 *
 * Optional; absent or null is none, []. Otherwise a list of at most six
 * criterion labels, each one of SUITABILITY_CHECK_CRITERIA exactly as the
 * check reports it ('Capacity', 'Operating hours', ... 'Availability'). An
 * unknown label is refused rather than ignored: it is a statement the
 * coordinator made, and silently dropping it could leave them believing they
 * had accepted something they had not. A label repeated counts once.
 *
 * @param {{add: Function}} errors  a collector
 * @param {*} value
 * @returns {string[]}
 */
function checkAcknowledgedCriteria(errors, value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    errors.add('acknowledgedCriteria', 'must be a list of criterion names');
    return [];
  }
  if (value.length > SUITABILITY_CHECK_CRITERIA.length) {
    errors.add(
      'acknowledgedCriteria',
      `must name at most ${SUITABILITY_CHECK_CRITERIA.length} criteria`,
    );
    return [];
  }
  const names = [];
  let valid = true;
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      errors.add('acknowledgedCriteria', `entry ${index} must be a non-empty criterion name`);
      valid = false;
    } else if (!SUITABILITY_CHECK_CRITERIA.includes(entry.trim())) {
      errors.add(
        'acknowledgedCriteria',
        `entry ${index} is not a criterion: "${entry.trim()}" (expected one of ` +
          `${SUITABILITY_CHECK_CRITERIA.join(', ')})`,
      );
      valid = false;
    } else if (!names.includes(entry.trim())) {
      names.push(entry.trim());
    }
  });
  return valid ? names : [];
}

/**
 * SCRUM-253: which booking request is being withdrawn must at least be shaped
 * like an id, so a value that can never match one costs no round trip.
 *
 * @param {*} id
 * @returns {string} the id, trimmed and lower-cased
 * @throws {ValidationError}
 */
export function validateBookingRequestId(id) {
  if (!isPlausibleId(id)) {
    throw new ValidationError('Invalid booking request id', [
      { field: 'id', message: 'must be a valid booking request id' },
    ]);
  }
  return id.trim().toLowerCase();
}

/**
 * Validate input for creating a booking request.
 *
 * @param {object} input
 * @param {string} input.eventRequestId   the event the venue is for
 * @param {string} input.venueId          the venue being requested
 * @param {string} [input.roomLayoutCode] one of room_layouts.code
 * @param {string} [input.setupNotes]     at most 1000 characters
 * @param {boolean} [input.confirmUnsuitable] confirm a venue that failed the
 *                                        suitability check; false by default
 * @param {string[]} [input.accessibility] SCRUM-190: accessibility feature
 *                                        codes to judge the venue against
 * @param {string[]} [input.facilities]   SCRUM-190: facility codes, likewise
 * @param {string[]} [input.acknowledgedCriteria] SCRUM-193/194: the criteria the
 *                                        coordinator accepts the venue does not
 *                                        meet, by label; see
 *                                        checkAcknowledgedCriteria
 * @param {number} [input.expectedAttendance] SCRUM-525: the attendance for this
 *                                        venue, a whole number above zero;
 *                                        absent or null means the event's
 * @param {string} [input.replacesBookingId] SCRUM-266: the flagged booking of
 *                                        this event that this request replaces
 * @returns {{eventRequestId: string, venueId: string, roomLayoutCode: string|null,
 *            setupNotes: string|null, confirmUnsuitable: boolean,
 *            accessibility: string[], facilities: string[],
 *            acknowledgedCriteria: string[], expectedAttendance: number|null,
 *            replacesBookingId: string|null}}
 *            the code lists trimmed, and [] when none were sent;
 *            expectedAttendance and replacesBookingId null when none was sent
 * @throws {ValidationError} listing every problem found, not just the first
 */
export function validateCreateBookingRequest(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('Invalid booking request -- expected an object');
  }

  const errors = createErrorCollector();

  const eventRequestId = checkId(errors, 'eventRequestId', 'event', input.eventRequestId);
  const venueId = checkId(errors, 'venueId', 'venue', input.venueId);

  let roomLayoutCode = checkOptionalText(errors, 'roomLayoutCode', input.roomLayoutCode, 50);
  if (roomLayoutCode !== null && !LAYOUT_CODE_PATTERN.test(roomLayoutCode)) {
    errors.add('roomLayoutCode', 'must be a room layout code, such as theatre or u_shape');
    roomLayoutCode = null;
  }

  const setupNotes = checkOptionalText(errors, 'setupNotes', input.setupNotes, SETUP_NOTES_MAX_LENGTH);

  // No coercion: "true" or 1 is refused, because this field means "yes, request
  // it even though it failed the check", and a guessed yes is worse than a
  // readable fault.
  let confirmUnsuitable = false;
  if (input.confirmUnsuitable !== undefined && input.confirmUnsuitable !== null) {
    if (typeof input.confirmUnsuitable !== 'boolean') {
      errors.add('confirmUnsuitable', 'must be true or false');
    } else {
      confirmUnsuitable = input.confirmUnsuitable;
    }
  }

  // SCRUM-190: optional, and read by the search's rule, so a list the search
  // accepts is a list a booking request accepts.
  const { accessibility, facilities } = checkOptionalCodeLists(errors, input);

  const acknowledgedCriteria = checkAcknowledgedCriteria(errors, input.acknowledgedCriteria);

  // SCRUM-525: null, not a number, when absent, so the service can tell "the
  // event's" from a value and fill in the default itself.
  const expectedAttendance =
    input.expectedAttendance === undefined || input.expectedAttendance === null
      ? null
      : checkAttendance(errors, input.expectedAttendance);

  // SCRUM-266: optional. Whether it is this event's flagged booking is 078's
  // to say, under the event lock.
  const replacesBookingId =
    input.replacesBookingId === undefined || input.replacesBookingId === null
      ? null
      : checkId(errors, 'replacesBookingId', 'booking', input.replacesBookingId);

  if (errors.hasErrors) {
    const summary = errors.details.map(({ field, message }) => `${field}: ${message}`).join('; ');
    throw new ValidationError(`Invalid booking request -- ${summary}`, errors.details);
  }

  return {
    eventRequestId,
    venueId,
    roomLayoutCode,
    setupNotes,
    confirmUnsuitable,
    accessibility,
    facilities,
    acknowledgedCriteria,
    expectedAttendance,
    replacesBookingId,
  };
}

/** Mirrors the 1000-character cap 066 puts on decision_reason and suggested_alternative. */
export const DECISION_TEXT_MAX_LENGTH = 1000;

/**
 * SCRUM-260: what Venue Staff send to reject a request (SCRUM-258 AC4). The
 * reason is required and must say something; the suggested alternative venue
 * or arrangement is optional, and blank means none.
 *
 * @param {object} input
 * @param {string} input.reason                 why the request is rejected
 * @param {string} [input.suggestedAlternative] another venue or arrangement
 * @returns {{reason: string, suggestedAlternative: string|null}} both trimmed
 * @throws {ValidationError} listing every problem found
 */
export function validateRejectBookingRequest(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('Invalid rejection -- expected an object');
  }

  const errors = createErrorCollector();

  const reason = checkOptionalText(errors, 'reason', input.reason, DECISION_TEXT_MAX_LENGTH);
  // checkOptionalText reads blank as absent; for the reason, absent is the error.
  if (reason === null && !errors.details.some(({ field }) => field === 'reason')) {
    errors.add('reason', 'is required');
  }

  const suggestedAlternative = checkOptionalText(
    errors,
    'suggestedAlternative',
    input.suggestedAlternative,
    DECISION_TEXT_MAX_LENGTH,
  );

  throwIfInvalid(errors, 'Invalid rejection');

  return { reason, suggestedAlternative };
}

/** Mirrors the 1000-character cap 089 puts on release_reason. */
export const RELEASE_REASON_MAX_LENGTH = 1000;

/**
 * SCRUM-492: what the coordinator sends to release an approved booking (AC1).
 * The reason is required and must say something.
 *
 * @param {object} input
 * @param {string} input.reason  why the venue is released
 * @returns {{reason: string}} trimmed
 * @throws {ValidationError}
 */
export function validateReleaseBooking(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('Invalid release -- expected an object');
  }

  const errors = createErrorCollector();

  const reason = checkOptionalText(errors, 'reason', input.reason, RELEASE_REASON_MAX_LENGTH);
  // checkOptionalText reads blank as absent; for the reason, absent is the error.
  if (reason === null && !errors.details.some(({ field }) => field === 'reason')) {
    errors.add('reason', 'is required');
  }

  throwIfInvalid(errors, 'Invalid release');

  return { reason };
}
