/**
 * Event request input validation.
 *
 * SCRUM-30, a subtask of SCRUM-10 (Create Event Request).
 *
 * Two entry points rather than one, because mandatoriness here is a rule about
 * a single state change and not an invariant. The Postgres enum
 * event_request_status begins at 'draft' and the status column defaults to it
 * (001_event_requests.sql), so every request is born incomplete by design and
 * SCRUM-11 (save/edit draft) depends on that staying true. The schema
 * therefore leaves almost every column nullable and cannot say which fields
 * are required -- 005_event_request_details.sql records that reasoning in its
 * header. What the database cannot express, this module does: a draft is
 * accepted with whatever the Organiser has so far, and the full set is
 * demanded only at the draft -> submitted transition.
 *
 * Creation and submission differ in exactly two ways, which is why they share
 * one collection pass below: which fields are mandatory, and whether the
 * proposed start has to be ahead of now.
 *
 * Pure and synchronous -- no database, no network, no imports beyond the error
 * types and the shared timestamp rules, and no clock read except the default
 * for the injected `now`. That keeps it unit-testable without credentials and
 * deterministic in CI.
 *
 * The timestamp rules themselves -- TIMESTAMP_PATTERN, its two near-miss
 * patterns, daysInMonth and checkTimestamp -- live in timestampValidation.js
 * (SCRUM-126), moved there unchanged so venue blocks obey the same contract.
 * Their reasoning is documented there, not here.
 *
 * Deliberately NOT checked here:
 *
 *  - Whether the Organiser exists, or owns this request. That is authorisation,
 *    it needs the caller's role and the event relationship, and it belongs in
 *    the API layer where both are known.
 *  - Any minimum notice between submission and the proposed start. The customer
 *    has not said what that period should be; inventing one would be a business
 *    rule nobody asked for. Open for the next Q&A.
 *  - Timezone conversion. A caller must state an offset (see TIMESTAMP_PATTERN
 *    in timestampValidation.js) but the value is passed on as written: the
 *    column is timestamptz, so Postgres is the authority on resolving it, and
 *    a second interpretation here could only introduce disagreement.
 *  - submitted_at, and any status transition. Whether the move to 'submitted'
 *    is legal is answered by canTransition in src/domain/eventRequestStatus.js,
 *    and stamping the timestamp is the service layer's job. This module answers
 *    one question only: is this input good enough to submit?
 */

import { ValidationError } from '../errors.js';
import { createErrorCollector, throwIfInvalid } from './collector.js';
import { MAX_INTEGER } from './limits.js';
import { checkTimestamp } from './timestampValidation.js';
import { DETAIL_FIELDS } from '../domain/eventDetailField.js';


/** Fields carrying prose, in the order the story lists them. */
const TEXT_FIELDS = [
  'eventName',
  'purpose',
  'description',
  'venueRequirements',
  'accessibilityRequirements',
  'equipmentRequirements',
];

const TIMESTAMP_FIELDS = ['proposedStart', 'proposedEnd'];

/**
 * The one field a draft cannot do without: a request still has to be findable
 * in the Organiser's own list, which is why 001 makes event_name not null.
 */
const CREATE_MANDATORY = ['eventName'];

/**
 * What a Coordinator cannot start work without.
 *
 * A field is here when a downstream feature fails without it: Step 6 searches
 * venues by date and time, and Booking Conflict Detection and Setup/Turnaround
 * Time both compute on the period, so both ends of it are needed; Venue
 * Suitability Checking compares expected attendance against venue capacity.
 * purpose is the weakest of the five -- nothing computes on it -- but Step 5
 * has the Coordinator deciding whether planning should proceed, and that
 * judgement cannot be made without knowing what the event is for.
 */
const SUBMIT_MANDATORY = [
  'eventName',
  'purpose',
  'proposedStart',
  'proposedEnd',
  'expectedAttendance',
];

/**
 * Nothing at all, and that is the rule rather than an unfinished list.
 *
 * SCRUM-11 edits a draft, and an edit says only "change these fields". A field
 * the Organiser did not touch is not missing from the edit, it is simply not
 * part of it -- demanding it back on every save would mean a form could never
 * PATCH one field, which is the only thing a PATCH is for.
 *
 * Empty and not simply reusing CREATE_MANDATORY: eventName still may not be
 * *cleared*, but that is a rule about a value that arrived, not about one that
 * has to arrive, and it is enforced separately below for exactly that reason.
 */
const UPDATE_MANDATORY = [];

/** Every field but eventName, which a draft cannot do without. */
const CLEARABLE_FIELDS = [...TEXT_FIELDS, ...TIMESTAMP_FIELDS, 'expectedAttendance']
  .filter((field) => field !== 'eventName');


/**
 * A non-object is refused before any collection starts.
 *
 * There is nothing to enumerate field by field, so details stays empty -- but
 * it still exists, so no caller has to guard against its absence.
 */
function assertObject(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('Invalid event request details -- expected an object');
  }
}


/** Prose: must be a string with something in it once trimmed. */
function checkText(errors, field, value, required) {
  if (typeof value !== 'string') {
    errors.add(field, 'must be text');
    return null;
  }

  const trimmed = value.trim();

  if (trimmed === '') {
    // Required: blank is worth naming, because the Organiser believes they
    // answered. Optional: blank is simply no answer, stored as null for the
    // reason 005_event_request_details.sql gives -- an unanswered requirement
    // is absent, and '' would make "said nothing" look like a real answer.
    if (required) errors.add(field, 'cannot be blank');
    return null;
  }

  return trimmed;
}

/**
 * A storage limit, not a business rule: Postgres's integer maximum, the type of
 * event_requests.expected_attendance and bookings.expected_attendance (051).
 * Refused here, on the field, rather than failing the cast in the database.
 * A booking's attendance is separately capped by its event's
 * (bookingRequestService.js, 051).
 */
export const MAX_ATTENDANCE = MAX_INTEGER;

/**
 * AC1 of the venue story put the same rule on capacity: a positive whole number.
 *
 * Strict about type on purpose. '40' is refused rather than coerced, so the
 * fault surfaces here instead of inside Venue Suitability Checking, where
 * attendance is compared with a venue's capacity.
 *
 * SCRUM-525: exported for bookingRequestValidation.js, so a booking request's
 * expectedAttendance is held to this rule and reported on the same field.
 */
export function checkAttendance(errors, value) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    errors.add('expectedAttendance', 'must be a number');
    return null;
  }

  if (!Number.isInteger(value) || value <= 0) {
    // One message for both faults: half a person and minus five people are the
    // same mistake to whoever is filling in the form.
    errors.add('expectedAttendance', 'must be a whole number greater than zero');
    return null;
  }

  if (value > MAX_ATTENDANCE) {
    errors.add('expectedAttendance', `must be at most ${MAX_ATTENDANCE}`);
    return null;
  }

  return value;
}


/**
 * The rules creation and submission share, run as a single pass.
 *
 * Returns the parsed instants alongside the normalised copy because the
 * submission rule needs them, and re-parsing the strings there would give this
 * module two places that decide what a timestamp means.
 *
 * @param {object} errors     collector to record faults against
 * @param {object} input      the caller's object, never modified
 * @param {string[]} mandatory fields that must be present and non-blank
 * @returns {{normalised: object, instants: Object<string, Date>}}
 */
function collectEventRequest(errors, input, mandatory) {
  const normalised = {};
  const instants = {};

  for (const field of TEXT_FIELDS) {
    const value = input[field];

    if (value === undefined || value === null) {
      if (mandatory.includes(field)) errors.add(field, 'is required');
      // Left off the copy entirely, rather than set to null. It keeps "the
      // Organiser has not answered this" distinct from "the Organiser cleared
      // it", which is the distinction SCRUM-11 needs when saving partial edits.
      continue;
    }

    normalised[field] = checkText(errors, field, value, mandatory.includes(field));
  }

  for (const field of TIMESTAMP_FIELDS) {
    const value = input[field];

    if (value === undefined || value === null) {
      if (mandatory.includes(field)) errors.add(field, 'is required');
      continue;
    }

    const instant = checkTimestamp(errors, field, value);

    if (instant === null) {
      normalised[field] = null;
    } else {
      instants[field] = instant;
      // Passed on as the caller wrote it, trimmed. The column is timestamptz,
      // so rewriting '+08:00' into Z here would be this layer reinterpreting a
      // value Postgres already understands.
      normalised[field] = value.trim();
    }
  }

  if (input.expectedAttendance === undefined || input.expectedAttendance === null) {
    if (mandatory.includes('expectedAttendance')) {
      errors.add('expectedAttendance', 'is required');
    }
  } else {
    normalised.expectedAttendance = checkAttendance(errors, input.expectedAttendance);
  }

  // Structural, so it is checked at creation too and not only at submission,
  // mirroring event_requests_dates_ordered in 001. Only checked once both ends
  // parsed: complaining that a period is backwards when one end is missing
  // would bury the fault the Organiser can actually act on.
  if (
    instants.proposedStart !== undefined &&
    instants.proposedEnd !== undefined &&
    instants.proposedEnd <= instants.proposedStart
  ) {
    errors.add('proposedEnd', 'must be later than the proposed start');
  }

  return { normalised, instants };
}


/**
 * Validate input for creating or saving a draft event request.
 *
 * Permissive by design: only the event name is required, because Step 1 of the
 * customer's process has the Organiser saving a request and continuing to edit
 * it before submission. Anything stricter here would make SCRUM-11 impossible.
 *
 * Deliberately does not look at the clock. A draft may be written one day and
 * edited over several more, and the dates in it are a working guess until it is
 * sent; the future-dated rule belongs to the transition, not to every save.
 *
 * @param {object} input
 * @param {string} input.eventName
 * @param {string} [input.purpose]
 * @param {string} [input.description]
 * @param {string} [input.proposedStart]  ISO 8601 with an offset
 * @param {string} [input.proposedEnd]    ISO 8601 with an offset
 * @param {number} [input.expectedAttendance]
 * @param {string} [input.venueRequirements]
 * @param {string} [input.accessibilityRequirements]
 * @param {string} [input.equipmentRequirements]
 * @returns {object} a normalised copy -- text trimmed, blank optional text null
 * @throws {ValidationError} listing every problem found, not just the first
 */
export function validateCreateEventRequest(input) {
  assertObject(input);

  const errors = createErrorCollector();
  const { normalised } = collectEventRequest(errors, input, CREATE_MANDATORY);

  throwIfInvalid(errors, 'Invalid event request details');
  return normalised;
}

/**
 * Validate input for saving changes to an existing draft.
 *
 * SCRUM-11. The third mandatory list is the entire extension -- everything
 * else is the same collection pass creation and submission already share,
 * which is this module's thesis at the top of the file. Sitting between
 * create and submit here because create / update / submit is the order a
 * request actually moves through.
 *
 * Every field is optional, so the two rules beyond the create path are both
 * about what an edit may *not* say:
 *
 *  - eventName may be changed but not removed. 001 makes event_name not null
 *    and a request still has to be findable in the Organiser's own list, so
 *    an edit that empties it is refused rather than written and bounced by
 *    the column constraint a round trip later.
 *  - an edit that changes nothing is refused, matching validateUpdateVenue.
 *    It is not pedantry: toColumns({}) is {}, so the service would issue
 *    .update({}), whose PostgREST behaviour is unspecified and untranslated
 *    -- an ambiguous 500 where a precise 400 was available. It costs the real
 *    client nothing, because EventRequestForm always sends eventName, so it
 *    only ever catches a caller bug.
 *
 * An explicit null clears an optional field (SCRUM-355 AC3): an Organiser
 * revising a rejected request must be able to remove what was rejected. An
 * absent key still means "leave it", and the create path still reads null as
 * "not answered".
 *
 * @param {object} changes  any subset of validateCreateEventRequest's fields
 * @returns {object} a normalised copy containing only the supplied fields
 * @throws {ValidationError} listing every problem found, not just the first
 */
export function validateUpdateEventRequest(changes) {
  assertObject(changes);

  const errors = createErrorCollector();
  const { normalised } = collectEventRequest(errors, changes, UPDATE_MANDATORY);

  // Tested against the RAW value, not the normalised one, and only for the two
  // shapes that actually mean "clear this": an explicit null, and a string
  // that trims to nothing. Normalised would be the wrong thing to test --
  // checkText already returns null for { eventName: 42 } having recorded "must
  // be text", so this would pile a contradictory second message onto a fault
  // that has already been named correctly.
  const rawName = changes.eventName;
  if (rawName === null || (typeof rawName === 'string' && rawName.trim() === '')) {
    errors.add('eventName', 'cannot be blank -- omit it to leave the name unchanged');
  }

  throwIfInvalid(errors, 'Invalid event request details');

  for (const field of CLEARABLE_FIELDS) {
    if (changes[field] === null) normalised[field] = null;
  }

  // Deliberately after the field faults, unlike validateUpdateVenue which
  // checks first. A caller sending { expectedAttendance: 'lots' } has supplied
  // a change; the useful answer is what is wrong with it, not that there was
  // nothing there. Counted on the normalised copy rather than the raw keys so
  // that { somethingUnknown: 1 } is caught too -- an unrecognised key is not a
  // change, because toColumns would drop it and the write would be empty.
  if (Object.keys(normalised).length === 0) {
    throw new ValidationError('Invalid event request details -- no changes supplied');
  }

  return normalised;
}

/**
 * Validate input for submitting an event request for review.
 *
 * Every rule creation applies, plus the five fields a Coordinator cannot start
 * without, plus a start that is still ahead of us.
 *
 * `now` is injected so this function is deterministic. A check written against
 * the real clock would pass today and fail tomorrow, or pass locally and fail
 * in CI; callers in production simply omit it.
 *
 * @param {object} input                 same shape as validateCreateEventRequest
 * @param {object} [options]
 * @param {Date} [options.now]           the instant to judge "future" against
 * @returns {object} a normalised copy
 * @throws {ValidationError} listing every problem found, not just the first
 */
export function validateSubmitEventRequest(input, { now = new Date() } = {}) {
  assertObject(input);

  const errors = createErrorCollector();
  const { normalised, instants } = collectEventRequest(errors, input, SUBMIT_MANDATORY);

  // Strictly later than now, not "now or later". Submission is the point at
  // which the dates stop being a working guess, and an event starting at the
  // instant it is submitted leaves no room for any of Steps 2 to 9. Skipped
  // when the start never parsed, so the Organiser is not told a value is in the
  // past when the real complaint is that it is missing or malformed.
  if (instants.proposedStart !== undefined && instants.proposedStart <= now) {
    errors.add('proposedStart', 'must be in the future');
  }

  throwIfInvalid(errors, 'Invalid event request details');
  return normalised;
}

/**
 * Validate a coordinator's significant event change with the same field rules
 * as SCRUM-10, then validate the complete resulting event as submit-ready.
 *
 * `equipmentChange` records the reasoned handoff to SCRUM-21; equipment lines
 * are deliberately not edited through this event-field change.
 *
 * @param {object} changes
 * @param {object} current  camelCase event request
 * @param {object} [options]
 * @param {Date} [options.now]
 * @returns {object} normalised changed fields
 */
export function validateSignificantEventChange(changes, current, { now = new Date() } = {}) {
  assertObject(changes);
  assertObject(current);

  const allowed = new Set([
    'proposedStart',
    'proposedEnd',
    'expectedAttendance',
    'venueRequirements',
    'accessibilityRequirements',
    'equipmentChange',
  ]);
  const unknown = Object.keys(changes).filter((field) => !allowed.has(field));
  if (unknown.length > 0) {
    throw new ValidationError(
      `Invalid significant event change -- unsupported field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`,
    );
  }

  const eventFields = {};
  for (const field of allowed) {
    if (field === 'equipmentChange' || !Object.prototype.hasOwnProperty.call(changes, field)) continue;
    if (
      changes[field] === null &&
      !['venueRequirements', 'accessibilityRequirements'].includes(field)
    ) {
      throw new ValidationError(`Invalid significant event change -- ${field} cannot be null`);
    }
    // Null is the wire representation for clearing optional prose. The shared
    // SCRUM-10 validator interprets a blank optional string as stored null.
    eventFields[field] = changes[field] === null ? '' : changes[field];
  }

  const normalised = Object.keys(eventFields).length > 0
    ? validateUpdateEventRequest(eventFields)
    : {};

  if (
    Object.prototype.hasOwnProperty.call(changes, 'equipmentChange') &&
    typeof changes.equipmentChange !== 'boolean'
  ) {
    throw new ValidationError('Invalid significant event change -- equipmentChange must be true or false');
  }
  if (changes.equipmentChange === true) normalised.equipmentChange = true;

  if (Object.keys(normalised).length === 0) {
    throw new ValidationError('Invalid significant event change -- no changes supplied');
  }

  const merged = {
    eventName: current.eventName,
    purpose: current.purpose,
    description: current.description,
    proposedStart: current.proposedStart,
    proposedEnd: current.proposedEnd,
    expectedAttendance: current.expectedAttendance,
    venueRequirements: current.venueRequirements,
    accessibilityRequirements: current.accessibilityRequirements,
    equipmentRequirements: current.equipmentRequirements,
    ...normalised,
  };
  validateSubmitEventRequest(merged, { now });

  return normalised;
}


/** SCRUM-387 (D5): the reason a coordinator's edit is saved with, as event_change_history allows. */
export const EDIT_REASON_MAX_LENGTH = 4000;

/** A value the form showed for a field, typed as that field is. */
function checkExpectedValue(errors, field, value) {
  if (value === null) return null;
  const key = `expected.${field}`;
  if (TIMESTAMP_FIELDS.includes(field)) return checkTimestamp(errors, key, value) === null ? null : value.trim();
  if (field === 'expectedAttendance') {
    if (!Number.isInteger(value)) errors.add(key, 'must be a whole number or null');
    return value;
  }
  if (typeof value !== 'string') errors.add(key, 'must be text or null');
  return value;
}

/**
 * Validate a coordinator's edit of an event's information (SCRUM-387, AC6).
 *
 * The changed fields are held to SCRUM-10's submission rules, so the messages
 * match the submit form: a field submission requires cannot be cleared, a new
 * start must be in the future, and the end must follow the start when both are
 * sent. Every fault is listed at once. Whether the end follows the stored start
 * is the database function's to answer, after it has checked the caller: reading
 * the event here first would tell a stranger its dates.
 *
 * @param {object} body
 * @param {object} body.changes   camelCase fields and their new values; null clears an optional field
 * @param {object} body.expected  the value the form showed for each changed field (D12)
 * @param {string} body.reason    why, 1 to 4,000 characters (D5)
 * @param {object} [options]
 * @param {Date} [options.now]
 * @returns {{changes: object, expected: object, reason: string}} normalised
 * @throws {ValidationError} listing every problem found
 */
export function validateEventDetailsEdit(body, { now = new Date() } = {}) {
  assertObject(body);
  const errors = createErrorCollector();
  const { changes, expected, reason } = body;

  const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
  if (trimmedReason === '') errors.add('reason', 'is required');
  else if (Array.from(trimmedReason).length > EDIT_REASON_MAX_LENGTH) {
    errors.add('reason', `must be ${EDIT_REASON_MAX_LENGTH.toLocaleString('en-US')} characters or fewer`);
  }

  const changesIsObject = typeof changes === 'object' && changes !== null && !Array.isArray(changes);
  const expectedIsObject = typeof expected === 'object' && expected !== null && !Array.isArray(expected);
  if (!changesIsObject) errors.add('changes', 'must be an object of fields to change');
  if (!expectedIsObject) errors.add('expected', 'must be an object of the values the form showed');

  const supplied = changesIsObject ? Object.keys(changes) : [];
  const known = supplied.filter((field) => DETAIL_FIELDS.includes(field));
  for (const field of supplied) {
    if (!DETAIL_FIELDS.includes(field)) errors.add(field, 'cannot be edited here');
  }
  if (changesIsObject && supplied.length === 0) errors.add('changes', 'name at least one field to change');

  // SCRUM-10's collection pass over just the fields sent; those submission
  // requires may not be cleared.
  const fields = Object.fromEntries(known.map((field) => [field, changes[field]]));
  const mandatory = SUBMIT_MANDATORY.filter((field) => known.includes(field));
  const { normalised, instants } = collectEventRequest(errors, fields, mandatory);
  for (const field of known) {
    if (fields[field] === null && !mandatory.includes(field)) normalised[field] = null;
  }
  if (instants.proposedStart !== undefined && instants.proposedStart <= now) {
    errors.add('proposedStart', 'must be in the future');
  }

  const expectedValues = {};
  if (expectedIsObject) {
    for (const field of known) {
      if (!Object.prototype.hasOwnProperty.call(expected, field)) {
        errors.add(`expected.${field}`, 'is required for every field being changed');
      } else {
        expectedValues[field] = checkExpectedValue(errors, field, expected[field]);
      }
    }
  }

  throwIfInvalid(errors, 'Invalid event details');
  return { changes: normalised, expected: expectedValues, reason: trimmedReason };
}
