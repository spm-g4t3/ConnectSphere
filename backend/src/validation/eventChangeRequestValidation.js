/**
 * Event change request input validation.
 *
 * SCRUM-11: request a change to a submitted event and specify what needs
 * updating (AC1, AC2).
 *
 * Pure and synchronous, the same posture as venueValidation.js: no database,
 * no imports beyond the error type and the change-field vocabulary. That
 * keeps it unit-testable without credentials -- the database
 * (005_event_change_requests.sql) is the backstop for anything this does not
 * check, and this layer exists to say what went wrong in words an Organiser
 * can act on.
 *
 * Deliberately NOT checked here: whether requestedChange is a valid value
 * for the chosen changeField (a real date for proposed_start, a positive
 * number for expected_attendance, ...). The column stores plain text
 * regardless of which field it is about, and turning that text back into a
 * typed value only matters once a change is applied to the event record --
 * a later subtask (AC5). Checking it here would be guessing a rule that
 * subtask has not defined yet.
 *
 * Also NOT checked here, because it needs the database: whether the event
 * exists, whether it is still a draft, and whether the caller owns it. Those
 * are eventChangeRequestService's job, the same division venueService uses
 * for referential checks a plain object can never answer on its own.
 */

import { ValidationError } from '../errors.js';
import { CHANGE_FIELDS } from '../domain/eventChangeField.js';

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

  normalised.eventRequestId = checkRequiredText(errors, 'eventRequestId', input.eventRequestId);
  normalised.changeField = checkChangeField(errors, input.changeField);
  normalised.requestedChange = checkRequiredText(errors, 'requestedChange', input.requestedChange);

  throwIfInvalid(errors);
  return normalised;
}
