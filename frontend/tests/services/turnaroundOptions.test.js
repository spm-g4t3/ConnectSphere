// turnaroundOptions.test.js
//
// SCRUM-186. The frontend's list of turnaround durations, its labels and the
// saved-value fallback the venue form uses.
//
// The minutes are asserted against a literal rather than by importing the
// backend, so this suite stands on its own. The literal is the same list, in
// the same order, as TURNAROUND_MINUTES_OPTIONS in
// backend/src/domain/turnaroundOptions.js and the CHECK
// `venues_turnaround_minutes_allowed` in
// backend/db/migrations/017_venue_turnaround.sql. If one of those changes,
// this literal must change with it.

import { describe, it, expect } from "vitest";

import {
  DEFAULT_TURNAROUND_MINUTES,
  TURNAROUND_MINUTES,
  TURNAROUND_OPTIONS,
  formatTurnaround,
  turnaroundOptionsWith,
} from "../../src/services/turnaroundOptions.js";

const ALLOWED = [0, 15, 30, 45, 60, 90, 120];

describe("SCRUM186 TURNAROUND_MINUTES", () => {
  it("SCRUM186_lists_the_seven_allowed_minutes_in_backend_order", () => {
    expect([...TURNAROUND_MINUTES]).toEqual(ALLOWED);
    expect(TURNAROUND_OPTIONS.map((o) => o.minutes)).toEqual(ALLOWED);
  });

  it("SCRUM186_default_is_zero_and_is_in_the_list", () => {
    expect(DEFAULT_TURNAROUND_MINUTES).toBe(0);
    expect(TURNAROUND_MINUTES).toContain(DEFAULT_TURNAROUND_MINUTES);
  });

  it("SCRUM186_options_carry_the_formatted_labels", () => {
    expect(TURNAROUND_OPTIONS.map((o) => o.label)).toEqual([
      "None",
      "15 minutes",
      "30 minutes",
      "45 minutes",
      "1 hour",
      "1 hour 30 minutes",
      "2 hours",
    ]);
  });

  it("SCRUM186_minutes_options_and_entries_are_frozen", () => {
    expect(Object.isFrozen(TURNAROUND_MINUTES)).toBe(true);
    expect(Object.isFrozen(TURNAROUND_OPTIONS)).toBe(true);
    for (const option of TURNAROUND_OPTIONS) {
      expect(Object.isFrozen(option)).toBe(true);
    }
  });
});

describe("SCRUM186 formatTurnaround", () => {
  it.each([
    [0, "None"],
    [1, "1 minute"],
    [15, "15 minutes"],
    [60, "1 hour"],
    [75, "1 hour 15 minutes"],
    [90, "1 hour 30 minutes"],
    [120, "2 hours"],
    [135, "2 hours 15 minutes"],
  ])("SCRUM186_formats_%s_as_%s", (minutes, expected) => {
    expect(formatTurnaround(minutes)).toBe(expected);
  });

  it("SCRUM186_null_and_undefined_read_not_set", () => {
    expect(formatTurnaround(null)).toBe("not set");
    expect(formatTurnaround(undefined)).toBe("not set");
  });

  it.each([
    [-15, "-15"],
    [15.5, "15.5"],
    ["30", "30"],
    [NaN, "NaN"],
    [{}, "[object Object]"],
    [[30], "30"],
  ])("SCRUM186_shows_non_whole_value_%s_as_itself", (value, expected) => {
    expect(formatTurnaround(value)).toBe(expected);
  });

  it("SCRUM186_a_value_that_cannot_become_a_string_does_not_throw", () => {
    expect(() => formatTurnaround(Object.create(null))).not.toThrow();
    expect(formatTurnaround(Object.create(null))).toBe("unrecognised value");
  });
});

describe("SCRUM186 turnaroundOptionsWith", () => {
  it("SCRUM186_returns_the_list_itself_for_no_saved_value", () => {
    expect(turnaroundOptionsWith(null)).toBe(TURNAROUND_OPTIONS);
    expect(turnaroundOptionsWith(undefined)).toBe(TURNAROUND_OPTIONS);
  });

  it("SCRUM186_returns_the_list_itself_for_a_listed_value", () => {
    for (const minutes of ALLOWED) {
      expect(turnaroundOptionsWith(minutes)).toBe(TURNAROUND_OPTIONS);
    }
  });

  it("SCRUM186_appends_an_unlisted_saved_value_marked_unknown", () => {
    const options = turnaroundOptionsWith(75);
    expect(options).toHaveLength(8);
    expect(options.slice(0, 7)).toEqual([...TURNAROUND_OPTIONS]);
    expect(options[7]).toEqual({
      minutes: 75,
      label: "1 hour 15 minutes (not in this form's list)",
      unknown: true,
    });
    // The shared list is untouched.
    expect(TURNAROUND_OPTIONS).toHaveLength(7);
  });
});
