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
 */

import { ValidationError } from '../errors.js';
import { isPlausibleId } from './eventChangeRequestValidation.js';

/** Mirrors bookings_setup_notes_length in 030. */
export const SETUP_NOTES_MAX_LENGTH = 1000;

/** The shape of room_layouts.code (002): lower-case words joined by underscores. */
const LAYOUT_CODE_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;

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

/** Optional text: trimmed, blank becomes null. Length counts code points, as Postgres does. */
function checkOptionalText(errors, field, value, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    errors.add(field, 'must be text');
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (Array.from(trimmed).length > max) {
    errors.add(field, `must be ${max} characters or fewer`);
    return null;
  }
  return trimmed;
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
 * @returns {{eventRequestId: string, venueId: string, roomLayoutCode: string|null,
 *            setupNotes: string|null, confirmUnsuitable: boolean}}
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

  if (errors.hasErrors) {
    const summary = errors.details.map(({ field, message }) => `${field}: ${message}`).join('; ');
    throw new ValidationError(`Invalid booking request -- ${summary}`, errors.details);
  }

  return { eventRequestId, venueId, roomLayoutCode, setupNotes, confirmUnsuitable };
}
