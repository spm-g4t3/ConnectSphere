// bookingRequestStatusDisplay.test.js
//
// SCRUM-255. The style for each booking status group, and the fallback.

import { describe, it, expect } from "vitest";

import {
  bookingStatusClassName,
  readBookingStatusDisplay,
} from "../../src/services/bookingRequestStatusDisplay.js";

describe("bookingStatusClassName", () => {
  it.each([
    ["PENDING", "status--booking-pending"],
    ["APPROVED", "status--booking-approved"],
    ["FLAGGED", "status--booking-flagged"],
    ["REJECTED", "status--booking-rejected"],
    ["WITHDRAWN", "status--booking-withdrawn"],
    ["CANCELLED", "status--booking-cancelled"],
    ["UNKNOWN", "status--booking-unknown"],
    ["UNAVAILABLE", "status--booking-unknown"],
  ])("SCRUM255_styles_group_%s_as_%s", (group, expected) => {
    expect(bookingStatusClassName(group)).toBe(expected);
  });

  it.each(["SOMETHING_NEW", "toString", undefined, null])(
    "SCRUM255_styles_the_group_%s_as_unknown_rather_than_nothing",
    (group) => {
      expect(bookingStatusClassName(group)).toBe("status--booking-unknown");
    },
  );

  it("SCRUM492_AC2_a_released_booking_has_its_own_status_class", () => {
    // Its own class, not unknown's, though App.css gives both the same grey.
    expect(bookingStatusClassName("RELEASED")).toBe("status--booking-released");
  });
});

describe("readBookingStatusDisplay", () => {
  it("SCRUM255_returns_the_servers_display", () => {
    const statusDisplay = { status: "withdrawn", label: "Withdrawn", group: "WITHDRAWN", description: "x" };
    expect(readBookingStatusDisplay({ statusDisplay })).toBe(statusDisplay);
  });

  it.each([{}, null, undefined])("SCRUM255_falls_back_to_status_unavailable_for_%j", (row) => {
    expect(readBookingStatusDisplay(row)).toMatchObject({ label: "Status Unavailable", group: "UNAVAILABLE" });
  });
});
