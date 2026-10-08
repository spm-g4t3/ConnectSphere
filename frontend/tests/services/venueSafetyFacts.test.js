// venueSafetyFacts.test.js
//
// SCRUM-493. The shared safety-fact labels, the length limit, the code-point
// counter and the "Not recorded" fallback that VenueForm and VenueDetail use.

import { describe, it, expect } from "vitest";

import {
  NOT_RECORDED,
  SAFETY_FACTS,
  SAFETY_TEXT_MAX_LENGTH,
  codePointLength,
  safetyFactText,
} from "../../src/services/venueSafetyFacts";

describe("SCRUM493 safetyFactText", () => {
  it("SCRUM493_AC1_returns_recorded_text_unchanged", () => {
    expect(safetyFactText("Exit A via the east stairwell")).toBe("Exit A via the east stairwell");
    expect(safetyFactText("  Line one\nLine two  ")).toBe("  Line one\nLine two  ");
  });

  it("SCRUM493_AC2_null_and_undefined_read_as_not_recorded", () => {
    expect(safetyFactText(null)).toBe("Not recorded");
    expect(safetyFactText(undefined)).toBe("Not recorded");
    expect(NOT_RECORDED).toBe("Not recorded");
  });

  it("SCRUM493_AC2_empty_and_whitespace_read_as_not_recorded", () => {
    expect(safetyFactText("")).toBe("Not recorded");
    expect(safetyFactText("   ")).toBe("Not recorded");
    expect(safetyFactText(" \n\t ")).toBe("Not recorded");
  });

  it("SCRUM493_AC2_non_strings_read_as_not_recorded", () => {
    expect(safetyFactText(0)).toBe("Not recorded");
    expect(safetyFactText(42)).toBe("Not recorded");
    expect(safetyFactText(false)).toBe("Not recorded");
    expect(safetyFactText({})).toBe("Not recorded");
    expect(safetyFactText(["Exit A"])).toBe("Not recorded");
  });
});

describe("SCRUM493 codePointLength", () => {
  it("SCRUM493_AC1_counts_plain_text_by_characters", () => {
    expect(codePointLength("Exit A")).toBe(6);
    expect(codePointLength("")).toBe(0);
  });

  it("SCRUM493_AC1_counts_an_emoji_as_one", () => {
    expect("🚪".length).toBe(2);
    expect(codePointLength("🚪")).toBe(1);
    expect(codePointLength("Exit 🚪")).toBe(6);
  });

  it("SCRUM493_AC1_treats_null_and_undefined_as_zero", () => {
    expect(codePointLength(null)).toBe(0);
    expect(codePointLength(undefined)).toBe(0);
  });
});

describe("SCRUM493 shared constants", () => {
  it("SCRUM493_AC1_the_limit_is_2000", () => {
    expect(SAFETY_TEXT_MAX_LENGTH).toBe(2000);
  });

  it("SCRUM493_AC1_lists_the_two_facts_with_their_keys_and_labels_in_order", () => {
    expect(SAFETY_FACTS.map(({ key, label }) => ({ key, label }))).toEqual([
      { key: "emergencyAccess", label: "Emergency access" },
      { key: "knownRestrictions", label: "Known restrictions" },
    ]);
    for (const fact of SAFETY_FACTS) {
      expect(typeof fact.help).toBe("string");
      expect(fact.help.trim()).not.toBe("");
    }
  });
});
