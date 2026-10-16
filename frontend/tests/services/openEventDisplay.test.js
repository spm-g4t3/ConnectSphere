/* global process -- the time zone tests set TZ for the Node process the tests run in */
// openEventDisplay.test.js
//
// SCRUM-495 (AC3). How availability, dates and times read on the browse list.

import { describe, it, expect, afterEach, vi } from "vitest";

import {
  EVENT_TIME_NOTE,
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

    it("SCRUM495_AC3_reads_09_00_to_11_30_on_the_25th", () => {
      process.env.TZ = deviceZone;

      expect(formatEventDate(startsAt)).toBe("2026-10-25");
      expect(formatEventStartTime(startsAt)).toBe("09:00");
      expect(formatEventEndTime(startsAt, endsAt)).toBe("11:30");
    });

    it("SCRUM495_AC3_shows_the_end_date_only_where_the_event_crosses_midnight_in_singapore", () => {
      // 15:00Z to 17:00Z is 23:00 to 01:00 the next day in Singapore, the same afternoon in New York.
      process.env.TZ = deviceZone;

      expect(formatEventEndTime("2026-10-25T15:00:00.000Z", "2026-10-25T17:00:00.000Z")).toBe("2026-10-26 01:00");
      expect(formatEventEndTime("2026-10-25T01:00:00.000Z", "2026-10-25T03:00:00.000Z")).toBe("11:00");
    });

    it("SCRUM495_AC3_accepts_the_same_instant_written_with_an_offset", () => {
      process.env.TZ = deviceZone;

      expect(formatEventStartTime("2026-10-25T09:00:00+08:00")).toBe(formatEventStartTime(startsAt));
      expect(formatEventDate("2026-10-25T09:00:00+08:00")).toBe(formatEventDate(startsAt));
    });
  },
);

describe("SCRUM495_AC3 unreadable times", () => {
  it("SCRUM495_AC3_falls_back_to_plain_text", () => {
    expect(formatEventDate(null)).toBe("Date to be confirmed");
    expect(formatEventStartTime("not a date")).toBe("Not set");
    expect(formatEventEndTime("2026-10-25T01:00:00.000Z", undefined)).toBe("Not set");
  });
});

describe("SCRUM495_AC3 the same text whatever the browser's locale", () => {
  it("SCRUM495_AC3_does_not_call_the_locale_dependent_formatters", () => {
    const date = vi.spyOn(Date.prototype, "toLocaleDateString");
    const time = vi.spyOn(Date.prototype, "toLocaleTimeString");

    formatEventDate("2026-10-25T01:00:00.000Z");
    formatEventStartTime("2026-10-25T01:00:00.000Z");
    formatEventEndTime("2026-10-25T01:00:00.000Z", "2026-10-26T01:00:00.000Z");

    expect(date).not.toHaveBeenCalled();
    expect(time).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("SCRUM495_AC3_carries_one_zone_note_shared_with_the_venue_pages", () => {
    expect(EVENT_TIME_NOTE).toBe("(Singapore time)");
  });
});