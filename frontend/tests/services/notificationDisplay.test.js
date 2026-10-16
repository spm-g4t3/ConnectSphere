// notificationDisplay.test.js
//
// SCRUM-128 (part of SCRUM-17, AC3). The wording of a notification on the
// Coordinator dashboard. Timezone-safe: every expected time is built here
// with the same formatRange the module uses, from fixtures that carry +08:00
// offsets, so the suite passes in any zone and locale.

import { describe, it, expect } from "vitest";

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

describe("describeNotification: Safety Officer outcomes (SCRUM-490)", () => {
  it.each([
    ["approved", "Industry Night was approved after safety review"],
    ["changes_requested", "Industry Night needs changes after safety review"],
    ["rejected", "Industry Night had its safety arrangement rejected"],
  ])("describes a %s response with its recorded note", (outcome, headline) => {
    expect(describeNotification({
      type: "safety_review_response",
      payload: { eventName: "Industry Night", outcome, note: "See the review note." },
    })).toEqual({
      headline,
      detail: "See the review note.",
    });
  });

  it("uses the response defaults when event name, outcome, or note are missing", () => {
    expect(describeNotification({ type: "safety_review_response", payload: {} })).toEqual({
      headline: "The event received a safety review response",
      detail: "Open the event to review the Safety Officer's response.",
    });
  });

  it("describes a booking marked for safety review", () => {
    expect(describeNotification({
      type: "safety_booking_flagged",
      payload: {
        eventName: "Industry Night",
        venueName: "Hall A",
        reason: "Safety review",
        startsAt: "2026-12-01T10:00:00Z",
        endsAt: "2026-12-01T12:00:00Z",
      },
    })).toMatchObject({
      headline: "Industry Night at Hall A needs review",
      detail: expect.stringMatching(/^Reason: Safety review\. Booked /),
    });
  });

  it("uses safe defaults for a booking safety notification with missing fields", () => {
    expect(describeNotification({ type: "safety_booking_flagged", payload: {} })).toEqual({
      headline: "Unnamed event at Unknown venue needs review",
      detail: "Reason: Safety review. Booked unknown – unknown.",
    });
  });

  it("describes an equipment request returned to review", () => {
    expect(describeNotification({
      type: "safety_equipment_review",
      payload: { eventName: "Industry Night" },
    })).toEqual({
      headline: "Equipment for Industry Night was returned for review",
      detail: "A Safety Officer marked the equipment arrangement as affected.",
    });
  });

  it("uses a safe default event name for an equipment safety notification", () => {
    expect(describeNotification({ type: "safety_equipment_review", payload: {} })).toEqual({
      headline: "Equipment for Unnamed event was returned for review",
      detail: "A Safety Officer marked the equipment arrangement as affected.",
    });
  });
});
