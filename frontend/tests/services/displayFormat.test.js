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
  formatDateTime,
  formatDateTimeRange,
  formatDateTimeRangeOrFallback,
  formatDay,
  formatDayMonth,
  formatEventDate,
  formatLongDay,
  formatMediumDateTime,
  formatMediumTimestamp,
  formatRange,
  formatTimestamp,
  formatWeekdayShort,
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

// One fixed locale as well as the zone, so the text is identical on every device
// and the expected values can be literals.
describe("the display format", () => {
  const MORNING = "2026-01-15T01:00:00Z";
  const LATE_MORNING = "2026-01-15T03:00:00Z";
  const PAST_MIDNIGHT = "2026-01-15T17:30:00Z";

  it("SCRUM584_AC6_formatDateTime_is_the_fixed_singapore_text", () => {
    expect(formatDateTime(MORNING)).toBe("15 Jan 2026, 9:00 am");
    expect(formatDateTime(PAST_MIDNIGHT)).toBe("16 Jan 2026, 1:30 am");
  });

  it("SCRUM584_AC6_formatDay_is_the_fixed_singapore_day", () => {
    expect(formatDay(MORNING)).toBe("15 Jan 2026");
    expect(formatDay(PAST_MIDNIGHT)).toBe("16 Jan 2026");
  });

  it("SCRUM584_AC6_a_range_within_one_singapore_day_gives_the_date_once", () => {
    expect(formatDateTimeRange(MORNING, LATE_MORNING)).toBe("15 Jan 2026, 9:00 am – 11:00 am");
  });

  it("SCRUM584_AC6_a_range_across_singapore_midnight_gives_both_dates", () => {
    // One UTC day (14:00Z to 17:00Z), two Singapore days.
    expect(formatDateTimeRange("2026-01-15T14:00:00Z", "2026-01-15T17:00:00Z")).toBe(
      "15 Jan 2026, 10:00 pm – 16 Jan 2026, 1:00 am",
    );
  });

  it("SCRUM584_AC6_a_range_across_utc_midnight_only_is_one_singapore_day", () => {
    // Two UTC days (23:00Z to 01:00Z), one Singapore day.
    expect(formatDateTimeRange("2026-01-15T23:00:00Z", "2026-01-16T01:00:00Z")).toBe(
      "16 Jan 2026, 7:00 am – 9:00 am",
    );
  });

  it("SCRUM584_AC6_missing_and_unparseable_values_read_as_the_older_helpers", () => {
    expect(formatDateTime(null)).toBe("unknown");
    expect(formatDateTime(undefined, "-")).toBe("-");
    expect(formatDateTime("not a date")).toBe("not a date");
    expect(formatDay("")).toBe("unknown");
    expect(formatDay("not a date")).toBe("not a date");
    expect(formatDateTimeRange(null, undefined)).toBe("unknown – unknown");
    expect(formatDateTimeRange(null, MORNING, "-")).toBe("- – 15 Jan 2026, 9:00 am");
    expect(formatDateTimeRange("soon", LATE_MORNING)).toBe("soon – 15 Jan 2026, 11:00 am");
  });
});

// The venue calendar builds its days as the device's local midnights.
describe("calendar day labels", () => {
  // Local midnight, so in Singapore it is the previous day in UTC, and east of
  // Singapore it is the previous day in Singapore too: neither zone may shift it.
  const MON_28_SEP = new Date(2026, 8, 28);

  it("SCRUM587_AC4_calendar_day_labels_are_the_fixed_text_for_the_local_day", () => {
    expect(formatWeekdayShort(MON_28_SEP)).toBe("Mon");
    expect(formatDayMonth(MON_28_SEP)).toBe("28 Sept");
    expect(formatLongDay(MON_28_SEP)).toBe("Monday, 28 September 2026");
  });

  it("SCRUM587_AC4_a_range_with_no_dates_says_the_fallback_once", () => {
    expect(formatDateTimeRangeOrFallback(null, undefined, "no date")).toBe("no date");
    expect(formatDateTimeRangeOrFallback(null, "2026-01-15T01:00:00Z", "no date")).toBe(
      "no date – 15 Jan 2026, 9:00 am",
    );
    expect(formatDateTimeRangeOrFallback("2026-01-15T01:00:00Z", "2026-01-15T03:00:00Z", "no date")).toBe(
      "15 Jan 2026, 9:00 am – 11:00 am",
    );
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
