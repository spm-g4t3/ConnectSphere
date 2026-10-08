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
  isRecordedText,
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

// Review fix: text made only of invisible characters is "not recorded", the
// same test as the backend's venueValidation.
const INVISIBLES = [
  ["U+200B zero-width space", "​"],
  ["U+2060 word joiner", "⁠"],
  ["U+FEFF byte-order mark", "﻿"],
  ["U+00AD soft hyphen", "­"],
  ["U+180E Mongolian vowel separator", "᠎"],
  ["U+2800 Braille blank", "⠀"],
  ["U+3164 Hangul filler", "ㅤ"],
  ["U+115F Hangul choseong filler", "ᅟ"],
  ["U+1160 Hangul jungseong filler", "ᅠ"],
  ["U+FFA0 halfwidth Hangul filler", "ﾠ"],
];

describe("SCRUM493 isRecordedText", () => {
  it("SCRUM493_AC2_null_and_undefined_are_not_recorded", () => {
    expect(isRecordedText(null)).toBe(false);
    expect(isRecordedText(undefined)).toBe(false);
  });

  it("SCRUM493_AC2_non_strings_are_not_recorded", () => {
    for (const value of [0, 42, true, false, {}, ["Exit A"], new String("Exit A")]) {
      expect(isRecordedText(value)).toBe(false);
    }
  });

  it("SCRUM493_AC2_empty_and_whitespace_are_not_recorded", () => {
    expect(isRecordedText("")).toBe(false);
    expect(isRecordedText("   ")).toBe(false);
    expect(isRecordedText(" \n\t\r\n ")).toBe(false);
    expect(isRecordedText(" 　")).toBe(false);
  });

  it.each(INVISIBLES)("SCRUM493_AC2_%s_alone_is_not_recorded", (_name, ch) => {
    expect(isRecordedText(ch)).toBe(false);
    expect(isRecordedText(ch.repeat(3))).toBe(false);
  });

  it.each(INVISIBLES)("SCRUM493_AC2_%s_mixed_with_spaces_is_not_recorded", (_name, ch) => {
    expect(isRecordedText(` ${ch} `)).toBe(false);
    expect(isRecordedText(`\n${ch}\t${ch} `)).toBe(false);
  });

  it("SCRUM493_AC2_all_invisibles_together_are_not_recorded", () => {
    expect(isRecordedText(INVISIBLES.map(([, ch]) => ch).join(" "))).toBe(false);
  });

  it.each(INVISIBLES)("SCRUM493_AC1_visible_text_containing_%s_is_recorded", (_name, ch) => {
    expect(isRecordedText(`Exit${ch} A`)).toBe(true);
    expect(isRecordedText(`${ch}Exit A${ch}`)).toBe(true);
  });

  it("SCRUM493_AC1_plain_and_crlf_text_is_recorded", () => {
    expect(isRecordedText("Exit A")).toBe(true);
    expect(isRecordedText("  Exit A  ")).toBe(true);
    expect(isRecordedText("Exit A\r\nExit B")).toBe(true);
    expect(isRecordedText("\r\nExit A\r\n")).toBe(true);
    expect(isRecordedText("🚪")).toBe(true);
  });
});

describe("SCRUM493 safetyFactText invisible-only", () => {
  it.each(INVISIBLES)("SCRUM493_AC2_%s_only_reads_as_not_recorded", (_name, ch) => {
    expect(safetyFactText(ch)).toBe("Not recorded");
    expect(safetyFactText(` ${ch}\n${ch} `)).toBe("Not recorded");
  });

  it("SCRUM493_AC1_visible_text_with_invisibles_is_returned_unchanged", () => {
    expect(safetyFactText("Exit​ A")).toBe("Exit​ A");
    expect(safetyFactText("Exit A\r\nExit B")).toBe("Exit A\r\nExit B");
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
