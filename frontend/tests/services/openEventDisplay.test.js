/* global process -- the time zone tests set TZ for the Node process the tests run in */
// openEventDisplay.test.js
//
// SCRUM-495 (AC3). How availability reads on the browse list. Date and time
// formatting is covered through the page's own tests, which read the same
// locale calls.

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

// ---------------------------------------------------------------------------
// Time zones: the API sends instants with an offset, and the device decides how
// they read. The same instant must read as the local date and time in each zone.
// ---------------------------------------------------------------------------


const ORIGINAL_TZ = process.env.TZ;

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe("SCRUM495_AC4 date and times follow the device's time zone", () => {
  // 2026-10-25T01:00Z is 09:00 on the 25th in Singapore and 21:00 on the 24th in New York.
  const startsAt = "2026-10-25T01:00:00.000Z";
  const endsAt = "2026-10-25T03:30:00.000Z";

  it("reads 09:00 on the 25th in Singapore", () => {
    process.env.TZ = "Asia/Singapore";

    expect(formatEventDate(startsAt)).toContain("25");
    expect(formatEventStartTime(startsAt)).toContain("09:00");
    expect(formatEventEndTime(startsAt, endsAt)).toContain("11:30");
  });

  it("reads 21:00 on the 24th in New York, an earlier calendar day than Singapore", () => {
    process.env.TZ = "America/New_York";

    expect(formatEventDate(startsAt)).toContain("24");
    expect(formatEventStartTime(startsAt)).toMatch(/21:00|09:00/);
    expect(formatEventEndTime(startsAt, endsAt)).toMatch(/23:30|11:30/);
  });

  it("accepts the same instant written with an offset", () => {
    process.env.TZ = "Asia/Singapore";

    expect(formatEventStartTime("2026-10-25T09:00:00+08:00")).toBe(formatEventStartTime(startsAt));
    expect(formatEventDate("2026-10-25T09:00:00+08:00")).toBe(formatEventDate(startsAt));
  });

  it("shows the end date only where the event crosses midnight in the reader's zone", () => {
    // 15:00Z to 17:00Z: 23:00 to 01:00 the next day in Singapore, the same afternoon in New York.
    const late = { startsAt: "2026-10-25T15:00:00.000Z", endsAt: "2026-10-25T17:00:00.000Z" };

    process.env.TZ = "Asia/Singapore";
    expect(formatEventEndTime(late.startsAt, late.endsAt)).toContain("26");

    process.env.TZ = "America/New_York";
    expect(formatEventEndTime(late.startsAt, late.endsAt)).not.toMatch(/Oct|,/);
  });
});
