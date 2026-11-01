import { describe, it, expect } from "vitest";
import { describeHoldExpiry } from "../../src/services/holdExpiry";

const NOW = new Date("2026-12-01T00:00:00Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const at = (ms) => new Date(NOW.getTime() + ms).toISOString();

describe("describeHoldExpiry", () => {
  it.each([
    ["two days away", 2 * DAY, "in 2 days", false],
    ["one day and a minute away", DAY + MINUTE, "in 1 day", false],
    // Rounded, not truncated: minutes after placing a three-day hold it still reads 3 days.
    ["three days less a minute away", 3 * DAY - MINUTE, "in 3 days", false],
    ["exactly 24 hours away", DAY, "in 24 hours", true],
    ["five hours away", 5 * HOUR, "in 5 hours", true],
    ["one hour away", HOUR, "in 1 hour", true],
    ["59 minutes away", 59 * MINUTE, "in less than an hour", true],
    ["already past", -MINUTE, "expired", false],
    ["expiring this instant", 0, "expired", false],
  ])("SCRUM587_AC1_hold_expiry_is_described_in_words (%s)", (_name, offset, relative, soon) => {
    expect(describeHoldExpiry(at(offset), NOW)).toEqual({ relative, soon });
  });

  it("SCRUM587_AC1_hold_expiry_says_nothing_for_an_unreadable_date", () => {
    expect(describeHoldExpiry("not a date", NOW)).toEqual({ relative: null, soon: false });
  });
});
