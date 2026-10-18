// equipmentNotificationDisplay.test.js
//
// SCRUM-176: the wording of the six equipment notifications (097) and the link
// each one carries. Pure functions, so nothing is rendered.

import { describe, it, expect } from "vitest";

import { describeNotification } from "../../src/services/notificationDisplay.js";
import { notificationLink } from "../../src/services/notificationLink.js";
import { formatRange } from "../../src/services/displayFormat.js";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";

function note(type, payload, overrides = {}) {
  return {
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    type,
    eventRequestId: EVENT_ID,
    payload: { eventName: "Tech Talk", ...payload },
    readAt: null,
    createdAt: "2026-10-15T11:00:00+08:00",
    ...overrides,
  };
}

const PROJECTOR = { equipmentType: "Projector", quantity: 2, reserved: 0, outcome: null };
const SPEAKER = { equipmentType: "Speaker", quantity: 1, reserved: 0, outcome: null };

describe("SCRUM-176 AC1 and AC2: equipment_requested", () => {
  it("SCRUM176_AC2_names_the_event_and_lists_each_type_with_its_quantity", () => {
    const { headline, detail } = describeNotification(
      note("equipment_requested", { lines: [PROJECTOR, SPEAKER] }),
    );

    expect(headline).toBe("Equipment requested for Tech Talk");
    expect(detail).toBe("Requested: 2 x Projector, 1 x Speaker.");
  });

  it("SCRUM176_AC2_a_line_missing_its_fields_still_reads_as_text", () => {
    const { detail } = describeNotification(note("equipment_requested", { lines: [{}, null] }));

    expect(detail).toBe("Requested: ? x Unknown equipment, ? x Unknown equipment.");
  });

  it("SCRUM176_AC2_without_lines_it_points_at_the_request", () => {
    expect(describeNotification(note("equipment_requested", {})).detail).toBe(
      "Open the request to see what was asked for.",
    );
    expect(describeNotification(note("equipment_requested", { lines: "x" })).detail).toBe(
      "Open the request to see what was asked for.",
    );
  });

  it("SCRUM176_AC2_a_missing_event_name_and_payload_never_read_as_undefined", () => {
    const withoutName = describeNotification(note("equipment_requested", { eventName: "" }));
    const withoutPayload = describeNotification({ type: "equipment_requested", payload: null });

    expect(withoutName.headline).toBe("Equipment requested for Unnamed event");
    expect(withoutPayload.headline).toBe("Equipment requested for Unnamed event");
  });
});

describe("SCRUM-176 AC3: equipment_arranged", () => {
  it("SCRUM176_AC3_says_every_line_is_reserved_and_lists_them", () => {
    const { headline, detail } = describeNotification(
      note("equipment_arranged", { lines: [{ ...PROJECTOR, reserved: 2 }] }),
    );

    expect(headline).toBe("Equipment for Tech Talk is arranged");
    expect(detail).toBe("Every line is fully reserved: 2 x Projector.");
  });

  it("SCRUM176_AC3_without_lines_it_still_says_it_is_arranged", () => {
    expect(describeNotification(note("equipment_arranged", {})).detail).toBe(
      "Every line is fully reserved.",
    );
  });
});

describe("SCRUM-176 AC4: equipment_not_fully_arranged", () => {
  it("SCRUM176_AC4_names_only_the_lines_that_are_short_and_how_many_are_held", () => {
    const { headline, detail } = describeNotification(
      note("equipment_not_fully_arranged", {
        lines: [
          { equipmentType: "Projector", quantity: 2, reserved: 2 },
          { equipmentType: "Microphone", quantity: 5, reserved: 1, outcome: "cannot_be_provided" },
        ],
      }),
    );

    expect(headline).toBe("Equipment for Tech Talk cannot be fully arranged");
    expect(detail).toBe("Short: Microphone (1 of 5 reserved).");
  });

  it("SCRUM176_AC4_a_short_line_with_missing_fields_still_reads_as_text", () => {
    const { detail } = describeNotification(
      note("equipment_not_fully_arranged", { lines: [{ quantity: 3 }] }),
    );

    expect(detail).toBe("Short: Unknown equipment (0 of 3 reserved).");
  });

  it("SCRUM176_AC4_without_a_short_line_it_gives_the_general_sentence", () => {
    const empty = describeNotification(note("equipment_not_fully_arranged", {}));
    const nothingShort = describeNotification(
      note("equipment_not_fully_arranged", { lines: [{ equipmentType: "Projector", quantity: 2, reserved: 2 }, null] }),
    );

    expect(empty.detail).toBe("Some equipment could not be provided.");
    expect(nothingShort.detail).toBe("Some equipment could not be provided.");
  });
});

describe("SCRUM-176 AC5: equipment_request_changed", () => {
  it("SCRUM176_AC5_an_added_line_is_listed", () => {
    const { headline, detail } = describeNotification(
      note("equipment_request_changed", { change: "added", lines: [SPEAKER] }),
    );

    expect(headline).toBe("Equipment added for Tech Talk");
    expect(detail).toBe("Added: 1 x Speaker.");
  });

  it("SCRUM176_AC5_an_added_line_without_details_still_says_so", () => {
    expect(describeNotification(note("equipment_request_changed", { change: "added" })).detail).toBe(
      "A line was added to the request.",
    );
  });

  it("SCRUM176_AC5_a_removed_line_is_listed", () => {
    const { headline, detail } = describeNotification(
      note("equipment_request_changed", { change: "removed", lines: [SPEAKER] }),
    );

    expect(headline).toBe("Equipment removed for Tech Talk");
    expect(detail).toBe("Removed: 1 x Speaker.");
  });

  it("SCRUM176_AC5_a_removed_line_without_details_still_says_so", () => {
    expect(describeNotification(note("equipment_request_changed", { change: "removed" })).detail).toBe(
      "A line was removed from the request.",
    );
  });

  it("SCRUM176_AC5_a_changed_quantity_says_what_it_was_and_what_it_is", () => {
    const { headline, detail } = describeNotification(
      note("equipment_request_changed", {
        change: "amended",
        previousQuantity: 2,
        notesChanged: false,
        lines: [{ equipmentType: "Projector", quantity: 5 }],
      }),
    );

    expect(headline).toBe("Equipment changed for Tech Talk");
    expect(detail).toBe("Projector: quantity was 2, now 5.");
  });

  it("SCRUM176_AC5_changed_notes_are_named_alongside_a_quantity_change", () => {
    const { detail } = describeNotification(
      note("equipment_request_changed", {
        change: "amended",
        previousQuantity: 2,
        notesChanged: true,
        lines: [{ equipmentType: "Projector", quantity: 5 }],
      }),
    );

    expect(detail).toBe("Projector: quantity was 2, now 5. Technical notes were updated for Projector.");
  });

  it("SCRUM176_AC5_changed_notes_alone_do_not_claim_a_quantity_change", () => {
    const { detail } = describeNotification(
      note("equipment_request_changed", {
        change: "amended",
        previousQuantity: 2,
        notesChanged: true,
        lines: [{ equipmentType: "Projector", quantity: 2 }],
      }),
    );

    expect(detail).toBe("Technical notes were updated for Projector.");
  });

  it("SCRUM176_AC5_notes_changed_with_no_line_in_the_payload_still_reads_as_a_sentence", () => {
    const { detail } = describeNotification(
      note("equipment_request_changed", { change: "amended", notesChanged: true }),
    );

    expect(detail).toBe("Technical notes were updated.");
  });

  it("SCRUM176_AC5_an_amendment_with_nothing_to_report_falls_back_to_a_general_line", () => {
    const noQuantityInfo = describeNotification(
      note("equipment_request_changed", { change: "amended", lines: [{ equipmentType: "Projector", quantity: 2 }] }),
    );
    const nothing = describeNotification(note("equipment_request_changed", {}));

    expect(noQuantityInfo.detail).toBe("A line on the request was changed.");
    expect(nothing.detail).toBe("A line on the request was changed.");
  });

  it("SCRUM176_AC5_a_date_change_gives_the_new_period", () => {
    const startsAt = "2026-12-05T14:00:00+08:00";
    const endsAt = "2026-12-05T16:00:00+08:00";

    const { headline, detail } = describeNotification(
      note("equipment_request_changed", { change: "event_period", startsAt, endsAt }),
    );

    expect(headline).toBe("The date or time of Tech Talk changed");
    expect(detail).toBe(
      `Reserved equipment was flagged for review. The event is now ${formatRange(startsAt, endsAt)}.`,
    );
  });

  it("SCRUM176_AC5_a_date_change_without_usable_times_says_only_what_it_knows", () => {
    const { detail } = describeNotification(
      note("equipment_request_changed", { change: "event_period", startsAt: null, endsAt: "nonsense" }),
    );

    expect(detail).toBe("Reserved equipment was flagged for review.");
  });
});

describe("SCRUM-176 AC5: equipment_request_cancelled", () => {
  it("SCRUM176_AC5_says_why_and_that_held_equipment_was_released", () => {
    const { headline, detail } = describeNotification(
      note("equipment_request_cancelled", { reason: "The last line was removed" }),
    );

    expect(headline).toBe("The equipment request for Tech Talk was cancelled");
    expect(detail).toBe("The last line was removed. Any equipment held for it was released.");
  });

  it("SCRUM176_AC5_without_a_reason_it_still_reads_as_a_sentence", () => {
    expect(describeNotification(note("equipment_request_cancelled", {})).detail).toBe(
      "The request was cancelled. Any equipment held for it was released.",
    );
  });
});

describe("SCRUM-176 AC6: equipment_flagged", () => {
  it("SCRUM176_AC6_names_the_equipment_and_why_it_was_flagged", () => {
    const { headline, detail } = describeNotification(
      note("equipment_flagged", {
        equipmentType: "Projector",
        reason: "The equipment type was retired",
      }),
    );

    expect(headline).toBe("Reserved equipment for Tech Talk was flagged");
    expect(detail).toBe("Projector: The equipment type was retired. The reservation is flagged for review.");
  });

  it("SCRUM176_AC6_without_a_type_or_reason_it_still_reads_as_a_sentence", () => {
    expect(describeNotification(note("equipment_flagged", {})).detail).toBe(
      "The equipment is no longer available. The reservation is flagged for review.",
    );
  });
});

describe("SCRUM-176 AC7: where an equipment notification leads", () => {
  it.each(["equipment_requested", "equipment_request_changed"])(
    "SCRUM176_AC7_technical_support_opens_the_equipment_review_for_%s",
    (type) => {
      expect(notificationLink(note(type), "technical_support_staff")).toEqual({
        to: `/equipment-review/${EVENT_ID}`,
      });
    },
  );

  it("SCRUM176_AC7_a_cancelled_request_has_nothing_to_review_so_it_has_no_link", () => {
    expect(notificationLink(note("equipment_request_cancelled"), "technical_support_staff")).toBeNull();
  });

  it.each([
    "equipment_requested",
    "equipment_request_changed",
    "equipment_request_cancelled",
    "equipment_arranged",
    "equipment_not_fully_arranged",
    "equipment_flagged",
  ])("SCRUM176_AC7_the_coordinator_opens_their_event_page_for_%s", (type) => {
    expect(notificationLink(note(type), "event_coordinator")).toEqual({
      to: `/event-requests/${EVENT_ID}`,
    });
  });

  it("SCRUM176_AC7_no_link_when_the_notification_has_no_event", () => {
    expect(
      notificationLink(note("equipment_requested", {}, { eventRequestId: null }), "technical_support_staff"),
    ).toBeNull();
  });
});
