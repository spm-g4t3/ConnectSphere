// SCRUM-310 (SCRUM-315): the wording for a line with flagged reservations and for
// the Needs attention reasons. Named SCRUM310_ACn_<what_it_checks>.
//
//   AC5  a line with a flagged reservation says what is flagged and why
//   AC6  the Needs attention reasons are shown as the server gave them

import { describe, it, expect } from "vitest";
import { describeFlaggedLine, attentionReasonsOf, FLAG_WITHOUT_REASON, LOST_HEADING, FLAGGED_HEADING } from "../../src/services/equipmentFlagDisplay";
import { formatEventPeriod } from "../../src/services/eventPeriodFormat";

const START = "2030-12-01T02:00:00Z";
const END = "2030-12-01T04:00:00Z";
const flag = (overrides = {}) => ({
  id: "f1",
  quantity: 2,
  startAt: START,
  endAt: END,
  reason: "Fewer units of this equipment are usable (Dropped)",
  code: "equipment_lost",
  flaggedAt: "2026-10-24T08:00:00Z",
  ...overrides,
});

describe("describeFlaggedLine", () => {
  it("SCRUM310_AC5_a_line_with_one_flag_gives_its_quantity_period_and_reason", () => {
    const result = describeFlaggedLine({ flaggedReservations: [flag()] });

    expect(result.flagged).toBe(true);
    expect(result.heading).toBe("Equipment unavailable");
    expect(result.summary).toBe("2 units across 1 reservation flagged for review");
    expect(result.items).toEqual([
      {
        id: "f1",
        quantity: "2 units",
        period: formatEventPeriod(START, END),
        reason: "Fewer units of this equipment are usable (Dropped)",
      },
    ]);
  });

  it("SCRUM310_AC5_the_two_headings_are_the_ones_the_screen_shows", () => {
    expect(LOST_HEADING).toBe("Equipment unavailable");
    expect(FLAGGED_HEADING).toBe("Flagged for review");
  });

  it("SCRUM310_AC5_several_lost_equipment_flags_are_all_called_equipment_lost", () => {
    const result = describeFlaggedLine({ flaggedReservations: [flag({ id: "a" }), flag({ id: "b" })] });

    expect(result.heading).toBe("Equipment unavailable");
  });

  it.each([
    ["null", null],
    ["missing", undefined],
    ["an unknown kind", "something_else"],
    ["empty", ""],
  ])("SCRUM310_AC5_a_flag_whose_code_is_%s_is_called_flagged_for_review_not_equipment_lost", (_label, code) => {
    const result = describeFlaggedLine({
      flaggedReservations: [flag({ code, reason: "The event date or time changed" })],
    });

    expect(result.heading).toBe("Flagged for review");
    expect(result.items[0].reason).toBe("The event date or time changed");
  });

  it("SCRUM310_AC5_one_flag_for_something_else_among_lost_ones_means_the_line_is_not_called_equipment_lost", () => {
    const result = describeFlaggedLine({
      flaggedReservations: [flag({ id: "a" }), flag({ id: "b", code: null }), flag({ id: "c" })],
    });

    expect(result.heading).toBe("Flagged for review");
    expect(result.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("SCRUM310_AC5_the_period_is_written_in_singapore_time", () => {
    const [item] = describeFlaggedLine({ flaggedReservations: [flag()] }).items;

    expect(item.period).toBe("Sun, 1 Dec 2030, 10:00 am to 12:00 pm");
  });

  it("SCRUM310_AC5_one_unit_is_singular", () => {
    const result = describeFlaggedLine({ flaggedReservations: [flag({ quantity: 1 })] });

    expect(result.items[0].quantity).toBe("1 unit");
    expect(result.summary).toBe("1 unit across 1 reservation flagged for review");
  });

  it("SCRUM310_AC5_several_flags_are_totalled_and_kept_in_order", () => {
    const result = describeFlaggedLine({
      flaggedReservations: [flag({ id: "a", quantity: 1 }), flag({ id: "b", quantity: 3 }), flag({ id: "c", quantity: 2 })],
    });

    expect(result.summary).toBe("6 units across 3 reservations flagged for review");
    expect(result.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it.each([
    ["null", null],
    ["missing", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["not text", 5],
  ])("SCRUM310_AC5_a_flag_with_a_%s_reason_gets_the_plain_wording", (_label, reason) => {
    const [item] = describeFlaggedLine({ flaggedReservations: [flag({ reason })] }).items;

    expect(item.reason).toBe(FLAG_WITHOUT_REASON);
  });

  it("SCRUM310_AC5_the_reason_is_trimmed", () => {
    const [item] = describeFlaggedLine({ flaggedReservations: [flag({ reason: "  Lost in transit  " })] }).items;

    expect(item.reason).toBe("Lost in transit");
  });

  it("SCRUM310_AC5_a_flag_with_no_dates_says_so_instead_of_throwing", () => {
    const [item] = describeFlaggedLine({ flaggedReservations: [flag({ startAt: null, endAt: undefined })] }).items;

    expect(item.period).toBe("Date not set");
  });

  it.each([
    ["a quantity that is missing", undefined],
    ["a quantity that is text", "2"],
    ["a quantity that is not finite", Number.NaN],
  ])("SCRUM310_AC5_%s_counts_as_zero_units", (_label, quantity) => {
    const result = describeFlaggedLine({ flaggedReservations: [flag({ quantity })] });

    expect(result.items[0].quantity).toBe("0 units");
    expect(result.summary).toBe("0 units across 1 reservation flagged for review");
  });

  it("SCRUM310_AC5_a_flag_without_an_id_gets_a_stable_key", () => {
    const result = describeFlaggedLine({ flaggedReservations: [flag({ id: undefined }), flag({ id: "" }), flag({ id: 7 })] });

    expect(result.items.map((i) => i.id)).toEqual(["flag-0", "flag-1", "flag-2"]);
  });

  it("SCRUM310_AC5_entries_that_are_not_objects_are_skipped", () => {
    const result = describeFlaggedLine({ flaggedReservations: [null, "x", 4, flag({ id: "keep" })] });

    expect(result.items.map((i) => i.id)).toEqual(["keep"]);
    expect(result.summary).toBe("2 units across 1 reservation flagged for review");
  });

  it.each([
    ["an empty list", { flaggedReservations: [] }],
    ["no key", {}],
    ["null", { flaggedReservations: null }],
    ["not a list", { flaggedReservations: "x" }],
    ["an object", { flaggedReservations: flag() }],
    ["no line", undefined],
    ["a null line", null],
  ])("SCRUM310_AC5_%s_means_nothing_flagged", (_label, line) => {
    expect(describeFlaggedLine(line)).toEqual({ flagged: false, heading: "", summary: "", items: [] });
  });

  it("SCRUM310_AC5_a_list_of_only_junk_means_nothing_flagged", () => {
    expect(describeFlaggedLine({ flaggedReservations: [null, 3] })).toEqual({ flagged: false, heading: "", summary: "", items: [] });
  });
});

describe("attentionReasonsOf", () => {
  it("SCRUM310_AC6_gives_the_reasons_of_an_event_that_needs_attention", () => {
    expect(
      attentionReasonsOf({ needsAttention: true, attentionReasons: ["Equipment: Lost in transit", "Venue: a booking is flagged for review"] }),
    ).toEqual(["Equipment: Lost in transit", "Venue: a booking is flagged for review"]);
  });

  it("SCRUM310_AC6_trims_each_reason", () => {
    expect(attentionReasonsOf({ needsAttention: true, attentionReasons: ["  Equipment: x  "] })).toEqual(["Equipment: x"]);
  });

  it("SCRUM310_AC6_drops_blank_and_non_text_reasons", () => {
    expect(attentionReasonsOf({ needsAttention: true, attentionReasons: ["", "   ", null, 4, "Equipment: x"] })).toEqual([
      "Equipment: x",
    ]);
  });

  it.each([
    ["needsAttention is false", { needsAttention: false, attentionReasons: ["Equipment: x"] }],
    ["needsAttention is missing", { attentionReasons: ["Equipment: x"] }],
    ["needsAttention is the text true", { needsAttention: "true", attentionReasons: ["Equipment: x"] }],
    ["the reasons are missing", { needsAttention: true }],
    ["the reasons are null", { needsAttention: true, attentionReasons: null }],
    ["the reasons are not a list", { needsAttention: true, attentionReasons: "Equipment: x" }],
    ["the reasons are empty", { needsAttention: true, attentionReasons: [] }],
    ["there is no event", undefined],
    ["the event is null", null],
  ])("SCRUM310_AC6_shows_nothing_when_%s", (_label, event) => {
    expect(attentionReasonsOf(event)).toEqual([]);
  });
});
