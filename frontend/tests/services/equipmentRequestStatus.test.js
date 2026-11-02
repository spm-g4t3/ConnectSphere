// equipmentRequestStatus.test.js
//
// The one place a status gets its badge class, for the review screen and the queue.

import { describe, it, expect } from "vitest";
import { equipmentStatusClass } from "../../src/services/equipmentRequestStatus";

describe("equipmentStatusClass", () => {
  it.each([
    ["pending_review", "pending"],
    ["under_review", "under"],
    ["arranged", "arranged"],
    ["cannot_be_fully_arranged", "cannot"],
    ["cancelled", "cancelled"],
  ])("SCRUM284_%s_has_the_class_%s", (status, expected) => {
    expect(equipmentStatusClass(status)).toBe(expected);
  });

  it("SCRUM284_a_status_it_does_not_know_reads_as_pending", () => {
    expect(equipmentStatusClass("something_new")).toBe("pending");
    expect(equipmentStatusClass(undefined)).toBe("pending");
  });
});
