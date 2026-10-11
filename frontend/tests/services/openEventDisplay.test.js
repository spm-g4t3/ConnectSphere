// openEventDisplay.test.js
//
// SCRUM-495 (AC3). How availability reads on the browse list. Date and time
// formatting is covered through the page's own tests, which read the same
// locale calls.

import { describe, it, expect } from "vitest";

import { availabilityLabel } from "../../src/services/openEventDisplay.js";

describe("availabilityLabel", () => {
  it.each([
    [{ isFull: false, placesLeft: 12 }, "12 places left"],
    [{ isFull: false, placesLeft: 2 }, "2 places left"],
    [{ isFull: false, placesLeft: 1 }, "1 place left"],
    [{ isFull: true, placesLeft: 0 }, "Full"],
    [{ isFull: false, placesLeft: null }, "No limit"],
    [{ isFull: false }, "No limit"],
  ])("SCRUM495_AC3_%j_reads_%s", (event, label) => {
    expect(availabilityLabel(event)).toBe(label);
  });

  it("SCRUM495_AC3_Full_wins_over_every_other_field", () => {
    expect(availabilityLabel({ isFull: true, placesLeft: null })).toBe("Full");
  });
});
