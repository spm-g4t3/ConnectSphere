// notificationLink.test.js
//
// SCRUM-172 AC7: selecting a notification links to the related event,
// provided the user is authorised to view that event. Each role must land on
// a page its route allows, or get no link at all.

import { describe, it, expect } from "vitest";

import { notificationLink } from "../../src/services/notificationLink";

const EVENT = "22222222-2222-4222-8222-222222222222";

function note(type, eventRequestId = EVENT) {
  return { id: "n1", type, eventRequestId };
}

describe("SCRUM172_AC7 where each role lands", () => {
  it.each([
    ["event_coordinator", "booking_flagged"],
    ["event_coordinator", "event_cancelled"],
    ["event_coordinator", "clarification_responded"],
    ["event_coordinator_lead", "event_request_awaiting_assignment"],
    ["event_coordinator_lead", "event_cancelled"],
  ])("SCRUM172_AC7_%s_opens_the_event_review_page_for_%s", (role, type) => {
    expect(notificationLink(note(type), role)).toEqual({ to: `/event-requests/${EVENT}` });
  });

  it.each(["event_cancelled", "event_request_decided", "booking_request_approved"])(
    "SCRUM172_AC7_organiser_opens_their_list_focused_on_the_event_for_%s",
    (type) => {
      // /event-requests/:id is coordinator-only; the organiser's page is /events.
      expect(notificationLink(note(type), "event_organiser")).toEqual({
        to: "/events",
        state: { focusEventRequestId: EVENT },
      });
    },
  );

  it("SCRUM172_AC7_organiser_clarification_opens_the_reply_form", () => {
    expect(notificationLink(note("clarification_requested"), "event_organiser")).toEqual({
      to: "/events",
      state: { openClarificationRequestId: EVENT },
    });
  });

  it("SCRUM172_AC7_tech_support_opens_the_equipment_review_for_a_safety_review", () => {
    expect(notificationLink(note("safety_equipment_review"), "technical_support_staff")).toEqual({
      to: `/equipment-review/${EVENT}`,
    });
  });

  it("SCRUM172_AC7_tech_support_gets_no_link_for_a_cancelled_event", () => {
    expect(notificationLink(note("event_cancelled"), "technical_support_staff")).toBeNull();
  });

  it.each([
    ["venue_staff", "booking_flagged"],
    ["safety_officer", "event_submitted_for_safety_review"],
    ["attendee", "event_cancelled"],
    ["system_admin", "event_cancelled"],
    [undefined, "event_cancelled"],
    [null, "event_cancelled"],
  ])("SCRUM172_AC7_role_%s_without_an_event_page_gets_no_link", (role, type) => {
    expect(notificationLink(note(type), role)).toBeNull();
  });

  it.each([undefined, null, ""])(
    "SCRUM172_AC7_no_link_without_an_event_request_id_(%s)",
    (eventRequestId) => {
      const withoutEvent = { id: "n1", type: "event_cancelled", eventRequestId };
      expect(notificationLink(withoutEvent, "event_coordinator")).toBeNull();
      expect(notificationLink(withoutEvent, "event_organiser")).toBeNull();
    },
  );

  it.each([
    ["Event Coordinator", "event_cancelled", { to: `/event-requests/${EVENT}` }],
    ["EVENT_COORDINATOR", "event_cancelled", { to: `/event-requests/${EVENT}` }],
    ["event-coordinator-lead", "event_cancelled", { to: `/event-requests/${EVENT}` }],
    ["Event Organizer", "event_cancelled", { to: "/events", state: { focusEventRequestId: EVENT } }],
    [" Technical Support Staff ", "safety_equipment_review", { to: `/equipment-review/${EVENT}` }],
  ])("SCRUM172_AC7_role_spelling_%s_is_normalised", (role, type, expected) => {
    expect(notificationLink(note(type), role)).toEqual(expected);
  });
});

describe("SCRUM266_AC1 Venue Staff's flag notice", () => {
  it("SCRUM266_AC1_venue_staff_safety_flag_opens_the_flagged_bookings_list", () => {
    expect(notificationLink(note("safety_booking_flagged"), "venue_staff")).toEqual({ to: "/flagged-bookings" });
  });
});

describe("SCRUM174_AC1 Venue Staff's new request notice", () => {
  it("SCRUM174_AC1_venue_staff_submitted_links_to_queue", () => {
    expect(notificationLink(note("booking_request_submitted"), "venue_staff")).toEqual({ to: "/booking-requests" });
  });
});

describe("SCRUM395 significant change notification destinations", () => {
  it("SCRUM395_AC9_sends_venue_staff_to_the_flagged_booking_list", () => {
    expect(notificationLink(note("booking_flagged_event_change"), "venue_staff")).toEqual({
      to: "/flagged-bookings",
    });
  });

  it("SCRUM395_AC9_sends_venue_staff_to_the_request_queue_for_a_pending_request_on_the_old_time", () => {
    expect(notificationLink(note("booking_request_event_change"), "venue_staff")).toEqual({
      to: "/booking-requests",
    });
  });

  it("SCRUM395_AC9_focuses_the_changed_event_for_its_organiser", () => {
    expect(notificationLink(note("event_significant_change"), "event_organiser")).toEqual({
      to: "/events",
      state: { focusEventRequestId: EVENT },
    });
  });
});

describe("SCRUM494_AC7 a start that moved before the registration dates", () => {
  it("SCRUM494_AC7_organiser_opens_the_event_registration_settings_page", () => {
    expect(notificationLink(note("registration_schedule_conflict"), "event_organiser")).toEqual({
      to: `/events/${EVENT}/registration`,
    });
  });

  it("SCRUM494_AC7_coordinator_opens_the_event_review_page", () => {
    // The settings page is organiser-only; the coordinator reads the event instead.
    expect(notificationLink(note("registration_schedule_conflict"), "event_coordinator")).toEqual({
      to: `/event-requests/${EVENT}`,
    });
  });
});
