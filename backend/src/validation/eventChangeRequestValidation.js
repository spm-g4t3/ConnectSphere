/**
 * Event change request input validation.
 *
 * SCRUM-11: request a change to a submitted event and specify what needs
 * updating (AC1, AC2).
 *
 * SCRUM-33: ensure the Organiser has supplied the required details, and that
 * the request is associated with the correct event.
 *
 * Pure and synchronous, the same posture as venueValidation.js: no database,
 * no imports beyond the error type and the change-field vocabulary. That
 * keeps it unit-testable without credentials -- the database
 * (005_event_change_requests.sql) is the backstop for anything this does not
 * check, and this layer exists to say what went wrong in words an Organiser
 * can act on.
 *
 * "Associated with the correct event" is checked in two places, deliberately
 * split by what a plain object can and cannot know:
 *   - here: eventRequestId is at least shaped like an id. A value that could
 *     never name any event -- an empty string, an event's name typed into
 *     the wrong box -- is rejected before anything reaches the network.
 *   - eventChangeRequestService.js: whether that id names an event that
 *     actually exists, and belongs to the caller. That needs the database,
 *     so it cannot live in a module that deliberately has none.
 *
 * requestedChange is checked against the shape its changeField implies (a
 * real date for the two date fields, a positive whole number for expected
 * attendance) so that "the organiser provided the required details" means
 * the details were usable, not just present. Still NOT checked here: whether
 * a new proposed_start still falls before proposed_end, since that depends
 * on whichever of the two the event does not have a pending change for --
 * data only the service has. That comparison belongs to whichever subtask
 * applies an approved change back onto the event record (AC5).
 */

import { ValidationError } from '../errors.js';
import { CHANGE_FIELD, CHANGE_FIELDS } from '../domain/eventChangeField.js';

/** Loose enough to accept any real UUID (v1-v5) without pinning to Postgres's v4 default. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ISO 8601 date, optionally with a time component. Deliberately stricter than
 * asking `Date.parse` alone: it accepts ambiguous legacy formats too, and
 * `Date.parse('120')` -- clearly not a date anyone typed on purpose -- still
 * returns a real timestamp under those fallback rules. A proposed_start the
 * browser, this validator and the database cannot all agree on the meaning
 * of is not a usable value.
 */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** changeField values whose requestedChange must parse as a date/time. */
const DATE_CHANGE_FIELDS = [CHANGE_FIELD.PROPOSED_START, CHANGE_FIELD.PROPOSED_END];

/** Collects problems so every fault in a request is reported at once. */
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

function throwIfInvalid(errors) {
  if (!errors.hasErrors) return;

  const summary = errors.details
    .map(({ field, message }) => `${field}: ${message}`)
    .join('; ');

  throw new ValidationError(`Invalid change request -- ${summary}`, errors.details);
}

/** Required text: must be a string with something in it once trimmed. */
function checkRequiredText(errors, field, value) {
  if (value === undefined || value === null) {
    errors.add(field, 'is required');
    return null;
  }
  if (typeof value !== 'string') {
    errors.add(field, 'must be text');
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    errors.add(field, 'cannot be blank');
    return null;
  }
  return trimmed;
}

/**
 * AC2: which piece of event information or arrangement is being changed.
 * Must be one of the fixed vocabulary -- matching the database enum -- so
 * 'other' is the only way to describe something not modelled elsewhere.
 */
function checkChangeField(errors, value) {
  if (value === undefined || value === null) {
    errors.add('changeField', 'is required');
    return null;
  }
  if (typeof value !== 'string' || !CHANGE_FIELDS.includes(value)) {
    errors.add('changeField', `must be one of: ${CHANGE_FIELDS.join(', ')}`);
    return null;
  }
  return value;
}

/**
 * SCRUM-33: which event the change is about must at least be shaped like an
 * id. This cannot confirm the event exists or belongs to the caller -- that
 * needs the database -- but a value that is not id-shaped at all can never
 * be "the correct event", so there is no reason to wait for a network round
 * trip to say so.
 */
function checkEventRequestId(errors, value) {
  const trimmed = checkRequiredText(errors, 'eventRequestId', value);
  if (trimmed === null) return null;

  if (!UUID_PATTERN.test(trimmed)) {
    errors.add('eventRequestId', 'must be a valid event id');
    return null;
  }
  return trimmed;
}

/**
 * SCRUM-33: requestedChange must be usable for the changeField it is paired
 * with, not merely present.
 *
 * changeField may already be invalid (or absent) by the time this runs; in
 * that case none of the field-specific shapes apply and only the generic
 * required-text check below applies, so this never raises a second,
 * confusing error about a field the caller has already been told is wrong.
 */
function checkRequestedChange(errors, changeField, value) {
  const trimmed = checkRequiredText(errors, 'requestedChange', value);
  if (trimmed === null) return null;

  if (changeField === CHANGE_FIELD.EXPECTED_ATTENDANCE) {
    if (!/^\d+$/.test(trimmed) || Number(trimmed) <= 0) {
      errors.add('requestedChange', 'must be a positive whole number of attendees');
      return null;
    }
  }

  if (DATE_CHANGE_FIELDS.includes(changeField)) {
    if (!ISO_DATE_PATTERN.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
      errors.add('requestedChange', 'must be a valid date/time, e.g. 2026-10-15T09:00:00Z');
      return null;
    }
  }

  return trimmed;
}

/**
 * Validate input for requesting a change to an event.
 *
 * @param {object} input
 * @param {string} input.eventRequestId  which event the change is about
 * @param {string} input.changeField     which field/arrangement (AC2)
 * @param {string} input.requestedChange the new value, or -- for 'other' --
 *                                       a description of the arrangement change
 * @returns {object} a normalised copy: { eventRequestId, changeField, requestedChange }
 * @throws {ValidationError} listing every problem found, not just the first
 */
export function validateCreateChangeRequest(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('Invalid change request -- expected an object');
  }

  const errors = createErrorCollector();
  const normalised = {};

  normalised.eventRequestId = checkEventRequestId(errors, input.eventRequestId);
  normalised.changeField = checkChangeField(errors, input.changeField);
  normalised.requestedChange = checkRequestedChange(errors, normalised.changeField, input.requestedChange);

  throwIfInvalid(errors);
  return normalised;
}
