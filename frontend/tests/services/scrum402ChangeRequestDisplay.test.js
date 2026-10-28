// scrum402ChangeRequestDisplay.test.js
//
// SCRUM-402: the words a change request reads as on every screen.

import { describe, it, expect } from "vitest";
import {
  CHANGE_FIELD_LABELS,
  changeClassLabel,
  changeFieldLabel,
  changeFieldList,
  formatChangeValue,
  groupChangeRequests,
  outcomeLabel,
} from "../../src/services/changeRequestDisplay.js";
import { formatTimestamp } from "../../src/services/displayFormat.js";

describe("SCRUM-402 change request display", () => {
  it("SCRUM402_AC1_labels_every_enum_member_and_reads_an_unknown_one", () => {
    expect(Object.keys(CHANGE_FIELD_LABELS)).toHaveLength(10);
    expect(changeFieldLabel("venue")).toBe("Venue requirements");
    expect(changeFieldLabel("cancellation")).toBe("Cancel the event");
    expect(changeFieldLabel("something_new")).toBe("A change");
    expect(changeFieldList([])).toBe("");
    expect(changeFieldList(["purpose"])).toBe("Purpose");
    expect(changeFieldList(["purpose", "venue", "other"])).toBe("Purpose, Venue requirements and Something else");
  });

  it.each([
    [null, null],
    ["approved", "Accepted"],
    ["rejected", "Declined"],
    ["event_cancelled", "Closed: the event was cancelled"],
    ["event_rejected", "Closed: the event was rejected"],
    ["something_another_story_adds", "Closed"],
  ])("SCRUM402_AC10_the_outcome_%s_reads_as_%s", (decision, label) => {
    expect(outcomeLabel(decision)).toBe(label);
  });

  it.each([
    ["ordinary", "Applied directly"],
    ["significant", "Re-checks bookings"],
    ["equipment", "Equipment change"],
    ["cancellation", "Cancels the event"],
    ["other", "Recorded only"],
    ["new_class", "Recorded only"],
  ])("SCRUM402_AC4_the_class_%s_reads_as_%s", (changeClass, label) => {
    expect(changeClassLabel(changeClass)).toBe(label);
  });

  it("SCRUM402_AC1_current_and_requested_go_through_one_formatter", () => {
    const iso = "2026-12-01T09:00:00Z";
    expect(formatChangeValue("proposed_start", iso)).toBe(formatTimestamp(iso, "Not set"));
    expect(formatChangeValue("proposed_start", "2026-12-01T17:00:00+08:00")).toBe(formatChangeValue("proposed_start", iso));
    expect(formatChangeValue("expected_attendance", 150)).toBe("150");
    expect(formatChangeValue("purpose", null)).toBe("Not set");
    expect(formatChangeValue("purpose", "")).toBe("Not set");
    expect(formatChangeValue("purpose", undefined)).toBe("Not set");
  });

  it("SCRUM402_AC1_rows_become_submissions_open_first_each_in_the_order_sent", () => {
    const groups = groupChangeRequests([
      { id: "a", requestGroupId: "g1", createdAt: "1", decision: "approved", decisionNotes: "Done", processedAt: "9" },
      { id: "b", requestGroupId: "g2", createdAt: "2", organiserNote: "Both please" },
      { id: "c", requestGroupId: "g2", createdAt: "2" },
      { id: "d", createdAt: "3" },
    ]);

    expect(groups.map((g) => [g.id, g.open, g.rows.map((r) => r.id)])).toEqual([
      ["g2", true, ["b", "c"]],
      ["d", true, ["d"]],
      ["g1", false, ["a"]],
    ]);
    expect(groups[0].organiserNote).toBe("Both please");
    expect(groups[2]).toMatchObject({ decision: "approved", decisionNotes: "Done", processedAt: "9" });
    expect(groupChangeRequests(undefined)).toEqual([]);
  });
});
