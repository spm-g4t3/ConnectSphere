// bookingRequestStatusDisplay.test.js
//
// SCRUM-255. The fallback when a booking request has no statusDisplay.

import { describe, it, expect } from "vitest";

import { readBookingStatusDisplay } from "../../src/services/bookingRequestStatusDisplay.js";

describe("readBookingStatusDisplay", () => {
  it("SCRUM255_returns_the_servers_display", () => {
    const statusDisplay = { status: "withdrawn", label: "Withdrawn", group: "WITHDRAWN", description: "x" };
    expect(readBookingStatusDisplay({ statusDisplay })).toBe(statusDisplay);
  });

  it.each([{}, null, undefined])("SCRUM255_falls_back_to_status_unavailable_for_%j", (row) => {
    expect(readBookingStatusDisplay(row)).toMatchObject({ label: "Status Unavailable", group: "UNAVAILABLE" });
  });
});
