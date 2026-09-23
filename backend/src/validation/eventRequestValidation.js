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
 * types, and no clock read except the default for the injected `now`. That
 * keeps it unit-testable without credentials and deterministic in CI.
 *
 * Deliberately NOT checked here:
 *
 *  - Whether the Organiser exists, or owns this request. That is authorisation,
 *    it needs the caller's role and the event relationship, and it belongs in
 *    the API layer where both are known.
 *  - Any minimum notice between submission and the proposed start. The customer
 *    has not said what that period should be; inventing one would be a business
 *    rule nobody asked for. Open for the next Q&A.
 *  - Timezone conversion. A caller must state an offset (see TIMESTAMP_PATTERN)
 *    but the value is passed on as written: the column is timestamptz, so
 *    Postgres is the authority on resolving it, and a second interpretation
 *    here could only introduce disagreement.
 *  - submitted_at, and any status transition. Whether the move to 'submitted'
 *    is legal is answered by canTransition in src/domain/eventRequestStatus.js,
 *    and stamping the timestamp is the service layer's job. This module answers
 *    one question only: is this input good enough to submit?
 */

import { ValidationError } from '../errors.js';


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


/** A date with no time of day at all. Checked first so it can be named. */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date and time with no offset. Exists only to produce a better message than
 * "malformed" for a value that is nearly right, so its date part stays loose --
 * anything reaching it already has a time of day and no offset.
 */
const LOCAL_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/;

/**
 * An instant this system will accept: a real calendar date, a time of day, and
 * an explicit offset. Seconds and fractional seconds are optional, following
 * the TIME_PATTERN precedent in venueValidation.js -- no Organiser types
 * milliseconds, and demanding them would refuse a well-formed value.
 *
 * The offset is required, not optional. ECMAScript parses a date-time without
 * one as LOCAL time while parsing a date-only value as UTC, so an offset-less
 * string means a different instant on a developer's machine, on Supabase and in
 * CI -- the same stored request would describe three different periods.
 *
 * Ranges are spelled out rather than left as \d{2} for the same reason
 * TIME_PATTERN spells out hours and minutes: '2026-13-45' should be refused for
 * what it is, not survive to be caught by a parse failure further down.
 */
const TIMESTAMP_PATTERN =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d)(\.\d+)?)?(Z|[+-]([01]\d|2[0-3]):([0-5]\d))$/;

/**
 * How many days that month actually had, leap years included.
 *
 * Date.UTC(year, month, 0) is day zero of the following month, which is the
 * last day of this one -- month being 1-based here and 0-based there.
 */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}


/**
 * Collects problems so every fault in a form is reported at once.
 *
 * Deliberately a copy of createErrorCollector and throwIfInvalid in
 * venueValidation.js rather than an import from it. Both modules are being
 * written on live branches this sprint, and reaching into a teammate's file to
 * export its private helpers would put a merge conflict in the middle of
 * someone else's story for no behavioural gain. Extracting a shared
 * src/validation/validationHelpers.js is the right end state and is a refactor
 * candidate once both branches are merged -- not before.
 */
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

  throw new ValidationError(`Invalid event request details -- ${summary}`, errors.details);
}

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
 * A timestamp, checked on the string's shape before it is parsed.
 *
 * The order matters and is the whole point of the two-step approach. A
 * deliberate midnight event, '2026-06-01T00:00:00Z', and a date-only
 * '2026-06-01' resolve to exactly the same instant, so no examination of the
 * parsed value can tell them apart -- a rule inferred from the instant would
 * have to refuse real midnight events. Only the string distinguishes them.
 *
 * The calendar day is then checked arithmetically rather than by trusting the
 * parse. '2026-02-30T09:00:00Z' matches every pattern here and is not a day,
 * and new Date() does not refuse it: V8 rolls it forward to 2026-03-02 and
 * reports success. An Organiser who typed 30 February would have been handed an
 * event two days later without being told -- the same silently invented value
 * the offset and time-of-day rules exist to stop.
 *
 * @returns {Date|null} the instant, or null when a fault was recorded
 */
function checkTimestamp(errors, field, value) {
  if (typeof value !== 'string') {
    // Strict about type, as checkCapacity in venueValidation.js is: epoch
    // milliseconds are a number the platform would happily accept, and a caller
    // sending them should find out here rather than three stories downstream.
    errors.add(field, 'must be an ISO 8601 date and time, given as text');
    return null;
  }

  const text = value.trim();

  if (DATE_ONLY_PATTERN.test(text)) {
    // Naming the real fault. "Invalid timestamp" would send the Organiser
    // hunting for a typo in a date that is perfectly well formed.
    errors.add(field, 'must include a time of day, not a date on its own');
    return null;
  }

  if (LOCAL_DATETIME_PATTERN.test(text)) {
    errors.add(field, 'must include a UTC offset, such as Z or +08:00');
    return null;
  }

  const match = TIMESTAMP_PATTERN.exec(text);
  if (match === null) {
    errors.add(
      field,
      'must be an ISO 8601 date and time such as 2026-06-01T09:00:00+08:00',
    );
    return null;
  }

  const [, year, month, day] = match;
  if (Number(day) > daysInMonth(Number(year), Number(month))) {
    errors.add(field, 'is not a real date -- that month does not have that many days');
    return null;
  }

  const instant = new Date(text);
  if (Number.isNaN(instant.getTime())) {
    // Unreachable for anything matching the pattern above on this engine, and
    // kept as a backstop rather than removed: it costs one comparison, and the
    // alternative is trusting that no future engine parses differently.
    errors.add(field, 'is not a real date');
    return null;
  }

  return instant;
}

/**
 * AC1 of the venue story put the same rule on capacity: a positive whole number.
 *
 * Strict about type on purpose. '40' is refused rather than coerced, so the
 * fault surfaces here instead of inside Venue Suitability Checking, where
 * attendance is compared with a venue's capacity.
 */
function checkAttendance(errors, value) {
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

  throwIfInvalid(errors);
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
 * KNOWN LIMITATION, recorded rather than accidental: a PATCH cannot *clear*
 * an optional field. collectEventRequest treats an explicit null as "not
 * answered" and leaves the key off the copy entirely, which is the same
 * semantics the create path documents and depends on. Giving "clear this" a
 * wire representation of its own is a later decision -- the frontend sends
 * undefined for an untouched field anyway, so nothing is blocked on it today.
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

  throwIfInvalid(errors);

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

  throwIfInvalid(errors);
  return normalised;
}
