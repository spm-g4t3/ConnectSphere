// venueBlockReasons.test.js
//
// SCRUM-17 (AC1) / SCRUM-123. The frontend's list of venue block reasons.
// The codes are asserted against a literal list rather than by importing the
// backend, so this suite stands on its own; the literal is the same order as
// venue_block_reason in backend/db/baseline/01_foundation.sql.

import { describe, it, expect } from "vitest";

import { VENUE_BLOCK_REASONS, reasonLabel } from "../../src/services/venueBlockReasons.js";

describe("VENUE_BLOCK_REASONS", () => {
  it("SCRUM17_AC1_lists_the_five_codes_in_backend_enum_order", () => {
    expect(VENUE_BLOCK_REASONS.map((r) => r.code)).toEqual([
      "maintenance",
      "renovation",
      "safety",
      "internal_activity",
      "other",
    ]);
  });

  it("gives every reason a non-empty label", () => {
    for (const reason of VENUE_BLOCK_REASONS) {
      expect(typeof reason.label).toBe("string");
      expect(reason.label.length).toBeGreaterThan(0);
    }
  });

  it("is frozen, entries included", () => {
    expect(Object.isFrozen(VENUE_BLOCK_REASONS)).toBe(true);
    for (const reason of VENUE_BLOCK_REASONS) {
      expect(Object.isFrozen(reason)).toBe(true);
    }
  });
});

describe("reasonLabel", () => {
  it("SCRUM17_AC1_labels_internal_activity", () => {
    expect(reasonLabel("internal_activity")).toBe("Internal activity");
  });

  it("returns the label listed for each code", () => {
    for (const { code, label } of VENUE_BLOCK_REASONS) {
      expect(reasonLabel(code)).toBe(label);
    }
  });

  it("SCRUM17_AC1_falls_back_to_the_raw_code_for_an_unknown_reason", () => {
    expect(reasonLabel("holiday")).toBe("holiday");
  });
});
