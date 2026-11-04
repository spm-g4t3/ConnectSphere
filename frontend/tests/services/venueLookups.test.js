// venueLookups.test.js
//
// SCRUM-15 (AC2). optionsWithUnknownCodes keeps a code the venue already holds
// in the edit form even when the form's catalogue copy does not know it, so
// saving the form does not silently drop it.

import { describe, it, expect } from "vitest";

import { FACILITIES, optionsWithUnknownCodes } from "../../src/services/venueLookups.js";

const KNOWN = [
  { code: "wifi", label: "Wi-Fi" },
  { code: "screen", label: "Screen" },
];

describe("optionsWithUnknownCodes", () => {
  it("SCRUM15_AC2_known_codes_come_first_in_catalogue_order_marked_known", () => {
    expect(optionsWithUnknownCodes(KNOWN)).toEqual([
      { code: "wifi", label: "Wi-Fi", unknown: false },
      { code: "screen", label: "Screen", unknown: false },
    ]);
  });

  it("SCRUM15_AC2_an_unknown_code_on_the_venue_is_added_after_them_labelled_as_itself", () => {
    expect(optionsWithUnknownCodes(KNOWN, ["screen", "stage_lighting", "wifi"])).toEqual([
      { code: "wifi", label: "Wi-Fi", unknown: false },
      { code: "screen", label: "Screen", unknown: false },
      { code: "stage_lighting", label: "stage_lighting", unknown: true },
    ]);
  });

  it("SCRUM15_AC2_extras_keep_the_venues_order_and_a_repeated_code_is_added_once", () => {
    const extras = optionsWithUnknownCodes(KNOWN, ["b_code", "a_code", "b_code"]).filter((o) => o.unknown);
    expect(extras.map((o) => o.code)).toEqual(["b_code", "a_code"]);
  });

  it("SCRUM15_AC2_empty_and_non_text_entries_are_not_options", () => {
    expect(optionsWithUnknownCodes(KNOWN, ["", null, 7, { code: "x" }])).toHaveLength(KNOWN.length);
  });

  it("SCRUM15_AC2_works_on_the_real_catalogue_without_changing_it", () => {
    const options = optionsWithUnknownCodes(FACILITIES, ["projector", "smoke_machine"]);
    expect(options).toHaveLength(FACILITIES.length + 1);
    expect(options.at(-1)).toEqual({ code: "smoke_machine", label: "smoke_machine", unknown: true });
    expect(FACILITIES[0]).not.toHaveProperty("unknown");
  });
});
