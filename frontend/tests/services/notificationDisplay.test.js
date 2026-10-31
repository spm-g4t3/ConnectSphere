// notificationDisplay.test.js
//
// SCRUM-128 (part of SCRUM-17, AC3). The wording of a notification on the
// Coordinator dashboard. The display format is fixed Singapore text, so an
// expected time is a literal or built with the helper the module uses, from
// fixtures that carry +08:00 offsets; the suite passes in any zone and locale.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { describeNotification } from "../../src/services/notificationDisplay.js";
import { formatDateTime, formatDateTimeRange } from "../../src/services/displayFormat.js";
import { formatOccupiedPeriod } from "../../src/services/occupiedPeriodDisplay.js";
import { PAYLOAD, SETUP_PAYLOAD } from "../fixtures/notifications.js";

function flagged(payload = PAYLOAD) {
  return { id: "n1", type: "booking_flagged", payload };
}

const BOOKED = "1 Oct 2026, 10:00 am – 12:00 pm";
const BLOCKED = "1 Oct 2026, 9:00 am – 5:00 pm";

describe("describeNotification: booking_flagged", () => {
  it("SCRUM17_AC3_names_the_event_and_venue_in_the_headline", () => {
    expect(describeNotification(flagged()).headline).toBe("Tech Talk at Hall A needs review");
  });

  it("SCRUM17_AC3_detail_gives_booking_times_reason_label_and_block_times", () => {
    expect(describeNotification(flagged()).detail).toBe(
      `Booked ${BOOKED}. The venue is blocked for Maintenance, ${BLOCKED}. Alternative arrangements are required.`,
    );
  });

  it("formats the times as the fixed Singapore display text", () => {
    const { detail } = describeNotification(flagged());
    expect(detail).toContain("Booked 1 Oct 2026, 10:00 am – 12:00 pm.");
    expect(detail).toContain("Maintenance, 1 Oct 2026, 9:00 am – 5:00 pm.");
    expect(detail).not.toContain("+08:00");
  });

  it.each([
    ["renovation", "Renovation"],
    ["safety", "Safety"],
    ["internal_activity", "Internal activity"],
    ["other", "Other"],
  ])("labels the %s reason as %s", (code, label) => {
    const { detail } = describeNotification(flagged({ ...PAYLOAD, reason: code }));
    expect(detail).toContain(`blocked for ${label},`);
  });

  it("shows an unknown reason code raw rather than hiding it", () => {
    const { detail } = describeNotification(flagged({ ...PAYLOAD, reason: "flood" }));
    expect(detail).toContain("blocked for flood,");
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
  ])("reads a %s reason as unspecified", (_label, reason) => {
    const { detail } = describeNotification(flagged({ ...PAYLOAD, reason }));
    expect(detail).toContain("blocked for unspecified reason,");
  });

  it("reads missing times as unknown, never undefined", () => {
    const { detail } = describeNotification(flagged({ eventName: "X", venueName: "Y" }));
    expect(detail).toBe(
      "Booked unknown – unknown. The venue is blocked for unspecified reason, unknown – unknown. Alternative arrangements are required.",
    );
    expect(detail).not.toContain("undefined");
  });

  it("shows an unparseable time as the raw string", () => {
    const { detail } = describeNotification(flagged({ ...PAYLOAD, startsAt: "soon" }));
    expect(detail).toContain("Booked soon – ");
  });
});

function setupChange(payload = SETUP_PAYLOAD) {
  return { id: "n6", type: "booking_flagged_setup_change", payload };
}

// The payload 012 writes when new opening hours leave a booking out. An
// overnight booking, so the period must read on the Singapore wall clock.
const HOURS_PAYLOAD = {
  venueName: "Harbour Room",
  eventName: "Night Market",
  startsAt: "2026-11-06T22:00:00+08:00",
  endsAt: "2026-11-07T01:00:00+08:00",
  reason: "Operating hours changed",
};

describe("describeNotification: booking_flagged_hours_change (SCRUM-575 AC7)", () => {
  it("SCRUM575_AC7_hours_change_notification_wording", () => {
    const { headline, detail } = describeNotification({
      id: "n575",
      type: "booking_flagged_hours_change",
      payload: HOURS_PAYLOAD,
    });

    expect(headline).toBe("Night Market at Harbour Room needs review");
    expect(detail).toBe(
      "Operating hours changed. The booking for 2026-11-06 22:00 – 2026-11-07 01:00 (Singapore time) " +
        "is outside the new hours. Alternative arrangements are required.",
    );
  });

  it("SCRUM575_AC7_hours_change_without_times_leaves_the_period_out", () => {
    const { detail } = describeNotification({
      id: "n575b",
      type: "booking_flagged_hours_change",
      payload: { eventName: "Night Market" },
    });
    expect(detail).toBe("Operating hours changed. Alternative arrangements are required.");
  });
});

describe("describeNotification: booking_flagged_setup_change (SCRUM-484 AC8)", () => {
  it("SCRUM484_AC8_setup_change_notification_wording", () => {
    const { headline, detail } = describeNotification(setupChange());

    expect(headline).toBe("Orientation at Harbour Room needs review");
    expect(detail).toBe(
      `Setup or turnaround time changed. It now occupies ${formatOccupiedPeriod(SETUP_PAYLOAD, formatDateTimeRange)}. Alternative arrangements are required.`,
    );
    // The parts, each from the same instants.
    expect(detail).toContain(
      `Setup ${formatDateTimeRange(SETUP_PAYLOAD.occupiedStartsAt, SETUP_PAYLOAD.startsAt)}`,
    );
    expect(detail).toContain(`Event ${formatDateTimeRange(SETUP_PAYLOAD.startsAt, SETUP_PAYLOAD.endsAt)}`);
    expect(detail).toContain(
      `Turnaround ${formatDateTimeRange(SETUP_PAYLOAD.endsAt, SETUP_PAYLOAD.occupiedEndsAt)}`,
    );
    expect(headline).not.toBe("New notification");
  });

  describe("describeNotification: significant event changes (SCRUM-395)", () => {
    it("SCRUM395_AC9_explains_the_change_to_the_organiser", () => {
      const notification = {
        id: "n395-1",
        type: "event_significant_change",
        payload: { eventName: "Tech Talk", reason: "Updated schedule" },
      };
      expect(describeNotification(notification)).toEqual({
        headline: "Tech Talk has a significant change",
        detail: "The event was updated by its Coordinator. Reason: Updated schedule.",
      });
    });

    it("SCRUM395_AC9_shows_the_changed_period_to_registered_attendees", () => {
      const notification = {
        id: "n395-2",
        type: "event_significant_change_attendee",
        payload: {
          eventName: "Tech Talk",
          reason: "Updated schedule",
          startsAt: PAYLOAD.startsAt,
          endsAt: PAYLOAD.endsAt,
        },
      };
      const { headline, detail } = describeNotification(notification);
      expect(headline).toBe("An event you registered for has changed: Tech Talk");
      expect(detail).toBe(`The event now runs ${formatDateTimeRange(PAYLOAD.startsAt, PAYLOAD.endsAt)}.`);
    });

    it("SCRUM395_AC9_explains_a_venue_booking_flag", () => {
      const notification = {
        id: "n395-3",
        type: "booking_flagged_event_change",
        payload: {
          eventName: "Tech Talk",
          venueName: "Hall A",
          startsAt: PAYLOAD.startsAt,
          endsAt: PAYLOAD.endsAt,
          reason: "Updated schedule",
        },
      };
      const { headline, detail } = describeNotification(notification);
      expect(headline).toBe("Tech Talk at Hall A needs review after a significant event change");
      expect(detail).toContain("Coordinator's reason: Updated schedule.");
    });

    it("SCRUM395_AC9_gives_venue_staff_both_periods_for_a_pending_request", () => {
      const notification = {
        id: "n395-4",
        type: "booking_request_event_change",
        payload: {
          eventName: "Tech Talk",
          venueName: "Hall A",
          startsAt: PAYLOAD.startsAt,
          endsAt: PAYLOAD.endsAt,
          newStartsAt: "2040-12-02T10:00:00+08:00",
          newEndsAt: "2040-12-02T12:00:00+08:00",
          reason: "Updated schedule",
        },
      };
      expect(describeNotification(notification)).toEqual({
        headline: "Tech Talk moved; a pending request is for the old time",
        detail:
          `The request for Hall A is for ${formatDateTimeRange(PAYLOAD.startsAt, PAYLOAD.endsAt)}. ` +
          `The event now runs ${formatDateTimeRange("2040-12-02T10:00:00+08:00", "2040-12-02T12:00:00+08:00")}. ` +
          "Coordinator's reason: Updated schedule.",
      });
    });
  });

  it("SCRUM484_AC8_setup_change_detail_does_not_repeat_the_backend_reason", () => {
    expect(describeNotification(setupChange()).detail).not.toContain(SETUP_PAYLOAD.reason);
  });

  it("SCRUM484_AC8_setup_change_notification_tolerates_missing_fields", () => {
    const { headline, detail } = describeNotification(setupChange({}));
    expect(headline).toBe("Unnamed event at Unknown venue needs review");
    // Nothing usable: no time sentence at all, rather than "unknown – unknown".
    expect(detail).toBe("Setup or turnaround time changed. Alternative arrangements are required.");
    expect(detail).not.toContain("unknown");
    expect(`${headline} ${detail}`).not.toContain("undefined");
  });

  it("SCRUM484_AC8_occupied_times_only_name_the_occupied_range", () => {
    const { detail } = describeNotification(
      setupChange({ ...SETUP_PAYLOAD, startsAt: undefined, endsAt: undefined }),
    );
    expect(detail).toBe(
      `Setup or turnaround time changed. It now occupies ${formatDateTimeRange(SETUP_PAYLOAD.occupiedStartsAt, SETUP_PAYLOAD.occupiedEndsAt)}. Alternative arrangements are required.`,
    );
    expect(detail).not.toContain("unknown");
    expect(detail).not.toContain("Setup 0");
    expect(detail).not.toContain("·");
  });

  it.each([
    ["missing", { startsAt: undefined, endsAt: undefined, occupiedStartsAt: undefined, occupiedEndsAt: undefined }],
    ["null", { startsAt: null, endsAt: null, occupiedStartsAt: null, occupiedEndsAt: null }],
    ["empty", { startsAt: "", endsAt: "", occupiedStartsAt: "", occupiedEndsAt: "" }],
    ["unparseable", { startsAt: "soon", endsAt: "later", occupiedStartsAt: "soon", occupiedEndsAt: "later" }],
    ["half-present", { startsAt: SETUP_PAYLOAD.startsAt, endsAt: null, occupiedStartsAt: null, occupiedEndsAt: SETUP_PAYLOAD.occupiedEndsAt }],
  ])("SCRUM484_AC8_%s_times_give_no_time_sentence", (_label, overrides) => {
    const { headline, detail } = describeNotification(setupChange({ ...SETUP_PAYLOAD, ...overrides }));
    expect(headline).toBe("Orientation at Harbour Room needs review");
    expect(detail).toBe("Setup or turnaround time changed. Alternative arrangements are required.");
    expect(detail).not.toContain("Invalid Date");
  });

  it.each([
    ["missing occupied fields", { occupiedStartsAt: undefined, occupiedEndsAt: undefined }],
    ["null occupied fields", { occupiedStartsAt: null, occupiedEndsAt: null }],
    ["unparseable occupied fields", { occupiedStartsAt: "soon", occupiedEndsAt: "later" }],
  ])("SCRUM484_AC8_%s_fall_back_to_the_plain_range", (_label, overrides) => {
    const { detail } = describeNotification(setupChange({ ...SETUP_PAYLOAD, ...overrides }));
    expect(detail).toBe(
      `Setup or turnaround time changed. It now occupies ${formatDateTimeRange(SETUP_PAYLOAD.startsAt, SETUP_PAYLOAD.endsAt)}. Alternative arrangements are required.`,
    );
    expect(detail).not.toContain("·");
    expect(detail).not.toContain("Turnaround ");
    expect(detail).not.toContain("Invalid Date");
  });
});

// 031. Sent to Venue Staff when a coordinator withdraws a pending request.
const WITHDRAWN_PAYLOAD = {
  eventRequestId: "e0000000-0000-4000-8000-000000000001",
  eventName: "Tech Talk",
  venueId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  venueName: "Hall A",
  startsAt: "2026-10-01T10:00:00+08:00",
  endsAt: "2026-10-01T12:00:00+08:00",
};

function withdrawn(payload = WITHDRAWN_PAYLOAD) {
  return { id: "n7", type: "booking_request_withdrawn", payload };
}

describe("describeNotification: booking_request_withdrawn", () => {
  it("SCRUM484_withdrawn_request_headline_and_detail", () => {
    expect(describeNotification(withdrawn())).toEqual({
      headline: "The request for Tech Talk at Hall A was withdrawn",
      detail:
        `It was for ${formatDateTimeRange(WITHDRAWN_PAYLOAD.startsAt, WITHDRAWN_PAYLOAD.endsAt)}. ` +
        "It no longer needs a decision.",
    });
  });
});

// 083. Sent to every Venue Staff user when a coordinator submits a request.
describe("describeNotification: booking_request_submitted", () => {
  it("SCRUM174_AC1_submitted_request_headline_and_detail", () => {
    const submitted = { id: "n12", type: "booking_request_submitted", payload: WITHDRAWN_PAYLOAD };
    expect(describeNotification(submitted)).toEqual({
      headline: "New request: Tech Talk at Hall A",
      detail:
        `It is for ${formatDateTimeRange(WITHDRAWN_PAYLOAD.startsAt, WITHDRAWN_PAYLOAD.endsAt)}. ` +
        "It needs a decision.",
      needsAction: true,
    });
  });
});

describe("describeNotification: event_cancelled (SCRUM-374)", () => {
  it("shows the reason and cancellation date to the Organiser", () => {
    const result = describeNotification({
      type: "event_cancelled",
      payload: {
        audience: "organiser",
        eventName: "Tech Talk",
        reason: "Venue unavailable",
        cancelledAt: "2026-10-01T10:00:00+08:00",
      },
    });

    expect(result.headline).toBe("Tech Talk was cancelled");
    expect(result.detail).toBe(
      `Reason: Venue unavailable. Cancelled ${formatDateTime("2026-10-01T10:00:00+08:00")}.`,
    );
  });

  it("uses safe defaults when the Organiser cancellation details are missing", () => {
    expect(describeNotification({
      type: "event_cancelled",
      payload: { audience: "organiser", reason: "", cancelledAt: null },
    })).toEqual({
      headline: "Unnamed event was cancelled",
      detail: "Reason: No reason recorded.",
    });
  });

  it("tells the Safety Officer the event no longer needs a safety review, with reason and time", () => {
    expect(describeNotification({
      type: "event_cancelled",
      payload: {
        audience: "safety_officer",
        eventName: "Tech Talk",
        reason: "Venue unavailable",
        cancelledAt: "2026-10-01T10:00:00+08:00",
      },
    })).toEqual({
      headline: "Tech Talk was cancelled",
      detail: `It no longer needs a safety review. Reason: Venue unavailable. Cancelled ${formatDateTime("2026-10-01T10:00:00+08:00")}.`,
    });
  });

  it("uses safe defaults when the Safety Officer cancellation details are missing", () => {
    expect(describeNotification({
      type: "event_cancelled",
      payload: { audience: "safety_officer", reason: "", cancelledAt: null },
    })).toEqual({
      headline: "Unnamed event was cancelled",
      detail: "It no longer needs a safety review. Reason: No reason recorded.",
    });
  });

  it("uses the generic notification for an unknown cancellation audience", () => {
    expect(describeNotification({
      type: "event_cancelled",
      payload: { audience: "unknown" },
    })).toEqual({
      headline: "New notification",
      detail: "This notification type cannot be displayed yet.",
    });
  });

  it("uses audience-specific details for venue and technical support staff", () => {
    expect(describeNotification({
      type: "event_cancelled",
      payload: { audience: "venue_staff", eventName: "Tech Talk" },
    })).toEqual({
      headline: "Bookings for Tech Talk were released",
      detail: "Pending booking requests were withdrawn and confirmed bookings were cancelled.",
    });
    expect(describeNotification({
      type: "event_cancelled",
      payload: { audience: "technical_support_staff", eventName: "Tech Talk" },
    })).toEqual({
      headline: "Equipment arrangements for Tech Talk were cancelled",
      detail: "The equipment request was cancelled and its active reservations were released.",
    });
  });
});

describe("describeNotification: other types", () => {
  it.each([
    ["clarification_requested", "A Coordinator has a question about Tech Talk"],
    ["clarification_replied", "The Organiser replied about Tech Talk"],
    ["clarification_closed", "A Coordinator closed the clarification for Tech Talk"],
  ])("describes %s with event context", (type, headline) => {
    expect(describeNotification({
      id: "n3",
      type,
      payload: {
        eventName: "Tech Talk",
        message: "Please confirm the details.",
        replyByDate: "2026-10-10",
      },
    })).toEqual({
      headline,
      detail: "Please confirm the details. Reply by 2026-10-10.",
    });
  });

  it("describes a clarification notification without a reply-by date", () => {
    expect(describeNotification({
      id: "n4",
      type: "clarification_replied",
      payload: { eventName: "Tech Talk", message: "The organiser replied." },
    })).toEqual({
      headline: "The Organiser replied about Tech Talk",
      detail: "The organiser replied.",
    });
  });

  it("uses clarification defaults when event context and message are missing", () => {
    expect(describeNotification({
      id: "n5",
      type: "clarification_requested",
      payload: {},
    })).toEqual({
      headline: "A Coordinator has a question about the event request",
      detail: "Open the event request to review the conversation.",
    });
  });

  it("SCRUM17_AC3_an_unknown_type_is_shown_generically_not_hidden", () => {
    expect(describeNotification({ id: "n2", type: "something_new", payload: PAYLOAD })).toEqual({
      headline: "New notification",
      detail: "This notification type cannot be displayed yet.",
    });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty object", {}],
  ])("does not throw for %s", (_label, value) => {
    expect(describeNotification(value).headline).toBe("New notification");
  });
});

describe("describeNotification: venue_hold_expired (SCRUM-491 AC8)", () => {
  const EXPIRES = "2026-11-02T18:00:00+08:00";
  const expired = (payload) => ({ id: "n9", type: "venue_hold_expired", venueHoldId: "h1", payload });

  it("SCRUM491_AC8_names_the_event_the_venue_and_the_expiry", () => {
    const { headline, detail } = describeNotification(
      expired({
        eventRequestId: "e1",
        eventName: "Product Launch",
        venueId: "v1",
        venueName: "Hall A",
        expiresAt: EXPIRES,
      }),
    );

    expect(headline).toBe("The hold on Hall A for Product Launch has expired");
    expect(detail).toContain(`It expired ${formatDateTime(EXPIRES)}.`);
  });

  it("SCRUM491_AC7_says_the_hold_was_never_a_booking", () => {
    const { detail } = describeNotification(
      expired({ eventName: "Product Launch", venueName: "Hall A", expiresAt: EXPIRES }),
    );
    expect(detail).toMatch(/a hold is not a booking/);
  });

  it("SCRUM491_AC8_a_missing_payload_reads_as_unknown_not_undefined", () => {
    const { headline, detail } = describeNotification({ type: "venue_hold_expired" });

    expect(headline).toBe("The hold on Unknown venue for Unnamed event has expired");
    expect(detail).toContain("It expired unknown.");
    expect(`${headline} ${detail}`).not.toMatch(/undefined|null/);
  });
});

describe("describeNotification: Venue Staff decisions (SCRUM-258 AC6)", () => {
  const DECISION = {
    eventName: "Tech Talk",
    venueName: "Hall A",
    startsAt: "2026-10-01T10:00:00+08:00",
    endsAt: "2026-10-01T12:00:00+08:00",
    reason: null,
    suggestedAlternative: null,
  };
  const of = (type, payload) => describeNotification({ id: "n8", type, payload });

  it("SCRUM258_AC6_approved_names_the_venue_event_and_period", () => {
    expect(of("booking_request_approved", DECISION)).toEqual({
      headline: "Hall A was approved for Tech Talk",
      detail: `It is booked for ${formatDateTimeRange(DECISION.startsAt, DECISION.endsAt)}.`,
    });
  });

  it("SCRUM258_AC6_rejected_ends_the_reason_with_a_full_stop_before_the_alternative", () => {
    expect(of("booking_request_rejected", {
      ...DECISION,
      reason: "Under renovation",
      suggestedAlternative: "Hall B",
    })).toEqual({
      headline: "The request for Hall A for Tech Talk was rejected",
      detail: "Reason: Under renovation. Suggested alternative: Hall B",
    });
  });

  it("SCRUM258_AC6_rejected_does_not_double_a_reasons_own_end_punctuation", () => {
    const { detail } = of("booking_request_rejected", {
      ...DECISION,
      reason: "Closed for an audit!",
      suggestedAlternative: "Hall B",
    });
    expect(detail).toBe("Reason: Closed for an audit! Suggested alternative: Hall B");
  });

  it("SCRUM258_AC6_rejected_without_an_alternative_gives_only_the_reason", () => {
    const { detail } = of("booking_request_rejected", { ...DECISION, reason: "Under renovation" });
    expect(detail).toBe("Reason: Under renovation");
  });

  it("SCRUM174_AC4_rejected_with_alternative_but_no_reason", () => {
    const { detail } = of("booking_request_rejected", { ...DECISION, suggestedAlternative: "Hall B" });
    expect(detail).toBe("Reason: No reason recorded. Suggested alternative: Hall B");
  });

  it("SCRUM258_AC3_conflicting_names_the_approved_event_and_says_the_request_is_still_open", () => {
    const { headline, detail } = of("booking_request_conflicting", {
      ...DECISION,
      approvedEventName: "Gala Dinner",
      approvedStartsAt: "2026-10-01T11:00:00+08:00",
      approvedEndsAt: "2026-10-01T14:00:00+08:00",
    });
    expect(headline).toBe("Your request for Hall A for Tech Talk now clashes with Gala Dinner");
    expect(detail).toContain(
      `Gala Dinner was approved for ${formatDateTimeRange("2026-10-01T11:00:00+08:00", "2026-10-01T14:00:00+08:00")}.`,
    );
    expect(detail).toMatch(/still open/);
  });
});

// SCRUM-172 (AC6). The 052 assignment notices and the 058 safety notices.
const of172 = (type, payload) => describeNotification({ id: "n10", type, payload });
const NO_PAYLOAD = [
  ["an empty", {}],
  ["a null", null],
  ["an undefined", undefined],
];

describe("describeNotification: event_request_awaiting_assignment (SCRUM-172 AC6)", () => {
  const SUBMITTED = "2026-10-01T09:30:00+08:00";

  it("SCRUM172_AC6_awaiting_assignment_wording", () => {
    expect(of172("event_request_awaiting_assignment", {
      eventRequestId: "e1",
      eventName: "Tech Talk",
      submittedAt: SUBMITTED,
    })).toEqual({
      headline: "Tech Talk is waiting for a coordinator",
      detail: `Submitted ${formatDateTime(SUBMITTED)}. Assign it from the unassigned queue.`,
    });
  });

  it("SCRUM172_AC6_awaiting_assignment_unparseable_time_drops_the_sentence", () => {
    expect(of172("event_request_awaiting_assignment", {
      eventName: "Tech Talk",
      submittedAt: "soon",
    }).detail).toBe("Assign it from the unassigned queue.");
  });
});

describe("describeNotification: event_request_assigned (SCRUM-172 AC6)", () => {
  const FIRST = {
    eventRequestId: "e1",
    eventName: "Tech Talk",
    assignedById: "u1",
    assignedByName: "Lena Lead",
    previousCoordinatorId: null,
    previousCoordinatorName: null,
    note: null,
  };
  const HANDOVER = {
    ...FIRST,
    previousCoordinatorId: "u2",
    previousCoordinatorName: "Cory Coord",
  };

  it("SCRUM172_AC6_assigned_first_assignment_names_the_lead", () => {
    expect(of172("event_request_assigned", FIRST)).toEqual({
      headline: "Tech Talk was assigned to you",
      detail: "Assigned by Lena Lead.",
    });
  });

  it("SCRUM172_AC6_assigned_reassignment_names_the_previous_coordinator", () => {
    expect(of172("event_request_assigned", HANDOVER)).toEqual({
      headline: "Tech Talk was handed over to you",
      detail: "Assigned by Lena Lead. It was with Cory Coord.",
    });
  });

  it("SCRUM172_AC6_assigned_reassignment_shows_the_handover_note", () => {
    expect(of172("event_request_assigned", { ...HANDOVER, note: "Venue is pencilled in." }).detail)
      .toBe("Assigned by Lena Lead. It was with Cory Coord. Handover note: Venue is pencilled in.");
  });

  it("SCRUM172_AC6_assigned_first_assignment_shows_a_note_when_given", () => {
    expect(of172("event_request_assigned", { ...FIRST, note: "Urgent." }).detail)
      .toBe("Assigned by Lena Lead. Handover note: Urgent.");
  });

  it("SCRUM172_AC6_assigned_missing_lead_name_reads_as_the_lead", () => {
    expect(of172("event_request_assigned", { ...HANDOVER, assignedByName: null, previousCoordinatorName: null }))
      .toEqual({
        headline: "Tech Talk was handed over to you",
        detail: "Assigned by the Lead. It was with the previous coordinator.",
      });
  });
});

describe("describeNotification: event_request_coordinator_assigned (SCRUM-172 AC6)", () => {
  const FIRST = {
    eventRequestId: "e1",
    eventName: "Tech Talk",
    coordinatorId: "u3",
    coordinatorName: "Nia New",
    previousCoordinatorId: null,
    previousCoordinatorName: null,
  };
  const HANDOVER = { ...FIRST, previousCoordinatorId: "u2", previousCoordinatorName: "Cory Coord" };

  it("SCRUM172_AC6_coordinator_assigned_first_assignment_wording", () => {
    expect(of172("event_request_coordinator_assigned", FIRST)).toEqual({
      headline: "Nia New is now coordinating Tech Talk",
      detail: "They will review your request and contact you if anything is needed.",
    });
  });

  it("SCRUM172_AC6_coordinator_assigned_reassignment_names_both_coordinators", () => {
    expect(of172("event_request_coordinator_assigned", HANDOVER)).toEqual({
      headline: "Tech Talk has a new coordinator",
      detail: "Nia New has taken over from Cory Coord.",
    });
  });

  it("SCRUM172_AC6_coordinator_assigned_reassignment_tolerates_missing_names", () => {
    expect(of172("event_request_coordinator_assigned", { previousCoordinatorId: "u2" })).toEqual({
      headline: "Unnamed event has a new coordinator",
      detail: "A coordinator has taken over from the previous coordinator.",
    });
  });

  // The handover note is for the coordinator only (052).
  it.each([
    ["first assignment", FIRST],
    ["reassignment", HANDOVER],
  ])("SCRUM172_AC6_organiser_notice_never_shows_a_handover_note (%s)", (_l, base) => {
    const { headline, detail } = of172("event_request_coordinator_assigned", {
      ...base,
      note: "Organiser is difficult",
    });
    expect(headline).not.toContain("Organiser is difficult");
    expect(detail).not.toContain("Organiser is difficult");
    expect(detail).not.toContain("note");
  });
});

describe("describeNotification: safety_review_response (SCRUM-172 AC6)", () => {
  const response = (outcome, note = null) =>
    of172("safety_review_response", {
      eventName: "Tech Talk",
      outcome,
      note,
      responseId: "r1",
      respondedAt: "2026-10-02T10:00:00+08:00",
    });

  it.each([
    ["approved_without_a_note", "approved", null,
      "Tech Talk passed the safety check", "No changes were needed."],
    ["approved_with_a_note_shows_the_note", "approved", "Keep exits clear.",
      "Tech Talk passed the safety check", "Safety Officer's note: Keep exits clear."],
    ["changes_requested_shows_the_note", "changes_requested", "Add a first-aider.",
      "The safety check asked for changes to Tech Talk", "Safety Officer's note: Add a first-aider."],
    ["rejected_without_a_note_points_to_the_event", "rejected", null,
      "Tech Talk did not pass the safety check", "Open the event for details."],
    ["unknown_outcome_still_says_who_responded", "deferred", null,
      "The Safety Officer responded about Tech Talk", "Open the event for details."],
  ])("SCRUM172_AC6_safety_review_response_%s", (_case, outcome, note, headline, detail) => {
    expect(response(outcome, note)).toEqual({ headline, detail });
  });
});

describe("describeNotification: safety_booking_flagged (SCRUM-172 AC6)", () => {
  it("SCRUM172_AC6_safety_booking_flagged_wording", () => {
    expect(of172("safety_booking_flagged", {
      eventName: "Tech Talk",
      venueName: "Hall A",
      startsAt: PAYLOAD.startsAt,
      endsAt: PAYLOAD.endsAt,
      reason: "changes_requested",
      responseId: "r1",
    })).toEqual({
      headline: "Tech Talk at Hall A needs review after the safety check",
      detail: `Booked ${BOOKED}. The Safety Officer flagged this booking.`,
    });
  });
});

describe("describeNotification: safety_equipment_review (SCRUM-172 AC6)", () => {
  it("SCRUM172_AC6_safety_equipment_review_wording", () => {
    expect(of172("safety_equipment_review", {
      eventName: "Tech Talk",
      equipmentRequestId: "q1",
      responseId: "r1",
    })).toEqual({
      headline: "Equipment for Tech Talk needs review after the safety check",
      detail: "The Safety Officer flagged the equipment arrangements.",
    });
  });
});

// Week 7: a flagged booking tells its coordinator that another plan is needed.
describe("describeNotification: flagged bookings need alternative arrangements (SCRUM-266 Week 7)", () => {
  it.each([
    ["booking_flagged", PAYLOAD],
    ["booking_flagged_setup_change", SETUP_PAYLOAD],
    ["booking_flagged_venue_retired", RETIRED_PAYLOAD],
    ["booking_flagged_hours_change", HOURS_PAYLOAD],
  ])("SCRUM266_W7_%s_says_alternative_arrangements_are_required", (type, payload) => {
    const { detail } = describeNotification({ id: "n1", type, payload });
    expect(detail).toMatch(/\. Alternative arrangements are required\.$/);
  });
});

// SCRUM-174. A block or retirement reaches the coordinator of each affected
// booking or request; the payloads 084 and 085 write.
const UNAVAILABLE_PAYLOAD = {
  ...WITHDRAWN_PAYLOAD,
  cause: "block",
  reason: "maintenance",
  blockStartsAt: PAYLOAD.blockStartsAt,
  blockEndsAt: PAYLOAD.blockEndsAt,
};
const RETIRED_PAYLOAD = { ...WITHDRAWN_PAYLOAD, retiredAt: "2026-09-20T09:00:00+08:00" };
const REQUESTED = `Requested ${formatDateTimeRange(WITHDRAWN_PAYLOAD.startsAt, WITHDRAWN_PAYLOAD.endsAt)}.`;
const STILL_OPEN = "The request is still open; you may want to request another venue.";
const unavailable = (overrides = {}) => describeNotification({
  id: "n13",
  type: "booking_request_venue_unavailable",
  payload: { ...UNAVAILABLE_PAYLOAD, ...overrides },
});

describe("describeNotification: booking_request_venue_unavailable (SCRUM-174 AC5)", () => {
  it("SCRUM174_AC5_block_names_the_reason_and_block_period_and_says_the_request_is_open", () => {
    expect(unavailable()).toEqual({
      headline: "Hall A is unavailable for your request for Tech Talk",
      detail: `${REQUESTED} The venue is blocked for Maintenance, ${BLOCKED}. ${STILL_OPEN}`,
    });
  });

  it("SCRUM174_AC5_block_without_a_reason_reads_as_unspecified", () => {
    expect(unavailable({ reason: null }).detail).toBe(
      `${REQUESTED} The venue is blocked for unspecified reason, ${BLOCKED}. ${STILL_OPEN}`,
    );
  });

  it("SCRUM174_AC5_retired_says_the_venue_was_retired_not_blocked", () => {
    expect(unavailable({ cause: "retired", reason: undefined, blockStartsAt: undefined, blockEndsAt: undefined })).toEqual({
      headline: "Hall A is unavailable for your request for Tech Talk",
      detail: `${REQUESTED} The venue has been retired. ${STILL_OPEN}`,
    });
  });

  it.each([
    ["an unknown cause", { cause: "demolished" }],
    ["a missing cause", { cause: undefined }],
  ])("SCRUM174_AC5_%s_reads_as_the_generic_notification", (_label, overrides) => {
    expect(unavailable(overrides)).toEqual({
      headline: "New notification",
      detail: "This notification type cannot be displayed yet.",
    });
  });
});

describe("describeNotification: booking_flagged_venue_retired (SCRUM-174 AC6)", () => {
  it("SCRUM174_AC6_retired_flag_gives_the_booked_period_and_asks_for_alternatives", () => {
    expect(describeNotification({ id: "n14", type: "booking_flagged_venue_retired", payload: RETIRED_PAYLOAD })).toEqual({
      headline: "Tech Talk at Hall A needs review",
      detail:
        `Booked ${formatDateTimeRange(RETIRED_PAYLOAD.startsAt, RETIRED_PAYLOAD.endsAt)}. ` +
        "The venue has been retired. Alternative arrangements are required.",
    });
  });
});

// SCRUM-266 (AC6). The payload sent when a flagged booking is resolved.
const RESOLVED_PAYLOAD = {
  audience: "coordinator",
  outcome: "reinstated",
  eventRequestId: "e0000000-0000-4000-8000-000000000001",
  eventName: "Tech Talk",
  venueId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  venueName: "Hall A",
  startsAt: "2026-10-01T10:00:00+08:00",
  endsAt: "2026-10-01T12:00:00+08:00",
  reason: "Maintenance finished early",
  resolvedAt: "2026-09-20T09:00:00+08:00",
  resolvedByRole: "venue_staff",
  replacementBookingId: null,
  replacementVenueName: null,
  replacementStartsAt: null,
  replacementEndsAt: null,
};
const REPLACED = {
  outcome: "replaced",
  replacementBookingId: "b0000000-0000-4000-8000-000000000002",
  replacementVenueName: "Hall B",
  replacementStartsAt: "2026-10-01T13:00:00+08:00",
  replacementEndsAt: "2026-10-01T15:00:00+08:00",
};
const resolved = (overrides = {}) => describeNotification({
  id: "n12",
  type: "flagged_booking_resolved",
  payload: { ...RESOLVED_PAYLOAD, ...overrides },
});
const RESOLVED_RANGE = formatDateTimeRange(RESOLVED_PAYLOAD.startsAt, RESOLVED_PAYLOAD.endsAt);
const REPLACED_RANGE = formatDateTimeRange(REPLACED.replacementStartsAt, REPLACED.replacementEndsAt);

describe("describeNotification: flagged_booking_resolved (SCRUM-266 AC6)", () => {
  it.each(["coordinator", "organiser"])("SCRUM266_AC6_reinstated_tells_the_%s_it_is_booked_again", (audience) => {
    expect(resolved({ audience })).toEqual({
      headline: "Hall A for Tech Talk was reinstated",
      detail: `It is booked again for ${RESOLVED_RANGE}. Reason: Maintenance finished early.`,
    });
  });

  it("SCRUM266_AC6_cancelled_tells_the_coordinator_they_can_request_another_venue", () => {
    expect(resolved({ outcome: "cancelled", reason: "Flood damage." })).toEqual({
      headline: "The booking of Hall A for Tech Talk was cancelled",
      detail:
        "It was cancelled by Venue Staff. Reason: Flood damage. " +
        "You can request another venue from the event.",
    });
  });

  it("SCRUM266_AC6_cancelled_gives_the_organiser_nothing_to_do", () => {
    const { detail } = resolved({ audience: "organiser", outcome: "cancelled", reason: "Flood damage" });
    expect(detail).toBe(
      "It was cancelled by Venue Staff. Reason: Flood damage. Your event is not cancelled.",
    );
    expect(detail).not.toContain("You can request");
  });

  it("SCRUM266_AC6_cancelled_by_the_coordinator_says_so_to_the_organiser", () => {
    expect(resolved({
      audience: "organiser",
      outcome: "cancelled",
      resolvedByRole: "event_coordinator",
    }).detail).toBe(
      "It was cancelled by the event's coordinator. Reason: Maintenance finished early. " +
        "Your event is not cancelled.",
    );
  });

  it.each([
    ["unknown", "lead"],
    ["missing", undefined],
    ["prototype key", "toString"],
  ])("SCRUM266_AC6_cancelled_by_an_%s_role_names_no_one", (_label, resolvedByRole) => {
    expect(resolved({ outcome: "cancelled", resolvedByRole }).detail).toBe(
      "It was cancelled. Reason: Maintenance finished early. You can request another venue from the event.",
    );
  });

  it.each(["coordinator", "organiser"])("SCRUM266_W7_replaced_tells_the_%s_the_new_venue_and_time", (audience) => {
    expect(resolved({ audience, ...REPLACED })).toEqual({
      headline: "Hall A for Tech Talk was replaced by Hall B",
      detail: `Hall B is booked for ${REPLACED_RANGE}. Reason: Maintenance finished early.`,
    });
  });

  it("SCRUM266_W7_replaced_without_replacement_details_reads_as_unknown", () => {
    expect(resolved({ outcome: "replaced" })).toEqual({
      headline: "Hall A for Tech Talk was replaced by Unknown venue",
      detail: "Unknown venue is booked for unknown – unknown. Reason: Maintenance finished early.",
    });
  });

  it.each([
    ["reinstated", {
      headline: "Unknown venue for Unnamed event was reinstated",
      detail: "It is booked again for unknown – unknown. Reason: No reason recorded.",
    }],
    ["cancelled", {
      headline: "The booking of Unknown venue for Unnamed event was cancelled",
      detail: "It was cancelled. Reason: No reason recorded. You can request another venue from the event.",
    }],
  ])("SCRUM266_AC6_%s_tolerates_missing_fields", (outcome, expected) => {
    const result = describeNotification({
      id: "n12",
      type: "flagged_booking_resolved",
      payload: { audience: "coordinator", outcome },
    });
    expect(result).toEqual(expected);
    expect(`${result.headline} ${result.detail}`).not.toContain("undefined");
  });

  it.each([
    ["an unknown outcome", { outcome: "deleted" }],
    ["a missing outcome", { outcome: undefined }],
    ["an unknown audience", { audience: "venue_staff" }],
    ["a missing audience", { audience: undefined }],
  ])("SCRUM266_AC6_%s_reads_as_the_generic_notification", (_label, overrides) => {
    expect(resolved(overrides)).toEqual({
      headline: "New notification",
      detail: "This notification type cannot be displayed yet.",
    });
  });
});

// A notification outlives the build that wrote it, so a missing name or a
// missing payload must still read as words. Each row keeps the title of the
// test it replaced.
const NAMELESS = [
  ["missing", undefined],
  ["null", null],
  ["empty", ""],
];
const nameless = (payload, value) => ({ ...payload, eventName: value, venueName: value });

const FALLBACKS = [
  ...NAMELESS.map(([label, value]) => [
    `falls back for a ${label} event and venue name`,
    "booking_flagged",
    nameless(PAYLOAD, value),
    {
      headline: "Unnamed event at Unknown venue needs review",
      detail: `Booked ${BOOKED}. The venue is blocked for Maintenance, ${BLOCKED}. Alternative arrangements are required.`,
    },
  ]),
  ...[["null", null], ["undefined", undefined]].map(([label, payload]) => [
    `survives a ${label} payload`,
    "booking_flagged",
    payload,
    {
      headline: "Unnamed event at Unknown venue needs review",
      detail: "Booked unknown – unknown. The venue is blocked for unspecified reason, unknown – unknown. Alternative arrangements are required.",
    },
  ]),
  ...NAMELESS.map(([label, value]) => [
    `SCRUM484_AC8_falls_back_for_a_${label}_event_and_venue_name`,
    "booking_flagged_setup_change",
    nameless(SETUP_PAYLOAD, value),
    {
      headline: "Unnamed event at Unknown venue needs review",
      detail: `Setup or turnaround time changed. It now occupies ${formatOccupiedPeriod(SETUP_PAYLOAD, formatDateTimeRange)}. Alternative arrangements are required.`,
    },
  ]),
  ...[["null", null], ["undefined", undefined]].map(([label, payload]) => [
    `SCRUM484_AC8_survives_a_${label}_payload`,
    "booking_flagged_setup_change",
    payload,
    { headline: "Unnamed event at Unknown venue needs review", detail: "Setup or turnaround time changed. Alternative arrangements are required." },
  ]),
  ...NAMELESS.map(([label, value]) => [
    `SCRUM484_withdrawn_falls_back_for_a_${label}_event_and_venue_name`,
    "booking_request_withdrawn",
    nameless(WITHDRAWN_PAYLOAD, value),
    {
      headline: "The request for Unnamed event at Unknown venue was withdrawn",
      detail:
        `It was for ${formatDateTimeRange(WITHDRAWN_PAYLOAD.startsAt, WITHDRAWN_PAYLOAD.endsAt)}. ` +
        "It no longer needs a decision.",
    },
  ]),
  ...NO_PAYLOAD.map(([label, payload]) => [
    `SCRUM484_withdrawn_tolerates_${label}_payload`,
    "booking_request_withdrawn",
    payload,
    {
      headline: "The request for Unnamed event at Unknown venue was withdrawn",
      detail: "It was for unknown – unknown. It no longer needs a decision.",
    },
  ]),
  ...[
    ["booking_request_approved", {
      headline: "Unknown venue was approved for Unnamed event",
      detail: "It is booked for unknown – unknown.",
    }],
    ["booking_request_rejected", {
      headline: "The request for Unknown venue for Unnamed event was rejected",
      detail: "Reason: No reason recorded",
    }],
    ["booking_request_conflicting", {
      headline: "Your request for Unknown venue for Unnamed event now clashes with another event",
      detail:
        "another event was approved for unknown – unknown. " +
        "Your request is still open; you can withdraw it or wait for Venue Staff.",
    }],
  ].map(([type, expected]) => [`SCRUM258_AC6_${type}_tolerates_an_empty_payload`, type, null, expected]),
  ...NO_PAYLOAD.map(([label, payload]) => [
    `SCRUM174_AC6_venue_retired_flag_tolerates_${label}_payload`,
    "booking_flagged_venue_retired",
    payload,
    {
      headline: "Unnamed event at Unknown venue needs review",
      detail: "Booked unknown – unknown. The venue has been retired. Alternative arrangements are required.",
    },
  ]),
  ...NAMELESS.map(([label, value]) => [
    `SCRUM174_AC5_venue_unavailable_falls_back_for_a_${label}_event_and_venue_name`,
    "booking_request_venue_unavailable",
    { cause: "retired", eventName: value, venueName: value },
    {
      headline: "Unknown venue is unavailable for your request for Unnamed event",
      detail: `Requested unknown – unknown. The venue has been retired. ${STILL_OPEN}`,
    },
  ]),
  ...[
    ["awaiting_assignment", "event_request_awaiting_assignment", {
      headline: "Unnamed event is waiting for a coordinator",
      detail: "Assign it from the unassigned queue.",
    }],
    ["assigned", "event_request_assigned", {
      headline: "Unnamed event was assigned to you",
      detail: "Assigned by the Lead.",
    }],
    ["coordinator_assigned", "event_request_coordinator_assigned", {
      headline: "A coordinator is now coordinating Unnamed event",
      detail: "They will review your request and contact you if anything is needed.",
    }],
    ["safety_review_response", "safety_review_response", {
      headline: "The Safety Officer responded about Unnamed event",
      detail: "Open the event for details.",
    }],
    ["safety_booking_flagged", "safety_booking_flagged", {
      headline: "Unnamed event at Unknown venue needs review after the safety check",
      detail: "Booked unknown – unknown. The Safety Officer flagged this booking.",
    }],
    ["safety_equipment_review", "safety_equipment_review", {
      headline: "Equipment for Unnamed event needs review after the safety check",
      detail: "The Safety Officer flagged the equipment arrangements.",
    }],
  ].flatMap(([name, type, expected]) =>
    NO_PAYLOAD.map(([label, payload]) => [
      `SCRUM172_AC6_${name}_tolerates_missing_fields (${label} payload)`,
      type,
      payload,
      expected,
    ]),
  ),
];

describe("describeNotification: registration_schedule_conflict (SCRUM-494 AC7)", () => {
  const NEW_START = "2030-01-01T09:00:00.000Z";

  it("SCRUM494_AC7_names_the_event_and_every_clashing_registration_date_in_words", () => {
    const described = describeNotification({
      id: "n1",
      type: "registration_schedule_conflict",
      payload: {
        eventName: "Industry Night",
        newStart: NEW_START,
        fields: ["registrationClosesAt", "registrationWithdrawalDeadline"],
      },
    });

    expect(described).toEqual({
      headline: "Registration dates for Industry Night need updating",
      detail: `The new start (${formatDateTime(NEW_START)}) is earlier than the closing time and withdrawal deadline.`,
    });
    expect(described.detail).not.toMatch(/registration[A-Z]/);
  });

  it("SCRUM494_AC7_lists_three_clashing_dates_and_skips_unknown_field_keys", () => {
    const { detail } = describeNotification({
      id: "n1",
      type: "registration_schedule_conflict",
      payload: {
        eventName: "Industry Night",
        newStart: NEW_START,
        fields: ["registrationOpensAt", "somethingNew", "registrationClosesAt", "registrationWithdrawalDeadline"],
      },
    });

    expect(detail).toBe(
      `The new start (${formatDateTime(NEW_START)}) is earlier than the opening time, closing time and withdrawal deadline.`,
    );
  });

  it("SCRUM494_AC7_still_reads_as_a_clash_when_the_payload_is_missing_its_fields", () => {
    expect(describeNotification({ id: "n1", type: "registration_schedule_conflict", payload: {} })).toEqual({
      headline: "Registration dates for Unnamed event need updating",
      detail: "The new start clashes with the registration dates.",
    });
  });
});

describe("describeNotification: missing names and payloads", () => {
  it.each(FALLBACKS)("%s", (_title, type, payload, expected) => {
    expect(describeNotification({ id: "n1", type, payload })).toEqual(expected);
  });
});

// The types the backend can send: the latest file that restates
// notifications_type_known (the baseline, or a migration from 010 on), plus any
// a later migration widens it by. A type there with no wording here would show
// as "New notification".
const DB = resolve(dirname(fileURLToPath(import.meta.url)), "../../../backend/db");
const TYPE_LIST =
  /notifications_type_known\s+check\s*\(\s*type\s*(?:=\s*any\s*\(\s*array\s*\[([^\]]*)\]|in\s*\(([^)]*)\))/;
// A widen reads the live list back and adds the types it lacks (042's idiom).
const WIDENED_TYPES = /unnest\(array\[([^\]]*)\]\)\s+as\s+t\s+where\s+not\s+\(t\s*=\s*any\s*\(v_types\)\)/;
const quoted = (text) => [...text.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

function knownNotificationTypes() {
  const later = readdirSync(join(DB, "migrations"))
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort()
    .map((name) => join(DB, "migrations", name));
  let known = [];
  for (const file of [join(DB, "baseline", "05_notifications.sql"), ...later]) {
    const source = readFileSync(file, "utf8");
    const list = source.match(TYPE_LIST);
    if (list) known = quoted(list[1] ?? list[2]);
    const widened = source.match(WIDENED_TYPES);
    if (widened) known = [...new Set([...known, ...quoted(widened[1])])];
  }
  return known;
}

const FIXTURES = {
  booking_flagged: PAYLOAD,
  booking_flagged_event_change: {
    eventName: "Tech Talk",
    venueName: "Hall A",
    startsAt: PAYLOAD.startsAt,
    endsAt: PAYLOAD.endsAt,
    reason: "Updated schedule",
  },
  booking_request_withdrawn: WITHDRAWN_PAYLOAD,
  booking_request_submitted: WITHDRAWN_PAYLOAD,
  clarification_requested: { eventName: "Tech Talk", message: "Please confirm." },
  clarification_replied: { eventName: "Tech Talk", message: "Confirmed." },
  clarification_closed: { eventName: "Tech Talk" },
  booking_flagged_setup_change: SETUP_PAYLOAD,
  booking_flagged_hours_change: HOURS_PAYLOAD,
  venue_hold_expired: { eventName: "Tech Talk", venueName: "Hall A", expiresAt: PAYLOAD.startsAt },
  event_cancelled: { audience: "organiser", eventName: "Tech Talk", reason: "Venue unavailable" },
  // SCRUM-347 (024).
  event_rejected: { audience: "organiser", eventName: "Tech Talk", reason: "No hall is free" },
  event_request_awaiting_assignment: { eventName: "Tech Talk", submittedAt: PAYLOAD.startsAt },
  event_request_assigned: { eventName: "Tech Talk", assignedByName: "Lena Lead" },
  event_request_coordinator_assigned: { eventName: "Tech Talk", coordinatorName: "Nia New" },
  safety_review_response: { eventName: "Tech Talk", outcome: "approved" },
  safety_booking_flagged: { eventName: "Tech Talk", venueName: "Hall A", startsAt: PAYLOAD.startsAt, endsAt: PAYLOAD.endsAt },
  safety_equipment_review: { eventName: "Tech Talk" },
  booking_request_event_change: {
    eventName: "Tech Talk",
    venueName: "Hall A",
    startsAt: PAYLOAD.startsAt,
    endsAt: PAYLOAD.endsAt,
    newStartsAt: PAYLOAD.startsAt,
    newEndsAt: PAYLOAD.endsAt,
    reason: "Updated schedule",
  },
  event_significant_change: { eventName: "Tech Talk", reason: "Updated schedule" },
  event_details_changed: { eventName: "Tech Talk", reason: "Typo in the name", changedFields: ["eventName"] },
  event_significant_change_attendee: {
    eventName: "Tech Talk",
    startsAt: PAYLOAD.startsAt,
    endsAt: PAYLOAD.endsAt,
    reason: "Updated schedule",
  },
  event_submitted_for_safety_review: { eventName: "Tech Talk", coordinatorName: "Nia New", startsAt: PAYLOAD.startsAt },
  booking_request_approved: { eventName: "Tech Talk", venueName: "Hall A", startsAt: PAYLOAD.startsAt, endsAt: PAYLOAD.endsAt },
  booking_request_rejected: { eventName: "Tech Talk", venueName: "Hall A", reason: "Under renovation" },
  booking_request_conflicting: { eventName: "Tech Talk", venueName: "Hall A", approvedEventName: "Gala Dinner" },
  flagged_booking_resolved: RESOLVED_PAYLOAD,
  booking_request_venue_unavailable: UNAVAILABLE_PAYLOAD,
  booking_flagged_venue_retired: RETIRED_PAYLOAD,
  // SCRUM-492 (089).
  booking_released: { eventName: "Tech Talk", venueName: "Hall A", releasedByName: "Priya Nair", reason: "Moved" },
  booking_request_conflict_cleared: { eventName: "Tech Talk", venueName: "Hall A", releasedEventName: "Gala Dinner" },
  // SCRUM-176 (097).
  equipment_requested: { eventName: "Tech Talk", lines: [] },
  equipment_request_changed: { eventName: "Tech Talk", lines: [] },
  equipment_request_cancelled: { eventName: "Tech Talk", reason: "Removed" },
  equipment_arranged: { eventName: "Tech Talk", lines: [] },
  equipment_not_fully_arranged: { eventName: "Tech Talk", lines: [] },
  equipment_flagged: { eventName: "Tech Talk", reason: "Retired" },
  // SCRUM-494 (091).
  registration_schedule_conflict: { eventName: "Tech Talk", fields: ["registrationClosesAt"] },
  // SCRUM-173 (032).
  event_request_approved: { eventName: "Tech Talk" },
  event_request_rejected: { eventName: "Tech Talk", reason: "Too large" },
  venue_hold_placed: { eventName: "Tech Talk", venueName: "Hall A", expiresAt: PAYLOAD.startsAt },
  venue_hold_expiring: { eventName: "Tech Talk", venueName: "Hall A", expiresAt: PAYLOAD.startsAt },
  // SCRUM-460 (037).
  registration_promoted: { eventName: "Tech Talk" },
  // SCRUM-175 (042).
  event_confirmed: { audience: "organiser", eventName: "Tech Talk", reconfirmed: false, venues: [] },
  event_venue_changed: { audience: "attendee", eventName: "Tech Talk", previousVenueName: "Hall A", venueName: "Hall B" },
};

describe("describeNotification: event_rejected (SCRUM-347)", () => {
  const d = (payload) => describeNotification({ id: "n30", type: "event_rejected", payload });

  it("SCRUM347_AC7_tells_the_organiser_the_reason_and_that_they_can_resubmit", () => {
    expect(d({ audience: "organiser", eventName: "Tech Talk", reason: "No hall is free", rejectedAt: null })).toEqual({
      headline: "Tech Talk was rejected",
      detail: "Reason: No hall is free. You can revise and resubmit it.",
    });
  });

  it("SCRUM347_AC7_dates_the_rejection_and_falls_back_when_no_reason_is_given", () => {
    const { detail } = d({ audience: "organiser", eventName: "Tech Talk", rejectedAt: PAYLOAD.startsAt });
    expect(detail).toMatch(/^Reason: No reason recorded\. Rejected .+\. You can revise and resubmit it\.$/);
  });

  it("SCRUM347_AC7_tells_venue_staff_which_venue_was_released", () => {
    const { headline, detail } = d({
      audience: "venue_staff", eventName: "Tech Talk", venueName: "Hall A", startsAt: PAYLOAD.startsAt, endsAt: PAYLOAD.endsAt,
    });
    expect(headline).toBe("Hall A was released for Tech Talk");
    expect(detail).toContain("The event was rejected");
  });

  it("SCRUM347_AC7_tells_venue_staff_a_withdrawn_request_was_withdrawn_not_released", () => {
    const { headline, detail } = d({
      audience: "venue_staff", outcome: "withdrawn", eventName: "Tech Talk", venueName: "Hall A",
      startsAt: PAYLOAD.startsAt, endsAt: PAYLOAD.endsAt,
    });
    expect(headline).toBe("The request for Hall A for Tech Talk was withdrawn");
    expect(detail).toContain("no longer needs a decision");
  });

  it("SCRUM347_AC7_tells_technical_support_the_equipment_request_was_cancelled", () => {
    expect(d({ audience: "technical_support_staff", eventName: "Tech Talk" }).headline)
      .toBe("The equipment request for Tech Talk was cancelled");
  });

  it("SCRUM347_AC7_an_unknown_audience_reads_as_the_generic_notification", () => {
    expect(d({ audience: "unknown" }).headline).toBe("New notification");
  });
});

describe("describeNotification: every type the backend sends (SCRUM-172 AC6)", () => {
  it("SCRUM172_AC6_every_known_type_has_wording", () => {
    const known = knownNotificationTypes();
    expect(known.length).toBeGreaterThanOrEqual(18);
    expect(Object.keys(FIXTURES).sort()).toEqual([...known].sort());

    const generic = known.filter(
      (type) => describeNotification({ id: "n11", type, payload: FIXTURES[type] }).headline === "New notification",
    );
    expect(generic).toEqual([]);
  });
});

describe("describeNotification: fallbacks for sparse payloads", () => {
  const d = (type, payload) => describeNotification({ id: "n20", type, payload });

  it("SCRUM395_AC9_booking_released_falls_back_to_the_coordinator_and_no_reason", () => {
    const out = d("booking_released", {});
    expect(out.detail).toContain("released by the event's coordinator");
  });

  it("SCRUM395_AC9_conflict_cleared_names_another_event_when_none_is_given", () => {
    expect(d("booking_request_conflict_cleared", {}).detail).toContain("Another event");
  });

  it("SCRUM395_AC9_safety_submission_defaults_the_coordinator_and_omits_a_bad_start", () => {
    const out = d("event_submitted_for_safety_review", {});
    expect(out.detail).toContain("its coordinator");
    expect(out.detail).not.toContain("It starts");
  });

  it("SCRUM395_AC9_significant_change_types_fall_back_when_fields_are_missing", () => {
    expect(d("event_significant_change", {}).detail).toContain("Reason:");
    expect(d("event_significant_change_attendee", { startsAt: PAYLOAD.startsAt }).detail).toBe("Check the event for its latest details.");
    expect(d("event_significant_change_attendee", { reason: "Moved", startsAt: PAYLOAD.startsAt, endsAt: PAYLOAD.endsAt }).detail)
      .toContain("now runs");
    expect(d("booking_flagged_event_change", {}).detail).toContain("Coordinator's reason:");
    expect(d("booking_flagged_event_change", { reason: "Moved" }).detail).toContain("Moved");
  });

  it("SCRUM395_AC9_pending_request_notice_falls_back_when_fields_are_missing", () => {
    const { headline, detail } = d("booking_request_event_change", {});
    expect(headline).toBe("Unnamed event moved; a pending request is for the old time");
    expect(detail).toContain("The request for Unknown venue");
    expect(detail).toContain("Coordinator's reason: No reason recorded.");
    expect(`${headline} ${detail}`).not.toContain("undefined");
  });
});

describe("describeNotification: registration_promoted (SCRUM-460 AC5)", () => {
  it("SCRUM460_AC5_tells_the_attendee_they_now_have_a_place", () => {
    expect(describeNotification({ id: "n1", type: "registration_promoted", payload: { eventName: "Tech Talk" } }))
      .toMatchObject({
        headline: "You have a place at Tech Talk",
        detail: "A place opened and you were first on the waiting list, so you are now registered.",
      });
  });
});
