// displayFormat.test.js
//
// SCRUM-125 (part of SCRUM-17). The display helpers moved out of
// VenueDetail.jsx, plus the new formatRange. Timezone-safe: every expected
// string is computed here as Singapore time, from fixtures that carry
// offsets, so the suite passes in any zone and locale.

import { describe, it, expect } from "vitest";

import {
  asList,
  formatDate,
  formatEventDate,
  formatMediumDateTime,
  formatMediumTimestamp,
  formatRange,
  formatTimestamp,
  orNotSpecified,
  pluralise,
  shortId,
} from "../../src/services/displayFormat.js";
import { sgTime, sgMediumTime } from "../helpers/singaporeTime.js";

const START = "2026-10-01T09:00:00+08:00";
const END = "2026-10-01T17:30:00+08:00";

describe("shortId", () => {
  it("takes the first 8 characters of a string", () => {
    expect(shortId("3f2504e0-4f89-41d3-9a0c-0305e82c3301")).toBe("3f2504e0");
    expect(shortId("abc")).toBe("abc");
    expect(shortId("")).toBe("");
  });

  it("turns non-strings into strings", () => {
    expect(shortId(null)).toBe("null");
    expect(shortId(undefined)).toBe("undefined");
    expect(shortId(1234567890123)).toBe("1234567890123");
  });
});

describe("formatTimestamp", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
    ["zero", 0],
  ])("reads %s as unknown", (_label, value) => {
    expect(formatTimestamp(value)).toBe("unknown");
  });

  it("uses a supplied fallback for a missing value", () => {
    expect(formatTimestamp(null, "open-ended")).toBe("open-ended");
    expect(formatTimestamp("", "-")).toBe("-");
  });

  it("returns an unparseable value unchanged", () => {
    expect(formatTimestamp("not a date")).toBe("not a date");
    expect(formatTimestamp("not a date", "fallback")).toBe("not a date");
  });

  it("matches toLocaleString for a real timestamp", () => {
    expect(formatTimestamp(START)).toBe(sgTime(START));
  });
});

describe("formatRange", () => {
  it("joins both ends with a spaced en dash", () => {
    expect(formatRange(START, END)).toBe(
      `${sgTime(START)} – ${sgTime(END)}`,
    );
  });

  it("applies the fallback to a missing end", () => {
    expect(formatRange(START, null, "open-ended")).toBe(
      `${sgTime(START)} – open-ended`,
    );
  });

  it("defaults the fallback to unknown", () => {
    expect(formatRange(null, undefined)).toBe("unknown – unknown");
  });
});

// The event lists render an unparseable value as given, not String(value);
// an object would show as "[object Object]" through formatTimestamp.
describe("formatEventDate", () => {
  it("reads a missing value as Date not set, or the supplied fallback", () => {
    expect(formatEventDate(null)).toBe("Date not set");
    expect(formatEventDate("", "Not specified")).toBe("Not specified");
  });

  it("returns an unparseable value as given, not stringified", () => {
    const value = { not: "a date" };
    expect(formatEventDate(value)).toBe(value);
  });

  it("matches toLocaleString for a real timestamp", () => {
    expect(formatEventDate(START)).toBe(sgTime(START));
  });
});

describe("formatMediumTimestamp", () => {
  it("reads a missing value as the fallback", () => {
    expect(formatMediumTimestamp(undefined, "Date not recorded")).toBe("Date not recorded");
  });

  it("returns an unparseable value as given, not stringified", () => {
    const value = { not: "a date" };
    expect(formatMediumTimestamp(value, "-")).toBe(value);
  });

  it("formats a real timestamp as a medium date and short time", () => {
    expect(formatMediumTimestamp(START, "-")).toBe(sgMediumTime(START));
  });
});

// Singapore is UTC+8 with no daylight saving. 01:00Z is 9:00 am there on the same
// day; 17:30Z is 1:30 am the next day, so a device-zone formatter fails in UTC too.
describe("Singapore time on every device", () => {
  const MORNING = "2026-01-15T01:00:00Z";
  const PAST_MIDNIGHT = "2026-01-15T17:30:00Z";

  it("SCRUM584_AC6_formatTimestamp_shows_the_singapore_hour_and_day", () => {
    expect(formatTimestamp(MORNING)).toBe(sgTime(MORNING));
    expect(formatTimestamp(MORNING)).toMatch(/\b15\b/);
    expect(formatTimestamp(MORNING)).toMatch(/\b0?9:00/);
    expect(formatTimestamp(PAST_MIDNIGHT)).toMatch(/\b16\b/);
    expect(formatTimestamp(PAST_MIDNIGHT)).not.toMatch(/\b15\b/);
  });

  it("SCRUM584_AC6_formatEventDate_shows_the_singapore_hour_and_day", () => {
    expect(formatEventDate(MORNING)).toBe(sgTime(MORNING));
    expect(formatEventDate(MORNING)).toMatch(/\b0?9:00/);
    expect(formatEventDate(PAST_MIDNIGHT)).toMatch(/\b16\b/);
    expect(formatEventDate(PAST_MIDNIGHT)).not.toMatch(/\b15\b/);
  });

  it("SCRUM584_AC6_formatMediumDateTime_shows_the_singapore_hour_and_day", () => {
    expect(formatMediumDateTime(new Date(MORNING))).toBe(sgMediumTime(MORNING));
    expect(formatMediumDateTime(new Date(MORNING))).toMatch(/\b0?9:00/);
    expect(formatMediumDateTime(new Date(PAST_MIDNIGHT))).toMatch(/\b16\b/);
    expect(formatMediumDateTime(new Date(PAST_MIDNIGHT))).not.toMatch(/\b15\b/);
  });

  it("SCRUM584_AC6_formatRange_shows_both_ends_in_singapore_time", () => {
    expect(formatRange(MORNING, PAST_MIDNIGHT)).toBe(`${sgTime(MORNING)} – ${sgTime(PAST_MIDNIGHT)}`);
  });

  it("SCRUM584_AC6_formatDate_gives_the_singapore_calendar_day", () => {
    expect(formatDate(PAST_MIDNIGHT)).toMatch(/\b16\b/);
    expect(formatDate(PAST_MIDNIGHT)).not.toMatch(/\b15\b/);
    expect(formatDate(PAST_MIDNIGHT)).not.toMatch(/:/);
  });

  it("SCRUM584_AC6_formatDate_keeps_the_missing_and_unparseable_behaviour", () => {
    expect(formatDate(null)).toBe("unknown");
    expect(formatDate(undefined, "-")).toBe("-");
    expect(formatDate("not a date")).toBe("not a date");
  });
});

describe("asList", () => {
  it("passes an array through and reads anything else as empty", () => {
    const rows = [{ id: "1" }];
    expect(asList(rows)).toBe(rows);
    expect(asList({ unexpected: true })).toEqual([]);
    expect(asList(null)).toEqual([]);
  });
});

describe("pluralise", () => {
  it("adds an s to every count but one", () => {
    expect(pluralise(1, "hour")).toBe("1 hour");
    expect(pluralise(0, "active event")).toBe("0 active events");
    expect(pluralise(3, "day")).toBe("3 days");
  });
});

describe("orNotSpecified", () => {
  it("trims text and says a blank or missing value was not specified", () => {
    expect(orNotSpecified("  Ramp access  ")).toBe("Ramp access");
    expect(orNotSpecified("   ")).toBe("Not specified");
    expect(orNotSpecified(null)).toBe("Not specified");
    expect(orNotSpecified(undefined)).toBe("Not specified");
  });
});
