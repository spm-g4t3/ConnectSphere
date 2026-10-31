// scrum402NotificationDisplay.test.js
//
// SCRUM-402 AC11 and AC12: the two notices 036 adds, their wording, where each
// opens, and that the frontend's list of known types finds them.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describeNotification } from "../../src/services/notificationDisplay.js";
import { notificationLink } from "../../src/services/notificationLink.js";

const ID = "22222222-2222-4222-8222-222222222222";
const d = (type, payload) => describeNotification({ id: "n402", type, payload });

describe("SCRUM-402 change_request_decided", () => {
  it.each([
    ["accepted", { decision: "approved", notes: "Done as asked" }, "Your change request for Tech Talk was accepted", "Requested: Purpose and Proposed start date/time. Coordinator's note: Done as asked."],
    ["declined", { decision: "rejected", notes: "Not this term" }, "Your change request for Tech Talk was declined", "Requested: Purpose and Proposed start date/time. Reason: Not this term."],
    ["closed_another_way", { decision: "event_rejected" }, "Your change request for Tech Talk was closed", "Requested: Purpose and Proposed start date/time. No note was left."],
  ])("SCRUM402_AC11_a_request_%s_names_the_event_the_fields_and_the_note", (_label, extra, headline, detail) => {
    expect(d("change_request_decided", {
      eventRequestId: ID, eventName: "Tech Talk", changeFields: ["purpose", "proposed_start"], ...extra,
    })).toEqual({ headline, detail });
  });

  it("SCRUM402_AC11_a_cancellation_request_is_named_as_one", () => {
    expect(d("change_request_decided", {
      eventName: "Tech Talk", decision: "approved", notes: "Speaker withdrew", changeFields: ["cancellation"],
    })).toEqual({
      headline: "Your request to cancel Tech Talk was accepted",
      detail: "Coordinator's note: Speaker withdrew.",
    });
  });

  it("SCRUM402_AC11_a_sparse_payload_still_reads", () => {
    expect(d("change_request_decided", { decision: "approved" })).toEqual({
      headline: "Your change request for Unnamed event was accepted",
      detail: "No note was left.",
    });
  });

  it("SCRUM402_AC11_the_organiser_opens_it_on_their_events_list", () => {
    expect(notificationLink({ type: "change_request_decided", eventRequestId: ID }, "event_organiser"))
      .toEqual({ to: "/events", state: { focusEventRequestId: ID } });
  });
});

describe("SCRUM-402 change_request_significant_submitted", () => {
  it("SCRUM402_AC12_names_the_event_and_the_fields", () => {
    expect(d("change_request_significant_submitted", {
      eventName: "Tech Talk", changeFields: ["proposed_start", "venue"],
    })).toEqual({
      headline: "The organiser asked to change Tech Talk",
      detail: "Requested: Proposed start date/time and Venue requirements. Review it on the event.",
    });
  });

  it("SCRUM402_AC12_with_no_fields_or_name_it_still_reads", () => {
    expect(d("change_request_significant_submitted", {})).toEqual({
      headline: "The organiser asked to change Unnamed event",
      detail: "Review it on the event.",
    });
  });

  it("SCRUM402_AC12_the_coordinator_opens_the_events_screen", () => {
    expect(notificationLink({ type: "change_request_significant_submitted", eventRequestId: ID }, "event_coordinator"))
      .toEqual({ to: `/event-requests/${ID}` });
  });
});

describe("SCRUM-402 the frontend knows the types 036 appends", () => {
  it("SCRUM402_AC11_036_appends_both_types_to_the_live_list_in_the_pattern_the_type_test_reads", () => {
    // The pattern notificationDisplay.test.js's knownNotificationTypes() matches.
    const sql = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../../backend/db/migrations/036_process_change_requests.sql"),
      "utf8",
    );
    const appended = [...sql.matchAll(/unnest\(\s*array\s*\[([^\]]*)\]\s*\)\s+as\s+t\b/g)]
      .flatMap((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((n) => n[1]));

    expect(sql).toContain("notifications_type_known");
    expect(appended).toEqual(["change_request_decided", "change_request_significant_submitted"]);
  });
});
