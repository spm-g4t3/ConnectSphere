// datetimeFormat.test.js
//
// A smoke test on an existing pure module, and proof the frontend harness runs.
// Timezone-safe by construction: it compares instants through getTime() and
// checks the offset's shape, never a hard-coded wall-clock string, so it
// passes on any device zone (and in CI's UTC).

import { describe, it, expect } from "vitest";

import {
  closesNextDay,
  describeClosing,
  formatHoursEntry,
  toDatetimeLocalValue,
  toOffsetIsoString,
  deviceTimeZoneLabel,
  formatVenueTimestamp,
  isReplyOverdue,
  toVenueOffsetIsoString,
  toVenueWallClock,
  VENUE_TIME_ZONE,
  VENUE_UTC_OFFSET,
  venueToday,
  venueTomorrow,
} from "../../src/services/datetimeFormat.js";

const OFFSET_SUFFIX = /[+-]\d{2}:\d{2}$|Z$/;

describe("toOffsetIsoString(toDatetimeLocalValue(x)) round trip", () => {
  it.each([
    "2026-06-01T01:00:00+00:00",
    "2026-01-15T23:30:00Z",
    "2026-07-04T12:45:00+08:00",
    "2026-03-29T08:15:00-05:00",
  ])("names the same instant as %s", (iso) => {
    const roundTripped = toOffsetIsoString(toDatetimeLocalValue(iso));
    expect(roundTripped).toMatch(OFFSET_SUFFIX);
    expect(new Date(roundTripped).getTime()).toBe(new Date(iso).getTime());
  });
});

describe("toDatetimeLocalValue", () => {
  it("produces the YYYY-MM-DDTHH:mm shape a datetime-local input wants", () => {
    expect(toDatetimeLocalValue("2026-06-01T01:00:00Z")).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/,
    );
  });

  it.each([
    ["garbage", "not a date"],
    ["empty string", ""],
    ["undefined", undefined],
    ["null", null],
  ])("returns '' for %s", (_label, value) => {
    expect(toDatetimeLocalValue(value)).toBe("");
  });
});

describe("toOffsetIsoString", () => {
  it("stamps an explicit offset onto a wall-clock value, adding seconds", () => {
    const result = toOffsetIsoString("2026-06-01T09:00");
    expect(result).toMatch(/^2026-06-01T09:00:00[+-]\d{2}:\d{2}$/);
    // The stamped string names the instant the device reads the input as.
    expect(new Date(result).getTime()).toBe(new Date("2026-06-01T09:00").getTime());
  });

  it("keeps seconds that are already present", () => {
    expect(toOffsetIsoString("2026-06-01T09:00:30")).toMatch(
      /^2026-06-01T09:00:30[+-]\d{2}:\d{2}$/,
    );
  });

  it.each(["2026-06-01T09:00:00Z", "2026-06-01T09:00:00+08:00", "2026-06-01T09:00:00-05:30"])(
    "leaves %s, which already has an offset, unchanged",
    (value) => {
      expect(toOffsetIsoString(value)).toBe(value);
    },
  );

  it.each([
    ["empty string", ""],
    ["undefined", undefined],
  ])("returns undefined for %s", (_label, value) => {
    expect(toOffsetIsoString(value)).toBeUndefined();
  });

  it("returns garbage unchanged so the backend can name the fault", () => {
    expect(toOffsetIsoString("not a date")).toBe("not a date");
  });
});

describe("deviceTimeZoneLabel", () => {
  it("returns a non-empty zone name", () => {
    const label = deviceTimeZoneLabel();
    expect(typeof label).toBe("string");
    expect(label.length).toBeGreaterThan(0);
  });
});

// Venue (Singapore) time is the one place a hard-coded wall clock is right:
// the answer must be the same on every device, so these pass unchanged under
// TZ=UTC, Asia/Singapore and America/New_York.
describe("venue time", () => {
  it("names Singapore and its fixed offset", () => {
    expect(VENUE_TIME_ZONE).toBe("Asia/Singapore");
    expect(VENUE_UTC_OFFSET).toBe("+08:00");
  });

  it.each([
    ["a +08:00 instant", "2026-11-11T09:00:00+08:00", "2026-11-11T09:00"],
    ["a UTC instant", "2026-11-11T01:00:00Z", "2026-11-11T09:00"],
    ["a New York evening, already the next Singapore day", "2026-11-10T20:00:00-05:00", "2026-11-11T09:00"],
    ["Singapore midnight", "2026-11-11T00:00:00+08:00", "2026-11-11T00:00"],
  ])("toVenueWallClock reads %s in Singapore", (_label, iso, expected) => {
    expect(toVenueWallClock(iso)).toBe(expected);
  });

  it.each([
    ["garbage", "not a date"],
    ["empty string", ""],
    ["undefined", undefined],
    ["null", null],
  ])("toVenueWallClock returns empty for %s", (_label, value) => {
    expect(toVenueWallClock(value)).toBe("");
  });

  it("toVenueOffsetIsoString stamps +08:00, adding seconds only when absent", () => {
    expect(toVenueOffsetIsoString("2026-11-11T09:00")).toBe("2026-11-11T09:00:00+08:00");
    expect(toVenueOffsetIsoString("2026-11-11T09:00:30")).toBe("2026-11-11T09:00:30+08:00");
  });

  it.each(["2026-11-11T09:00:00Z", "2026-11-11T09:00:00-05:00", "not a date", "T"])(
    "toVenueOffsetIsoString leaves %s unchanged",
    (value) => {
      expect(toVenueOffsetIsoString(value)).toBe(value);
    },
  );

  it.each([
    ["empty string", ""],
    ["undefined", undefined],
  ])("toVenueOffsetIsoString returns undefined for %s", (_label, value) => {
    expect(toVenueOffsetIsoString(value)).toBeUndefined();
  });

  it.each(["2026-11-11T09:00:00+08:00", "2026-11-11T01:00:00Z", "2026-03-08T07:30:00-05:00"])(
    "round trips %s to the same instant",
    (iso) => {
      expect(new Date(toVenueOffsetIsoString(toVenueWallClock(iso))).getTime())
        .toBe(new Date(iso).getTime());
    },
  );
});

describe("formatVenueTimestamp", () => {
  // Venue time on every device, like formatVenuePeriod (see the note above "venue time").
  it.each([
    ["a UTC instant", "2026-11-01T02:00:00.000Z", "2026-11-01 10:00 (Singapore time)"],
    ["a New York evening, already the next Singapore day", "2026-10-31T21:00:00-05:00", "2026-11-01 10:00 (Singapore time)"],
  ])("SCRUM494_AC6_formatVenueTimestamp_reads_%s_in_singapore", (_label, iso, expected) => {
    expect(formatVenueTimestamp(iso)).toBe(expected);
  });

  it.each([null, undefined, "", "not a date"])("SCRUM494_AC6_formatVenueTimestamp_falls_back_for_%s", (value) => {
    expect(formatVenueTimestamp(value)).toBe("Not set");
    expect(formatVenueTimestamp(value, "Unknown")).toBe("Unknown");
  });
});

// The reply-by date is a Singapore calendar day, on every device.
describe("isReplyOverdue", () => {
  const now = new Date("2026-10-20T20:00:00Z"); // 04:00 on 21 Oct in Singapore

  it("SCRUM162_AC12_isReplyOverdue_is_overdue_once_the_singapore_date_is_past_the_reply_by_date", () => {
    expect(isReplyOverdue("2026-10-19", now)).toBe(true);
    // Still 20 Oct in UTC, but 21 Oct in Singapore, so the 20th has lapsed.
    expect(isReplyOverdue("2026-10-20", now)).toBe(true);
    expect(isReplyOverdue("2026-10-21", now)).toBe(false);
  });
});

describe("venueToday and venueTomorrow", () => {
  // Singapore midnight is 16:00 UTC, so the day turns over there.
  it("SCRUM162_AC1_venueToday_keeps_the_singapore_day_until_16_00_utc", () => {
    expect(venueToday(new Date("2026-10-20T15:59:59Z"))).toBe("2026-10-20");
  });

  it("SCRUM162_AC1_venueToday_turns_to_the_next_singapore_day_at_16_00_utc", () => {
    expect(venueToday(new Date("2026-10-20T16:00:00Z"))).toBe("2026-10-21");
  });

  it("SCRUM162_AC1_venueTomorrow_is_the_day_after_the_singapore_day", () => {
    expect(venueTomorrow(new Date("2026-10-20T15:59:59Z"))).toBe("2026-10-21");
    expect(venueTomorrow(new Date("2026-10-20T16:00:00Z"))).toBe("2026-10-22");
    expect(venueTomorrow(new Date("2026-10-31T16:00:00Z"))).toBe("2026-11-02");
  });
});

describe("opening hours past midnight", () => {
  it("SCRUM575_AC1_closesNextDay_when_closing_is_at_or_before_opening", () => {
    expect(closesNextDay("18:00", "02:00")).toBe(true);
    // Compared in one format: the server's "HH:MM:SS" against the input's "HH:MM".
    expect(closesNextDay("18:00:00", "02:00")).toBe(true);
    expect(closesNextDay("09:00", "18:00:00")).toBe(false);
    expect(closesNextDay("18:00", "")).toBe(false);
  });

  it("SCRUM575_AC1_describeClosing_names_the_next_day", () => {
    expect(describeClosing(5, "18:00", "02:00")).toBe("Closes Saturday 02:00 (next day)");
    // Saturday wraps to Sunday.
    expect(describeClosing(6, "20:00:00", "01:30:00")).toBe("Closes Sunday 01:30 (next day)");
  });

  it("SCRUM575_AC2_describeClosing_reads_00_00_as_midnight", () => {
    expect(describeClosing(4, "18:00", "00:00")).toBe("Closes at midnight");
  });

  it("SCRUM575_AC1_describeClosing_is_null_for_same_day_equal_or_unreadable_times", () => {
    expect(describeClosing(1, "09:00", "18:00")).toBeNull();
    expect(describeClosing(1, "09:00", "09:00:00")).toBeNull();
    expect(describeClosing(1, "", "02:00")).toBeNull();
  });

  it("SCRUM575_AC4_formatHoursEntry_shows_both_days_overnight", () => {
    expect(formatHoursEntry({ day_of_week: 5, opens_at: "18:00:00", closes_at: "02:00:00" }))
      .toBe("Fri 18:00 – Sat 02:00");
    expect(formatHoursEntry({ day_of_week: 6, opens_at: "22:00", closes_at: "03:00" }))
      .toBe("Sat 22:00 – Sun 03:00");
  });

  it("SCRUM575_AC2_formatHoursEntry_shows_a_00_00_close_as_midnight", () => {
    expect(formatHoursEntry({ day_of_week: 4, opens_at: "18:00:00", closes_at: "00:00:00" }))
      .toBe("Thu 18:00 – midnight");
  });

  it("SCRUM575_AC4_formatHoursEntry_keeps_the_same_day_format", () => {
    expect(formatHoursEntry({ day_of_week: 1, opens_at: "09:00:00", closes_at: "18:00:00" }))
      .toBe("Mon 09:00–18:00");
    expect(formatHoursEntry({ day_of_week: 9, opens_at: "09:00", closes_at: "18:00" }))
      .toBe("Day 9 09:00–18:00");
  });
});
