// venueSuitabilityDisplay.test.js
//
// codesText: a venue code list as labels, shared by the venue search results
// and the suitability result.

import { describe, it, expect } from "vitest";

import { codesText, criterionDetailText } from "../../src/services/venueSuitabilityDisplay.js";

const OPTIONS = [
  { code: "ramp", label: "Ramp access" },
  { code: "loop", label: "Hearing loop" },
];

describe("codesText", () => {
  it("joins the codes' labels in the order given", () => {
    expect(codesText(["loop", "ramp"], OPTIONS, "None listed")).toBe("Hearing loop, Ramp access");
  });

  it("shows a code the lookup does not know as itself", () => {
    expect(codesText(["ramp", "lift"], OPTIONS, "None listed")).toBe("Ramp access, lift");
  });

  it("uses the caller's empty text for an empty or missing list", () => {
    expect(codesText([], OPTIONS, "None requested")).toBe("None requested");
    expect(codesText(null, OPTIONS, "None listed")).toBe("None listed");
  });
});

// SCRUM-188 (AC2): each criterion is shown with the values compared.
describe("criterionDetailText", () => {
  it("SCRUM188_AC2_a_missing_or_non_object_criterion_reads_as_empty", () => {
    expect(criterionDetailText(null)).toBe("");
    expect(criterionDetailText(undefined)).toBe("");
    expect(criterionDetailText("Layout")).toBe("");
  });

  it("SCRUM188_AC2_an_unmet_layout_lists_what_the_venue_offers", () => {
    expect(criterionDetailText({ criterion: "Layout", met: false, layout: "banquet", offers: ["theatre", "classroom"] }))
      .toBe("Layout Banquet not offered (offers: Theatre, Classroom)");
  });

  it("SCRUM188_AC2_an_unmet_layout_without_an_offers_list_says_none", () => {
    expect(criterionDetailText({ criterion: "Layout", met: false, layout: "banquet", detail: "Layout banquet not offered" }))
      .toBe("Layout Banquet not offered (offers: none)");
  });
});
