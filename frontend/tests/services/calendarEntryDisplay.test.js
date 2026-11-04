// calendarEntryDisplay.test.js
//
// SCRUM-180 (part of SCRUM-178, AC2 and AC5). What one calendar entry says:
// "Booked" with the event name, "Booked – under review", or "Blocked" with
// the reason. Anything the module does not recognise maps to null so it is
// never shown, and above all never shown as "Booked".

import { describe, it, expect } from "vitest";

import { calendarEntryDisplay } from "../../src/services/calendarEntryDisplay.js";

const BOOKING = {
  kind: "booking",
  id: "b1",
  startsAt: "2026-10-06T09:00:00+08:00",
  endsAt: "2026-10-06T17:00:00+08:00",
  status: "approved",
  eventRequestId: "e1",
  eventName: "Gala Dinner",
};

const BLOCK = {
  kind: "block",
  id: "k1",
  startsAt: "2026-10-07T09:00:00+08:00",
  endsAt: "2026-10-07T17:00:00+08:00",
  reason: "maintenance",
  notes: "Replace the stage lights",
};

describe("SCRUM178_AC2 calendarEntryDisplay labels", () => {
  it("SCRUM178_AC2_an_approved_booking_reads_Booked_with_the_event_name", () => {
    expect(calendarEntryDisplay(BOOKING)).toEqual({
      label: "Booked",
      detail: "Gala Dinner",
      tone: "booked",
    });
  });

  it("SCRUM178_AC2_a_flagged_booking_reads_Booked_under_review_with_the_event_name", () => {
    expect(calendarEntryDisplay({ ...BOOKING, status: "flagged_for_review" })).toEqual({
      label: "Booked – under review",
      detail: "Gala Dinner",
      tone: "review",
    });
  });

  it("SCRUM178_AC2_a_block_reads_Blocked_with_its_reason_and_hides_its_notes", () => {
    const display = calendarEntryDisplay(BLOCK);
    expect(display).toEqual({ label: "Blocked — Maintenance", detail: null, tone: "blocked" });
    expect(JSON.stringify(display)).not.toContain("stage lights");
  });

  it("SCRUM178_AC2_a_block_without_a_reason_reads_plain_Blocked", () => {
    expect(calendarEntryDisplay({ ...BLOCK, reason: null })).toEqual({
      label: "Blocked",
      detail: null,
      tone: "blocked",
    });
  });

  it("SCRUM178_AC2_a_block_with_an_unknown_reason_shows_the_code", () => {
    expect(calendarEntryDisplay({ ...BLOCK, reason: "flood" }).label).toBe("Blocked — flood");
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
  ])("SCRUM178_AC2_a_booking_with_a_%s_eventName_has_a_null_detail", (_, eventName) => {
    expect(calendarEntryDisplay({ ...BOOKING, eventName })).toEqual({
      label: "Booked",
      detail: null,
      tone: "booked",
    });
  });
});

describe("SCRUM178_AC5 calendarEntryDisplay hidden entries", () => {
  it.each(["pending", "cancelled", "rejected", "APPROVED", "toString", "hasOwnProperty", undefined])(
    "SCRUM178_AC5_a_booking_with_status_%s_is_hidden",
    (status) => {
      expect(calendarEntryDisplay({ ...BOOKING, status })).toBeNull();
    },
  );

  // "hold" left this list with SCRUM-491, which made it a kind of its own.
  it.each(["reservation", "Hold", "Booking", undefined])("SCRUM178_AC5_an_entry_of_kind_%s_is_hidden", (kind) => {
    expect(calendarEntryDisplay({ ...BOOKING, kind })).toBeNull();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("SCRUM178_AC5_a_%s_entry_is_hidden_without_throwing", (_, value) => {
    expect(calendarEntryDisplay(value)).toBeNull();
  });
});

describe("SCRUM178_AC3 calendarEntryDisplay pending requests", () => {
  it.each(["pending", "rejected"])("SCRUM178_AC3_a_%s_booking_is_never_labelled_Booked", (status) => {
    // Kept alongside the AC5 table above: a request that is still pending (or
    // was turned down) has no approved booking, so it must not read "Booked".
    expect(calendarEntryDisplay({ ...BOOKING, status })).toBeNull();
    expect(calendarEntryDisplay({ ...BOOKING, status, eventName: "Pending Party" })).toBeNull();
  });
});

describe("SCRUM491_AC6 calendarEntryDisplay tentative holds", () => {
  const HOLD = {
    kind: "hold",
    id: "h1",
    startsAt: "2026-10-08T09:00:00+08:00",
    endsAt: "2026-10-08T17:00:00+08:00",
    eventRequestId: "e2",
    eventName: "Product Launch",
  };

  it("SCRUM491_AC6_an_active_hold_reads_Tentatively_held_naming_the_holding_event", () => {
    expect(calendarEntryDisplay(HOLD)).toEqual({
      label: "Tentatively held",
      detail: "Product Launch",
      tone: "held",
    });
  });

  it("SCRUM491_AC7_a_hold_is_never_labelled_Booked", () => {
    expect(calendarEntryDisplay(HOLD).label).not.toMatch(/Booked/);
    expect(calendarEntryDisplay({ ...HOLD, status: "approved" }).tone).toBe("held");
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
  ])("SCRUM491_AC6_a_hold_with_a_%s_eventName_has_a_null_detail", (_, eventName) => {
    expect(calendarEntryDisplay({ ...HOLD, eventName }).detail).toBeNull();
  });
});
