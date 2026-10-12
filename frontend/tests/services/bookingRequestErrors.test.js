// bookingRequestErrors.test.js
//
// SCRUM-254. What a failed request says, for every code the endpoint can answer.

import { describe, it, expect } from "vitest";

import {
  bookingRequestErrorMessage,
  fieldErrorsFrom,
  isSuitabilityConfirmationRequired,
  isVenueAlreadyRequested,
  periodConflicts,
  unmetCriteria,
  isStaleWithdrawError,
  withdrawErrorMessage,
} from "../../src/services/bookingRequestErrors.js";

const http = (status, data = {}) => Object.assign(new Error(`status ${status}`), { response: { status, data } });
const conflict = (code, conflicts = []) => http(409, { error: "database prose with a uuid", code, conflicts });

describe("bookingRequestErrorMessage", () => {
  it.each([
    ["EVENT_NOT_BOOKABLE", /approved or confirmed/],
    ["EVENT_DATES_MISSING", /no proposed start and end/],
    ["VENUE_RETIRED", /retired/],
    ["BOOKING_PERIOD_CONFLICT", /not available for the whole of the event/],
    ["BOOKING_CHANGED", /changed while you were working/],
  ])("SCRUM254_explains_the_409_%s", (code, pattern) => {
    expect(bookingRequestErrorMessage(conflict(code))).toMatch(pattern);
  });

  // SCRUM-525 (AC1): one live request per venue, so both refusals are about
  // the venue asked for, and the old event-wide wording would wrongly tell the
  // coordinator that no other venue can be requested.
  it.each([
    // SCRUM-525: names where to withdraw it, the Venue Requests page.
    ["BOOKING_REQUEST_EXISTS", /pending or approved request for this venue\..*withdraw that request first under Venue Requests\.$/],
    ["BOOKING_FLAGGED_FOR_REVIEW", /booking for this venue is flagged for review/],
  ])("SCRUM525_AC1_%s_is_explained_per_venue", (code, pattern) => {
    const message = bookingRequestErrorMessage(conflict(code, [{ kind: "booking_request", bookingId: "b9" }]));
    expect(message).toMatch(pattern);
    expect(message).toMatch(/this venue/);
    expect(message).not.toMatch(/only one is allowed/);
  });

  // SCRUM-525 (R4): no attendance in the body and none on the event.
  it("SCRUM525_AC2_explains_EVENT_ATTENDANCE_MISSING", () => {
    expect(bookingRequestErrorMessage(conflict("EVENT_ATTENDANCE_MISSING"))).toBe(
      "This event has no expected attendance saved, so enter one for this venue before requesting it.",
    );
  });

  it.each([
    [400, /check the form/],
    [401, /sign in again/],
    [403, /assigned to this event/],
    [404, /no longer exists/],
    [503, /suitability checking is not available/],
  ])("SCRUM254_explains_a_%i", (status, pattern) => {
    expect(bookingRequestErrorMessage(http(status))).toMatch(pattern);
  });

  it.each([
    ["an unknown 409 code", conflict("SOMETHING_NEW")],
    ["a 409 with no code", http(409, {})],
    ["a 500", http(500)],
    ["no response at all", new Error("network")],
    ["nothing", undefined],
  ])("SCRUM254_falls_back_to_the_default_for_%s", (_label, err) => {
    expect(bookingRequestErrorMessage(err)).toBe("Could not submit the request. Please try again.");
  });

  it("SCRUM254_never_shows_the_servers_own_prose", () => {
    const message = bookingRequestErrorMessage(
      http(409, { error: "booking 4444 for event 2222 is pending", code: "BOOKING_REQUEST_EXISTS" }),
    );
    expect(message).not.toContain("4444");
  });

  it("SCRUM254_a_code_this_build_does_not_know_does_not_match_inherited_keys", () => {
    expect(bookingRequestErrorMessage(conflict("toString"))).toBe(
      "Could not submit the request. Please try again.",
    );
  });
});

describe("suitability confirmation", () => {
  it("SCRUM254_recognises_the_confirmation_answer_and_lists_the_unmet_criteria", () => {
    const criteria = [{ criterion: "capacity", met: false, detail: "Capacity 80 < expected attendance 150" }];
    const err = conflict("SUITABILITY_CONFIRMATION_REQUIRED", criteria);
    expect(isSuitabilityConfirmationRequired(err)).toBe(true);
    expect(unmetCriteria(err)).toEqual(criteria);
  });

  it.each([conflict("VENUE_RETIRED"), http(400), new Error("x"), undefined])(
    "SCRUM254_does_not_mistake_%s_for_it",
    (err) => {
      expect(isSuitabilityConfirmationRequired(err)).toBe(false);
    },
  );

  it("SCRUM254_ignores_conflicts_that_are_not_objects", () => {
    expect(unmetCriteria(conflict("SUITABILITY_CONFIRMATION_REQUIRED", ["x", null, { criterion: "a" }]))).toEqual([
      { criterion: "a" },
    ]);
  });

  it("SCRUM254_an_answer_with_no_conflicts_list_has_no_criteria", () => {
    expect(unmetCriteria(http(409, { code: "SUITABILITY_CONFIRMATION_REQUIRED" }))).toEqual([]);
  });
});

describe("periodConflicts", () => {
  it("SCRUM254_returns_blocks_and_bookings_for_a_period_conflict", () => {
    const list = [
      { kind: "block", blockId: "b1" },
      { kind: "booking", bookingId: "k1" },
      { kind: "other" },
    ];
    expect(periodConflicts(conflict("BOOKING_PERIOD_CONFLICT", list))).toEqual(list.slice(0, 2));
  });

  it("SCRUM491_AC5_keeps_another_events_hold_as_a_conflict", () => {
    const list = [
      { kind: "hold", holdId: "h1", eventName: "Product Launch" },
      { kind: "booking", bookingId: "k1" },
      { kind: "other" },
      null,
    ];
    expect(periodConflicts(conflict("BOOKING_PERIOD_CONFLICT", list))).toEqual(list.slice(0, 2));
  });

  it("SCRUM254_is_empty_for_any_other_error", () => {
    expect(periodConflicts(conflict("VENUE_RETIRED", [{ kind: "block" }]))).toEqual([]);
    expect(periodConflicts(undefined)).toEqual([]);
  });
});

// SCRUM-525 renamed isEventAlreadyRequested: the codes now name a venue.
describe("isVenueAlreadyRequested", () => {
  it.each(["BOOKING_REQUEST_EXISTS", "BOOKING_FLAGGED_FOR_REVIEW"])("SCRUM254_is_true_for_%s", (code) => {
    expect(isVenueAlreadyRequested(conflict(code))).toBe(true);
  });

  it.each([conflict("VENUE_RETIRED"), http(403, { code: "BOOKING_REQUEST_EXISTS" }), undefined])(
    "SCRUM254_is_false_for_%s",
    (err) => {
      expect(isVenueAlreadyRequested(err)).toBe(false);
    },
  );
});

describe("fieldErrorsFrom", () => {
  it("SCRUM254_keeps_only_the_fields_the_form_has", () => {
    const details = [
      { field: "setupNotes", message: "must be 1000 characters or fewer" },
      { field: "venueId", message: "must be a valid venue id" },
    ];
    expect(fieldErrorsFrom(http(400, { details }), ["setupNotes"])).toEqual([details[0]]);
  });

  it.each([http(409, { details: [{ field: "setupNotes" }] }), http(400, {}), undefined])(
    "SCRUM254_is_empty_for_%s",
    (err) => {
      expect(fieldErrorsFrom(err, ["setupNotes"])).toEqual([]);
    },
  );
});

describe("withdrawErrorMessage (SCRUM-255)", () => {
  it.each([
    ["BOOKING_NOT_PENDING", /no longer pending, so it can't be withdrawn.*refreshed/],
    ["BOOKING_CHANGED", /changed while you were working.*refreshed/],
  ])("SCRUM255_explains_the_409_%s", (code, pattern) => {
    expect(withdrawErrorMessage(conflict(code))).toMatch(pattern);
  });

  it("SCRUM255_any_other_409_is_treated_as_a_changed_request", () => {
    expect(withdrawErrorMessage(conflict("SOMETHING_NEW"))).toMatch(/changed while you were working/);
    expect(withdrawErrorMessage(http(409, {}))).toMatch(/changed while you were working/);
  });

  it.each([
    [401, /sign in again/],
    [403, /assigned to this event can withdraw/],
    [404, /no longer exists.*refreshed/],
  ])("SCRUM255_explains_a_%i", (status, pattern) => {
    expect(withdrawErrorMessage(http(status))).toMatch(pattern);
  });

  it.each([http(400), http(500), new Error("network"), undefined, conflict("toString")])(
    "SCRUM255_falls_back_to_the_default_for_%s",
    (err) => {
      // conflict("toString") is a 409, which is a changed request, not the default.
      const expected = err?.response?.status === 409
        ? /changed while you were working/
        : /Could not withdraw the request/;
      expect(withdrawErrorMessage(err)).toMatch(expected);
    },
  );

  it("SCRUM255_never_shows_the_servers_own_prose", () => {
    expect(withdrawErrorMessage(http(409, { error: "booking 4444 is withdrawn", code: "BOOKING_NOT_PENDING" }))).not.toContain("4444");
  });
});

describe("isStaleWithdrawError (SCRUM-255)", () => {
  it.each([403, 404, 409])("SCRUM255_a_%i_means_the_list_is_out_of_date", (status) => {
    expect(isStaleWithdrawError(http(status))).toBe(true);
  });

  it.each([http(400), http(401), http(500), new Error("network"), undefined])(
    "SCRUM255_%s_does_not",
    (err) => {
      expect(isStaleWithdrawError(err)).toBe(false);
    },
  );
});
// SCRUM-188 review fix F11: a 400 about the requirement codes points at the
// search form, where they were chosen.
describe("SCRUM-188 unrecognised requirement codes", () => {
  it.each(["accessibility", "facilities", "roomLayoutCode", "acknowledgedCriteria"])(
    "SCRUM188_AC7_a_400_naming_%s_says_the_requirements_were_not_recognised",
    (field) => {
      const message = bookingRequestErrorMessage(
        http(400, { error: "prose", details: [{ field, message: "Unknown code xyz" }] }),
      );
      expect(message).toBe(
        "The selected requirements were not recognised. Adjust the layout, accessibility features or facilities in the search form, then try again.",
      );
    },
  );

  // SCRUM-525 (AC2): the attendance is typed on the request form, so a
  // refused number must not send the coordinator to the search form.
  it("SCRUM525_AC2_a_400_naming_expectedAttendance_points_at_the_attendance_not_the_search_form", () => {
    const message = bookingRequestErrorMessage(
      http(400, { error: "prose", details: [{ field: "expectedAttendance", message: "must be at least 1" }] }),
    );
    expect(message).toBe(
      "The expected attendance for this venue was not accepted. Enter a whole number of 1 or more.",
    );
    expect(message).not.toMatch(/search form/);
  });

  it("SCRUM188_AC7_a_400_about_other_fields_keeps_the_general_message", () => {
    expect(
      bookingRequestErrorMessage(http(400, { details: [{ field: "setupNotes", message: "Too long" }] })),
    ).toBe("Some details were not accepted. Please check the form.");
  });
});
