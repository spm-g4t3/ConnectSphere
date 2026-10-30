// scrum175NotificationDisplay.test.js
//
// SCRUM-175: the wording and links of the notices about a confirmed event's
// changes (042). Times are built with the module's own formatRange, so the
// suite passes in any zone and locale.

import { describe, it, expect } from "vitest";

import { describeNotification } from "../../src/services/notificationDisplay.js";
import { notificationLink } from "../../src/services/notificationLink.js";
import { attendeeEventPath } from "../../src/services/attendeeEventRoutes.js";
import { formatRange } from "../../src/services/displayFormat.js";

const EVENT = "22222222-2222-4222-8222-222222222222";
const STARTS = "2026-11-11T13:00:00+08:00";
const ENDS = "2026-11-11T17:00:00+08:00";
const RANGE = formatRange(STARTS, ENDS);
// A venue booking's own period, which includes setup and turnaround.
const BOOKED_FROM = "2026-11-11T12:00:00+08:00";
const BOOKED_TO = "2026-11-11T18:00:00+08:00";
const GENERIC = {
  headline: "New notification",
  detail: "This notification type cannot be displayed yet.",
};

const describe175 = (type, payload) => describeNotification({ id: "n175", type, payload });

const organiserConfirmed = (overrides = {}) => ({
  audience: "organiser",
  eventRequestId: EVENT,
  eventName: "Tech Talk",
  startsAt: STARTS,
  endsAt: ENDS,
  confirmedAt: "2026-11-01T09:00:00+08:00",
  reconfirmed: false,
  venues: [
    { venueName: "Hall A", startsAt: BOOKED_FROM, endsAt: BOOKED_TO },
    { venueName: "Room 2", startsAt: BOOKED_FROM, endsAt: BOOKED_TO },
  ],
  ...overrides,
});

const attendeeConfirmed = (overrides = {}) => ({
  audience: "attendee",
  eventRequestId: EVENT,
  eventName: "Tech Talk",
  startsAt: STARTS,
  endsAt: ENDS,
  confirmedAt: "2026-11-01T09:00:00+08:00",
  reconfirmed: false,
  venueNames: ["Hall A", "Room 2"],
  ...overrides,
});

const decided = (overrides = {}) => ({
  eventRequestId: EVENT,
  eventName: "Tech Talk",
  changeRequestId: "cr-1",
  changeField: "proposed_start",
  requestedChange: "Start an hour later",
  decision: "approved",
  decisionNotes: "Hall is free then",
  decidedAt: "2026-11-02T09:00:00+08:00",
  ...overrides,
});

describe("SCRUM175_AC1 event_confirmed for the Organiser", () => {
  it("SCRUM175_AC1_organiser_is_told_the_event_is_confirmed_with_its_period_and_venues", () => {
    const { headline, detail } = describe175("event_confirmed", organiserConfirmed());

    expect(headline).toBe("Tech Talk is confirmed");
    expect(detail).toContain(RANGE);
    expect(detail).toContain("Hall A");
    expect(detail).toContain("Room 2");
  });

  it("SCRUM175_AC1_organiser_notice_falls_back_to_unnamed_event", () => {
    const { headline } = describe175("event_confirmed", organiserConfirmed({ eventName: null, venues: [] }));
    expect(headline).toBe("Unnamed event is confirmed");
  });
});

describe("SCRUM175_AC2 event_confirmed for attendees", () => {
  it("SCRUM175_AC2_attendee_is_told_an_event_they_registered_for_is_confirmed", () => {
    const { headline, detail } = describe175("event_confirmed", attendeeConfirmed());

    expect(headline).toBe("An event you registered for is confirmed: Tech Talk");
    expect(detail).toContain(RANGE);
    expect(detail).toContain("Hall A");
    expect(detail).toContain("Room 2");
    expect(detail).not.toMatch(/re-confirmed/i);
  });

  it("SCRUM175_AC2_a_reconfirmation_says_it_was_reconfirmed_after_a_change", () => {
    const { headline, detail } = describe175("event_confirmed", attendeeConfirmed({ reconfirmed: true }));

    expect(headline).toContain("Tech Talk");
    expect(`${headline} ${detail}`).toMatch(/re-confirmed after a change/i);
    expect(detail).toContain(RANGE);
  });
});

describe("SCRUM175_AC3 event_venue_changed for attendees", () => {
  it("SCRUM175_AC3_attendee_is_told_the_new_and_previous_venue", () => {
    expect(describe175("event_venue_changed", {
      audience: "attendee",
      eventRequestId: EVENT,
      eventName: "Tech Talk",
      previousVenueName: "Hall A",
      venueName: "Hall B",
    })).toEqual({
      headline: "The venue for Tech Talk changed",
      detail: "Now at Hall B (was Hall A).",
    });
  });
});

describe("SCRUM175_AC5 change_request_decided for the Organiser", () => {
  it("SCRUM175_AC5_organiser_is_told_their_change_request_was_approved_with_field_and_notes", () => {
    const { headline, detail } = describe175("change_request_decided", decided());

    expect(headline).toBe("Your change request for Tech Talk was approved");
    expect(detail).toContain("Proposed start");
    expect(detail).toContain("Hall is free then");
  });

  it("SCRUM175_AC5_organiser_is_told_their_change_request_was_declined", () => {
    const { headline, detail } = describe175(
      "change_request_decided",
      decided({ decision: "rejected", decisionNotes: "No hall is free" }),
    );

    expect(headline).toBe("Your change request for Tech Talk was declined");
    expect(detail).toContain("No hall is free");
  });

  it("SCRUM175_AC5_a_decision_without_notes_says_no_reason_was_recorded", () => {
    const { detail } = describe175("change_request_decided", decided({ decision: "rejected", decisionNotes: null }));
    expect(detail).toContain("No reason recorded");
  });
});

describe("SCRUM175_AC6 event_cancelled for attendees", () => {
  it("SCRUM175_AC6_attendee_is_told_the_event_was_cancelled_with_the_coordinators_message", () => {
    const { headline, detail } = describe175("event_cancelled", {
      audience: "attendee",
      eventRequestId: EVENT,
      eventName: "Tech Talk",
      message: "We will reschedule soon",
      cancelledAt: "2026-11-03T09:00:00+08:00",
    });

    expect(headline).toBe("Tech Talk was cancelled");
    expect(detail).toContain("We will reschedule soon");
  });

  it("SCRUM175_AC6_attendee_cancellation_without_a_message_says_nothing_more", () => {
    expect(describe175("event_cancelled", {
      audience: "attendee",
      eventRequestId: EVENT,
      eventName: "Tech Talk",
      message: null,
      cancelledAt: "2026-11-03T09:00:00+08:00",
    })).toEqual({ headline: "Tech Talk was cancelled", detail: "" });
  });
});

describe("SCRUM175 notices with parts of the payload missing", () => {
  it("SCRUM175_AC1_organiser_notice_without_a_venues_array_names_only_the_period", () => {
    expect(describe175("event_confirmed", organiserConfirmed({ venues: undefined }))).toEqual({
      headline: "Tech Talk is confirmed",
      detail: `Its fields are now locked; changes go through a change request. It runs ${RANGE}.`,
    });
  });

  it("SCRUM175_AC2_attendee_notice_without_a_venue_names_array_names_only_the_period", () => {
    expect(describe175("event_confirmed", attendeeConfirmed({ venueNames: undefined }))).toEqual({
      headline: "An event you registered for is confirmed: Tech Talk",
      detail: `It runs ${RANGE}.`,
    });
  });

  it("SCRUM175_AC2_reconfirmation_without_period_or_venues_says_only_that_it_was_reconfirmed", () => {
    const payload = attendeeConfirmed({ reconfirmed: true, startsAt: null, endsAt: null, venueNames: [] });
    expect(describe175("event_confirmed", payload)).toEqual({
      headline: "An event you registered for is confirmed again: Tech Talk",
      detail: "It was re-confirmed after a change.",
    });
  });

  it.each([["other"], [undefined], [42]])(
    "SCRUM175_AC5_a_change_field_of_%s_names_no_field",
    (changeField) => {
      expect(describe175("change_request_decided", decided({ changeField }))).toEqual({
        headline: "Your change request for Tech Talk was approved",
        detail: "Coordinator's notes: Hall is free then.",
      });
    },
  );

  it("SCRUM175_AC3_venue_change_without_the_previous_venue_says_unknown_venue", () => {
    expect(describe175("event_venue_changed", {
      audience: "attendee", eventRequestId: EVENT, eventName: "Tech Talk", venueName: "Hall B",
    })).toEqual({
      headline: "The venue for Tech Talk changed",
      detail: "Now at Hall B (was Unknown venue).",
    });
  });
});

describe("SCRUM175_AC7 an unknown branch reads as the generic notification", () => {
  it.each([
    ["event_confirmed", { ...attendeeConfirmed(), audience: "venue_staff" }],
    ["event_confirmed", { ...attendeeConfirmed(), audience: undefined }],
    ["event_venue_changed", { audience: "organiser", eventName: "Tech Talk", venueName: "Hall B" }],
    ["change_request_decided", decided({ decision: "event_cancelled" })],
    ["change_request_decided", decided({ decision: undefined })],
  ])("SCRUM175_AC7_%s_with_an_unknown_audience_or_decision_is_generic", (type, payload) => {
    expect(describe175(type, payload)).toEqual(GENERIC);
  });
});

describe("SCRUM175_AC7 notices expose nothing the reader may not see", () => {
  it("SCRUM175_AC7_attendee_cancellation_never_shows_the_internal_reason", () => {
    const secret = "Organiser lost sponsor funding";
    for (const message of ["See you next term", null]) {
      const { headline, detail } = describe175("event_cancelled", {
        audience: "attendee",
        eventRequestId: EVENT,
        eventName: "Tech Talk",
        message,
        reason: secret,
        cancelledAt: "2026-11-03T09:00:00+08:00",
      });
      expect(`${headline} ${detail}`).not.toContain(secret);
      expect(detail).not.toMatch(/reason/i);
    }
  });

  it("SCRUM175_AC7_attendee_confirmation_does_not_show_organiser_only_booking_data", () => {
    // An attendee payload carries venue names only; booking periods (with setup
    // and turnaround) and organiser venue rows must not leak in if present.
    const { headline, detail } = describe175("event_confirmed", attendeeConfirmed({
      venueNames: ["Hall A"],
      venues: [{ venueName: "Backstage Store", startsAt: BOOKED_FROM, endsAt: BOOKED_TO }],
    }));
    const text = `${headline} ${detail}`;

    expect(text).toContain("Hall A");
    expect(text).not.toContain("Backstage Store");
    expect(text).not.toContain(formatRange(BOOKED_FROM, BOOKED_TO));
    expect(text).not.toMatch(/change request|locked/i);
  });
});

describe("SCRUM175_AC7 where each notice opens", () => {
  const note = (type) => ({ id: "n175", type, eventRequestId: EVENT });

  it.each(["event_confirmed", "event_venue_changed"])(
    "SCRUM175_AC7_attendee_%s_opens_the_attendee_event_page",
    (type) => {
      expect(notificationLink(note(type), "attendee")).toEqual({ to: attendeeEventPath(EVENT) });
    },
  );

  it("SCRUM175_AC7_attendee_event_cancelled_opens_nothing", () => {
    expect(notificationLink(note("event_cancelled"), "attendee")).toBeNull();
  });

  it.each(["event_confirmed", "change_request_decided"])(
    "SCRUM175_AC7_organiser_%s_opens_their_list_focused_on_the_event",
    (type) => {
      expect(notificationLink(note(type), "event_organiser")).toEqual({
        to: "/events",
        state: { focusEventRequestId: EVENT },
      });
    },
  );
});
