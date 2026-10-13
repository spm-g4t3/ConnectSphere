/* global process -- the time zone tests set TZ for the Node process the tests run in */
// openEventDisplay.test.js
//
// SCRUM-495 (AC3). How availability, dates and times read on the browse list.

import { describe, it, expect, afterEach } from "vitest";

import {
  availabilityLabel,
  formatEventDate,
  formatEventEndTime,
  formatEventStartTime,
} from "../../src/services/openEventDisplay.js";

describe("availabilityLabel", () => {
  it.each([
    [{ isFull: false, placesLeft: 12 }, "12 places left"],
    [{ isFull: false, placesLeft: 2 }, "2 places left"],
    [{ isFull: false, placesLeft: 1 }, "1 place left"],
    [{ isFull: true, placesLeft: 0 }, "Full"],
    [{ isFull: false, placesLeft: null }, "No limit"],
    [{ isFull: false }, "No limit"],
  ])("SCRUM495_AC3_%j_reads_%s", (event, label) => {
    expect(availabilityLabel(event)).toBe(label);
  });

  it("SCRUM495_AC3_Full_wins_over_every_other_field", () => {
    expect(availabilityLabel({ isFull: true, placesLeft: null })).toBe("Full");
  });
});

// The API sends instants with an offset; the page shows them in Singapore time
// whatever the device's own zone is.
const ORIGINAL_TZ = process.env.TZ;

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe.each(["Asia/Singapore", "America/New_York", "Pacific/Kiritimati"])(
  "SCRUM495_AC3 date and times read in Singapore time on a device set to %s",
  (deviceZone) => {
    // 01:00Z is 09:00 on the 25th in Singapore, 21:00 on the 24th in New York.
    const startsAt = "2026-10-25T01:00:00.000Z";
    const endsAt = "2026-10-25T03:30:00.000Z";

    it("reads 09:00 to 11:30 on the 25th", () => {
      process.env.TZ = deviceZone;

      expect(formatEventDate(startsAt)).toMatch(/Oct 25, 2026|25 Oct 2026/);
      expect(formatEventStartTime(startsAt)).toContain("09:00");
      expect(formatEventEndTime(startsAt, endsAt)).toContain("11:30");
    });

    it("shows the end date only where the event crosses midnight in Singapore", () => {
      // 15:00Z to 17:00Z is 23:00 to 01:00 the next day in Singapore, the same afternoon in New York.
      process.env.TZ = deviceZone;

      expect(formatEventEndTime("2026-10-25T15:00:00.000Z", "2026-10-25T17:00:00.000Z")).toMatch(/Oct 26, 2026|26 Oct 2026/);
      expect(formatEventEndTime("2026-10-25T01:00:00.000Z", "2026-10-25T03:00:00.000Z")).not.toMatch(/Oct/);
    });

    it("accepts the same instant written with an offset", () => {
      process.env.TZ = deviceZone;

      expect(formatEventStartTime("2026-10-25T09:00:00+08:00")).toBe(formatEventStartTime(startsAt));
      expect(formatEventDate("2026-10-25T09:00:00+08:00")).toBe(formatEventDate(startsAt));
    });
  },
);

describe("SCRUM495_AC3 unreadable times", () => {
  it("falls back to plain text", () => {
    expect(formatEventDate(null)).toBe("Date to be confirmed");
    expect(formatEventStartTime("not a date")).toBe("Not set");
    expect(formatEventEndTime("2026-10-25T01:00:00.000Z", undefined)).toBe("Not set");
  });
});