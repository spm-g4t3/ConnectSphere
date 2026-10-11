/**
 * Validation for a venue suitability check.
 *
 * SCRUM-190, a subtask of SCRUM-188 (Check Venue Suitability for an Event).
 *
 * GET /api/event-requests/:id/venue-suitability takes the event from the path
 * and, from the query string, the venue and the requirement codes the
 * coordinator picked: a layout, and accessibility and facility code lists.
 * Nothing else is read. The event's period and expected attendance are the
 * stored ones, never the caller's, so a query naming startsAt or
 * expectedAttendance is not an error; those keys are simply never looked at.
 *
 * The same rules as a booking request, on purpose: a check the panel runs
 * (SCRUM-191) and the check the booking request repeats on submit must accept
 * the same input, or the panel could show a verdict the submit then refuses.
 * So the layout is bookingRequestValidation's pattern and the lists are its
 * checkOptionalCodeLists, which is venueValidation's checkCodeArray.
 *
 * A pure module, with no database access. Whether a code exists is the
 * service's question (venueService.assertKnownCodes).
 */

import { ValidationError } from '../errors.js';
import { isPlausibleId } from './eventChangeRequestValidation.js';
import { LAYOUT_CODE_PATTERN, checkOptionalCodeLists } from './bookingRequestValidation.js';

function createErrorCollector() {
  const details = [];
  return {
    add: (field, message) => details.push({ field, message }),
    details,
    get hasErrors() {
      return details.length > 0;
    },
  };
}

function checkId(errors, field, label, value) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
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
 * Validate a suitability check's input.
 *
 * The route has already split the comma-separated lists (http/parseCodeList.js);
 * a list it could not split -- not text -- arrives as it came and is reported
 * here.
 *
 * @param {object} input
 * @param {string} input.eventRequestId  the event, from the path
 * @param {string} input.venueId         the venue being checked
 * @param {string} [input.layout]        one room layout code
 * @param {string[]} [input.accessibility] accessibility feature codes
 * @param {string[]} [input.facilities]  facility codes
 * @returns {{eventRequestId: string, venueId: string, roomLayoutCode: string|null,
 *            accessibility: string[], facilities: string[]}}  ids lower-cased;
 *            a blank layout is null and a missing list is []
 * @throws {ValidationError} listing every problem found
 */
export function validateSuitabilityQuery(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('Invalid suitability check -- expected an object');
  }

  const errors = createErrorCollector();

  const eventRequestId = checkId(errors, 'eventRequestId', 'event', input.eventRequestId);
  const venueId = checkId(errors, 'venueId', 'venue', input.venueId);

  // Blank is "no layout asked for", as in the search: an untouched picker is
  // not a criterion. A repeated ?layout= arrives as an array and is refused,
  // since an event is set out in one layout.
  let roomLayoutCode = null;
  const { layout } = input;
  if (layout !== undefined && layout !== null) {
    if (typeof layout !== 'string') {
      errors.add('layout', 'must be a single layout code');
    } else if (layout.trim() !== '') {
      if (LAYOUT_CODE_PATTERN.test(layout.trim())) {
        roomLayoutCode = layout.trim();
      } else {
        errors.add('layout', 'must be a room layout code, such as theatre or u_shape');
      }
    }
  }

  const { accessibility, facilities } = checkOptionalCodeLists(errors, input);

  if (errors.hasErrors) {
    const summary = errors.details.map(({ field, message }) => `${field}: ${message}`).join('; ');
    throw new ValidationError(`Invalid suitability check -- ${summary}`, errors.details);
  }

  return { eventRequestId, venueId, roomLayoutCode, accessibility, facilities };
}

/**
 * Validate the event id of a recheck of the event's venues (SCRUM-192).
 *
 * GET /api/event-requests/:id/venue-suitability/bookings takes nothing but the
 * event from the path: the venues, layouts and codes are the bookings' own.
 * The same id rule as the one-venue check, so a malformed id is a 400 before
 * any read rather than a 404 from the database.
 *
 * @param {object} input
 * @param {string} input.eventRequestId  the event, from the path
 * @returns {{eventRequestId: string}}  lower-cased
 * @throws {ValidationError}
 */
export function validateEventVenuesQuery(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('Invalid suitability check -- expected an object');
  }

  const errors = createErrorCollector();
  const eventRequestId = checkId(errors, 'eventRequestId', 'event', input.eventRequestId);

  if (errors.hasErrors) {
    const summary = errors.details.map(({ field, message }) => `${field}: ${message}`).join('; ');
    throw new ValidationError(`Invalid suitability check -- ${summary}`, errors.details);
  }

  return { eventRequestId };
}
