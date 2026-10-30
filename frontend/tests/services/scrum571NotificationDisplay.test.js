// scrum571NotificationDisplay.test.js
//
// SCRUM-571: 038 also sends booking_request_conflict_cleared when the clashing
// booking is cancelled or replaced, so the notice must not claim a release.
// Times are built with the module's own formatRange, so the suite passes in
// any zone and locale.

import { describe, it, expect } from "vitest";

import { describeNotification } from "../../src/services/notificationDisplay.js";
import { formatRange } from "../../src/services/displayFormat.js";

const STARTS = "2026-11-11T13:00:00+08:00";
const ENDS = "2026-11-11T14:00:00+08:00";
const RANGE = formatRange(STARTS, ENDS);

describe("SCRUM571_AC1 describeNotification: booking_request_conflict_cleared", () => {
  it("SCRUM571_AC1_the_conflict_cleared_notice_does_not_say_released", () => {
    const { detail } = describeNotification({
      id: "n1",
      type: "booking_request_conflict_cleared",
      payload: {
        eventName: "Tech Talk", venueName: "Hall A", startsAt: STARTS, endsAt: ENDS,
        releasedEventName: "Gala Dinner",
      },
    });

    expect(detail).toContain("Gala Dinner");
    expect(detail).toContain(`your request for ${RANGE} is pending again`);
    expect(detail).not.toMatch(/released/i);
  });
});
