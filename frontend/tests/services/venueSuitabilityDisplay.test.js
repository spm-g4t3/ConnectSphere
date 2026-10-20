// venueSuitabilityDisplay.test.js
//
// codesText: a venue code list as labels, shared by the venue search results
// and the suitability result.

import { describe, it, expect } from "vitest";

import { codesText } from "../../src/services/venueSuitabilityDisplay.js";

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
