// flaggedBookingDisplay.test.js
//
// SCRUM-484 (AC8). The wording shared by the venue catalogue's flagged-bookings
// notice and the coordinator's booking-request list: the label for a stored
// review_reason code, and the heading of the notice. SCRUM-266 adds
// flagReasons; its block periods go through formatVenuePeriod, which fixes
// Singapore time, so nothing here depends on the runner's timezone.

import { describe, it, expect } from "vitest";

import {
  REVIEW_REASON_LABELS,
  reviewReasonLabel,
  flaggedBookingsHeading,
  flagReasons,
} from "../../src/services/flaggedBookingDisplay.js";
import { formatVenuePeriod } from "../../src/services/datetimeFormat.js";

describe("reviewReasonLabel", () => {
  it("SCRUM484_AC8_labels_the_setup_or_turnaround_code", () => {
    expect(reviewReasonLabel("setup_or_turnaround_changed")).toBe("Setup or turnaround time changed");
  });

  it("SCRUM490_AC8_labels_a_safety_review_flag", () => {
    expect(reviewReasonLabel("safety_review")).toBe("Safety review");
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

// SCRUM-266 AC1: the two codes 078 allows before anything sets them, and every
// cause the flagged bookings list shows for one booking.
describe("SCRUM266 review reason labels", () => {
  it.each([
    ["event_changed", "Event details changed"],
    ["venue_details_changed", "Venue details changed"],
  ])("SCRUM266_AC1_labels_the_%s_code", (code, label) => {
    expect(reviewReasonLabel(code)).toBe(label);
    expect(REVIEW_REASON_LABELS[code]).toBe(label);
  });
});

describe("flagReasons", () => {
  const BLOCK_STARTS = "2026-12-01T08:00:00+08:00";
  const BLOCK_ENDS = "2026-12-01T18:00:00+08:00";
  const BLOCKED = `Blocked ${formatVenuePeriod(BLOCK_STARTS, BLOCK_ENDS)}`;

  function block(overrides = {}) {
    return { id: "k1", reason: "maintenance", notes: null, startsAt: BLOCK_STARTS, endsAt: BLOCK_ENDS, removedAt: null, ...overrides };
  }

  it("SCRUM266_AC1_a_block_flag_names_the_block_reason_and_period", () => {
    expect(flagReasons({ block: block(), reviewReason: null })).toEqual([
      { kind: "block", text: "Venue unavailable: Maintenance", details: [BLOCKED] },
    ]);
  });

  it("SCRUM266_AC1_a_block_flag_without_a_reason_still_says_the_venue_was_unavailable", () => {
    expect(flagReasons({ block: block({ reason: null }) })).toEqual([
      { kind: "block", text: "Venue unavailable", details: [BLOCKED] },
    ]);
  });

  it("SCRUM266_AC1_a_block_flag_shows_the_block_notes", () => {
    expect(flagReasons({ block: block({ reason: "safety", notes: "Fire alarm testing" }) })).toEqual([
      { kind: "block", text: "Venue unavailable: Safety", details: [BLOCKED, "Notes: Fire alarm testing"] },
    ]);
  });

  it("SCRUM266_AC1_a_removed_block_says_so", () => {
    expect(flagReasons({ block: block({ removedAt: "2026-11-01T10:00:00+08:00" }) })).toEqual([
      { kind: "block", text: "Venue unavailable: Maintenance (block since removed)", details: [BLOCKED] },
    ]);
    expect(flagReasons({ block: block({ reason: null, removedAt: "2026-11-01T10:00:00+08:00" }) })[0].text).toBe(
      "Venue unavailable (block since removed)",
    );
  });

  it("SCRUM266_AC1_a_block_period_that_cannot_be_read_falls_back", () => {
    expect(flagReasons({ block: block({ startsAt: null }) })[0].details).toEqual(["Blocked Not set"]);
  });

  it.each([
    ["setup_or_turnaround_changed", "Setup or turnaround time changed"],
    ["safety_review", "Safety review"],
    ["event_changed", "Event details changed"],
    ["venue_details_changed", "Venue details changed"],
  ])("SCRUM266_AC1_a_review_only_flag_%s_uses_its_label", (code, label) => {
    expect(flagReasons({ block: null, reviewReason: code })).toEqual([{ kind: "review", text: label, details: [] }]);
  });

  it("SCRUM266_AC1_a_safety_flag_on_top_of_a_block_lists_both_block_first", () => {
    expect(flagReasons({ block: block(), reviewReason: "safety_review" })).toEqual([
      { kind: "block", text: "Venue unavailable: Maintenance", details: [BLOCKED] },
      { kind: "review", text: "Safety review", details: [] },
    ]);
  });

  it.each([
    ["an unknown code and no block", { block: null, reviewReason: "flood" }],
    ["no code and no block", { block: null, reviewReason: null }],
    ["an item with neither field", {}],
    ["no item at all", undefined],
  ])("SCRUM266_AC1_%s_reads_as_reason_not_recorded", (_label, item) => {
    expect(flagReasons(item)).toEqual([{ kind: "unknown", text: "Reason not recorded", details: [] }]);
  });
});
