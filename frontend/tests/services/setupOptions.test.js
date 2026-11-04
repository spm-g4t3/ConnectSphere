// setupOptions.test.js
//
// SCRUM-137 (SCRUM-20). The frontend's list of setup durations, its labels
// and the saved-value fallback the venue form uses.
//
// The minutes are asserted against a literal, as turnaroundOptions.test.js
// does, and also against the backend's SETUP_MINUTES_OPTIONS read as text from
// backend/src/domain/setupOptions.js (which a backend test in turn pins to the
// CHECK `venues_setup_minutes_allowed` in db/baseline/03_venues.sql). Read as
// text, not imported, so the frontend bundle never pulls in backend code.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  DEFAULT_SETUP_MINUTES,
  SETUP_MINUTES,
  SETUP_OPTIONS,
  setupOptionsWith,
} from "../../src/services/setupOptions.js";
import { TURNAROUND_MINUTES, formatTurnaround } from "../../src/services/turnaroundOptions.js";

const ALLOWED = [0, 15, 30, 45, 60, 90, 120];

/** SETUP_MINUTES_OPTIONS / DEFAULT_SETUP_MINUTES as the backend declares them. */
function backendDeclaration() {
  const text = readFileSync(
    // path, not `new URL(..., import.meta.url)`: under jsdom URL is jsdom's.
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../backend/src/domain/setupOptions.js"),
    "utf8",
  ).replace(/\/\/[^\n]*/g, "");
  const list = text.match(/SETUP_MINUTES_OPTIONS\s*=\s*Object\.freeze\(\s*\[([^\]]*)\]\s*\)/);
  const fallback = text.match(/DEFAULT_SETUP_MINUTES\s*=\s*(-?\d+)\s*;/);
  if (!list || !fallback) throw new Error("could not read backend/src/domain/setupOptions.js");
  return {
    minutes: list[1].split(",").map((v) => Number(v.trim())),
    fallback: Number(fallback[1]),
  };
}

describe("SCRUM20_SCRUM137 SETUP_MINUTES", () => {
  it("SCRUM20_SCRUM137_lists_the_seven_allowed_minutes_in_backend_order", () => {
    expect([...SETUP_MINUTES]).toEqual(ALLOWED);
    expect(SETUP_OPTIONS.map((o) => o.minutes)).toEqual(ALLOWED);
  });

  it("SCRUM20_SCRUM137_mirrors_the_backend_domain_list_and_default", () => {
    const backend = backendDeclaration();
    expect([...SETUP_MINUTES]).toEqual(backend.minutes);
    expect(DEFAULT_SETUP_MINUTES).toBe(backend.fallback);
  });

  it("SCRUM20_SCRUM137_default_is_zero_and_is_in_the_list", () => {
    expect(DEFAULT_SETUP_MINUTES).toBe(0);
    expect(SETUP_MINUTES).toContain(DEFAULT_SETUP_MINUTES);
  });

  it("SCRUM20_SCRUM137_equals_the_turnaround_list_today_but_is_its_own_array", () => {
    expect([...SETUP_MINUTES]).toEqual([...TURNAROUND_MINUTES]);
    expect(SETUP_MINUTES).not.toBe(TURNAROUND_MINUTES);
  });

  it("SCRUM20_SCRUM137_options_carry_the_formatted_labels", () => {
    expect(SETUP_OPTIONS.map((o) => o.label)).toEqual([
      "None",
      "15 minutes",
      "30 minutes",
      "45 minutes",
      "1 hour",
      "1 hour 30 minutes",
      "2 hours",
    ]);
  });

  it("SCRUM20_SCRUM137_labels_come_from_formatTurnaround", () => {
    for (const option of SETUP_OPTIONS) {
      expect(option.label).toBe(formatTurnaround(option.minutes));
    }
  });

  it("SCRUM20_SCRUM137_minutes_options_and_entries_are_frozen", () => {
    expect(Object.isFrozen(SETUP_MINUTES)).toBe(true);
    expect(Object.isFrozen(SETUP_OPTIONS)).toBe(true);
    for (const option of SETUP_OPTIONS) {
      expect(Object.isFrozen(option)).toBe(true);
    }
  });
});

describe("SCRUM20_SCRUM137 setupOptionsWith", () => {
  it("SCRUM20_SCRUM137_returns_the_list_itself_for_no_saved_value", () => {
    expect(setupOptionsWith(null)).toBe(SETUP_OPTIONS);
    expect(setupOptionsWith(undefined)).toBe(SETUP_OPTIONS);
  });

  it("SCRUM20_SCRUM137_returns_the_list_itself_for_a_listed_value", () => {
    for (const minutes of ALLOWED) {
      expect(setupOptionsWith(minutes)).toBe(SETUP_OPTIONS);
    }
  });

  it("SCRUM20_SCRUM137_appends_an_unlisted_saved_value_marked_unknown", () => {
    const options = setupOptionsWith(75);
    expect(options).toHaveLength(8);
    expect(options.slice(0, 7)).toEqual([...SETUP_OPTIONS]);
    expect(options[7]).toEqual({
      minutes: 75,
      label: "1 hour 15 minutes (not in this form's list)",
      unknown: true,
    });
    // The shared list is untouched.
    expect(SETUP_OPTIONS).toHaveLength(7);
  });

  it("SCRUM20_SCRUM137_a_string_of_a_listed_value_is_treated_as_unlisted", () => {
    // includes() is strict, so "30" is not 30. The form always passes the
    // number the backend sent, so this only documents the boundary.
    const options = setupOptionsWith("30");
    expect(options).toHaveLength(8);
    expect(options[7]).toMatchObject({ minutes: "30", unknown: true });
  });
});
