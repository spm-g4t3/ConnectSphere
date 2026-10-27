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
 * no imports beyond the error type, the shared validation helpers and the
 * change-field vocabulary. That
 * keeps it unit-testable without credentials -- the database
 * (006_event_change_requests.sql) is the backstop for anything this does not
 * check, and this layer exists to say what went wrong in words an Organiser
 * can act on.
 *
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
 *
 * SCRUM-37: validateProcessChangeRequest checks the shape of a decision --
 * approve or reject a change request -- before it reaches the service.
 * Whether the change request named still exists, and whether it has already
 * been processed, both need the database and stay in
 * eventChangeRequestService.js, the same split as everywhere else in this
 * module.
 */

import { ValidationError } from '../errors.js';
import { UUID_PATTERN, isPlausibleId } from './ids.js';
import { createErrorCollector, throwIfInvalid } from './collector.js';
import { CHANGE_FIELD, CHANGE_FIELDS } from '../domain/eventChangeField.js';
import { CHANGE_REQUEST_DECISION, CHANGE_REQUEST_DECISIONS } from '../domain/changeRequestStatus.js';

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

/** SCRUM-402 (D2): one submission names at most this many fields, each once. */
export const MAX_CHANGES_PER_REQUEST = 9;

/** The same collector, every field it is given named under one row. */
function scopedTo(errors, prefix) {
  return { add: (field, message) => errors.add(`${prefix}.${field}`, message) };
}

/**
 * SCRUM-402: a group of changes, each checked as a single request is. A
 * cancellation stands alone (D8). create_change_request_group (036) checks
 * all of it again under the event lock.
 */
function checkChanges(errors, value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHANGES_PER_REQUEST) {
    errors.add('changes', `must list 1 to ${MAX_CHANGES_PER_REQUEST} changes`);
    return null;
  }
  const seen = new Set();
  const changes = value.map((item, i) => {
    const row = scopedTo(errors, `changes[${i}]`);
    const entry = typeof item === 'object' && item !== null ? item : {};
    const changeField = checkChangeField(row, entry.changeField);
    if (changeField !== null && seen.has(changeField)) row.add('changeField', 'is already in this request');
    if (changeField !== null) seen.add(changeField);
    return { changeField, requestedChange: checkRequestedChange(row, changeField, entry.requestedChange) };
  });
  if (seen.has(CHANGE_FIELD.CANCELLATION) && value.length > 1) {
    errors.add('changes', 'a cancellation cannot be combined with other changes');
  }
  return changes;
}

/**
 * Validate input for requesting a change to an event.
 *
 * Two shapes. The single one SCRUM-11's form sends, { eventRequestId,
 * changeField, requestedChange }, comes back as it always has. SCRUM-402's
 * group, { eventRequestId, changes: [{ changeField, requestedChange }] }, comes
 * back as { eventRequestId, changes }.
 *
 * @param {object} input
 * @param {string} input.eventRequestId  which event the change is about
 * @param {string} [input.changeField]     which field/arrangement (AC2)
 * @param {string} [input.requestedChange] the new value, or -- for 'other' --
 *                                         a description of the arrangement change
 * @param {object[]} [input.changes]       the group shape instead
 * @returns {object} a normalised copy of whichever shape was given
 * @throws {ValidationError} listing every problem found, not just the first
 */
export function validateCreateChangeRequest(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('Invalid change request -- expected an object');
  }

  const errors = createErrorCollector();
  const normalised = {};

  normalised.eventRequestId = checkEventRequestId(errors, input.eventRequestId);
  if (Object.hasOwn(input, 'changes')) {
    normalised.changes = checkChanges(errors, input.changes);
  } else {
    normalised.changeField = checkChangeField(errors, input.changeField);
    normalised.requestedChange = checkRequestedChange(errors, normalised.changeField, input.requestedChange);
  }

  throwIfInvalid(errors, 'Invalid change request');
  return normalised;
}

/**
 * SCRUM-37: which change request a decision is about must at least be
 * shaped like an id, the same reasoning checkEventRequestId already applies
 * to eventRequestId -- reuses isPlausibleId rather than a second copy of the
 * pattern it checks against.
 */
function checkChangeRequestId(errors, value) {
  const trimmed = checkRequiredText(errors, 'changeRequestId', value);
  if (trimmed === null) return null;

  if (!isPlausibleId(trimmed)) {
    errors.add('changeRequestId', 'must be a valid change request id');
    return null;
  }
  return trimmed;
}

/** Must be one of the two outcomes a change request can be given. */
function checkDecision(errors, value) {
  if (value === undefined || value === null) {
    errors.add('decision', 'is required');
    return null;
  }
  if (typeof value !== 'string' || !CHANGE_REQUEST_DECISIONS.includes(value)) {
    errors.add('decision', `must be one of: ${CHANGE_REQUEST_DECISIONS.join(', ')}`);
    return null;
  }
  return value;
}

/**
 * Optional for an approval; required for a rejection, so a rejected request
 * always carries a reason the Organiser can act on -- an approval, by
 * contrast, speaks for itself once the event record reflects it.
 *
 * decision may already be invalid (or absent) by the time this runs; in that
 * case the "required when rejecting" rule cannot fire, so this never adds a
 * second, confusing error about a decision the caller has already been told
 * is wrong.
 */
function checkDecisionNotes(errors, decision, value) {
  const isBlank = value === undefined || value === null
    || (typeof value === 'string' && value.trim() === '');

  if (isBlank) {
    if (decision === CHANGE_REQUEST_DECISION.REJECTED) {
      errors.add('decisionNotes', 'is required when rejecting a change request');
    }
    return null;
  }

  if (typeof value !== 'string') {
    errors.add('decisionNotes', 'must be text');
    return null;
  }

  // SCRUM-402: process_change_request (036) keeps a note to 2,000 characters.
  const trimmed = value.trim();
  if (Array.from(trimmed).length > DECISION_NOTES_MAX_LENGTH) {
    errors.add('decisionNotes', `must be ${DECISION_NOTES_MAX_LENGTH.toLocaleString('en-US')} characters or fewer`);
    return null;
  }
  return trimmed;
}

/** SCRUM-402: the limit process_change_request (036) applies to a note. */
export const DECISION_NOTES_MAX_LENGTH = 2000;

/**
 * Validate input for deciding a change request -- approving or rejecting it.
 *
 * @param {object} input
 * @param {string} input.changeRequestId
 * @param {string} input.decision        'approved' | 'rejected'
 * @param {string} [input.decisionNotes] required when rejecting
 * @returns {object} a normalised copy: { changeRequestId, decision, decisionNotes }
 *   -- decisionNotes is null, never undefined, when none was given
 * @throws {ValidationError} listing every problem found, not just the first
 */
export function validateProcessChangeRequest(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('Invalid change request decision -- expected an object');
  }

  const errors = createErrorCollector();
  const normalised = {};

  normalised.changeRequestId = checkChangeRequestId(errors, input.changeRequestId);
  normalised.decision = checkDecision(errors, input.decision);
  normalised.decisionNotes = checkDecisionNotes(errors, normalised.decision, input.decisionNotes);
  // SCRUM-402 AC4: the impact the coordinator previewed, for 395 to compare.
  // Only passed on when given, so a decision without one is sent as before.
  if (input.expectedImpact !== undefined && input.expectedImpact !== null) {
    if (typeof input.expectedImpact !== 'object' || Array.isArray(input.expectedImpact)) {
      errors.add('expectedImpact', 'must be the impact object the preview returned');
    } else {
      normalised.expectedImpact = input.expectedImpact;
    }
  }

  throwIfInvalid(errors, 'Invalid change request');
  return normalised;
}
