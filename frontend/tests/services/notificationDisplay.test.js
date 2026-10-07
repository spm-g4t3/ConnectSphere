// notificationDisplay.test.js
//
// SCRUM-128 (part of SCRUM-17, AC3). The wording of a notification on the
// Coordinator dashboard. Timezone-safe: every expected time is built here
// with the same formatRange the module uses, from fixtures that carry +08:00
// offsets, so the suite passes in any zone and locale.

import { describe, it, expect } from "vitest";

import { describeNotification } from "../../src/services/notificationDisplay.js";
import { formatRange } from "../../src/services/displayFormat.js";

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
