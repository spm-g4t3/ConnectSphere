// venueBlockDisplay.test.js
//
// SCRUM-127 (part of SCRUM-17, AC4). Where a block sits in time. The rule is
// the backend's half-open [start, end). `now` is injected, so no fake timers
// and no dependence on the device's zone: every instant is compared as one.

import { describe, it, expect } from "vitest";

import {
  BLOCK_PHASE_LABELS,
  blockCalendarLabel,
  blockPhase,
} from "../../src/services/venueBlockDisplay.js";
import { VENUE_BLOCK_REASONS } from "../../src/services/venueBlockReasons.js";

const NOW = new Date("2026-10-02T04:00:00Z");
const HOUR = 60 * 60 * 1000;

function at(offsetMs) {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

describe("blockPhase", () => {
  it("SCRUM17_AC4_upcoming_when_the_start_is_ahead", () => {
    expect(blockPhase({ startsAt: at(HOUR), endsAt: at(2 * HOUR) }, NOW)).toBe("upcoming");
  });

  it("SCRUM17_AC4_in_effect_between_start_and_end", () => {
    expect(blockPhase({ startsAt: at(-HOUR), endsAt: at(HOUR) }, NOW)).toBe("in_effect");
  });

  it("SCRUM17_AC4_ended_when_the_end_has_passed", () => {
    expect(blockPhase({ startsAt: at(-2 * HOUR), endsAt: at(-HOUR) }, NOW)).toBe("ended");
  });

  it("SCRUM17_AC4_endsAt_equal_to_now_is_ended_half_open", () => {
    expect(blockPhase({ startsAt: at(-HOUR), endsAt: at(0) }, NOW)).toBe("ended");
  });

  it("SCRUM17_AC4_startsAt_equal_to_now_is_in_effect", () => {
    expect(blockPhase({ startsAt: at(0), endsAt: at(HOUR) }, NOW)).toBe("in_effect");
  });

  it("compares instants regardless of the offset they are written in", () => {
    // NOW is 04:00Z, i.e. 12:00 at +08:00. An end at 12:00+08:00 is exactly now.
    expect(
      blockPhase({ startsAt: "2026-10-02T09:00:00+08:00", endsAt: "2026-10-02T12:00:00+08:00" }, NOW),
    ).toBe("ended");
    expect(
      blockPhase({ startsAt: "2026-10-02T09:00:00+08:00", endsAt: "2026-10-02T12:01:00+08:00" }, NOW),
    ).toBe("in_effect");
  });

  it("an unparseable end reads as upcoming, so the server stays the authority", () => {
    expect(blockPhase({ startsAt: at(-2 * HOUR), endsAt: "not a date" }, NOW)).toBe("upcoming");
    expect(blockPhase({ startsAt: at(-2 * HOUR) }, NOW)).toBe("upcoming");
    expect(blockPhase(null, NOW)).toBe("upcoming");
  });

  it("an unparseable start with a future end reads as upcoming", () => {
    expect(blockPhase({ startsAt: "garbage", endsAt: at(HOUR) }, NOW)).toBe("upcoming");
  });

  it("defaults now to the real clock", () => {
    const DAY = 24 * HOUR;
    const past = new Date(Date.now() - 2 * DAY).toISOString();
    const pastEnd = new Date(Date.now() - DAY).toISOString();
    const future = new Date(Date.now() + DAY).toISOString();
    expect(blockPhase({ startsAt: past, endsAt: pastEnd })).toBe("ended");
    expect(blockPhase({ startsAt: past, endsAt: future })).toBe("in_effect");
  });
});

describe("BLOCK_PHASE_LABELS", () => {
  it("SCRUM17_AC4_labels_every_phase", () => {
    expect(BLOCK_PHASE_LABELS).toEqual({
      upcoming: "Upcoming",
      in_effect: "In effect",
      ended: "Ended",
    });
    expect(Object.isFrozen(BLOCK_PHASE_LABELS)).toBe(true);
  });
});

describe("blockCalendarLabel (SCRUM-130)", () => {
  it.each(VENUE_BLOCK_REASONS.map((r) => [r.code, r.label]))(
    "SCRUM17_AC2_labels_%s_as_Blocked_with_its_reason_label",
    (code, label) => {
      expect(blockCalendarLabel({ reason: code })).toBe(`Blocked \u2014 ${label}`);
    },
  );

  it("SCRUM17_AC2_covers_every_reason_the_form_offers", () => {
    expect(VENUE_BLOCK_REASONS.length).toBeGreaterThan(0);
    for (const { code, label } of VENUE_BLOCK_REASONS) {
      expect(blockCalendarLabel({ reason: code })).toBe(`Blocked \u2014 ${label}`);
    }
  });

  it("SCRUM17_AC2_separates_with_an_em_dash", () => {
    const label = blockCalendarLabel({ reason: "maintenance" });
    expect(label).toBe("Blocked \u2014 Maintenance");
    expect(label.charCodeAt("Blocked ".length)).toBe(0x2014);
  });

  it("SCRUM17_AC2_an_unknown_reason_code_shows_raw", () => {
    expect(blockCalendarLabel({ reason: "flood" })).toBe("Blocked \u2014 flood");
  });

  it.each([
    ["a null reason", { reason: null }],
    ["an empty reason", { reason: "" }],
    ["no reason key", {}],
    ["a null block", null],
    ["an undefined block", undefined],
  ])("SCRUM17_AC2_%s_is_plain_Blocked", (_label, block) => {
    expect(blockCalendarLabel(block)).toBe("Blocked");
  });
});
