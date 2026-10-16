// flaggedBookingErrors.test.js
//
// SCRUM-266. What a failed reinstate or cancel says to Venue Staff, for every
// code and status the endpoints answer, and which failures refresh the list.

import { describe, it, expect } from "vitest";

import {
  conflictText,
  isStaleResolutionError,
  resolutionConflicts,
  resolutionErrorMessage,
} from "../../src/services/flaggedBookingErrors.js";

const http = (status, data = {}) => Object.assign(new Error(`status ${status}`), { response: { status, data } });
const PROSE = "database prose with a uuid 3f2a9c1e-0000-0000-0000-000000000000";
const conflict = (code, extra = {}) => http(409, { error: PROSE, code, ...extra });

const PERIOD_CONFLICT_START =
  "The venue is no longer free for this booking's period, setup and turnaround included, so it can't be reinstated.";

describe("resolutionErrorMessage", () => {
  it.each([
    ["BOOKING_NOT_FLAGGED", /no longer flagged for review; it may already have been resolved\. The list has been refreshed\./],
    ["SAFETY_FLAG_NOT_REINSTATABLE", /flagged by the safety review, so it can't be reinstated\. It can be cancelled\./],
    ["EVENT_NOT_BOOKABLE", /no longer approved, in the safety check, or confirmed \(it may have been cancelled\).*can't be reinstated\. It can be cancelled\./],
    ["BOOKING_PERIOD_STALE", /dates have changed.*no longer covers the whole event.*request the venue for the new dates\./],
    ["VENUE_RETIRED", /^This venue has been retired, so the booking can't be reinstated\. It can be cancelled\.$/],
    ["BOOKING_CHANGED", /changed while you were resolving it\. The list has been refreshed; please try again\./],
  ])("SCRUM266_AC2_explains_the_409_%s", (code, pattern) => {
    const message = resolutionErrorMessage(conflict(code));
    expect(message).toMatch(pattern);
    expect(message).not.toContain(PROSE);
  });

  it("SCRUM266_AC2_a_period_conflict_with_no_conflicts_says_the_venue_is_not_free_and_names_nothing", () => {
    expect(resolutionErrorMessage(conflict("BOOKING_PERIOD_CONFLICT"))).toBe(PERIOD_CONFLICT_START);
    expect(resolutionErrorMessage(conflict("BOOKING_PERIOD_CONFLICT", { conflicts: [] }))).toBe(PERIOD_CONFLICT_START);
    expect(resolutionErrorMessage(conflict("BOOKING_PERIOD_CONFLICT", { conflicts: "not a list" }))).toBe(
      PERIOD_CONFLICT_START,
    );
  });

  it("SCRUM266_AC2_a_period_conflict_names_every_kind_of_occupant", () => {
    const message = resolutionErrorMessage(
      conflict("BOOKING_PERIOD_CONFLICT", {
        conflicts: [
          { kind: "block", reason: "maintenance" },
          { kind: "booking", eventName: "Gala Dinner" },
          { kind: "hold", eventName: "Open Day" },
        ],
      }),
    );
    expect(message).toBe(
      `${PERIOD_CONFLICT_START} In the way: a venue block (Maintenance), the booking for Gala Dinner, a tentative hold for Open Day.`,
    );
  });

  it("SCRUM266_AC2_a_period_conflict_names_a_repeated_occupant_once", () => {
    const message = resolutionErrorMessage(
      conflict("BOOKING_PERIOD_CONFLICT", {
        conflicts: [
          { kind: "booking", eventName: "Gala Dinner" },
          { kind: "booking", eventName: "Gala Dinner" },
          { kind: "booking" },
          { kind: "booking", eventName: "" },
        ],
      }),
    );
    expect(message).toBe(`${PERIOD_CONFLICT_START} In the way: the booking for Gala Dinner, the booking for another event.`);
  });

  it("SCRUM266_AC2_a_period_conflict_leaves_out_entries_of_an_unknown_kind", () => {
    const message = resolutionErrorMessage(
      conflict("BOOKING_PERIOD_CONFLICT", { conflicts: [{ kind: "mystery", eventName: "Secret" }, null] }),
    );
    expect(message).toBe(PERIOD_CONFLICT_START);
    expect(message).not.toContain("Secret");
  });

  it.each([
    [400, "The reason was not accepted. A reason is required, and it must be at most 1000 characters."],
    [401, "Your session has expired. Please sign in again."],
    [403, "Only Venue Staff can resolve flagged bookings."],
    [404, "That booking no longer exists. The list has been refreshed."],
  ])("SCRUM266_AC2_explains_status_%i", (status, message) => {
    expect(resolutionErrorMessage(http(status, { error: PROSE }))).toBe(message);
  });

  it.each([
    ["a 500", http(500, { error: PROSE })],
    ["an unknown 409 code", conflict("SOMETHING_NEW")],
    ["a 409 with no code", http(409, { error: PROSE })],
    ["a network error with no response", new Error("Network Error")],
    ["an inherited property name as the code", conflict("toString")],
    ["nothing at all", undefined],
  ])("SCRUM266_AC2_falls_back_to_the_default_for_%s", (_label, err) => {
    const message = resolutionErrorMessage(err);
    expect(message).toBe("Could not resolve the flagged booking. Please try again.");
    expect(message).not.toContain(PROSE);
  });

  it("SCRUM266_AC2_a_code_wins_over_its_status", () => {
    expect(resolutionErrorMessage(http(404, { code: "BOOKING_CHANGED" }))).toMatch(/changed while you were resolving it/);
  });
});

describe("resolutionConflicts", () => {
  it("SCRUM266_AC2_returns_only_known_kinds_from_a_period_conflict", () => {
    const block = { kind: "block", reason: "safety" };
    const booking = { kind: "booking", eventName: "Gala" };
    const hold = { kind: "hold", eventName: "Fair" };
    const err = conflict("BOOKING_PERIOD_CONFLICT", {
      conflicts: [block, { kind: "other" }, null, booking, {}, hold],
    });

    expect(resolutionConflicts(err)).toEqual([block, booking, hold]);
  });

  it("SCRUM266_AC2_returns_nothing_for_any_other_code_even_with_conflicts", () => {
    expect(resolutionConflicts(conflict("BOOKING_CHANGED", { conflicts: [{ kind: "booking" }] }))).toEqual([]);
  });

  it.each([
    ["a missing list", conflict("BOOKING_PERIOD_CONFLICT")],
    ["a list that is not an array", conflict("BOOKING_PERIOD_CONFLICT", { conflicts: { kind: "booking" } })],
    ["no response", new Error("Network Error")],
    ["nothing", null],
  ])("SCRUM266_AC2_returns_nothing_for_%s", (_label, err) => {
    expect(resolutionConflicts(err)).toEqual([]);
  });
});

describe("conflictText", () => {
  it.each([
    [{ kind: "block", reason: "renovation" }, "a venue block (Renovation)"],
    [{ kind: "block", reason: "brand_new_reason" }, "a venue block (brand_new_reason)"],
    [{ kind: "hold", eventName: "Open Day" }, "a tentative hold for Open Day"],
    [{ kind: "hold" }, "a tentative hold for another event"],
    [{ kind: "booking", eventName: "Gala" }, "the booking for Gala"],
    [{ kind: "booking" }, "the booking for another event"],
  ])("SCRUM266_AC2_names_%j", (clash, text) => {
    expect(conflictText(clash)).toBe(text);
  });
});

describe("isStaleResolutionError", () => {
  it.each([
    ["a 404", http(404)],
    ["BOOKING_NOT_FLAGGED", conflict("BOOKING_NOT_FLAGGED")],
    ["BOOKING_CHANGED", conflict("BOOKING_CHANGED")],
  ])("SCRUM266_AC2_%s_means_the_list_is_out_of_date", (_label, err) => {
    expect(isStaleResolutionError(err)).toBe(true);
  });

  it.each([
    ["BOOKING_PERIOD_CONFLICT", conflict("BOOKING_PERIOD_CONFLICT")],
    ["SAFETY_FLAG_NOT_REINSTATABLE", conflict("SAFETY_FLAG_NOT_REINSTATABLE")],
    ["EVENT_NOT_BOOKABLE", conflict("EVENT_NOT_BOOKABLE")],
    ["BOOKING_PERIOD_STALE", conflict("BOOKING_PERIOD_STALE")],
    ["VENUE_RETIRED", conflict("VENUE_RETIRED")],
    ["a 400", http(400)],
    ["a 403", http(403)],
    ["a 500", http(500)],
    ["a network error", new Error("Network Error")],
    ["nothing", undefined],
  ])("SCRUM266_AC2_%s_is_not_stale", (_label, err) => {
    expect(isStaleResolutionError(err)).toBe(false);
  });
});
