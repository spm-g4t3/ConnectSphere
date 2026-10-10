// venueHoldValidation.test.js
//
// SCRUM-491 (AC2). The hold form's client checks -- an event is required, and
// an expiry that is a real date and time in the future -- and the payload it
// sends. Timezone-safe: "future" is judged against a fixed `now` built from
// the same datetime-local reading the validator uses.

import { describe, it, expect } from "vitest";

import { toHoldPayload, validateHoldInput } from "../../src/services/venueHoldValidation.js";

const NOW = new Date("2026-10-10T12:00");
const EVENT_ID = "e1000000-0000-4000-8000-000000000001";
const OFFSET_SUFFIX = /[+-]\d{2}:\d{2}$|Z$/;

describe("SCRUM491_AC2 validateHoldInput", () => {
  it("SCRUM491_AC2_an_event_and_a_future_expiry_pass", () => {
    expect(
      validateHoldInput({ eventRequestId: EVENT_ID, expiresAt: "2026-10-11T09:00" }, { now: NOW }),
    ).toEqual([]);
  });

  it("SCRUM491_AC2_both_fields_are_required", () => {
    expect(validateHoldInput({ eventRequestId: "  ", expiresAt: "" }, { now: NOW })).toEqual([
      { field: "eventRequestId", message: "is required" },
      { field: "expiresAt", message: "is required" },
    ]);
  });

  it.each([undefined, null, {}, { eventRequestId: 1, expiresAt: 2 }])(
    "SCRUM491_AC2_%s_reads_as_nothing_given",
    (values) => {
      expect(validateHoldInput(values, { now: NOW }).map((e) => e.message)).toEqual([
        "is required",
        "is required",
      ]);
    },
  );

  it.each(["tomorrow", "2026-02-30T09:00", "2026-13-01T09:00"])(
    "SCRUM491_AC2_%s_is_not_a_valid_date_and_time",
    (expiresAt) => {
      expect(validateHoldInput({ eventRequestId: EVENT_ID, expiresAt }, { now: NOW })).toEqual([
        { field: "expiresAt", message: "must be a valid date and time" },
      ]);
    },
  );

  it.each(["2026-10-10T12:00", "2026-10-09T09:00"])(
    "SCRUM491_AC2_an_expiry_at_%s_is_not_in_the_future",
    (expiresAt) => {
      expect(validateHoldInput({ eventRequestId: EVENT_ID, expiresAt }, { now: NOW })).toEqual([
        { field: "expiresAt", message: "must be in the future" },
      ]);
    },
  );

  it("SCRUM491_AC2_defaults_now_to_the_real_clock", () => {
    expect(
      validateHoldInput({ eventRequestId: EVENT_ID, expiresAt: "2000-01-01T00:00" }),
    ).toEqual([{ field: "expiresAt", message: "must be in the future" }]);
  });
});

describe("SCRUM491_AC2 toHoldPayload", () => {
  it("SCRUM491_AC2_sends_the_event_and_the_expiry_with_an_offset", () => {
    const payload = toHoldPayload({ eventRequestId: ` ${EVENT_ID} `, expiresAt: " 2026-10-11T09:00 " });

    expect(Object.keys(payload).sort()).toEqual(["eventRequestId", "expiresAt"]);
    expect(payload.eventRequestId).toBe(EVENT_ID);
    expect(payload.expiresAt).toMatch(OFFSET_SUFFIX);
    expect(payload.expiresAt.startsWith("2026-10-11T09:00:00")).toBe(true);
    expect(new Date(payload.expiresAt).getTime()).toBe(new Date("2026-10-11T09:00").getTime());
  });
});
