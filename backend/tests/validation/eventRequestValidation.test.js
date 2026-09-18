/**
 * Tests for event request input validation.
 *
 * SCRUM-30, a subtask of SCRUM-10 (Create Event Request).
 *
 * Written before src/validation/eventRequestValidation.js exists, so the first
 * run of this file cannot resolve its import. That is deliberate: the evidence
 * asked for is a history of failing tests followed by the implementation that
 * turns them green, not tests reconstructed after the fact.
 *
 * Test names carry the ticket and the acceptance criterion they prove --
 * SCRUM10_AC2_* for accepting and normalising what the Organiser supplied,
 * SCRUM10_AC4_* for the refusal rules -- so a criterion traces to its test
 * without anyone having to read the body first.
 *
 * Why the rules are asserted against two functions rather than one:
 *
 * The Postgres enum event_request_status begins at 'draft' and the status
 * column defaults to it (001_event_requests.sql), so every request is born
 * incomplete by design, and SCRUM-11 (save/edit draft) depends on that staying
 * true. The schema therefore cannot express which fields are mandatory -- 001
 * leaves them nullable and 005_event_request_details.sql records the reasoning
 * in its header. Mandatoriness is a rule about one state change, draft ->
 * submitted, not a rule every row must satisfy at all times. So the strict
 * expectations below are asserted against validateSubmitEventRequest, and
 * validateCreateEventRequest is expected to stay permissive.
 */

import { describe, it, expect } from 'vitest';

import {
  validateCreateEventRequest,
  validateSubmitEventRequest,
} from '../../src/validation/eventRequestValidation.js';
import { ValidationError } from '../../src/errors.js';


/**
 * A fixed "current time", passed explicitly to every submission test.
 *
 * validateSubmitEventRequest accepts now as an injected option purely so these
 * tests are deterministic. A test that compared against the real clock would
 * pass today and fail tomorrow, or pass locally and fail in CI. Every instant
 * in this file is chosen relative to this constant, never to the real date.
 */
const NOW = new Date('2026-01-15T09:00:00.000Z');

/** The least an Organiser can save and still have a findable draft. */
const DRAFT = Object.freeze({
  eventName: 'IS212 Industry Night',
});

/**
 * A submission that satisfies every rule.
 *
 * These five fields are the ones required at submission, on the rule that a
 * field is mandatory when a downstream feature cannot function without it:
 *
 *  - proposedStart / proposedEnd: Step 6 has the Coordinator searching venues
 *    by date and time, and Booking Conflict Detection and Setup/Turnaround
 *    Time both compute on the period. Neither works with only one end of it.
 *  - expectedAttendance: Venue Suitability Checking states that a venue should
 *    not normally be treated as suitable when attendance exceeds its capacity.
 *  - eventName: already not null in the schema.
 *  - purpose: the weakest of the five, and a deliberate call rather than an
 *    obvious one. Nothing computes on it, but Step 5 has the Coordinator
 *    deciding whether planning should proceed, and that judgement cannot be
 *    made without knowing what the event is for.
 */
const SUBMITTABLE = Object.freeze({
  eventName: 'IS212 Industry Night',
  purpose: 'Connect final-year students with industry partners.',
  proposedStart: '2026-06-01T09:00:00.000Z',
  proposedEnd: '2026-06-01T17:00:00.000Z',
  expectedAttendance: 120,
});

/**
 * Text fields that stay optional even at submission.
 *
 * The briefing's own worked example is an Organiser asking for a "large room"
 * without stating expected attendance, and Step 4 (Review and Clarification)
 * exists precisely to resolve that vagueness. Step 8 makes equipment
 * conditional -- "where equipment or technical support is required and
 * requested by the Event Organiser". Demanding precision at submission would
 * contradict the process the customer described.
 */
const OPTIONAL_TEXT = Object.freeze([
  'description',
  'venueRequirements',
  'accessibilityRequirements',
  'equipmentRequirements',
]);


/** Run validation and return the thrown error, or null if it passed. */
function errorFrom(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

/** Which fields a failed validation complained about. */
function fieldsIn(err) {
  return err.details.map((d) => d.field);
}

/** What it said about one particular field. */
function messageFor(err, field) {
  return err.details.find((d) => d.field === field)?.message;
}

/**
 * The instant a timestamp stands for, however it happens to be encoded.
 *
 * The specification fixes which timestamps are accepted but not what a
 * normalised one is handed back as -- an ISO string or a Date. Asserting on the
 * instant keeps these tests from quietly deciding that on the implementation's
 * behalf; the open question is recorded for the next customer Q&A.
 */
function instantOf(value) {
  return new Date(value).getTime();
}


// ---------------------------------------------------------------------------
// Creating a draft
// ---------------------------------------------------------------------------
describe('AC2: a draft is accepted with whatever the Organiser has so far', () => {
  it('SCRUM10_AC2_accepts_a_draft_with_only_an_event_name', () => {
    // Step 1 of the process: the Organiser creates a draft and may save it and
    // keep editing before submitting. Anything stricter breaks SCRUM-11.
    expect(validateCreateEventRequest({ ...DRAFT })).toMatchObject(DRAFT);
  });

  it('SCRUM10_AC2_accepts_a_draft_with_every_field_supplied', () => {
    const input = {
      ...SUBMITTABLE,
      description: 'An evening of short talks followed by networking.',
      venueRequirements: 'A large room, ideally tiered seating.',
      accessibilityRequirements: 'Step-free access to the stage.',
      equipmentRequirements: 'Two handheld microphones and a projector.',
    };

    const result = validateCreateEventRequest(input);

    expect(result).toMatchObject({
      eventName: input.eventName,
      purpose: input.purpose,
      description: input.description,
      expectedAttendance: input.expectedAttendance,
      venueRequirements: input.venueRequirements,
      accessibilityRequirements: input.accessibilityRequirements,
      equipmentRequirements: input.equipmentRequirements,
    });
    expect(instantOf(result.proposedStart)).toBe(instantOf(input.proposedStart));
    expect(instantOf(result.proposedEnd)).toBe(instantOf(input.proposedEnd));
  });

  it('SCRUM10_AC2_accepts_proposed_dates_that_are_already_in_the_past', () => {
    // Creation deliberately does not look at the clock. A draft may be written
    // one day and edited over several more, and the dates in it are a working
    // guess until it is sent. The future-dated rule belongs to the transition.
    expect(() =>
      validateCreateEventRequest({
        ...DRAFT,
        proposedStart: '2020-03-01T09:00:00.000Z',
        proposedEnd: '2020-03-01T17:00:00.000Z',
      }),
    ).not.toThrow();
  });

  it('SCRUM10_AC2_returns_a_copy_and_does_not_mutate_the_input', () => {
    // The caller's request body is not ours to edit: the service layer reads it
    // again when mapping camelCase fields onto snake_case columns.
    const input = { ...SUBMITTABLE, description: '  padded  ' };
    const before = structuredClone(input);

    validateCreateEventRequest(input);

    expect(input).toEqual(before);
  });
});


describe('AC2: supplied text is normalised', () => {
  it('SCRUM10_AC2_trims_surrounding_whitespace_from_text_fields', () => {
    const result = validateCreateEventRequest({
      eventName: '  IS212 Industry Night  ',
      purpose: '  Connect students with industry.  ',
      venueRequirements: '  A large room.  ',
    });

    expect(result.eventName).toBe('IS212 Industry Night');
    expect(result.purpose).toBe('Connect students with industry.');
    expect(result.venueRequirements).toBe('A large room.');
  });

  it.each(OPTIONAL_TEXT)('SCRUM10_AC2_normalises_an_empty_%s_to_null', (field) => {
    // An unanswered requirement is absent, not an empty string. Storing ''
    // would make "the Organiser said nothing" indistinguishable from "the
    // Organiser said nothing matters", and the submission check reads absence.
    // The same reasoning is written into 005_event_request_details.sql.
    expect(validateCreateEventRequest({ ...DRAFT, [field]: '' })[field]).toBeNull();
  });

  it.each(OPTIONAL_TEXT)('SCRUM10_AC2_normalises_a_whitespace_only_%s_to_null', (field) => {
    expect(validateCreateEventRequest({ ...DRAFT, [field]: '   ' })[field]).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// Refusal rules
// ---------------------------------------------------------------------------
describe('AC4: input that is not an object is refused outright', () => {
  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'IS212 Industry Night'],
    ['a number', 7],
  ])('SCRUM10_AC4_refuses_input_that_is_%s', (_label, value) => {
    expect(() => validateCreateEventRequest(value)).toThrow(ValidationError);
    expect(() => validateSubmitEventRequest(value, { now: NOW })).toThrow(ValidationError);
  });

  it('SCRUM10_AC4_collects_nothing_when_there_is_no_form_to_collect_against', () => {
    // Field-by-field collection is the right behaviour for a form with faults
    // in it. A non-object is not a form, so there is nothing to enumerate --
    // but details still exists, so no caller has to guard against its absence.
    const err = errorFrom(() => validateCreateEventRequest(null));

    expect(err).toBeInstanceOf(ValidationError);
    expect(Array.isArray(err.details)).toBe(true);
    expect(err.details).toHaveLength(0);
  });
});


describe('AC4: an event name is always required', () => {
  it('SCRUM10_AC4_refuses_a_draft_with_no_event_name', () => {
    // The one field the schema itself insists on: a draft still has to be
    // findable in the Organiser's own list of requests.
    const err = errorFrom(() => validateCreateEventRequest({}));

    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err)).toContain('eventName');
    expect(messageFor(err, 'eventName')).toMatch(/is required/i);
  });

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('SCRUM10_AC4_refuses_an_event_name_that_is_%s', (_label, value) => {
    // Blank is judged after trimming, so '   ' cannot slip past this layer and
    // then fail the schema's length(trim(event_name)) > 0 check instead.
    const err = errorFrom(() => validateCreateEventRequest({ eventName: value }));

    expect(fieldsIn(err)).toContain('eventName');
  });
});


describe('AC4: a supplied timestamp must be a well-formed instant', () => {
  it.each([
    ['not a date at all', 'not-a-date'],
    ['an empty string', ''],
    ['an impossible calendar date', '2026-13-45T00:00:00.000Z'],
    ['epoch milliseconds rather than an ISO string', 1780000000000],
  ])('SCRUM10_AC4_refuses_a_timestamp_that_is_%s', (_label, value) => {
    // Structural, so it is checked at creation and not only at submission: an
    // unparseable timestamp is never a fact worth saving, draft or otherwise.
    const startErr = errorFrom(() =>
      validateCreateEventRequest({ ...DRAFT, proposedStart: value }),
    );
    expect(fieldsIn(startErr)).toContain('proposedStart');

    const endErr = errorFrom(() =>
      validateCreateEventRequest({ ...DRAFT, proposedEnd: value }),
    );
    expect(fieldsIn(endErr)).toContain('proposedEnd');
  });

  it('SCRUM10_AC4_refuses_a_date_only_proposed_start', () => {
    // '2026-06-01' is valid ISO 8601 and parses without complaint, which is
    // exactly what makes it dangerous: it becomes midnight UTC, 08:00 in
    // Singapore where ConnectSphere operates, and the Coordinator is handed a
    // venue search for a period nobody chose. The fault is a silently invented
    // time of day rather than a parse failure, so nothing downstream can spot
    // it -- Step 6 searches by date and time and gets a plausible-looking lie.
    const createErr = errorFrom(() =>
      validateCreateEventRequest({ ...DRAFT, proposedStart: '2026-06-01' }),
    );
    expect(createErr).toBeInstanceOf(ValidationError);
    expect(fieldsIn(createErr)).toContain('proposedStart');

    // Structural, so it holds at submission too. A draft carrying a guessed
    // start is not a fact worth storing either.
    const submitErr = errorFrom(() =>
      validateSubmitEventRequest(
        { ...SUBMITTABLE, proposedStart: '2026-06-01' },
        { now: NOW },
      ),
    );
    expect(fieldsIn(submitErr)).toContain('proposedStart');
  });

  it('SCRUM10_AC4_refuses_a_date_only_proposed_end', () => {
    // The same invented default at the other end of the period, where it
    // shortens the event instead of moving it -- and Setup/Turnaround Time
    // computes on the end. '2026-06-02' is used rather than the start's own
    // date so the value is genuinely after the start, leaving the missing time
    // of day as the only thing left to complain about.
    const createErr = errorFrom(() =>
      validateCreateEventRequest({
        ...DRAFT,
        proposedStart: '2026-06-01T09:00:00.000Z',
        proposedEnd: '2026-06-02',
      }),
    );
    expect(createErr).toBeInstanceOf(ValidationError);
    expect(fieldsIn(createErr)).toContain('proposedEnd');

    const submitErr = errorFrom(() =>
      validateSubmitEventRequest(
        { ...SUBMITTABLE, proposedEnd: '2026-06-02' },
        { now: NOW },
      ),
    );
    expect(fieldsIn(submitErr)).toContain('proposedEnd');
  });

  it('SCRUM10_AC4_says_a_time_of_day_is_required', () => {
    // The Organiser has to be told what to change. A message like "must be a
    // valid timestamp" would send them hunting for a typo in a date that is
    // already well formed, because the date is not what is wrong with it.
    const startErr = errorFrom(() =>
      validateCreateEventRequest({ ...DRAFT, proposedStart: '2026-06-01' }),
    );
    expect(messageFor(startErr, 'proposedStart')).toMatch(/time of day/i);

    const endErr = errorFrom(() =>
      validateCreateEventRequest({ ...DRAFT, proposedEnd: '2026-06-01' }),
    );
    expect(messageFor(endErr, 'proposedEnd')).toMatch(/time of day/i);
  });

  it('SCRUM10_AC4_refuses_a_datetime_with_no_offset', () => {
    // Closes the local-time ambiguity. ECMAScript parses a date-time with no
    // offset as LOCAL time, while it parses a date-only value as UTC -- so
    // '2026-06-01T09:00:00' means a different instant on a developer's laptop,
    // on Supabase and in CI, and the same stored request would describe three
    // different periods depending on which machine read it in. The Organiser
    // did state a time of day here, so the previous rule is satisfied; what is
    // missing is which nine o'clock they meant.
    const createErr = errorFrom(() =>
      validateCreateEventRequest({ ...DRAFT, proposedStart: '2026-06-01T09:00:00' }),
    );
    expect(createErr).toBeInstanceOf(ValidationError);
    expect(fieldsIn(createErr)).toContain('proposedStart');
    expect(messageFor(createErr, 'proposedStart')).toMatch(/offset/i);

    const submitErr = errorFrom(() =>
      validateSubmitEventRequest(
        { ...SUBMITTABLE, proposedStart: '2026-06-01T09:00:00' },
        { now: NOW },
      ),
    );
    expect(fieldsIn(submitErr)).toContain('proposedStart');
  });

  it('SCRUM10_AC2_accepts_a_datetime_with_a_numeric_utc_offset', () => {
    // ConnectSphere operates in Singapore, so a client is entitled to send
    // '+08:00' rather than converting to Z itself. Refusing the offset form
    // would push that conversion onto every caller, and a caller that got it
    // wrong would produce the same eight-hour error this rule exists to stop.
    // The instant is asserted, not the encoding, so the offset must be read
    // rather than ignored: 09:00+08:00 is 01:00Z, not 09:00Z.
    const result = validateCreateEventRequest({
      ...DRAFT,
      proposedStart: '2026-06-01T09:00:00+08:00',
      proposedEnd: '2026-06-01T17:00:00+08:00',
    });

    expect(instantOf(result.proposedStart)).toBe(instantOf('2026-06-01T01:00:00.000Z'));
    expect(instantOf(result.proposedEnd)).toBe(instantOf('2026-06-01T09:00:00.000Z'));
  });

  it('SCRUM10_AC2_accepts_a_datetime_with_no_fractional_seconds', () => {
    // Every other timestamp fixture in this file carries '.000Z', so a pattern
    // written to match them could come to demand milliseconds without anyone
    // noticing. No Organiser types milliseconds, and a form sending whole
    // seconds is well formed: the rule is about a missing time of day, not
    // about precision.
    const result = validateCreateEventRequest({
      ...DRAFT,
      proposedStart: '2026-06-01T09:00:00Z',
      proposedEnd: '2026-06-01T17:00:00Z',
    });

    expect(instantOf(result.proposedStart)).toBe(instantOf('2026-06-01T09:00:00.000Z'));
    expect(instantOf(result.proposedEnd)).toBe(instantOf('2026-06-01T17:00:00.000Z'));
  });

  it('SCRUM10_AC2_accepts_an_explicit_midnight_start', () => {
    // The guard that forces the rule to be judged on the string's shape rather
    // than the parsed instant. A deliberate midnight event and the date-only
    // '2026-06-01' resolve to exactly the same instant, so any implementation
    // that infers the rule from the parsed value -- rejecting when hours,
    // minutes and seconds are all zero -- would refuse a real event that starts
    // at midnight while still passing every other test in this block. Checking
    // the string first is what tells the two apart.
    const result = validateCreateEventRequest({
      ...DRAFT,
      proposedStart: '2026-06-01T00:00:00Z',
      proposedEnd: '2026-06-01T17:00:00Z',
    });
    expect(instantOf(result.proposedStart)).toBe(instantOf('2026-06-01T00:00:00.000Z'));

    const submitted = validateSubmitEventRequest(
      { ...SUBMITTABLE, proposedStart: '2026-06-01T00:00:00Z' },
      { now: NOW },
    );
    expect(instantOf(submitted.proposedStart)).toBe(instantOf('2026-06-01T00:00:00.000Z'));
  });

  it('SCRUM10_AC4_refuses_a_proposed_end_before_the_proposed_start', () => {
    // Mirrors event_requests_dates_ordered in 001. The database is the
    // guarantee; this layer exists to say it in words the Organiser can act on.
    const err = errorFrom(() =>
      validateCreateEventRequest({
        ...DRAFT,
        proposedStart: '2026-06-01T17:00:00.000Z',
        proposedEnd: '2026-06-01T09:00:00.000Z',
      }),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err)).toContain('proposedEnd');
  });

  it('SCRUM10_AC4_refuses_a_proposed_end_equal_to_the_proposed_start', () => {
    // A zero-length period cannot be booked against a venue, and 001 spells the
    // rule as proposed_end > proposed_start rather than >=.
    const err = errorFrom(() =>
      validateCreateEventRequest({
        ...DRAFT,
        proposedStart: '2026-06-01T09:00:00.000Z',
        proposedEnd: '2026-06-01T09:00:00.000Z',
      }),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err)).toContain('proposedEnd');
  });
});


describe('AC4: expected attendance must be a whole number greater than zero', () => {
  it.each([
    ['a numeric string', '40'],
    ['zero', 0],
    ['a negative number', -5],
    ['a fractional number', 40.5],
  ])('SCRUM10_AC4_refuses_expected_attendance_that_is_%s', (_label, value) => {
    // Strict about type on purpose, exactly as checkCapacity in
    // venueValidation.js is: '40' is refused rather than coerced, so a caller
    // sending strings finds out here instead of the bug surfacing later in
    // Venue Suitability Checking, where attendance is compared with capacity.
    const err = errorFrom(() =>
      validateCreateEventRequest({ ...DRAFT, expectedAttendance: value }),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err)).toContain('expectedAttendance');
  });

  it('SCRUM10_AC4_says_why_expected_attendance_was_refused', () => {
    // The message is shown to the Organiser, so it has to name the rule rather
    // than merely report that something was wrong.
    const err = errorFrom(() =>
      validateCreateEventRequest({ ...DRAFT, expectedAttendance: 40.5 }),
    );

    expect(messageFor(err, 'expectedAttendance')).toMatch(/whole number greater than zero/i);
  });
});


// ---------------------------------------------------------------------------
// Submitting for review
// ---------------------------------------------------------------------------
describe('AC2: a complete submission is accepted', () => {
  it('SCRUM10_AC2_accepts_a_complete_submission', () => {
    const result = validateSubmitEventRequest({ ...SUBMITTABLE }, { now: NOW });

    expect(result).toMatchObject({
      eventName: SUBMITTABLE.eventName,
      purpose: SUBMITTABLE.purpose,
      expectedAttendance: SUBMITTABLE.expectedAttendance,
    });
    expect(instantOf(result.proposedStart)).toBe(instantOf(SUBMITTABLE.proposedStart));
    expect(instantOf(result.proposedEnd)).toBe(instantOf(SUBMITTABLE.proposedEnd));
  });

  it('SCRUM10_AC2_accepts_a_submission_with_no_requirements_stated', () => {
    // SUBMITTABLE names none of the four optional text fields, and that is
    // still a complete submission. Step 4 exists to draw the detail out later.
    expect(() =>
      validateSubmitEventRequest({ ...SUBMITTABLE }, { now: NOW }),
    ).not.toThrow();
  });

  it('SCRUM10_AC2_returns_a_copy_and_does_not_mutate_the_submitted_input', () => {
    const input = { ...SUBMITTABLE, venueRequirements: '  A large room.  ' };
    const before = structuredClone(input);

    validateSubmitEventRequest(input, { now: NOW });

    expect(input).toEqual(before);
  });
});


describe('AC4: submission requires the five fields the Coordinator works from', () => {
  it.each([
    'eventName',
    'purpose',
    'proposedStart',
    'proposedEnd',
    'expectedAttendance',
  ])('SCRUM10_AC4_refuses_a_submission_missing_%s', (field) => {
    const input = { ...SUBMITTABLE };
    delete input[field];

    const err = errorFrom(() => validateSubmitEventRequest(input, { now: NOW }));

    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err)).toContain(field);
  });

  it('SCRUM10_AC4_refuses_a_submission_with_a_blank_purpose', () => {
    // Required and non-blank are one rule at submission: a whitespace purpose
    // would satisfy a bare presence check while telling the Coordinator
    // nothing, and Step 5 needs it to decide whether planning proceeds.
    const err = errorFrom(() =>
      validateSubmitEventRequest({ ...SUBMITTABLE, purpose: '   ' }, { now: NOW }),
    );

    expect(fieldsIn(err)).toContain('purpose');
  });

  it('SCRUM10_AC4_reports_every_missing_field_in_one_error', () => {
    // The defining behaviour of this layer. The Organiser fixes a whole form in
    // one round trip instead of resubmitting to discover the next fault, which
    // is why faults accumulate rather than throwing at the first one found.
    const input = { ...SUBMITTABLE };
    delete input.purpose;
    delete input.proposedEnd;
    delete input.expectedAttendance;

    const err = errorFrom(() => validateSubmitEventRequest(input, { now: NOW }));

    expect(err.details).toHaveLength(3);
    expect(fieldsIn(err).sort()).toEqual([
      'expectedAttendance',
      'proposedEnd',
      'purpose',
    ]);
  });

  it('SCRUM10_AC4_summarises_every_missing_field_in_the_message', () => {
    const err = errorFrom(() => validateSubmitEventRequest({}, { now: NOW }));

    expect(err.message).toMatch(/eventName/);
    expect(err.message).toMatch(/purpose/);
    expect(err.message).toMatch(/proposedStart/);
    expect(err.message).toMatch(/proposedEnd/);
    expect(err.message).toMatch(/expectedAttendance/);
  });
});


describe('AC4: a submitted event must still be ahead of us', () => {
  it('SCRUM10_AC4_refuses_a_proposed_start_in_the_past', () => {
    // Submission is the point at which the dates stop being a working guess: a
    // Coordinator cannot be assigned to find a venue for a date already gone.
    const err = errorFrom(() =>
      validateSubmitEventRequest(
        {
          ...SUBMITTABLE,
          proposedStart: '2025-12-01T09:00:00.000Z',
          proposedEnd: '2025-12-01T17:00:00.000Z',
        },
        { now: NOW },
      ),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err)).toContain('proposedStart');
    expect(messageFor(err, 'proposedStart')).toMatch(/must be in the future/i);
  });

  it('SCRUM10_AC4_refuses_a_proposed_start_exactly_equal_to_now', () => {
    // The boundary case, and the reason now is injected rather than read from
    // the clock. An event starting at the instant it is submitted leaves no
    // time for any of Steps 2 to 9, so the rule is strictly later than now.
    const err = errorFrom(() =>
      validateSubmitEventRequest(
        {
          ...SUBMITTABLE,
          proposedStart: NOW.toISOString(),
          proposedEnd: '2026-06-01T17:00:00.000Z',
        },
        { now: NOW },
      ),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err)).toContain('proposedStart');
  });

  it('SCRUM10_AC4_refuses_a_future_start_with_an_end_before_it', () => {
    // A future start does not excuse a backwards period; both rules apply.
    const err = errorFrom(() =>
      validateSubmitEventRequest(
        {
          ...SUBMITTABLE,
          proposedStart: '2026-06-01T17:00:00.000Z',
          proposedEnd: '2026-06-01T09:00:00.000Z',
        },
        { now: NOW },
      ),
    );

    expect(err).toBeInstanceOf(ValidationError);
    expect(fieldsIn(err)).toContain('proposedEnd');
  });
});
