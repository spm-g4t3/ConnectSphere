// venueHoldErrors.test.js
//
// SCRUM-491. The words a failed hold request is shown in: by 409 code first,
// then by status, then a default per action -- never the server's own prose.

import { describe, it, expect } from "vitest";

import { holdConflicts, holdErrorMessage } from "../../src/services/venueHoldErrors.js";

const UUID_PROSE = "hold 3f2504e0-4f89-41d3-9a0c-0305e82c3301 already exists";

function http(status, data = {}) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { error: UUID_PROSE, ...data } },
  });
}

const conflict = (code, conflicts) => http(409, { code, conflicts });

describe("holdErrorMessage by code", () => {
  it.each([
    ["EVENT_NOT_APPROVED", /Only an Approved event can hold a venue/],
    ["EVENT_DATES_MISSING", /no proposed start and end/],
    ["VENUE_RETIRED", /retired, so it can no longer be held/],
    ["HOLD_EXISTS", /only one active hold at each venue/],
    ["HOLD_PERIOD_CONFLICT", /not free for the whole of the event/],
  ])("SCRUM491_AC4_%s_has_its_own_message", (code, pattern) => {
    expect(holdErrorMessage(conflict(code, []), "place")).toMatch(pattern);
  });

  it("SCRUM491_AC3_HOLD_EXISTS_says_one_active_hold_per_venue", () => {
    expect(holdErrorMessage(conflict("HOLD_EXISTS"), "place")).toBe(
      "This event already holds this venue. An event can have only one active hold at each venue.",
    );
  });

  it("SCRUM491_never_shows_the_server_prose", () => {
    for (const err of [conflict("HOLD_EXISTS"), http(500), http(409, { code: "MYSTERY" })]) {
      expect(holdErrorMessage(err, "place")).not.toContain(UUID_PROSE);
    }
  });

  it("SCRUM491_a_code_named_after_an_Object_prototype_key_is_not_a_match", () => {
    expect(holdErrorMessage(conflict("toString"), "place")).toBe(
      "Something changed while you were placing this hold. Please try again.",
    );
  });
});

describe("holdErrorMessage by status", () => {
  it("SCRUM491_AC1_a_403_says_only_Venue_Staff_can_place_a_hold", () => {
    expect(holdErrorMessage(http(403), "place")).toBe(
      "Only Venue Staff can place a tentative hold on a venue.",
    );
  });

  it.each([
    [400, "Some details were not accepted. Please check the form."],
  ])("SCRUM491_a_%s_has_its_status_message", (status, message) => {
    expect(holdErrorMessage(http(status), "place")).toBe(message);
  });

  it.each([
    ["list", "That venue no longer exists."],
    ["place", "That venue or event no longer exists. The event list has been refreshed."],
    ["candidates", "Could not load the Approved events. Please try again."],
  ])("SCRUM491_a_404_on_%s_names_what_is_gone", (action, message) => {
    expect(holdErrorMessage(http(404), action)).toBe(message);
  });

  it("SCRUM491_an_unknown_409_says_something_changed", () => {
    expect(holdErrorMessage(http(409), "place")).toBe(
      "Something changed while you were placing this hold. Please try again.",
    );
  });

  it.each([
    ["list", "Could not load this venue's holds. Please try again."],
    ["candidates", "Could not load the Approved events. Please try again."],
    ["place", "Could not place the hold. Please try again."],
    ["unknown", "Something went wrong. Please try again."],
  ])("SCRUM491_any_other_failure_on_%s_has_the_default", (action, message) => {
    expect(holdErrorMessage(http(500), action)).toBe(message);
    expect(holdErrorMessage(new Error("Network Error"), action)).toBe(message);
  });

  it("SCRUM491_no_error_at_all_still_has_a_message", () => {
    expect(holdErrorMessage(undefined, "place")).toBe("Could not place the hold. Please try again.");
  });
});

describe("holdConflicts", () => {
  it("SCRUM491_AC4_keeps_bookings_blocks_and_holds_in_order", () => {
    const list = [
      { kind: "booking", bookingId: "k1" },
      { kind: "other" },
      { kind: "block", blockId: "b1" },
      null,
      { kind: "hold", holdId: "h1" },
    ];
    expect(holdConflicts(conflict("HOLD_PERIOD_CONFLICT", list))).toEqual([
      list[0],
      list[2],
      list[4],
    ]);
  });

  it("SCRUM491_AC4_conflicts_that_are_not_a_list_are_empty", () => {
    expect(holdConflicts(conflict("HOLD_PERIOD_CONFLICT", "nope"))).toEqual([]);
  });

  it("SCRUM491_AC4_any_other_answer_has_no_conflicts", () => {
    expect(holdConflicts(conflict("HOLD_EXISTS", [{ kind: "hold", holdId: "h1" }]))).toEqual([]);
    expect(holdConflicts(http(500))).toEqual([]);
    expect(holdConflicts(undefined)).toEqual([]);
  });
});
