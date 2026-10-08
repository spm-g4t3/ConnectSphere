// occupiedPeriodDisplay.test.js
//
// SCRUM-484 (AC7). The helper that splits a booking's occupied period into
// its Setup, Event and Turnaround parts, writes them as one line, and words
// the note under a block a booking request ran into.
//
// Timezone-safe: every fixture carries an offset and every expected range is
// built with formatRange from the same instants, so the suite reads the same
// in any zone and locale.

import { describe, it, expect } from "vitest";

import {
  bookingPaddingNote,
  formatOccupiedPeriod,
  occupiedPeriodParts,
  requestPaddingNote,
} from "../../src/services/occupiedPeriodDisplay.js";
import { formatRange } from "../../src/services/displayFormat.js";

// The doc's fixture: a venue with 30 minutes of setup and 45 of turnaround,
// and an approved booking 10:00-12:00 Singapore time.
const START = "2026-11-10T10:00:00+08:00";
const END = "2026-11-10T12:00:00+08:00";
const OCC_START = "2026-11-10T09:30:00+08:00";
const OCC_END = "2026-11-10T12:45:00+08:00";

const BOOKING = {
  kind: "booking",
  bookingId: "8d1f7a52-3b2e-4c11-9f0a-2a6b9c3d4e01",
  eventName: "Orientation",
  startsAt: START,
  endsAt: END,
  occupiedStartsAt: OCC_START,
  occupiedEndsAt: OCC_END,
  setupMinutes: 30,
  turnaroundMinutes: 45,
};

const ZERO = {
  ...BOOKING,
  occupiedStartsAt: START,
  occupiedEndsAt: END,
  setupMinutes: 0,
  turnaroundMinutes: 0,
};

const labels = (parts) => parts.map((part) => part.label);

describe("SCRUM484_AC7 occupiedPeriodParts", () => {
  it("SCRUM484_AC7_parts_are_setup_event_turnaround", () => {
    const parts = occupiedPeriodParts(BOOKING);

    expect(parts).toEqual([
      { label: "Setup", startsAt: OCC_START, endsAt: START },
      { label: "Event", startsAt: START, endsAt: END },
      { label: "Turnaround", startsAt: END, endsAt: OCC_END },
    ]);
    expect(parts.map((p) => formatRange(p.startsAt, p.endsAt))).toEqual([
      formatRange(OCC_START, START),
      formatRange(START, END),
      formatRange(END, OCC_END),
    ]);
  });

  it("SCRUM484_AC7_zero_minutes_show_only_the_event", () => {
    expect(occupiedPeriodParts(ZERO)).toEqual([{ label: "Event", startsAt: START, endsAt: END }]);
  });

  it("SCRUM484_AC7_setup_only_has_no_turnaround_part", () => {
    const entry = { ...BOOKING, occupiedEndsAt: END, turnaroundMinutes: 0 };
    expect(labels(occupiedPeriodParts(entry))).toEqual(["Setup", "Event"]);
  });

  it("SCRUM484_AC7_turnaround_only_has_no_setup_part", () => {
    const entry = { ...BOOKING, occupiedStartsAt: START, setupMinutes: 0 };
    expect(labels(occupiedPeriodParts(entry))).toEqual(["Event", "Turnaround"]);
  });

  it("SCRUM484_AC7_missing_occupied_fields_fall_back_to_the_event", () => {
    const legacy = { kind: "booking", eventName: "Orientation", startsAt: START, endsAt: END };

    expect(() => occupiedPeriodParts(legacy)).not.toThrow();
    expect(occupiedPeriodParts(legacy)).toEqual([{ label: "Event", startsAt: START, endsAt: END }]);
    expect(formatOccupiedPeriod(legacy)).toBe(formatRange(START, END));
    expect(formatOccupiedPeriod(legacy)).not.toMatch(/Invalid Date/);
  });

  it.each([
    ["null occupied fields", { occupiedStartsAt: null, occupiedEndsAt: null }],
    ["empty strings", { occupiedStartsAt: "", occupiedEndsAt: "" }],
    ["an unparseable start", { occupiedStartsAt: "not a date" }],
    ["an unparseable end", { occupiedEndsAt: "not a date" }],
  ])("SCRUM484_AC7_%s_fall_back_to_the_event", (_label, override) => {
    const entry = { ...BOOKING, ...override };
    expect(labels(occupiedPeriodParts(entry))).toEqual(["Event"]);
    expect(formatOccupiedPeriod(entry)).toBe(formatRange(START, END));
    expect(formatOccupiedPeriod(entry)).not.toMatch(/Invalid Date/);
  });

  it("SCRUM484_AC7_occupied_fields_that_do_not_contain_the_event_fall_back_to_the_event", () => {
    // Occupied start after the event start, and occupied end before its end.
    const lateStart = { ...BOOKING, occupiedStartsAt: "2026-11-10T10:15:00+08:00" };
    const earlyEnd = { ...BOOKING, occupiedEndsAt: "2026-11-10T11:30:00+08:00" };

    for (const entry of [lateStart, earlyEnd]) {
      expect(occupiedPeriodParts(entry)).toEqual([{ label: "Event", startsAt: START, endsAt: END }]);
      expect(formatOccupiedPeriod(entry)).toBe(formatRange(START, END));
    }
  });

  it("SCRUM484_AC7_compares_instants_not_strings", () => {
    // The same occupied moments written in UTC: still a 30/45 split.
    const utc = {
      ...BOOKING,
      occupiedStartsAt: "2026-11-10T01:30:00Z",
      occupiedEndsAt: "2026-11-10T04:45:00Z",
    };
    expect(labels(occupiedPeriodParts(utc))).toEqual(["Setup", "Event", "Turnaround"]);

    // An occupied period equal to the event, in another notation, is 0/0.
    const sameInUtc = {
      ...BOOKING,
      occupiedStartsAt: "2026-11-10T02:00:00Z",
      occupiedEndsAt: "2026-11-10T04:00:00Z",
    };
    expect(labels(occupiedPeriodParts(sameInUtc))).toEqual(["Event"]);
  });
});

describe("SCRUM484_AC7 formatOccupiedPeriod", () => {
  it("SCRUM484_AC7_labels_each_part_and_joins_them_with_a_dot", () => {
    expect(formatOccupiedPeriod(BOOKING)).toBe(
      `Setup ${formatRange(OCC_START, START)} · ` +
        `Event ${formatRange(START, END)} · ` +
        `Turnaround ${formatRange(END, OCC_END)}`,
    );
  });

  it("SCRUM484_AC7_setup_only_and_turnaround_only_join_two_parts", () => {
    expect(formatOccupiedPeriod({ ...BOOKING, occupiedEndsAt: END })).toBe(
      `Setup ${formatRange(OCC_START, START)} · Event ${formatRange(START, END)}`,
    );
    expect(formatOccupiedPeriod({ ...BOOKING, occupiedStartsAt: START })).toBe(
      `Event ${formatRange(START, END)} · Turnaround ${formatRange(END, OCC_END)}`,
    );
  });

  it("SCRUM484_AC7_event_only_is_the_bare_range_without_labels", () => {
    const text = formatOccupiedPeriod(ZERO);
    expect(text).toBe(formatRange(START, END));
    expect(text).not.toMatch(/Setup|Event |Turnaround/);
  });
});

describe("SCRUM484_AC7 requestPaddingNote", () => {
  it("SCRUM484_AC7_names_both_setup_and_turnaround", () => {
    expect(requestPaddingNote({ kind: "block", setupMinutes: 30, turnaroundMinutes: 45 })).toBe(
      "Includes the 30 minutes of setup and 45 minutes of turnaround this venue needs around your event.",
    );
  });

  it("SCRUM484_AC7_names_setup_only", () => {
    expect(requestPaddingNote({ kind: "block", setupMinutes: 30, turnaroundMinutes: 0 })).toBe(
      "Includes the 30 minutes of setup this venue needs before your event.",
    );
  });

  it("SCRUM484_AC7_names_turnaround_only", () => {
    expect(requestPaddingNote({ kind: "block", setupMinutes: 0, turnaroundMinutes: 90 })).toBe(
      "Includes the 1 hour 30 minutes of turnaround this venue needs after your event.",
    );
  });

  it("SCRUM484_AC7_zero_minutes_give_no_note", () => {
    expect(requestPaddingNote({ kind: "block", setupMinutes: 0, turnaroundMinutes: 0 })).toBeNull();
  });

  it.each([
    ["missing minutes", {}],
    ["null minutes", { setupMinutes: null, turnaroundMinutes: null }],
    ["string minutes", { setupMinutes: "30", turnaroundMinutes: "45" }],
    ["fractional minutes", { setupMinutes: 7.5, turnaroundMinutes: 2.5 }],
    ["negative minutes", { setupMinutes: -15, turnaroundMinutes: -30 }],
    ["NaN minutes", { setupMinutes: Number.NaN, turnaroundMinutes: Number.NaN }],
  ])("SCRUM484_AC7_%s_give_no_note", (_label, minutes) => {
    expect(requestPaddingNote({ kind: "block", ...minutes })).toBeNull();
  });

  it("SCRUM484_AC7_a_missing_conflict_gives_no_note", () => {
    expect(requestPaddingNote(undefined)).toBeNull();
    expect(requestPaddingNote(null)).toBeNull();
  });
});

describe("SCRUM484_AC7 bookingPaddingNote", () => {
  // The note under a booking a request ran into names the requester's own
  // minutes, because the row above it already shows the booking's parts.
  it("SCRUM484_AC7_booking_note_names_both_setup_and_turnaround", () => {
    expect(bookingPaddingNote({ kind: "booking", setupMinutes: 30, turnaroundMinutes: 45 })).toBe(
      "Your event's own 30 minutes of setup and 45 minutes of turnaround count as well.",
    );
  });

  it("SCRUM484_AC7_booking_note_names_setup_only", () => {
    expect(bookingPaddingNote({ kind: "booking", setupMinutes: 30, turnaroundMinutes: 0 })).toBe(
      "Your event's own 30 minutes of setup counts as well.",
    );
  });

  it("SCRUM484_AC7_booking_note_names_turnaround_only", () => {
    expect(bookingPaddingNote({ kind: "booking", setupMinutes: 0, turnaroundMinutes: 90 })).toBe(
      "Your event's own 1 hour 30 minutes of turnaround counts as well.",
    );
  });

  it("SCRUM484_AC7_booking_note_zero_minutes_give_no_note", () => {
    expect(bookingPaddingNote({ kind: "booking", setupMinutes: 0, turnaroundMinutes: 0 })).toBeNull();
  });

  it.each([
    ["missing minutes", {}],
    ["null minutes", { setupMinutes: null, turnaroundMinutes: null }],
    ["string minutes", { setupMinutes: "30", turnaroundMinutes: "45" }],
    ["fractional minutes", { setupMinutes: 7.5, turnaroundMinutes: 2.5 }],
    ["negative minutes", { setupMinutes: -15, turnaroundMinutes: -30 }],
    ["NaN minutes", { setupMinutes: Number.NaN, turnaroundMinutes: Number.NaN }],
  ])("SCRUM484_AC7_booking_note_%s_give_no_note", (_label, minutes) => {
    expect(bookingPaddingNote({ kind: "booking", ...minutes })).toBeNull();
  });

  it("SCRUM484_AC7_booking_note_a_missing_conflict_gives_no_note", () => {
    expect(bookingPaddingNote(undefined)).toBeNull();
    expect(bookingPaddingNote(null)).toBeNull();
  });

  it("SCRUM484_AC7_booking_note_and_request_note_word_the_same_minutes_differently", () => {
    const conflict = { setupMinutes: 30, turnaroundMinutes: 45 };
    // requestPaddingNote's output is unchanged by the shared phrase helper.
    expect(requestPaddingNote({ kind: "block", ...conflict })).toBe(
      "Includes the 30 minutes of setup and 45 minutes of turnaround this venue needs around your event.",
    );
    expect(bookingPaddingNote({ kind: "booking", ...conflict })).not.toBe(
      requestPaddingNote({ kind: "block", ...conflict }),
    );
    expect(bookingPaddingNote(conflict)).not.toContain("Includes");
  });
});
