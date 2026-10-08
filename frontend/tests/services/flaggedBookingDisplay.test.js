// flaggedBookingDisplay.test.js
//
// SCRUM-484 (AC8). The wording shared by the venue catalogue's flagged-bookings
// notice and the coordinator's booking-request list: the label for a stored
// review_reason code, and the heading of the notice. No times are involved,
// so nothing here depends on the timezone.

import { describe, it, expect } from "vitest";

import {
  REVIEW_REASON_LABELS,
  reviewReasonLabel,
  flaggedBookingsHeading,
} from "../../src/services/flaggedBookingDisplay.js";

describe("reviewReasonLabel", () => {
  it("SCRUM484_AC8_labels_the_setup_or_turnaround_code", () => {
    expect(reviewReasonLabel("setup_or_turnaround_changed")).toBe("Setup or turnaround time changed");
  });

  it.each([
    ["an unknown code", "flood"],
    ["an inherited property name", "toString"],
    ["a differently cased code", "SETUP_OR_TURNAROUND_CHANGED"],
  ])("SCRUM484_AC8_reads_%s_as_null_not_the_raw_code", (_label, code) => {
    expect(reviewReasonLabel(code)).toBeNull();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
  ])("SCRUM484_AC8_reads_%s_as_null", (_label, code) => {
    expect(reviewReasonLabel(code)).toBeNull();
  });

  it("SCRUM484_AC8_the_label_table_is_frozen", () => {
    expect(Object.isFrozen(REVIEW_REASON_LABELS)).toBe(true);
  });
});

describe("flaggedBookingsHeading", () => {
  it("SCRUM484_AC8_heading_for_one_booking_is_singular", () => {
    expect(flaggedBookingsHeading(1)).toBe(
      "1 booking flagged for review: Setup or turnaround time changed",
    );
  });

  it.each([2, 3, 12])("SCRUM484_AC8_heading_for_%i_bookings_is_plural", (count) => {
    expect(flaggedBookingsHeading(count)).toBe(
      `${count} bookings flagged for review: Setup or turnaround time changed`,
    );
  });

  it("SCRUM484_AC8_heading_uses_the_same_label_as_reviewReasonLabel", () => {
    expect(flaggedBookingsHeading(2)).toContain(reviewReasonLabel("setup_or_turnaround_changed"));
  });

  it("SCRUM484_AC8_heading_names_the_venue", () => {
    expect(flaggedBookingsHeading(2, "Harbour Room")).toBe(
      "2 bookings at Harbour Room flagged for review: Setup or turnaround time changed",
    );
    expect(flaggedBookingsHeading(1, "Harbour Room")).toBe(
      "1 booking at Harbour Room flagged for review: Setup or turnaround time changed",
    );
  });

  it("SCRUM484_AC8_heading_trims_the_venue_name", () => {
    expect(flaggedBookingsHeading(1, "  Harbour Room  ")).toBe(
      "1 booking at Harbour Room flagged for review: Setup or turnaround time changed",
    );
  });

  it.each([
    ["an empty name", ""],
    ["a blank name", "   "],
    ["a null name", null],
    ["a missing name", undefined],
    ["a non-string name", 42],
  ])("SCRUM484_AC8_heading_with_%s_leaves_the_venue_out", (_label, venueName) => {
    const heading = flaggedBookingsHeading(2, venueName);
    expect(heading).toBe("2 bookings flagged for review: Setup or turnaround time changed");
    expect(heading).not.toContain(" at ");
  });
});
