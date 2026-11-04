// equipmentRequestStatus.test.js
//
// The one place a status gets its badge tone, for the review screen and the queue.

import { describe, it, expect } from "vitest";
import { equipmentStatusTone } from "../../src/services/equipmentRequestStatus";

describe("equipmentStatusTone", () => {
  it.each([
    ["pending_review", "warning"],
    ["under_review", "info"],
    ["arranged", "success"],
    ["cannot_be_fully_arranged", "danger"],
    ["cancelled", "neutral"],
  ])("SCRUM588_AC6_%s_has_the_tone_%s", (status, expected) => {
    expect(equipmentStatusTone(status)).toBe(expected);
  });

  it("SCRUM284_a_status_it_does_not_know_reads_as_pending", () => {
    expect(equipmentStatusTone("something_new")).toBe("warning");
    expect(equipmentStatusTone(undefined)).toBe("warning");
  });
});
