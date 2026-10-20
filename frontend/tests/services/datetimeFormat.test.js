// datetimeFormat.test.js
//
// A smoke test on an existing pure module, and proof the frontend harness runs.
// Timezone-safe by construction: it compares instants through getTime() and
// checks the offset's shape, never a hard-coded wall-clock string, so it
// passes on any device zone (and in CI's UTC).

import { describe, it, expect } from "vitest";

import {
  toDatetimeLocalValue,
  toOffsetIsoString,
  deviceTimeZoneLabel,
  isReplyOverdue,
  toVenueOffsetIsoString,
  toVenueWallClock,
  VENUE_TIME_ZONE,
  VENUE_UTC_OFFSET,
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

// Pins today's behaviour: the reply-by date is compared with the UTC date.
// Which zone it should use is an open question; change this test with it.
describe("isReplyOverdue", () => {
  const now = new Date("2026-10-20T20:00:00Z"); // 04:00 on 21 Oct in Singapore

  it("is overdue only once the UTC date is past the reply-by date", () => {
    expect(isReplyOverdue("2026-10-19", now)).toBe(true);
    expect(isReplyOverdue("2026-10-20", now)).toBe(false);
    expect(isReplyOverdue("2026-10-21", now)).toBe(false);
  });
});
