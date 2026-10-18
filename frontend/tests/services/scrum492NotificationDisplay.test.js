// scrum492NotificationDisplay.test.js
//
// SCRUM-492: what Venue Staff read when a coordinator releases a venue (AC6),
// and what a coordinator reads when the release frees their request (AC4).
// The payloads are 089's. Times are built with the module's own formatRange,
// so the suite passes in any zone and locale.

import { describe, it, expect } from "vitest";

import { describeNotification } from "../../src/services/notificationDisplay.js";
import { formatRange } from "../../src/services/displayFormat.js";

const STARTS = "2026-11-11T13:00:00+08:00";
const ENDS = "2026-11-11T14:00:00+08:00";
const RANGE = formatRange(STARTS, ENDS);

const released = (payload) => ({ id: "n1", type: "booking_released", payload });
const cleared = (payload) => ({ id: "n2", type: "booking_request_conflict_cleared", payload });

describe("SCRUM492_AC6 describeNotification: booking_released", () => {
  it("SCRUM492_AC6_names_the_venue_the_event_the_period_who_and_why", () => {
    expect(describeNotification(released({
      eventName: "Tech Talk", venueName: "Hall A", startsAt: STARTS, endsAt: ENDS,
      releasedByName: "Priya Nair", reason: "Moved to Hall B",
    }))).toEqual({
      headline: "Hall A was released for Tech Talk",
      detail: `It is free again for ${RANGE}, released by Priya Nair. Reason: Moved to Hall B.`,
    });
  });

  it("SCRUM492_AC6_with_no_payload_it_still_reads_as_a_release", () => {
    const { headline, detail } = describeNotification({ id: "n1", type: "booking_released" });

    expect(headline).toBe("Unknown venue was released for Unnamed event");
    expect(detail).toContain("released by the event's coordinator. Reason: No reason recorded.");
    expect(detail).not.toMatch(/undefined|null/);
  });
});

describe("SCRUM492_AC4 describeNotification: booking_request_conflict_cleared", () => {
  it("SCRUM492_AC4_says_the_request_is_pending_again_and_which_event_released_the_venue", () => {
    expect(describeNotification(cleared({
      eventName: "Tech Talk", venueName: "Hall A", startsAt: STARTS, endsAt: ENDS, releasedEventName: "Gala Dinner",
    }))).toEqual({
      headline: "Your request for Hall A for Tech Talk no longer clashes",
      detail: `Gala Dinner released the venue, so your request for ${RANGE} is pending again and waits for Venue Staff.`,
    });
  });

  it("SCRUM492_AC4_with_no_released_event_name_it_says_another_event_instead", () => {
    expect(describeNotification(cleared({ eventName: "Tech Talk", venueName: "Hall A" })).detail)
      .toMatch(/^Another event released the venue/);
  });
});
