// eventVenueSearchForm.test.js
//
// SCRUM-141 (SCRUM-20 AC1/AC2): the pure half of EventVenueFinder -- seeding
// the form from an event, checking it, turning it into findVenuesForEvent's
// criteria, and sorting a 400's details[] onto the form's fields.
//
// Timezone-proof: the form holds Singapore (venue) time on every device, so
// expected dates and times are Singapore literals and wire values are exact
// +08:00 strings. The same assertions pass under UTC, Asia/Singapore and
// America/New_York; run the suite under each.

import { describe, it, expect } from "vitest";

import {
  EMPTY_EVENT_SEARCH_FORM,
  mapServerDetails,
  searchErrorMessage,
  seedFromEvent,
  toSearchCriteria,
  validateEventSearchForm,
} from "../../src/services/eventVenueSearchForm.js";

// Wednesday 11 November 2026, 10:00-12:00 Singapore, and the Singapore date
// and times the form should hold for it on any device.
const START_ISO = "2026-11-11T10:00:00+08:00";
const END_ISO = "2026-11-11T12:00:00+08:00";
const START = { date: "2026-11-11", time: "10:00" };
const END = { date: "2026-11-11", time: "12:00" };

const EVENT = Object.freeze({
  id: "e1",
  eventName: "Tech Talk",
  proposedStart: START_ISO,
  proposedEnd: END_ISO,
  expectedAttendance: 80,
  venueRequirements: "A large room, ideally tiered",
});

/** A form the validator accepts: 2026-11-11, 10:00-12:00, 80 people. */
function validForm(overrides = {}) {
  return {
    ...EMPTY_EVENT_SEARCH_FORM,
    date: "2026-11-11",
    startTime: "10:00",
    endTime: "12:00",
    expectedAttendance: "80",
    accessibility: [],
    facilities: [],
    ...overrides,
  };
}

const fieldsOf = (errors) => errors.map((e) => e.field);
const messageFor = (errors, field) => errors.filter((e) => e.field === field).map((e) => e.message);

describe("EMPTY_EVENT_SEARCH_FORM", () => {
  it("SCRUM20_AC1_has_every_form_key_blank_and_is_frozen", () => {
    expect(EMPTY_EVENT_SEARCH_FORM).toEqual({
      date: "",
      startTime: "",
      endTime: "",
      expectedAttendance: "",
      location: "",
      layout: "",
      accessibility: [],
      facilities: [],
      spansDays: false,
    });
    expect(Object.isFrozen(EMPTY_EVENT_SEARCH_FORM)).toBe(true);
    expect(Object.isFrozen(EMPTY_EVENT_SEARCH_FORM.accessibility)).toBe(true);
    expect(Object.isFrozen(EMPTY_EVENT_SEARCH_FORM.facilities)).toBe(true);
  });
});

describe("SCRUM20_AC2 seedFromEvent", () => {
  it("SCRUM20_AC2_full_event_fills_date_times_and_attendance", () => {
    expect(seedFromEvent(EVENT)).toEqual({
      date: START.date,
      startTime: START.time,
      endTime: END.time,
      expectedAttendance: "80",
      location: "",
      layout: "",
      accessibility: [],
      facilities: [],
      spansDays: false,
    });
  });

  it("SCRUM20_AC2_seeded_times_name_the_event_instants", () => {
    const form = seedFromEvent(EVENT);
    // Read as Singapore wall clock, the seeded values are the event's instants.
    expect(new Date(`${form.date}T${form.startTime}:00+08:00`).getTime())
      .toBe(new Date(START_ISO).getTime());
    expect(new Date(`${form.date}T${form.endTime}:00+08:00`).getTime())
      .toBe(new Date(END_ISO).getTime());
  });

  it("SCRUM20_AC2_prefill_uses_singapore_time_on_any_device", () => {
    // 09:00-13:00 Singapore is 20:00-00:00 the day before in New York, which
    // would leave End blank if the form read the device's clock.
    expect(seedFromEvent({
      ...EVENT,
      proposedStart: "2026-11-11T09:00:00+08:00",
      proposedEnd: "2026-11-11T13:00:00+08:00",
    })).toMatchObject({ date: "2026-11-11", startTime: "09:00", endTime: "13:00" });
  });

  it("SCRUM20_AC2_instants_in_another_offset_are_read_in_singapore", () => {
    // 01:00-05:00 UTC is 09:00-13:00 Singapore.
    expect(seedFromEvent({
      ...EVENT,
      proposedStart: "2026-11-11T01:00:00Z",
      proposedEnd: "2026-11-11T05:00:00+00:00",
    })).toMatchObject({ date: "2026-11-11", startTime: "09:00", endTime: "13:00" });
  });

  it("SCRUM20_AC2_event_crossing_singapore_midnight_leaves_the_end_empty", () => {
    expect(seedFromEvent({
      ...EVENT,
      proposedStart: "2026-11-11T22:00:00+08:00",
      proposedEnd: "2026-11-12T01:00:00+08:00",
    })).toMatchObject({ date: "2026-11-11", startTime: "22:00", endTime: "" });
  });

  it("SCRUM20_AC2_optional_criteria_start_empty_whatever_the_prose_says", () => {
    const form = seedFromEvent({
      ...EVENT,
      venueRequirements: "theatre layout",
      accessibilityRequirements: "step-free entrance",
      equipmentRequirements: "projector, wifi",
    });
    expect(form.location).toBe("");
    expect(form.layout).toBe("");
    expect(form.accessibility).toEqual([]);
    expect(form.facilities).toEqual([]);
  });

  it("SCRUM20_AC2_code_lists_are_fresh_arrays_not_the_frozen_defaults", () => {
    const form = seedFromEvent(EVENT);
    expect(form.accessibility).not.toBe(EMPTY_EVENT_SEARCH_FORM.accessibility);
    expect(form.facilities).not.toBe(EMPTY_EVENT_SEARCH_FORM.facilities);
    expect(Object.isFrozen(form.accessibility)).toBe(false);
    expect(Object.isFrozen(form.facilities)).toBe(false);
  });

  it("SCRUM20_AC2_missing_start_takes_the_date_from_the_end", () => {
    expect(seedFromEvent({ ...EVENT, proposedStart: null })).toMatchObject({
      date: END.date,
      startTime: "",
      endTime: END.time,
    });
  });

  it("SCRUM20_AC2_missing_end_leaves_the_end_time_empty", () => {
    expect(seedFromEvent({ ...EVENT, proposedEnd: undefined })).toMatchObject({
      date: START.date,
      startTime: START.time,
      endTime: "",
    });
  });

  it("SCRUM20_AC2_missing_start_and_end_leave_date_and_times_empty", () => {
    expect(seedFromEvent({ ...EVENT, proposedStart: null, proposedEnd: null })).toMatchObject({
      date: "",
      startTime: "",
      endTime: "",
      expectedAttendance: "80",
    });
  });

  it("SCRUM20_AC2_unreadable_timestamps_are_treated_as_missing", () => {
    expect(seedFromEvent({ ...EVENT, proposedStart: "not a date", proposedEnd: "2026-99-99" }))
      .toMatchObject({ date: "", startTime: "", endTime: "" });
    expect(seedFromEvent({ ...EVENT, proposedStart: "garbage" })).toMatchObject({
      date: END.date,
      startTime: "",
      endTime: END.time,
    });
  });

  it("SCRUM20_AC2_end_on_a_different_date_leaves_the_end_time_empty", () => {
    const laterEnd = "2026-11-13T12:00:00+08:00";
    expect(seedFromEvent({ ...EVENT, proposedEnd: laterEnd })).toMatchObject({
      date: START.date,
      startTime: START.time,
      endTime: "",
    });
  });

  it("SCRUM20_AC3_same_day_event_does_not_span_days", () => {
    expect(seedFromEvent(EVENT).spansDays).toBe(false);
  });

  it.each([
    ["on a later date", "2026-11-13T12:00:00+08:00"],
    ["across singapore midnight", "2026-11-12T01:00:00+08:00"],
  ])("SCRUM20_AC3_end_%s_spans_days", (_label, proposedEnd) => {
    expect(seedFromEvent({ ...EVENT, proposedEnd })).toMatchObject({
      date: START.date,
      endTime: "",
      spansDays: true,
    });
  });

  it("SCRUM20_AC3_days_are_compared_in_singapore_not_utc", () => {
    // 23:00 UTC on the 10th is 07:00 on the 11th in Singapore: one day there.
    expect(seedFromEvent({
      ...EVENT,
      proposedStart: "2026-11-10T23:00:00Z",
      proposedEnd: "2026-11-11T12:00:00+08:00",
    })).toMatchObject({ date: "2026-11-11", spansDays: false });
  });

  it.each([
    ["the end is missing", { proposedEnd: null }],
    ["the start is missing", { proposedStart: null }],
    ["the end is unreadable", { proposedEnd: "garbage" }],
    ["both are missing", { proposedStart: null, proposedEnd: null }],
  ])("SCRUM20_AC3_does_not_span_days_when_%s", (_label, overrides) => {
    expect(seedFromEvent({ ...EVENT, ...overrides }).spansDays).toBe(false);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["zero", 0],
    ["negative", -5],
    ["fractional", 2.5],
    ["a string", "80"],
    ["NaN", Number.NaN],
  ])("SCRUM20_AC2_attendance_%s_leaves_the_field_empty", (_label, value) => {
    expect(seedFromEvent({ ...EVENT, expectedAttendance: value }).expectedAttendance).toBe("");
  });

  it("SCRUM20_AC2_attendance_of_one_is_seeded", () => {
    expect(seedFromEvent({ ...EVENT, expectedAttendance: 1 }).expectedAttendance).toBe("1");
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an empty object", {}],
  ])("SCRUM20_AC2_no_request_given_as_%s_seeds_an_empty_form", (_label, value) => {
    expect(seedFromEvent(value)).toEqual({ ...EMPTY_EVENT_SEARCH_FORM, accessibility: [], facilities: [] });
  });
});

describe("SCRUM20_AC1 validateEventSearchForm", () => {
  it("SCRUM20_AC1_valid_required_fields_pass", () => {
    expect(validateEventSearchForm(validForm())).toEqual([]);
  });

  it("SCRUM20_AC1_a_seeded_form_passes", () => {
    expect(validateEventSearchForm(seedFromEvent(EVENT))).toEqual([]);
  });

  it("SCRUM20_AC1_required_fields_blank_give_four_errors", () => {
    expect(validateEventSearchForm(validForm({
      date: "",
      startTime: "",
      endTime: "",
      expectedAttendance: "",
    }))).toEqual([
      { field: "date", message: "is required" },
      { field: "startTime", message: "is required" },
      { field: "endTime", message: "is required" },
      { field: "expectedAttendance", message: "is required" },
    ]);
  });

  it("SCRUM20_AC1_no_values_at_all_give_four_errors", () => {
    expect(fieldsOf(validateEventSearchForm())).toEqual([
      "date", "startTime", "endTime", "expectedAttendance",
    ]);
    expect(fieldsOf(validateEventSearchForm({}))).toHaveLength(4);
  });

  it("SCRUM20_AC1_whitespace_and_non_strings_count_as_blank", () => {
    expect(validateEventSearchForm({
      date: "   ",
      startTime: "\t",
      endTime: null,
      expectedAttendance: 80,
    })).toEqual([
      { field: "date", message: "is required" },
      { field: "startTime", message: "is required" },
      { field: "endTime", message: "is required" },
      { field: "expectedAttendance", message: "is required" },
    ]);
  });

  it("SCRUM20_AC1_surrounding_spaces_are_ignored", () => {
    expect(validateEventSearchForm(validForm({
      date: " 2026-11-11 ",
      startTime: " 10:00",
      endTime: "12:00 ",
      expectedAttendance: " 80 ",
    }))).toEqual([]);
  });

  it.each([
    ["not a date", "tomorrow"],
    ["day first", "11-11-2026"],
    ["slashes", "2026/11/11"],
    ["month 13", "2026-13-01"],
    ["30 February", "2026-02-30"],
    ["29 February in a common year", "2027-02-29"],
  ])("SCRUM20_AC1_date_%s_must_be_a_valid_date", (_label, date) => {
    expect(validateEventSearchForm(validForm({ date }))).toEqual([
      { field: "date", message: "must be a valid date" },
    ]);
  });

  it("SCRUM20_AC1_29_february_in_a_leap_year_is_valid", () => {
    expect(validateEventSearchForm(validForm({ date: "2028-02-29" }))).toEqual([]);
  });

  it.each([
    ["24:00", "24:00"],
    ["single-digit hour", "9:00"],
    ["minute 60", "10:60"],
    ["text", "ten"],
    ["seconds 60", "10:00:60"],
  ])("SCRUM20_AC1_start_time_%s_must_be_a_valid_time", (_label, startTime) => {
    expect(validateEventSearchForm(validForm({ startTime }))).toEqual([
      { field: "startTime", message: "must be a valid time" },
    ]);
  });

  it("SCRUM20_AC1_end_time_must_be_a_valid_time", () => {
    expect(validateEventSearchForm(validForm({ endTime: "25:00" }))).toEqual([
      { field: "endTime", message: "must be a valid time" },
    ]);
  });

  it("SCRUM20_AC1_times_with_seconds_are_accepted", () => {
    expect(validateEventSearchForm(validForm({ startTime: "10:00:30", endTime: "12:00:00" }))).toEqual([]);
  });

  it("SCRUM20_AC1_midnight_to_the_last_minute_is_valid", () => {
    expect(validateEventSearchForm(validForm({ startTime: "00:00", endTime: "23:59" }))).toEqual([]);
  });

  it("SCRUM20_AC1_end_equal_to_start_is_refused", () => {
    expect(validateEventSearchForm(validForm({ startTime: "10:00", endTime: "10:00" }))).toEqual([
      { field: "endTime", message: "must be later than the start" },
    ]);
  });

  it("SCRUM20_AC1_end_before_start_is_refused", () => {
    expect(validateEventSearchForm(validForm({ startTime: "10:00", endTime: "09:00" }))).toEqual([
      { field: "endTime", message: "must be later than the start" },
    ]);
  });

  it("SCRUM20_AC1_end_one_second_after_start_is_accepted", () => {
    expect(validateEventSearchForm(validForm({ startTime: "10:00:00", endTime: "10:00:01" }))).toEqual([]);
  });

  it("SCRUM20_AC1_order_is_not_checked_while_any_part_is_bad", () => {
    // End before start, but the date is invalid: only the date is reported.
    expect(validateEventSearchForm(validForm({ date: "2026-02-30", startTime: "10:00", endTime: "09:00" })))
      .toEqual([{ field: "date", message: "must be a valid date" }]);
    expect(validateEventSearchForm(validForm({ startTime: "bad", endTime: "09:00" })))
      .toEqual([{ field: "startTime", message: "must be a valid time" }]);
    expect(validateEventSearchForm(validForm({ startTime: "10:00", endTime: "" })))
      .toEqual([{ field: "endTime", message: "is required" }]);
  });

  it("SCRUM20_AC1_attendance_must_be_a_whole_number_of_at_least_one", () => {
    expect(messageFor(validateEventSearchForm(validForm({ expectedAttendance: "0" })), "expectedAttendance"))
      .toEqual(["must be at least 1"]);
    expect(messageFor(validateEventSearchForm(validForm({ expectedAttendance: "-5" })), "expectedAttendance"))
      .toEqual(["must be at least 1"]);
    expect(messageFor(validateEventSearchForm(validForm({ expectedAttendance: "2.5" })), "expectedAttendance"))
      .toEqual(["must be a whole number"]);
    expect(messageFor(validateEventSearchForm(validForm({ expectedAttendance: "abc" })), "expectedAttendance"))
      .toEqual(["must be a number"]);
  });

  it("SCRUM20_AC1_attendance_of_one_is_accepted", () => {
    expect(validateEventSearchForm(validForm({ expectedAttendance: "1" }))).toEqual([]);
  });

  it("SCRUM20_AC1_optional_criteria_have_no_client_rule", () => {
    expect(validateEventSearchForm(validForm({
      location: "%_anything_%",
      layout: "not_a_real_layout",
      accessibility: ["unknown"],
      facilities: ["also_unknown"],
    }))).toEqual([]);
  });

  it("SCRUM20_AC1_every_fault_is_reported_at_once", () => {
    const errors = validateEventSearchForm(validForm({
      date: "2026-02-30",
      startTime: "",
      endTime: "99:99",
      expectedAttendance: "1.5",
    }));
    expect(errors).toEqual([
      { field: "date", message: "must be a valid date" },
      { field: "startTime", message: "is required" },
      { field: "endTime", message: "must be a valid time" },
      { field: "expectedAttendance", message: "must be a whole number" },
    ]);
  });

  it("SCRUM20_AC1_order_and_attendance_faults_are_reported_together", () => {
    expect(validateEventSearchForm(validForm({ endTime: "08:00", expectedAttendance: "0" }))).toEqual([
      { field: "endTime", message: "must be later than the start" },
      { field: "expectedAttendance", message: "must be at least 1" },
    ]);
  });
});

describe("SCRUM20_AC1 toSearchCriteria", () => {
  it("SCRUM491_AC5_the_event_id_travels_with_the_criteria", () => {
    const criteria = toSearchCriteria(validForm(), { eventRequestId: " e1 " });
    expect(criteria.eventRequestId).toBe("e1");
  });

  it.each([
    ["missing", undefined],
    ["blank", "  "],
    ["not text", 42],
  ])("SCRUM491_AC5_a_%s_event_id_is_not_sent", (_, eventRequestId) => {
    expect(toSearchCriteria(validForm(), { eventRequestId })).not.toHaveProperty("eventRequestId");
  });

  it("SCRUM20_AC1_required_fields_only_send_exactly_three_keys", () => {
    const criteria = toSearchCriteria(validForm());
    expect(Object.keys(criteria).sort()).toEqual(["endsAt", "expectedAttendance", "startsAt"]);
  });

  it("SCRUM20_AC1_sent_period_is_singapore_time", () => {
    // The typed date and times, as typed, with Singapore's +08:00 -- not the
    // device's offset.
    const criteria = toSearchCriteria(validForm());

    expect(criteria.startsAt).toBe("2026-11-11T10:00:00+08:00");
    expect(criteria.endsAt).toBe("2026-11-11T12:00:00+08:00");
  });

  it("SCRUM20_AC1_typed_seconds_are_kept", () => {
    const criteria = toSearchCriteria(validForm({ startTime: "10:00:30", endTime: "12:00:00" }));

    expect(criteria.startsAt).toBe("2026-11-11T10:00:30+08:00");
    expect(criteria.endsAt).toBe("2026-11-11T12:00:00+08:00");
  });

  it("SCRUM20_AC3_spans_days_is_never_sent", () => {
    const form = { ...validForm(), spansDays: true };
    expect(validateEventSearchForm(form)).toEqual([]);
    const criteria = toSearchCriteria(form);
    expect(criteria).not.toHaveProperty("spansDays");
    expect(Object.keys(criteria).sort()).toEqual(["endsAt", "expectedAttendance", "startsAt"]);
  });

  it("SCRUM20_AC2_a_seeded_form_sends_the_event_instants_back", () => {
    const criteria = toSearchCriteria(seedFromEvent(EVENT));

    expect(criteria.startsAt).toBe(START_ISO);
    expect(criteria.endsAt).toBe(END_ISO);
    expect(criteria.expectedAttendance).toBe(80);
  });

  it("SCRUM20_AC1_attendance_is_sent_as_a_number", () => {
    expect(toSearchCriteria(validForm({ expectedAttendance: " 120 " })).expectedAttendance).toBe(120);
  });

  it("SCRUM20_AC1_values_are_trimmed_before_conversion", () => {
    const criteria = toSearchCriteria(validForm({ date: " 2026-11-11 ", startTime: " 10:00 " }));
    expect(criteria.startsAt).toBe("2026-11-11T10:00:00+08:00");
  });

  it("SCRUM20_AC1_selected_codes_are_sent", () => {
    expect(toSearchCriteria(validForm({
      layout: "theatre",
      accessibility: ["step_free_entrance"],
      facilities: ["projector", "wifi"],
    }))).toMatchObject({
      layout: "theatre",
      accessibility: ["step_free_entrance"],
      facilities: ["projector", "wifi"],
    });
  });

  it("SCRUM20_AC1_location_is_sent_trimmed", () => {
    expect(toSearchCriteria(validForm({ location: "  Level 2 " })).location).toBe("Level 2");
  });

  it("SCRUM20_AC1_unselected_criteria_are_left_out", () => {
    const criteria = toSearchCriteria(validForm({
      location: "   ",
      layout: "",
      accessibility: [],
      facilities: [],
    }));
    for (const key of ["location", "layout", "accessibility", "facilities"]) {
      expect(criteria).not.toHaveProperty(key);
    }
  });

  it("SCRUM20_AC1_non_list_and_non_string_codes_are_dropped", () => {
    const criteria = toSearchCriteria(validForm({
      layout: 7,
      location: null,
      accessibility: "lift_access",
      facilities: ["wifi", "", null, 3, "projector"],
    }));
    expect(criteria).not.toHaveProperty("layout");
    expect(criteria).not.toHaveProperty("location");
    expect(criteria).not.toHaveProperty("accessibility");
    expect(criteria.facilities).toEqual(["wifi", "projector"]);
  });

  it("SCRUM20_AC1_a_list_of_only_junk_is_left_out", () => {
    expect(toSearchCriteria(validForm({ facilities: ["", null] }))).not.toHaveProperty("facilities");
  });

  it("SCRUM20_AC1_does_not_mutate_the_form", () => {
    const form = validForm({ facilities: ["wifi", ""], location: " x " });
    const snapshot = structuredClone(form);
    toSearchCriteria(form);
    expect(form).toEqual(snapshot);
  });

  it("SCRUM20_AC1_no_values_does_not_throw", () => {
    // Validate first; this does not judge. Blank start and end go out unset.
    const criteria = toSearchCriteria();
    expect(Number.isNaN(criteria.expectedAttendance) || criteria.expectedAttendance === 0).toBe(true);
    expect(Object.keys(criteria).sort()).toEqual(["endsAt", "expectedAttendance", "startsAt"]);
  });
});

describe("SCRUM20_AC1 mapServerDetails", () => {
  it.each([
    ["startsAt", "startTime"],
    ["endsAt", "endTime"],
    ["expectedAttendance", "expectedAttendance"],
    ["location", "location"],
    ["layout", "layout"],
    ["accessibility", "accessibility"],
    ["facilities", "facilities"],
  ])("SCRUM20_AC1_server_field_%s_is_shown_beside_%s", (server, form) => {
    expect(mapServerDetails([{ field: server, message: "is wrong" }])).toEqual({
      fieldErrors: [{ field: form, message: "is wrong" }],
      hasUnmapped: false,
    });
  });

  it("SCRUM20_AC1_several_mapped_details_keep_their_order", () => {
    expect(mapServerDetails([
      { field: "endsAt", message: "must be later than the start" },
      { field: "facilities", message: "unknown code: hoverboard" },
    ])).toEqual({
      fieldErrors: [
        { field: "endTime", message: "must be later than the start" },
        { field: "facilities", message: "unknown code: hoverboard" },
      ],
      hasUnmapped: false,
    });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an object", { field: "startsAt", message: "x" }],
    ["a string", "bad"],
    ["an empty list", []],
  ])("SCRUM20_AC1_details_given_as_%s_are_unmapped", (_label, details) => {
    expect(mapServerDetails(details)).toEqual({ fieldErrors: [], hasUnmapped: true });
  });

  it.each([
    ["an unknown field", { field: "eventName", message: "x" }],
    ["the date, which has no wire field", { field: "date", message: "x" }],
    ["a prototype key", { field: "toString", message: "x" }],
    ["a missing field", { message: "x" }],
    ["a non-string message", { field: "startsAt", message: 42 }],
    ["a missing message", { field: "layout" }],
    ["a null entry", null],
    ["a string entry", "startsAt"],
  ])("SCRUM20_AC1_%s_is_unmapped", (_label, detail) => {
    expect(mapServerDetails([detail])).toEqual({ fieldErrors: [], hasUnmapped: true });
  });

  it("SCRUM20_AC1_mapped_and_unmapped_details_are_both_reported", () => {
    expect(mapServerDetails([
      { field: "expectedAttendance", message: "must be at least 1" },
      { field: "somethingElse", message: "x" },
    ])).toEqual({
      fieldErrors: [{ field: "expectedAttendance", message: "must be at least 1" }],
      hasUnmapped: true,
    });
  });
});

describe("SCRUM20_AC1 searchErrorMessage", () => {
  it("SCRUM20_AC1_403_names_the_role", () => {
    expect(searchErrorMessage({ response: { status: 403 } }))
      .toBe("Only Event Coordinators can search by event requirements.");
  });

  it.each([
    ["400", { response: { status: 400 } }],
    ["401", { response: { status: 401 } }],
    ["500", { response: { status: 500 } }],
    ["a network error", new Error("Network Error")],
    ["a response with no status", { response: {} }],
    ["undefined", undefined],
    ["null", null],
  ])("SCRUM20_AC1_%s_gets_the_generic_message", (_label, err) => {
    expect(searchErrorMessage(err)).toBe("Could not search venues. Please try again.");
  });
});
