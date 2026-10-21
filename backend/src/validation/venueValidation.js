/**
 * Venue input validation.
 *
 * SCRUM-94: validate venue creation and update input.
 *
 * AC1: name, location and maximum capacity are mandatory, and capacity must be
 * a positive whole number.
 *
 * Pure and synchronous -- no database, no imports beyond the error types and
 * the shared timestamp rules (SCRUM-130). That
 * keeps it unit-testable without credentials, which is the point: the database
 * constraints in 002_venues.sql already guarantee correctness, and this layer
 * exists to say what went wrong in words a Venue Staff member can act on.
 *
 * SCRUM-186 adds the turnaround between events, one of a fixed list of
 * minutes (domain/turnaroundOptions.js).
 *
 * SCRUM-137 (SCRUM-20) adds the setup time before an event, checked the same
 * way against its own list (domain/setupOptions.js).
 *
 * SCRUM-493 (AC1) adds emergencyAccess and knownRestrictions, optional free
 * text of up to SAFETY_TEXT_MAX_LENGTH characters each (checkSafetyText).
 *
 * SCRUM-185 (SCRUM-178 AC1) adds includeRetired to the search filters, so a
 * retired venue's calendar can be reached from search.
 *
 * SCRUM-138 (SCRUM-20 AC1) adds validateEventSearchCriteria, the shape of a
 * search against an event's requirements; SCRUM-141 adds an optional location
 * to it. Code existence is still not checked
 * here, for the reason below; for a search there is no foreign key to fall
 * back on, so venueService.assertKnownCodes does it against the lookup tables.
 *
 * Deliberately NOT checked here: whether a layout or facility code exists.
 * That is referential integrity, the foreign keys enforce it, and
 * venueService.translateError turns the violation into a ValidationError
 * naming the bad code. Checking it here would make this module async and
 * database-dependent for no real gain.
 */

import { ValidationError } from '../errors.js';
import { UUID_PATTERN } from './ids.js';
import { createErrorCollector, throwIfInvalid } from './collector.js';
import { checkTimeWindow, checkTimestamp } from './timestampValidation.js';
import {
  TURNAROUND_MINUTES_OPTIONS,
  isTurnaroundOption,
} from '../domain/turnaroundOptions.js';
import { SETUP_MINUTES_OPTIONS, isSetupOption } from '../domain/setupOptions.js';

/** HH:MM or HH:MM:SS, with real hour and minute ranges. */
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;

const ATTRIBUTE_FIELDS = ['layouts', 'accessibility', 'facilities'];

/**
 * SCRUM-493: the two venue safety facts, optional free text.
 *
 * SAFETY_TEXT_MAX_LENGTH mirrors venues_emergency_access_length and
 * venues_known_restrictions_length in 036_venue_safety_facts.sql.
 */
export const SAFETY_TEXT_MAX_LENGTH = 2000;
const SAFETY_TEXT_FIELDS = ['emergencyAccess', 'knownRestrictions'];

/**
 * SCRUM-493 (AC2): text with no visible character counts as blank.
 *
 * Matches a string made only of whitespace and invisible format or filler
 * characters: \p{Cf} (U+200B-U+200F, U+2060, U+FEFF, U+00AD, U+180E among
 * them) plus the Braille blank U+2800 and the Hangul fillers U+3164, U+115F,
 * U+1160 and U+FFA0, which are letters or symbols to Unicode but draw nothing.
 * AC2 must let the Safety Officer tell a missing entry from a recorded one, so
 * a paste of only invisible characters is stored as null and reads "Not
 * recorded" rather than as an entry that looks empty.
 *
 * Exported so the frontend can mirror it. The database CHECK in
 * 036_venue_safety_facts.sql is not widened to match: a direct SQL write can
 * still store such text, an accepted and recorded limit.
 */
export const SAFETY_TEXT_BLANK_PATTERN = /^[\s\p{Cf}⠀ㅤᅟᅠﾠ]*$/u;

/**
 * SCRUM-493: an unpaired UTF-16 surrogate, a high one with no low after it or
 * a low one with no high before it. Together with U+0000 these are the
 * characters Postgres refuses: text cannot hold NUL, and PostgREST's JSON cast
 * rejects both. Left to the database they come back as a 500 through
 * venueService.translateError, so they are refused here as a field error.
 */
const UNPAIRED_SURROGATE_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** 'HH:MM' -> 'HH:MM:SS', so two times are always compared in the same shape. */
function withSeconds(time) {
  return time.length === 5 ? `${time}:00` : time;
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
 * AC1: "capacity must be a positive whole number".
 *
 * Strict about type on purpose. "40" is rejected rather than coerced, so a
 * caller sending strings finds out here instead of the bug surfacing later.
 *
 * Takes the field name because the same rule guards two different fields: a
 * venue's maxCapacity, and the minCapacity a search filters by.
 */
function checkCapacity(errors, field, value) {
  if (value === undefined || value === null) {
    errors.add(field, 'is required');
    return null;
  }
  if (typeof value !== 'number' || Number.isNaN(value)) {
    errors.add(field, 'must be a number');
    return null;
  }
  if (!Number.isInteger(value)) {
    errors.add(field, 'must be a whole number');
    return null;
  }
  if (value <= 0) {
    errors.add(field, 'must be greater than zero');
    return null;
  }
  return value;
}

/**
 * Attribute sets are arrays of lookup codes; existence is the FK's job.
 *
 * Exported for SCRUM-190: a booking request (bookingRequestValidation.js) and
 * the suitability check's query (venueSuitabilityValidation.js) carry the
 * same accessibility and facility code lists as an event search, and read
 * them by this one rule. errors is any collector with add(field, message).
 */
export function checkCodeArray(errors, field, value) {
  if (!Array.isArray(value)) {
    errors.add(field, 'must be an array of codes');
    return null;
  }
  const cleaned = [];
  value.forEach((code, index) => {
    if (typeof code !== 'string' || code.trim() === '') {
      errors.add(field, `entry ${index} must be a non-empty code`);
      return;
    }
    cleaned.push(code.trim());
  });
  return cleaned;
}

/**
 * Opening hours, one entry per day.
 *
 * The non-empty and duplicate-day rules mirror constraints the database already
 * has. That duplication is intentional -- the database is the guarantee, this
 * is the readable message.
 */
function checkHours(errors, value) {
  if (!Array.isArray(value)) {
    errors.add('hours', 'must be an array');
    return null;
  }

  const cleaned = [];
  const daysSeen = new Set();

  value.forEach((entry, index) => {
    const label = `hours[${index}]`;

    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.add('hours', `${label} must be an object`);
      return;
    }

    const { day_of_week: day, opens_at: opens, closes_at: closes } = entry;

    let valid = true;

    if (!Number.isInteger(day) || day < 0 || day > 6) {
      errors.add('hours', `${label}.day_of_week must be a whole number from 0 (Sunday) to 6`);
      valid = false;
    } else if (daysSeen.has(day)) {
      errors.add('hours', `${label} repeats day ${day}; each day may appear once`);
      valid = false;
    }

    if (typeof opens !== 'string' || !TIME_PATTERN.test(opens)) {
      errors.add('hours', `${label}.opens_at must be a time such as 09:00`);
      valid = false;
    }

    if (typeof closes !== 'string' || !TIME_PATTERN.test(closes)) {
      errors.add('hours', `${label}.closes_at must be a time such as 18:00`);
      valid = false;
    }

    // An earlier closing time is the next day (overnight hours), so only an
    // empty window is refused. Compared in one format: '09:00' and '09:00:00'
    // are the same time.
    if (valid && withSeconds(closes) === withSeconds(opens)) {
      errors.add(
        'hours',
        `${label}.closes_at must differ from opens_at (an earlier closing time means the next day)`,
      );
      valid = false;
    }

    if (valid) {
      daysSeen.add(day);
      cleaned.push({ day_of_week: day, opens_at: opens, closes_at: closes });
    }
  });

  return cleaned;
}

/**
 * SCRUM-186: turnaround between events, one of the allowed minute values.
 *
 * Only called when the field was supplied, so null here was sent on purpose
 * and is refused: update_venue reads NULL as "keep the current value", and a
 * request that says "clear it" should not quietly do nothing.
 */
function checkTurnaround(errors, value) {
  if (!isTurnaroundOption(value)) {
    errors.add(
      'turnaroundMinutes',
      `must be one of ${TURNAROUND_MINUTES_OPTIONS.join(', ')} minutes`,
    );
    return null;
  }
  return value;
}

/**
 * SCRUM-137: setup time before an event, one of the allowed minute values.
 *
 * A separate check from checkTurnaround, not a shared one, because the two
 * lists are separate (each mirrors its own CHECK in the database) and the
 * error must name the field the caller actually sent. Null is refused for the
 * same reason as there: update_venue reads NULL as "keep the current value".
 */
function checkSetup(errors, value) {
  if (!isSetupOption(value)) {
    errors.add(
      'setupMinutes',
      `must be one of ${SETUP_MINUTES_OPTIONS.join(', ')} minutes`,
    );
    return null;
  }
  return value;
}

/**
 * SCRUM-493 (AC1): emergency access or known restrictions -- optional text,
 * trimmed, blank (including invisible-only) becomes null, no character
 * Postgres refuses, at most SAFETY_TEXT_MAX_LENGTH characters.
 *
 * The same shape as venueBlockValidation.js checkNotes. Only called when the
 * field was supplied. Unlike setup and turnaround, null is accepted: it
 * means "nothing recorded" (AC2), so on an update null and a blank string
 * both normalise to null, which the service sends as a clear.
 *
 * Length is counted in code points (Array.from), not UTF-16 units
 * (String.length), because that is what Postgres char_length() counts. With
 * .length an emoji counts twice, so 1,001 emoji would be refused here while
 * the column happily stores them.
 *
 * @returns {string|null} the trimmed text, or null for "not recorded" (and
 *          when the value was refused)
 */
function checkSafetyText(errors, field, value) {
  if (value === null) return null;

  if (typeof value !== 'string') {
    errors.add(field, 'must be text');
    return null;
  }

  // Blank includes invisible-only text (SAFETY_TEXT_BLANK_PATTERN). Text with
  // a visible character is kept exactly as trimmed, invisible ones and all.
  const trimmed = value.trim();
  if (SAFETY_TEXT_BLANK_PATTERN.test(trimmed)) return null;

  // Before the length check: a character Postgres cannot store is the
  // problem to report, whatever the length.
  if (trimmed.includes('\u0000') || UNPAIRED_SURROGATE_PATTERN.test(trimmed)) {
    errors.add(field, 'must not contain unsupported characters');
    return null;
  }

  if (Array.from(trimmed).length > SAFETY_TEXT_MAX_LENGTH) {
    errors.add(field, `must be ${SAFETY_TEXT_MAX_LENGTH} characters or fewer`);
  }

  return trimmed;
}


/**
 * Validate input for creating a venue.
 *
 * @param {object} input
 * @returns {object} a normalised copy -- name and location trimmed
 * @throws {ValidationError} listing every problem found, not just the first
 */
export function validateCreateVenue(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('Invalid venue details -- expected an object');
  }

  const errors = createErrorCollector();
  const normalised = {};

  normalised.name = checkRequiredText(errors, 'name', input.name);
  normalised.location = checkRequiredText(errors, 'location', input.location);
  normalised.maxCapacity = checkCapacity(errors, 'maxCapacity', input.maxCapacity);

  for (const field of ATTRIBUTE_FIELDS) {
    if (input[field] !== undefined) {
      normalised[field] = checkCodeArray(errors, field, input[field]);
    }
  }

  if (input.hours !== undefined) {
    normalised.hours = checkHours(errors, input.hours);
  }

  if (input.turnaroundMinutes !== undefined) {
    normalised.turnaroundMinutes = checkTurnaround(errors, input.turnaroundMinutes);
  }

  if (input.setupMinutes !== undefined) {
    normalised.setupMinutes = checkSetup(errors, input.setupMinutes);
  }

  // SCRUM-493: optional; null or blank means nothing recorded.
  for (const field of SAFETY_TEXT_FIELDS) {
    if (input[field] !== undefined) {
      normalised[field] = checkSafetyText(errors, field, input[field]);
    }
  }

  throwIfInvalid(errors, 'Invalid venue details');
  return normalised;
}

/** More bookings than any venue holds; caps the work one request can ask for. */
const CONFIRM_HOURS_CHANGE_MAX = 500;

/**
 * Optional confirmHoursChange: the booking ids the user saw listed and agreed
 * to flag. Lowercased and de-duplicated, because the service compares it with
 * the ids Postgres prints.
 *
 * @returns {string[]|undefined} undefined when refused
 */
function checkConfirmHoursChange(errors, value) {
  if (!Array.isArray(value)) {
    errors.add('confirmHoursChange', 'must be a list of booking ids');
    return undefined;
  }
  if (value.some((id) => typeof id !== 'string' || !UUID_PATTERN.test(id))) {
    errors.add('confirmHoursChange', 'must contain only booking ids');
    return undefined;
  }
  if (value.length > CONFIRM_HOURS_CHANGE_MAX) {
    errors.add('confirmHoursChange', `must list ${CONFIRM_HOURS_CHANGE_MAX} bookings or fewer`);
    return undefined;
  }
  return [...new Set(value.map((id) => id.toLowerCase()))];
}

/**
 * Validate input for updating a venue. Every field is optional.
 *
 * An empty object is rejected: an update that changes nothing is a caller bug,
 * not a request worth a database round trip.
 *
 * A supplied name or location must still be non-empty. Omitting a field means
 * "leave unchanged" (see update_venue in 004_venue_functions.sql), so there is
 * no way to clear a mandatory field -- a blank string is a mistake.
 *
 * @param {object} changes
 * @returns {object} a normalised copy containing only the supplied fields
 * @throws {ValidationError}
 */
export function validateUpdateVenue(changes) {
  if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) {
    throw new ValidationError('Invalid venue details -- expected an object');
  }

  // confirmHoursChange only confirms a change, so on its own it changes nothing.
  const supplied = Object.keys(changes)
    .filter((key) => key !== 'confirmHoursChange' && changes[key] !== undefined);
  if (supplied.length === 0) {
    throw new ValidationError('Invalid venue details -- no changes supplied');
  }

  const errors = createErrorCollector();
  const normalised = {};

  if (changes.name !== undefined) {
    normalised.name = checkRequiredText(errors, 'name', changes.name);
  }

  if (changes.location !== undefined) {
    normalised.location = checkRequiredText(errors, 'location', changes.location);
  }

  if (changes.maxCapacity !== undefined) {
    normalised.maxCapacity = checkCapacity(errors, 'maxCapacity', changes.maxCapacity);
  }

  for (const field of ATTRIBUTE_FIELDS) {
    if (changes[field] !== undefined) {
      normalised[field] = checkCodeArray(errors, field, changes[field]);
    }
  }

  if (changes.hours !== undefined) {
    normalised.hours = checkHours(errors, changes.hours);
  }

  // !== undefined, not truthiness: 0 is a real choice, so {turnaroundMinutes: 0}
  // on its own is a change and passes the "no changes supplied" rule above.
  if (changes.turnaroundMinutes !== undefined) {
    normalised.turnaroundMinutes = checkTurnaround(errors, changes.turnaroundMinutes);
  }

  // Same rule for setup: {setupMinutes: 0} alone is a change. The "no changes
  // supplied" count above already sees it, because it counts every key whose
  // value is not undefined -- so no field list there needs updating.
  if (changes.setupMinutes !== undefined) {
    normalised.setupMinutes = checkSetup(errors, changes.setupMinutes);
  }

  // SCRUM-493: supplied means changed. null or blank normalises to null,
  // which here means "clear it" (the service sends it as ''), so the key is
  // kept even when its value is null. {knownRestrictions: null} on its own is
  // therefore a change: the "no changes supplied" count above looks at keys
  // whose value is not undefined, and null is not undefined.
  for (const field of SAFETY_TEXT_FIELDS) {
    if (changes[field] !== undefined) {
      normalised[field] = checkSafetyText(errors, field, changes[field]);
    }
  }

  if (changes.confirmHoursChange !== undefined) {
    normalised.confirmHoursChange = checkConfirmHoursChange(errors, changes.confirmHoursChange);
  }

  throwIfInvalid(errors, 'Invalid venue details');
  return normalised;
}

/**
 * Validate a venue id before it reaches the database.
 *
 * SCRUM-110. Retirement is the only destructive operation on the catalogue, so
 * a malformed id is refused here rather than sent to Postgres and returned as
 * a driver-level cast error that names no field.
 *
 * @param {string} id
 * @returns {string} the id, unchanged
 * @throws {ValidationError}
 */
export function validateVenueId(id) {
  const errors = createErrorCollector();

  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    errors.add('id', 'must be a venue id');
  }

  throwIfInvalid(errors, 'Invalid venue details');
  return id;
}

/**
 * An unfilled search box is not a filter.
 *
 * This is the one place blankness is forgiven rather than reported. On create
 * and update a blank name is a mistake worth naming; on a search it is just a
 * field the user did not fill in, and rejecting it would make an empty form
 * unsubmittable.
 */
function isUnset(value) {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '')
  );
}

/**
 * Validate the filters a venue search may be narrowed by.
 *
 * SCRUM-111. Every filter is optional and, unlike validateUpdateVenue, an
 * empty object is valid -- "show me everything" is a legitimate search rather
 * than a caller bug.
 *
 * Retirement was deliberately not a filter: AC3 makes active-only the rule
 * for every search. SCRUM-185 (SCRUM-178 AC1) adds one exception,
 * includeRetired, so Venue Staff and Event Coordinators can find a retired
 * venue and open its calendar. This module only checks its shape; who may set
 * it is the route's rule (routes/venues.js), because validation knows no
 * roles. Without it a search is active-only exactly as before.
 *
 * SCRUM-130 adds an optional startsAt/endsAt window, both or neither, through
 * the same checkTimeWindow the block window uses. No length cap: how long an
 * event may run is SCRUM-20's rule, and a search should not invent one.
 *
 * @param {object} [filters]
 * @param {string} [filters.location]     matched as a substring, case-insensitively
 * @param {number} [filters.minCapacity]  venues that seat at least this many
 * @param {string} [filters.startsAt]     SCRUM-130: ISO 8601 with an offset
 * @param {string} [filters.endsAt]       SCRUM-130: ISO 8601 with an offset;
 *                                        later than startsAt
 * @param {boolean|string} [filters.includeRetired]  SCRUM-185: true or
 *                                        'true' to include retired venues;
 *                                        false, 'false' or unset leaves it
 *                                        off. Not with a date window.
 * @returns {object} a normalised copy holding only the filters actually supplied
 * @throws {ValidationError}
 */
export function validateSearchFilters(filters = {}) {
  if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) {
    throw new ValidationError('Invalid venue search -- expected an object');
  }

  const errors = createErrorCollector();
  const normalised = {};

  if (!isUnset(filters.location)) {
    normalised.location = checkRequiredText(errors, 'location', filters.location);
  }

  if (!isUnset(filters.minCapacity)) {
    normalised.minCapacity = checkCapacity(errors, 'minCapacity', filters.minCapacity);
  }

  // Keys only when a window was given, so a dateless search normalises to
  // exactly what it did before SCRUM-130.
  const window = checkTimeWindow(errors, ['startsAt', 'endsAt'], filters.startsAt, filters.endsAt);
  if (window !== null) {
    normalised.startsAt = window.start;
    normalised.endsAt = window.end;
  }

  // SCRUM-185. The key is set only when true, so a search without the flag --
  // or with it off -- normalises to exactly what it did before.
  const includeRetired = checkIncludeRetired(errors, filters.includeRetired);
  if (includeRetired) {
    if (window !== null) {
      errors.add(
        'includeRetired',
        'cannot be combined with a date window: a retired venue cannot be booked',
      );
    } else {
      normalised.includeRetired = true;
    }
  }

  throwIfInvalid(errors, 'Invalid venue details');
  return normalised;
}

/**
 * The includeRetired flag: a boolean, or its query-string spelling.
 *
 * SCRUM-185. A query parameter is always text, so 'true' and 'false' are
 * accepted alongside the booleans. Nothing else is: not 'TRUE', '1' or 'yes',
 * and not the array Express builds from a repeated parameter. A flag that
 * widens what a search can reach should mean one thing, and a near miss is
 * reported rather than guessed at. Unset (undefined, null or blank) is off,
 * like every other search field (isUnset).
 *
 * @returns {boolean} true only for true or 'true'
 */
function checkIncludeRetired(errors, value) {
  if (isUnset(value) || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  errors.add('includeRetired', 'must be true or false');
  return false;
}

/**
 * Validate a search against an event's requirements.
 *
 * SCRUM-138, for SCRUM-20 AC1: "search by event date, start time, end time and
 * expected attendance; room layout, accessibility features and facilities are
 * optional." The date and times travel as two instants, startsAt and endsAt,
 * because an instant with an offset is the one wire format this system
 * accepts for a moment in time (timestampValidation.js).
 *
 * Unlike validateSearchFilters, the period and attendance are REQUIRED: AC3's
 * hours and capacity checks have nothing to compare without them, and a
 * default would quietly search for an event nobody described.
 *
 * Every fault is reported at once, as everywhere else in this module. Unknown
 * keys are ignored, as everywhere else too.
 *
 * SCRUM-141 adds location, the one criterion the Week 4 instructions list that
 * AC1 does not. It is optional, like layout and the code lists.
 *
 * Leaving an optional criterion out means it is not filtered on. A blank
 * layout or location and an empty list are treated the same as leaving it
 * out (B-AC1-15): an unfilled form field is not a criterion, and "provides
 * every one of nothing" filters nothing anyway. So the normalised object carries an
 * optional key only when there is something to filter by.
 *
 * Whether each code exists is NOT checked here -- see the header. The service
 * checks it (assertKnownCodes) after this has passed.
 *
 * @param {object} input
 * @param {string} input.startsAt            ISO 8601 with an offset
 * @param {string} input.endsAt              ISO 8601 with an offset; later than startsAt
 * @param {number} input.expectedAttendance  a positive whole number
 * @param {string} [input.layout]            one room layout code
 * @param {string[]} [input.accessibility]   accessibility feature codes
 * @param {string[]} [input.facilities]      facility codes
 * @param {string} [input.location]          SCRUM-141: text the venue's
 *                                           location must contain
 * @param {string} [input.eventRequestId]    SCRUM-491: the event being
 *                                           searched for, so its own holds
 *                                           can be left out (the service
 *                                           decides whether they are)
 * @returns {object} a normalised copy: startsAt and endsAt trimmed, codes
 *                   and location trimmed, optional keys only when something
 *                   was supplied
 * @throws {ValidationError} listing every problem found
 */
export function validateEventSearchCriteria(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('Invalid venue search -- expected an object');
  }

  const errors = createErrorCollector();
  const normalised = {};

  checkRequiredPeriod(errors, input.startsAt, input.endsAt, normalised);

  normalised.expectedAttendance = checkCapacity(
    errors,
    'expectedAttendance',
    input.expectedAttendance,
  );

  if (!isUnset(input.layout)) {
    // isUnset has already ruled out a blank string, so a string here is a code.
    if (typeof input.layout === 'string') {
      normalised.layout = input.layout.trim();
    } else {
      errors.add('layout', 'must be a single layout code');
    }
  }

  for (const field of ['accessibility', 'facilities']) {
    if (input[field] === undefined || input[field] === null) continue;
    const codes = checkCodeArray(errors, field, input[field]);
    if (codes !== null && codes.length > 0) normalised[field] = codes;
  }

  // SCRUM-141: location, optional like the codes above. Shaped like layout:
  // isUnset has ruled out a blank string, so a string here is something to
  // match, trimmed; anything else gets checkRequiredText's wording for a
  // text field that is not text.
  if (!isUnset(input.location)) {
    if (typeof input.location === 'string') {
      normalised.location = input.location.trim();
    } else {
      errors.add('location', 'must be text');
    }
  }

  // SCRUM-491 (AC5): optional, and only the shape is checked here. Whether
  // the caller may leave this event's holds out is the service's question
  // (venueService.findVenuesForEvent), because it needs the stored event.
  if (!isUnset(input.eventRequestId)) {
    if (typeof input.eventRequestId === 'string' && UUID_PATTERN.test(input.eventRequestId.trim())) {
      normalised.eventRequestId = input.eventRequestId.trim().toLowerCase();
    } else {
      errors.add('eventRequestId', 'must be a valid event id');
    }
  }

  throwIfInvalid(errors, 'Invalid venue search');
  return normalised;
}

/**
 * The event's period: both ends required, each a valid instant, end after start.
 *
 * checkTimeWindow treats a window as optional -- neither end given is "no
 * window" and records nothing -- and its message for one missing end is "is
 * required when a start is given". Here the period is required outright, so a
 * missing end is reported as plainly "is required", whatever the other end did.
 *
 * Both given: checkTimeWindow does the whole job, including "must be later
 * than the start". One or none given: each missing end is reported, and any
 * end that was given is still checked on its own, so a missing endsAt and a
 * malformed startsAt come back together rather than one per round trip.
 */
function checkRequiredPeriod(errors, startValue, endValue, normalised) {
  const fields = ['startsAt', 'endsAt'];
  const values = [startValue, endValue];

  if (values.every((value) => !isUnset(value))) {
    const window = checkTimeWindow(errors, fields, startValue, endValue);
    if (window !== null) {
      normalised.startsAt = window.start;
      normalised.endsAt = window.end;
    }
    return;
  }

  fields.forEach((field, index) => {
    if (isUnset(values[index])) {
      errors.add(field, 'is required');
    } else {
      checkTimestamp(errors, field, values[index]);
    }
  });
}
