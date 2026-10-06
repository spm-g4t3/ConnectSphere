// bookingRequestErrors.test.js
//
// SCRUM-254. What a failed request says, for every code the endpoint can answer.

import { describe, it, expect } from "vitest";

import {
  bookingRequestErrorMessage,
  fieldErrorsFrom,
  isEventAlreadyRequested,
  isSuitabilityConfirmationRequired,
  periodConflicts,
  unmetCriteria,
} from "../../src/services/bookingRequestErrors.js";

const http = (status, data = {}) => Object.assign(new Error(`status ${status}`), { response: { status, data } });
const conflict = (code, conflicts = []) => http(409, { error: "database prose with a uuid", code, conflicts });

describe("bookingRequestErrorMessage", () => {
  it.each([
    ["EVENT_NOT_BOOKABLE", /approved or confirmed/],
    ["EVENT_DATES_MISSING", /no proposed start and end/],
    ["VENUE_RETIRED", /retired/],
    ["BOOKING_REQUEST_EXISTS", /pending or approved venue request/],
    ["BOOKING_FLAGGED_FOR_REVIEW", /flagged for review/],
    ["BOOKING_PERIOD_CONFLICT", /not available for the whole of the event/],
    ["BOOKING_CHANGED", /changed while you were working/],
  ])("SCRUM254_explains_the_409_%s", (code, pattern) => {
    expect(bookingRequestErrorMessage(conflict(code))).toMatch(pattern);
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

  it("SCRUM254_is_empty_for_any_other_error", () => {
    expect(periodConflicts(conflict("VENUE_RETIRED", [{ kind: "block" }]))).toEqual([]);
    expect(periodConflicts(undefined)).toEqual([]);
  });
});

describe("isEventAlreadyRequested", () => {
  it.each(["BOOKING_REQUEST_EXISTS", "BOOKING_FLAGGED_FOR_REVIEW"])("SCRUM254_is_true_for_%s", (code) => {
    expect(isEventAlreadyRequested(conflict(code))).toBe(true);
  });

  it.each([conflict("VENUE_RETIRED"), http(403, { code: "BOOKING_REQUEST_EXISTS" }), undefined])(
    "SCRUM254_is_false_for_%s",
    (err) => {
      expect(isEventAlreadyRequested(err)).toBe(false);
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
