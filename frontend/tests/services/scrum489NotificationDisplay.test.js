// scrum489NotificationDisplay.test.js
//
// SCRUM-489 (AC8): what a Safety Officer reads when an event is submitted for
// the safety check. The payload is 064's. Times are built with the module's
// own formatTimestamp, so the suite passes in any zone and locale.

import { describe, it, expect } from "vitest";

import { describeNotification } from "../../src/services/notificationDisplay.js";
import { formatTimestamp } from "../../src/services/displayFormat.js";

const PAYLOAD = Object.freeze({
  eventRequestId: "22222222-2222-4222-8222-222222222222",
  eventName: "IS212 Industry Night",
  coordinatorId: "44444444-4444-4444-8444-444444444444",
  coordinatorName: "Priya Nair",
  startsAt: "2026-11-11T10:00:00+08:00",
  submittedAt: "2026-10-14T09:00:00+08:00",
});

const submitted = (payload) => ({ id: "n1", type: "event_submitted_for_safety_review", payload });

describe("SCRUM489_AC8 describeNotification: event_submitted_for_safety_review", () => {
  it("SCRUM489_AC8_names_the_event_the_coordinator_and_the_start", () => {
    expect(describeNotification(submitted(PAYLOAD))).toEqual({
      headline: "Event submitted for safety check",
      detail: `IS212 Industry Night was submitted by Priya Nair. It starts ${formatTimestamp(PAYLOAD.startsAt)}.`,
    });
  });

  it.each([
    ["no_event_name", { eventName: null }, "Unnamed event was submitted by Priya Nair. It starts"],
    ["no_coordinator_name", { coordinatorName: "" }, "IS212 Industry Night was submitted by its coordinator. It starts"],
  ])("SCRUM489_AC8_with_%s_it_falls_back_in_words", (_label, change, start) => {
    const { detail } = describeNotification(submitted({ ...PAYLOAD, ...change }));

    expect(detail.startsWith(start)).toBe(true);
    expect(detail).not.toMatch(/undefined|null/);
  });

  it.each([
    ["missing", undefined],
    ["unreadable", "not a date"],
  ])("SCRUM489_AC8_a_start_that_is_%s_is_left_out", (_label, startsAt) => {
    expect(describeNotification(submitted({ ...PAYLOAD, startsAt })).detail)
      .toBe("IS212 Industry Night was submitted by Priya Nair.");
  });

  it("SCRUM489_AC8_with_no_payload_it_still_reads_as_a_submission", () => {
    expect(describeNotification({ id: "n1", type: "event_submitted_for_safety_review" })).toEqual({
      headline: "Event submitted for safety check",
      detail: "Unnamed event was submitted by its coordinator.",
    });
  });
});
