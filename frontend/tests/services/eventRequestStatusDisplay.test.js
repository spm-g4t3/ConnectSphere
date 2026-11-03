// eventRequestStatusDisplay.test.js
//
// SCRUM-14 (AC3), via SCRUM-42 and SCRUM-47. The Organiser tells statuses apart
// by their group's style, and a group this build does not know is styled as
// unknown rather than left unstyled.

import { describe, it, expect } from "vitest";

import { statusClassName } from "../../src/services/eventRequestStatusDisplay.js";

describe("statusClassName", () => {
  it.each([
    ["AWAITING_REVIEW", "status--awaiting-review"],
    ["UNDER_REVIEW", "status--under-review"],
    ["APPROVED", "status--approved"],
    ["REJECTED", "status--rejected"],
    ["CONFIRMED", "status--confirmed"],
    ["UNAVAILABLE", "status--unavailable"],
  ])("SCRUM14_AC3_the_%s_group_has_its_own_class", (group, className) => {
    expect(statusClassName(group)).toBe(className);
  });

  it.each([
    ["an unrecognised group", "ON_HOLD"],
    ["undefined", undefined],
    ["null", null],
  ])("SCRUM14_AC3_%s_is_styled_as_unknown", (_label, group) => {
    expect(statusClassName(group)).toBe("status--unknown");
  });
});
