// displayFormat.test.js
//
// SCRUM-125 (part of SCRUM-17). The display helpers moved out of
// VenueDetail.jsx, plus the new formatRange. Timezone-safe: every expected
// string is computed here with toLocaleString, from fixtures that carry
// offsets, so the suite passes in any zone and locale.

import { describe, it, expect } from "vitest";

import { formatRange, formatTimestamp, shortId } from "../../src/services/displayFormat.js";

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
    expect(formatTimestamp(START)).toBe(new Date(START).toLocaleString());
  });
});

describe("formatRange", () => {
  it("joins both ends with a spaced en dash", () => {
    expect(formatRange(START, END)).toBe(
      `${new Date(START).toLocaleString()} – ${new Date(END).toLocaleString()}`,
    );
  });

  it("applies the fallback to a missing end", () => {
    expect(formatRange(START, null, "open-ended")).toBe(
      `${new Date(START).toLocaleString()} – open-ended`,
    );
  });

  it("defaults the fallback to unknown", () => {
    expect(formatRange(null, undefined)).toBe("unknown – unknown");
  });
});
