// scrum173NotificationDisplay.test.js
//
// SCRUM-173: what an Organiser reads when their event request is decided
// (AC7, AC8), what the assigned coordinator reads about a venue hold (AC11),
// and where each notice opens. The payloads are 032's. Hold expiries are
// Singapore time on every device, so the expected text is a literal.

import { describe, it, expect } from "vitest";

import { describeNotification } from "../../src/services/notificationDisplay.js";
import { notificationLink } from "../../src/services/notificationLink.js";

const EVENT = "e1";
// 10:00 UTC is 18:00 in Singapore, so device-zone formatting would show otherwise.
const EXPIRES = "2026-11-03T10:00:00Z";
const EXPIRES_SGT = "2026-11-03 18:00 (Singapore time)";

const notice = (type, payload) => ({ id: "n1", type, payload });

describe("SCRUM173_AC7 describeNotification: event_request_approved", () => {
  it("SCRUM173_AC7_approval_tells_the_organiser_planning_can_go_ahead", () => {
    const decided = { eventRequestId: EVENT, eventName: "Tech Talk", decidedByName: "Priya Nair" };

    expect(describeNotification(notice("event_request_approved", { ...decided, reason: "Book Hall A early." })))
      .toEqual({
        headline: "Tech Talk was approved",
        detail: "Planning can go ahead. Coordinator's note: Book Hall A early.",
      });
    expect(describeNotification(notice("event_request_approved", decided)).detail)
      .toBe("Planning can go ahead.");
  });
});

describe("SCRUM173_AC8 describeNotification: event_request_rejected", () => {
  it("SCRUM173_AC8_rejection_shows_the_reason_and_that_the_request_can_be_resubmitted", () => {
    expect(describeNotification(notice("event_request_rejected", {
      eventRequestId: EVENT, eventName: "Tech Talk", reason: "Clashes with exam week",
    }))).toEqual({
      headline: "Tech Talk was rejected",
      detail: "Reason: Clashes with exam week. You can change the request and resubmit it.",
    });
  });

  it("SCRUM173_AC8_a_rejection_without_a_reason_says_none_was_recorded", () => {
    const { headline, detail } = describeNotification({ id: "n1", type: "event_request_rejected" });

    expect(headline).toBe("Unnamed event was rejected");
    expect(detail).toBe("Reason: No reason recorded. You can change the request and resubmit it.");
  });

  it("SCRUM173_AC8_a_decision_notice_opens_the_organisers_event_row", () => {
    for (const type of ["event_request_approved", "event_request_rejected"]) {
      expect(notificationLink({ type, eventRequestId: EVENT }, "event_organiser")).toEqual({
        to: "/events",
        state: { focusEventRequestId: EVENT },
      });
    }
  });
});

describe("SCRUM173_AC11 describeNotification: venue holds", () => {
  const HOLD = Object.freeze({
    eventRequestId: EVENT, eventName: "Tech Talk", venueName: "Hall A", expiresAt: EXPIRES,
  });

  it("SCRUM173_AC11_hold_placed_shows_the_expiry_in_singapore_time", () => {
    expect(describeNotification(notice("venue_hold_placed", { ...HOLD, placedByName: "Sam Lee" })))
      .toEqual({
        headline: "Hall A is held for Tech Talk",
        detail: `Placed by Sam Lee. The hold expires ${EXPIRES_SGT}. A hold is not a booking.`,
      });
  });

  it("SCRUM173_AC11_the_expiry_reminder_needs_action", () => {
    expect(describeNotification(notice("venue_hold_expiring", HOLD))).toEqual({
      headline: "The hold on Hall A for Tech Talk expires soon",
      detail: `It expires ${EXPIRES_SGT}. Complete the booking before then, or the venue is released.`,
      needsAction: true,
    });
  });

  it.each(["venue_hold_placed", "venue_hold_expiring"])(
    "SCRUM173_AC11_a_hold_notice_without_an_expiry_never_prints_undefined (%s)",
    (type) => {
      const { headline, detail } = describeNotification(notice(type, {}));

      // "Unknown venue" is the module's own fallback; a leaked placeholder is not.
      expect(`${headline} ${detail}`).not.toMatch(/undefined|null|Invalid Date|Not set/);
    },
  );

  it("SCRUM173_AC11_a_hold_notice_opens_the_coordinators_event_page", () => {
    expect(notificationLink({ type: "venue_hold_expiring", eventRequestId: EVENT }, "event_coordinator"))
      .toEqual({ to: `/event-requests/${EVENT}` });
  });
});
