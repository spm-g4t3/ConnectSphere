// scrum387NotificationDisplay.test.js
//
// SCRUM-387 AC8: the Organiser's event_details_changed notice (migration 022),
// its wording and where it opens.

import { describe, it, expect } from "vitest";

import { describeNotification } from "../../src/services/notificationDisplay.js";
import { notificationLink } from "../../src/services/notificationLink.js";

const ID = "22222222-2222-4222-8222-222222222222";
const d = (payload) => describeNotification({ id: "n387", type: "event_details_changed", payload });

describe("SCRUM-387 event_details_changed", () => {
  it("SCRUM387_AC8_names_the_event_the_fields_by_their_labels_and_the_reason", () => {
    expect(d({
      eventRequestId: ID,
      eventName: "Tech Talk 2026",
      reason: "The Organiser asked by email",
      changedFields: ["eventName", "proposedStart", "venueRequirements"],
      status: "under_review",
    })).toEqual({
      headline: "Your Coordinator updated Tech Talk 2026",
      detail: "Changed: Event name, Proposed start and Venue requirements. Reason: The Organiser asked by email.",
    });
  });

  it("SCRUM387_AC8_a_missing_reason_and_fields_still_read_as_a_sentence", () => {
    expect(d({ eventName: "Tech Talk" })).toEqual({
      headline: "Your Coordinator updated Tech Talk",
      detail: "Reason: No reason recorded.",
    });
    expect(d({ changedFields: "eventName" }).headline).toBe("Your Coordinator updated Unnamed event");
  });

  it("SCRUM387_AC8_an_unknown_field_name_falls_back_to_readable_words", () => {
    expect(d({ eventName: "Tech Talk", reason: "Why", changedFields: ["purpose", "cateringHeadcount"] }).detail)
      .toBe("Changed: Purpose and Catering headcount. Reason: Why.");
  });

  it("SCRUM387_AC8_the_organiser_opens_it_on_their_events_list_at_that_event", () => {
    expect(notificationLink({ type: "event_details_changed", eventRequestId: ID }, "event_organiser")).toEqual({
      to: "/events",
      state: { focusEventRequestId: ID },
    });
  });
});
