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
