// venueSearchValidation.test.js
//
// SCRUM-130 (part of SCRUM-17, AC2): "the blocked period is excluded from
// venue search results". The client-side check on the optional search window
// and its conversion to the wire's offset ISO strings.
//
// Timezone-safe: datetime-local inputs are built from fixed instants through
// toDatetimeLocalValue, and outputs are checked by offset shape and getTime(),
// never against a hard-coded wall-clock string.

import { describe, it, expect } from "vitest";

import { toSearchWindow, validateSearchWindow } from "../../src/services/venueSearchValidation.js";
import { toDatetimeLocalValue } from "../../src/services/datetimeFormat.js";

const OFFSET_SUFFIX = /[+-]\d{2}:\d{2}$|Z$/;
const HOUR = 60 * 60 * 1000;

// Mid-November, clear of every DST change the test zones have.
const START_ISO = "2026-11-10T02:00:00Z";
const END_ISO = "2026-11-10T06:00:00Z";

/** The datetime-local value for an instant, in this device's zone. */
function local(iso) {
  return toDatetimeLocalValue(iso);
}

const START = local(START_ISO);
const END = local(END_ISO);

describe("validateSearchWindow", () => {
  it("SCRUM17_AC2_blank_dates_are_no_window_and_no_error", () => {
    expect(validateSearchWindow({ startsAt: "", endsAt: "" })).toEqual([]);
    expect(validateSearchWindow({})).toEqual([]);
    expect(validateSearchWindow()).toEqual([]);
    expect(validateSearchWindow({ startsAt: undefined, endsAt: null })).toEqual([]);
  });

  it("SCRUM17_AC2_whitespace_counts_as_blank", () => {
    expect(validateSearchWindow({ startsAt: "   ", endsAt: "\t" })).toEqual([]);
    expect(validateSearchWindow({ startsAt: START, endsAt: "  " })).toEqual([
      { field: "endsAt", message: "is required when a start is given" },
    ]);
  });

  it("SCRUM17_AC2_a_valid_window_has_no_errors", () => {
    expect(validateSearchWindow({ startsAt: START, endsAt: END })).toEqual([]);
  });

  it("SCRUM17_AC2_a_start_without_an_end_is_refused_on_the_end", () => {
    expect(validateSearchWindow({ startsAt: START, endsAt: "" })).toEqual([
      { field: "endsAt", message: "is required when a start is given" },
    ]);
  });

  it("SCRUM17_AC2_an_end_without_a_start_is_refused_on_the_start", () => {
    expect(validateSearchWindow({ startsAt: "", endsAt: END })).toEqual([
      { field: "startsAt", message: "is required when an end is given" },
    ]);
  });

  it("SCRUM17_AC2_30_February_is_not_a_valid_date", () => {
    expect(validateSearchWindow({ startsAt: "2026-02-30T09:00", endsAt: END })).toEqual([
      { field: "startsAt", message: "must be a valid date and time" },
    ]);
    expect(validateSearchWindow({ startsAt: START, endsAt: "2026-02-30T09:00" })).toEqual([
      { field: "endsAt", message: "must be a valid date and time" },
    ]);
  });

  it("SCRUM17_AC2_29_February_is_valid_only_in_a_leap_year", () => {
    expect(validateSearchWindow({ startsAt: "2028-02-29T09:00", endsAt: "2028-02-29T10:00" })).toEqual([]);
    expect(
      validateSearchWindow({ startsAt: "2027-02-29T09:00", endsAt: "2027-03-01T10:00" }),
    ).toEqual([{ field: "startsAt", message: "must be a valid date and time" }]);
  });

  it.each([
    ["a bare year", "2026"],
    ["prose", "June 1"],
    ["a date without a time", "2026-11-10"],
    ["month 13", "2026-13-01T09:00"],
    ["day 0", "2026-11-00T09:00"],
    ["garbage", "not a date"],
  ])("SCRUM17_AC2_refuses_%s", (_label, value) => {
    expect(validateSearchWindow({ startsAt: value, endsAt: END })).toEqual([
      { field: "startsAt", message: "must be a valid date and time" },
    ]);
  });

  it("SCRUM17_AC2_reports_both_malformed_dates_together", () => {
    expect(validateSearchWindow({ startsAt: "nope", endsAt: "2026-02-30T09:00" })).toEqual([
      { field: "startsAt", message: "must be a valid date and time" },
      { field: "endsAt", message: "must be a valid date and time" },
    ]);
  });

  it("SCRUM17_AC2_a_malformed_start_with_no_end_reports_both_faults", () => {
    const errors = validateSearchWindow({ startsAt: "nope", endsAt: "" });
    expect(errors).toHaveLength(2);
    expect(errors).toContainEqual({ field: "endsAt", message: "is required when a start is given" });
    expect(errors).toContainEqual({ field: "startsAt", message: "must be a valid date and time" });
  });

  it("SCRUM17_AC2_an_end_before_the_start_is_refused_on_the_end", () => {
    expect(validateSearchWindow({ startsAt: END, endsAt: START })).toEqual([
      { field: "endsAt", message: "must be later than the start" },
    ]);
  });

  it("SCRUM17_AC2_an_end_equal_to_the_start_is_refused_half_open", () => {
    expect(validateSearchWindow({ startsAt: START, endsAt: START })).toEqual([
      { field: "endsAt", message: "must be later than the start" },
    ]);
  });

  it("SCRUM17_AC2_one_minute_long_is_enough", () => {
    const oneMinuteLater = local(new Date(new Date(START_ISO).getTime() + 60_000).toISOString());
    expect(validateSearchWindow({ startsAt: START, endsAt: oneMinuteLater })).toEqual([]);
  });

  it("SCRUM17_AC2_a_past_window_is_allowed", () => {
    expect(
      validateSearchWindow({ startsAt: local("2020-01-10T02:00:00Z"), endsAt: local("2020-01-10T06:00:00Z") }),
    ).toEqual([]);
  });

  it("SCRUM17_AC2_there_is_no_length_cap", () => {
    expect(
      validateSearchWindow({ startsAt: local("2026-01-10T02:00:00Z"), endsAt: local("2030-01-10T02:00:00Z") }),
    ).toEqual([]);
  });

  it("SCRUM17_AC2_accepts_offset_ISO_input", () => {
    expect(
      validateSearchWindow({ startsAt: "2026-11-10T10:00:00+08:00", endsAt: "2026-11-10T14:00:00+08:00" }),
    ).toEqual([]);
    expect(validateSearchWindow({ startsAt: START_ISO, endsAt: END_ISO })).toEqual([]);
  });

  it("SCRUM17_AC2_compares_offset_ISO_input_as_instants", () => {
    // 10:00+08:00 is 02:00Z; an end at 03:00Z is later even though "03" < "10".
    expect(
      validateSearchWindow({ startsAt: "2026-11-10T10:00:00+08:00", endsAt: "2026-11-10T03:00:00Z" }),
    ).toEqual([]);
    // 10:00+08:00 and 02:00Z are the same instant.
    expect(
      validateSearchWindow({ startsAt: "2026-11-10T10:00:00+08:00", endsAt: "2026-11-10T02:00:00Z" }),
    ).toEqual([{ field: "endsAt", message: "must be later than the start" }]);
  });

  it("SCRUM17_AC2_values_are_trimmed_before_parsing", () => {
    expect(validateSearchWindow({ startsAt: `  ${START} `, endsAt: ` ${END}  ` })).toEqual([]);
  });

  it("SCRUM17_AC2_non_string_values_count_as_blank", () => {
    expect(validateSearchWindow({ startsAt: 123, endsAt: {} })).toEqual([]);
  });
});

describe("toSearchWindow", () => {
  it("SCRUM17_AC2_blank_dates_give_an_empty_object", () => {
    expect(toSearchWindow({ startsAt: "", endsAt: "" })).toEqual({});
    expect(toSearchWindow({})).toEqual({});
    expect(toSearchWindow()).toEqual({});
    expect(toSearchWindow({ startsAt: "  ", endsAt: " " })).toEqual({});
    expect(Object.keys(toSearchWindow({ startsAt: "", endsAt: "" }))).toEqual([]);
  });

  it("SCRUM17_AC2_a_one_sided_window_gives_an_empty_object", () => {
    expect(toSearchWindow({ startsAt: START, endsAt: "" })).toEqual({});
    expect(toSearchWindow({ startsAt: "", endsAt: END })).toEqual({});
  });

  it("SCRUM17_AC2_converts_datetime_local_values_to_offset_ISO_naming_the_same_instants", () => {
    const out = toSearchWindow({ startsAt: START, endsAt: END });

    expect(Object.keys(out).sort()).toEqual(["endsAt", "startsAt"]);
    expect(out.startsAt).toMatch(OFFSET_SUFFIX);
    expect(out.endsAt).toMatch(OFFSET_SUFFIX);
    expect(new Date(out.startsAt).getTime()).toBe(new Date(START_ISO).getTime());
    expect(new Date(out.endsAt).getTime()).toBe(new Date(END_ISO).getTime());
    expect(new Date(out.endsAt).getTime() - new Date(out.startsAt).getTime()).toBe(4 * HOUR);
  });

  it("SCRUM17_AC2_the_same_instant_as_the_device_reads_the_input", () => {
    const out = toSearchWindow({ startsAt: START, endsAt: END });
    expect(new Date(out.startsAt).getTime()).toBe(new Date(START).getTime());
    expect(new Date(out.endsAt).getTime()).toBe(new Date(END).getTime());
  });

  it("SCRUM17_AC2_trims_before_converting", () => {
    const out = toSearchWindow({ startsAt: ` ${START} `, endsAt: `${END}  ` });
    expect(out.startsAt).toMatch(OFFSET_SUFFIX);
    expect(out.startsAt).not.toMatch(/^\s|\s$/);
    expect(new Date(out.startsAt).getTime()).toBe(new Date(START_ISO).getTime());
    expect(new Date(out.endsAt).getTime()).toBe(new Date(END_ISO).getTime());
  });

  it("SCRUM17_AC2_offset_ISO_input_passes_through_unchanged", () => {
    expect(
      toSearchWindow({ startsAt: "2026-11-10T10:00:00+08:00", endsAt: "2026-11-10T06:00:00Z" }),
    ).toEqual({ startsAt: "2026-11-10T10:00:00+08:00", endsAt: "2026-11-10T06:00:00Z" });
  });
});
