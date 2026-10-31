// scrum379ChangeRequestOutcome.test.js
//
// SCRUM-379 AC4: a change request still open when its event is completed is closed with the
// outcome "event_completed". This is the wording for it, shared by the Organiser's list and the
// coordinator's panel. It must never read as a rejection.

import { describe, it, expect } from "vitest";
import { changeRequestOutcomeLabel } from "../../src/services/changeRequestOutcome";

describe("SCRUM379 changeRequestOutcomeLabel", () => {
  it.each([
    ["approved", "Approved"],
    ["rejected", "Rejected"],
    ["event_rejected", "Closed, event rejected"],
    ["event_cancelled", "Closed, event cancelled"],
    ["event_completed", "Closed, event completed"],
  ])("SCRUM379_AC4_%s_reads_%s", (decision, label) => {
    expect(changeRequestOutcomeLabel(decision)).toBe(label);
  });

  it.each([null, undefined, ""])("SCRUM379_AC4_no_decision_%j_has_no_label", (decision) => {
    expect(changeRequestOutcomeLabel(decision)).toBeNull();
  });

  it("SCRUM379_AC4_an_outcome_the_screen_does_not_know_is_closed_not_rejected", () => {
    expect(changeRequestOutcomeLabel("something_new")).toBe("Closed");
  });

  it("SCRUM379_AC4_only_a_real_rejection_is_called_rejected", () => {
    for (const decision of ["event_rejected", "event_cancelled", "event_completed", "something_new"]) {
      expect(changeRequestOutcomeLabel(decision)).not.toMatch(/^Rejected$/);
    }
  });
});
