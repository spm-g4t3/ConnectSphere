// notificationDisplay.test.js
//
// SCRUM-128 (part of SCRUM-17, AC3). The wording of a notification on the
// Coordinator dashboard. Timezone-safe: every expected time is built here
// with the same formatRange the module uses, from fixtures that carry +08:00
// offsets, so the suite passes in any zone and locale.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { describeNotification } from "../../src/services/notificationDisplay.js";
import { formatRange, formatTimestamp } from "../../src/services/displayFormat.js";
import { formatOccupiedPeriod } from "../../src/services/occupiedPeriodDisplay.js";

const PAYLOAD = {
  venueName: "Hall A",
  eventName: "Tech Talk",
  startsAt: "2026-10-01T10:00:00+08:00",
  endsAt: "2026-10-01T12:00:00+08:00",
  reason: "maintenance",
  blockStartsAt: "2026-10-01T09:00:00+08:00",
  blockEndsAt: "2026-10-01T17:00:00+08:00",
};

function flagged(payload = PAYLOAD) {
  return { id: "n1", type: "booking_flagged", payload };
}

const BOOKED = formatRange(PAYLOAD.startsAt, PAYLOAD.endsAt);
const BLOCKED = formatRange(PAYLOAD.blockStartsAt, PAYLOAD.blockEndsAt);

describe("describeNotification: booking_flagged", () => {
  it("SCRUM17_AC3_names_the_event_and_venue_in_the_headline", () => {
    expect(describeNotification(flagged()).headline).toBe("Tech Talk at Hall A needs review");
  });

  it("SCRUM17_AC3_detail_gives_booking_times_reason_label_and_block_times", () => {
    expect(describeNotification(flagged()).detail).toBe(
      `Booked ${BOOKED}. The venue is blocked for Maintenance, ${BLOCKED}.`,
    );
  });

  it("formats the times in the reader's locale", () => {
    const { detail } = describeNotification(flagged());
    expect(detail).toContain(new Date(PAYLOAD.startsAt).toLocaleString());
    expect(detail).toContain(new Date(PAYLOAD.blockEndsAt).toLocaleString());
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

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
  ])("falls back for a %s event and venue name", (_label, value) => {
    const { headline } = describeNotification(
      flagged({ ...PAYLOAD, eventName: value, venueName: value }),
    );
    expect(headline).toBe("Unnamed event at Unknown venue needs review");
  });

  it("reads missing times as unknown, never undefined", () => {
    const { detail } = describeNotification(flagged({ eventName: "X", venueName: "Y" }));
    expect(detail).toBe(
      "Booked unknown – unknown. The venue is blocked for unspecified reason, unknown – unknown.",
    );
    expect(detail).not.toContain("undefined");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("survives a %s payload", (_label, payload) => {
    const result = describeNotification({ id: "n1", type: "booking_flagged", payload });
    expect(result.headline).toBe("Unnamed event at Unknown venue needs review");
    expect(result.detail).not.toContain("undefined");
  });

  it("shows an unparseable time as the raw string", () => {
    const { detail } = describeNotification(flagged({ ...PAYLOAD, startsAt: "soon" }));
    expect(detail).toContain("Booked soon – ");
  });
});

// SCRUM-484 (AC8). The payload 034 writes when a setup or turnaround change
// flags a booking (B-AC8-21's shape).
const SETUP_PAYLOAD = {
  venueName: "Harbour Room",
  eventName: "Orientation",
  startsAt: "2026-11-02T10:00:00+08:00",
  endsAt: "2026-11-02T12:00:00+08:00",
  occupiedStartsAt: "2026-11-02T09:30:00+08:00",
  occupiedEndsAt: "2026-11-02T12:15:00+08:00",
  setupMinutes: 30,
  turnaroundMinutes: 15,
  reason: "The venue's setup or turnaround time changed.",
};

function setupChange(payload = SETUP_PAYLOAD) {
  return { id: "n6", type: "booking_flagged_setup_change", payload };
}

describe("describeNotification: booking_flagged_setup_change (SCRUM-484 AC8)", () => {
  it("SCRUM484_AC8_setup_change_notification_wording", () => {
    const { headline, detail } = describeNotification(setupChange());

    expect(headline).toBe("Orientation at Harbour Room needs review");
    expect(detail).toBe(
      `Setup or turnaround time changed. It now occupies ${formatOccupiedPeriod(SETUP_PAYLOAD)}.`,
    );
    // The parts, each from the same instants.
    expect(detail).toContain(
      `Setup ${formatRange(SETUP_PAYLOAD.occupiedStartsAt, SETUP_PAYLOAD.startsAt)}`,
    );
    expect(detail).toContain(`Event ${formatRange(SETUP_PAYLOAD.startsAt, SETUP_PAYLOAD.endsAt)}`);
    expect(detail).toContain(
      `Turnaround ${formatRange(SETUP_PAYLOAD.endsAt, SETUP_PAYLOAD.occupiedEndsAt)}`,
    );
    expect(headline).not.toBe("New notification");
  });

  it("SCRUM484_AC8_setup_change_detail_does_not_repeat_the_backend_reason", () => {
    expect(describeNotification(setupChange()).detail).not.toContain(SETUP_PAYLOAD.reason);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
  ])("SCRUM484_AC8_falls_back_for_a_%s_event_and_venue_name", (_label, value) => {
    const { headline } = describeNotification(
      setupChange({ ...SETUP_PAYLOAD, eventName: value, venueName: value }),
    );
    expect(headline).toBe("Unnamed event at Unknown venue needs review");
  });

  it("SCRUM484_AC8_setup_change_notification_tolerates_missing_fields", () => {
    const { headline, detail } = describeNotification(setupChange({}));
    expect(headline).toBe("Unnamed event at Unknown venue needs review");
    // Nothing usable: no time sentence at all, rather than "unknown – unknown".
    expect(detail).toBe("Setup or turnaround time changed.");
    expect(detail).not.toContain("unknown");
    expect(`${headline} ${detail}`).not.toContain("undefined");
  });

  it("SCRUM484_AC8_occupied_times_only_name_the_occupied_range", () => {
    const { detail } = describeNotification(
      setupChange({ ...SETUP_PAYLOAD, startsAt: undefined, endsAt: undefined }),
    );
    expect(detail).toBe(
      `Setup or turnaround time changed. It now occupies ${formatRange(SETUP_PAYLOAD.occupiedStartsAt, SETUP_PAYLOAD.occupiedEndsAt)}.`,
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
    expect(detail).toBe("Setup or turnaround time changed.");
    expect(detail).not.toContain("Invalid Date");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("SCRUM484_AC8_survives_a_%s_payload", (_label, payload) => {
    const result = describeNotification({ id: "n6", type: "booking_flagged_setup_change", payload });
    expect(result.headline).toBe("Unnamed event at Unknown venue needs review");
    expect(result.detail).not.toContain("undefined");
  });

  it.each([
    ["missing occupied fields", { occupiedStartsAt: undefined, occupiedEndsAt: undefined }],
    ["null occupied fields", { occupiedStartsAt: null, occupiedEndsAt: null }],
    ["unparseable occupied fields", { occupiedStartsAt: "soon", occupiedEndsAt: "later" }],
  ])("SCRUM484_AC8_%s_fall_back_to_the_plain_range", (_label, overrides) => {
    const { detail } = describeNotification(setupChange({ ...SETUP_PAYLOAD, ...overrides }));
    expect(detail).toBe(
      `Setup or turnaround time changed. It now occupies ${formatRange(SETUP_PAYLOAD.startsAt, SETUP_PAYLOAD.endsAt)}.`,
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
        `It was for ${formatRange(WITHDRAWN_PAYLOAD.startsAt, WITHDRAWN_PAYLOAD.endsAt)}. ` +
        "It no longer needs a decision.",
    });
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
  ])("SCRUM484_withdrawn_falls_back_for_a_%s_event_and_venue_name", (_label, value) => {
    const { headline } = describeNotification(
      withdrawn({ ...WITHDRAWN_PAYLOAD, eventName: value, venueName: value }),
    );
    expect(headline).toBe("The request for Unnamed event at Unknown venue was withdrawn");
  });

  it.each([
    ["an empty", {}],
    ["a null", null],
    ["an undefined", undefined],
  ])("SCRUM484_withdrawn_tolerates_%s_payload", (_label, payload) => {
    const { headline, detail } = describeNotification({
      id: "n7",
      type: "booking_request_withdrawn",
      payload,
    });
    expect(headline).toBe("The request for Unnamed event at Unknown venue was withdrawn");
    expect(detail).toBe("It was for unknown – unknown. It no longer needs a decision.");
    expect(`${headline} ${detail}`).not.toContain("undefined");
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
      `Reason: Venue unavailable. Cancelled ${formatTimestamp("2026-10-01T10:00:00+08:00")}.`,
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
    expect(detail).toContain(`It expired ${formatTimestamp(EXPIRES)}.`);
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
      detail: `It is booked for ${formatRange(DECISION.startsAt, DECISION.endsAt)}.`,
    });
  });

  it("SCRUM258_AC6_rejected_gives_the_reason_and_the_suggested_alternative", () => {
    const { headline, detail } = of("booking_request_rejected", {
      ...DECISION,
      reason: "Under renovation",
      suggestedAlternative: "Hall B",
    });
    expect(headline).toBe("The request for Hall A for Tech Talk was rejected");
    expect(detail).toMatch(/^Reason: Under renovation\b/);
    expect(detail).toContain("Suggested alternative: Hall B");
  });

  it("SCRUM258_AC6_rejected_ends_the_reason_with_a_full_stop_before_the_alternative", () => {
    const { detail } = of("booking_request_rejected", {
      ...DECISION,
      reason: "Under renovation",
      suggestedAlternative: "Hall B",
    });
    expect(detail).toBe("Reason: Under renovation. Suggested alternative: Hall B");
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

  it("SCRUM258_AC3_conflicting_names_the_approved_event_and_says_the_request_is_still_open", () => {
    const { headline, detail } = of("booking_request_conflicting", {
      ...DECISION,
      approvedEventName: "Gala Dinner",
      approvedStartsAt: "2026-10-01T11:00:00+08:00",
      approvedEndsAt: "2026-10-01T14:00:00+08:00",
    });
    expect(headline).toBe("Your request for Hall A for Tech Talk now clashes with Gala Dinner");
    expect(detail).toContain(
      `Gala Dinner was approved for ${formatRange("2026-10-01T11:00:00+08:00", "2026-10-01T14:00:00+08:00")}.`,
    );
    expect(detail).toMatch(/still open/);
  });

  it.each(["booking_request_approved", "booking_request_rejected", "booking_request_conflicting"])(
    "SCRUM258_AC6_%s_tolerates_an_empty_payload",
    (type) => {
      const { headline, detail } = of(type, null);
      expect(`${headline} ${detail}`).not.toContain("undefined");
      expect(headline).toMatch(/Unknown venue/);
    },
  );
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
      detail: `Submitted ${formatTimestamp(SUBMITTED)}. Assign it from the unassigned queue.`,
    });
  });

  it("SCRUM172_AC6_awaiting_assignment_unparseable_time_drops_the_sentence", () => {
    expect(of172("event_request_awaiting_assignment", {
      eventName: "Tech Talk",
      submittedAt: "soon",
    }).detail).toBe("Assign it from the unassigned queue.");
  });

  it.each(NO_PAYLOAD)("SCRUM172_AC6_awaiting_assignment_tolerates_missing_fields (%s payload)", (_l, payload) => {
    expect(of172("event_request_awaiting_assignment", payload)).toEqual({
      headline: "Unnamed event is waiting for a coordinator",
      detail: "Assign it from the unassigned queue.",
    });
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

  it.each(NO_PAYLOAD)("SCRUM172_AC6_assigned_tolerates_missing_fields (%s payload)", (_l, payload) => {
    expect(of172("event_request_assigned", payload)).toEqual({
      headline: "Unnamed event was assigned to you",
      detail: "Assigned by the Lead.",
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

  it.each(NO_PAYLOAD)("SCRUM172_AC6_coordinator_assigned_tolerates_missing_fields (%s payload)", (_l, payload) => {
    expect(of172("event_request_coordinator_assigned", payload)).toEqual({
      headline: "A coordinator is now coordinating Unnamed event",
      detail: "They will review your request and contact you if anything is needed.",
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

  it("SCRUM172_AC6_safety_review_response_approved_without_a_note", () => {
    expect(response("approved")).toEqual({
      headline: "Tech Talk passed the safety check",
      detail: "No changes were needed.",
    });
  });

  it("SCRUM172_AC6_safety_review_response_approved_with_a_note_shows_the_note", () => {
    expect(response("approved", "Keep exits clear.")).toEqual({
      headline: "Tech Talk passed the safety check",
      detail: "Safety Officer's note: Keep exits clear.",
    });
  });

  it("SCRUM172_AC6_safety_review_response_changes_requested_shows_the_note", () => {
    expect(response("changes_requested", "Add a first-aider.")).toEqual({
      headline: "The safety check asked for changes to Tech Talk",
      detail: "Safety Officer's note: Add a first-aider.",
    });
  });

  it("SCRUM172_AC6_safety_review_response_rejected_without_a_note_points_to_the_event", () => {
    expect(response("rejected")).toEqual({
      headline: "Tech Talk did not pass the safety check",
      detail: "Open the event for details.",
    });
  });

  it("SCRUM172_AC6_safety_review_response_unknown_outcome_still_says_who_responded", () => {
    expect(response("deferred")).toEqual({
      headline: "The Safety Officer responded about Tech Talk",
      detail: "Open the event for details.",
    });
  });

  it.each(NO_PAYLOAD)("SCRUM172_AC6_safety_review_response_tolerates_missing_fields (%s payload)", (_l, payload) => {
    expect(of172("safety_review_response", payload)).toEqual({
      headline: "The Safety Officer responded about Unnamed event",
      detail: "Open the event for details.",
    });
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

  it.each(NO_PAYLOAD)("SCRUM172_AC6_safety_booking_flagged_tolerates_missing_fields (%s payload)", (_l, payload) => {
    expect(of172("safety_booking_flagged", payload)).toEqual({
      headline: "Unnamed event at Unknown venue needs review after the safety check",
      detail: "Booked unknown – unknown. The Safety Officer flagged this booking.",
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

  it.each(NO_PAYLOAD)("SCRUM172_AC6_safety_equipment_review_tolerates_missing_fields (%s payload)", (_l, payload) => {
    expect(of172("safety_equipment_review", payload)).toEqual({
      headline: "Equipment for Unnamed event needs review after the safety check",
      detail: "The Safety Officer flagged the equipment arrangements.",
    });
  });
});

// The latest migration that restates notifications_type_known is the list of
// types the backend can send; a type there with no wording here would show
// as "New notification".
const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), "../../../backend/db/migrations");
const TYPE_LIST = /v_ours\s+text\[\]\s*:=\s*array\[([^\]]*)\]/;

function knownNotificationTypes() {
  const latest = readdirSync(MIGRATIONS)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
    .map((name) => readFileSync(join(MIGRATIONS, name), "utf8"))
    .filter((sql) => TYPE_LIST.test(sql))
    .pop();
  return [...latest.match(TYPE_LIST)[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

const FIXTURES = {
  booking_flagged: PAYLOAD,
  booking_request_withdrawn: WITHDRAWN_PAYLOAD,
  clarification_requested: { eventName: "Tech Talk", message: "Please confirm." },
  clarification_replied: { eventName: "Tech Talk", message: "Confirmed." },
  clarification_closed: { eventName: "Tech Talk" },
  booking_flagged_setup_change: SETUP_PAYLOAD,
  venue_hold_expired: { eventName: "Tech Talk", venueName: "Hall A", expiresAt: PAYLOAD.startsAt },
  event_cancelled: { audience: "organiser", eventName: "Tech Talk", reason: "Venue unavailable" },
  event_request_awaiting_assignment: { eventName: "Tech Talk", submittedAt: PAYLOAD.startsAt },
  event_request_assigned: { eventName: "Tech Talk", assignedByName: "Lena Lead" },
  event_request_coordinator_assigned: { eventName: "Tech Talk", coordinatorName: "Nia New" },
  safety_review_response: { eventName: "Tech Talk", outcome: "approved" },
  safety_booking_flagged: { eventName: "Tech Talk", venueName: "Hall A", startsAt: PAYLOAD.startsAt, endsAt: PAYLOAD.endsAt },
  safety_equipment_review: { eventName: "Tech Talk" },
  event_submitted_for_safety_review: { eventName: "Tech Talk", coordinatorName: "Nia New", startsAt: PAYLOAD.startsAt },
  booking_request_approved: { eventName: "Tech Talk", venueName: "Hall A", startsAt: PAYLOAD.startsAt, endsAt: PAYLOAD.endsAt },
  booking_request_rejected: { eventName: "Tech Talk", venueName: "Hall A", reason: "Under renovation" },
  booking_request_conflicting: { eventName: "Tech Talk", venueName: "Hall A", approvedEventName: "Gala Dinner" },
};

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
