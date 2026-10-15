import { describe, expect, it } from "vitest";
import { describeNotification } from "../../src/services/notificationDisplay.js";

describe("SCRUM-490 safety notifications", () => {
  it.each([
    ["approved", "The event was approved after safety review"],
    ["changes_requested", "The event needs changes after safety review"],
    ["rejected", "The event had its safety arrangement rejected"],
    ["unknown", "The event received a safety review response"],
  ])("describes a %s review response", (outcome, headline) => {
    expect(describeNotification({
      type: "safety_review_response",
      payload: { eventName: "The event", outcome, note: "Review note" },
    })).toEqual({ headline, detail: "Review note" });
  });

  it("uses safe defaults for review response details", () => {
    expect(describeNotification({
      type: "safety_review_response",
      payload: { eventName: "", outcome: "unknown", note: "" },
    })).toEqual({
      headline: "The event received a safety review response",
      detail: "Open the event to review the Safety Officer's response.",
    });
  });

  it("describes a flagged safety booking and supplies missing details", () => {
    expect(describeNotification({
      type: "safety_booking_flagged",
      payload: {
        eventName: "The event",
        venueName: "Hall A",
        reason: "Emergency access is blocked",
        startsAt: "2026-10-01T10:00:00Z",
        endsAt: "2026-10-01T12:00:00Z",
      },
    })).toMatchObject({
      headline: "The event at Hall A needs review",
      detail: expect.stringContaining("Reason: Emergency access is blocked. Booked "),
    });
    expect(describeNotification({
      type: "safety_booking_flagged",
      payload: {},
    })).toEqual({
      headline: "Unnamed event at Unknown venue needs review",
      detail: "Reason: Safety review. Booked unknown – unknown.",
    });
  });

  it("describes equipment review notifications with and without an event name", () => {
    expect(describeNotification({
      type: "safety_equipment_review",
      payload: { eventName: "The event" },
    })).toEqual({
      headline: "Equipment for The event was returned for review",
      detail: "A Safety Officer marked the equipment arrangement as affected.",
    });
    expect(describeNotification({
      type: "safety_equipment_review",
      payload: {},
    }).headline).toBe("Equipment for Unnamed event was returned for review");
  });

  it.each([null, ""])("omits a submission start time when it is %s", (startsAt) => {
    expect(describeNotification({
      type: "event_submitted_for_safety_review",
      payload: { eventName: "The event", coordinatorName: "A coordinator", startsAt },
    }).detail).toBe("The event was submitted by A coordinator.");
  });
});
