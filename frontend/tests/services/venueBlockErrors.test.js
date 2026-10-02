// venueBlockErrors.test.js
//
// SCRUM-127 (part of SCRUM-17, AC1, AC3, AC4). What a failed block request
// says to Venue Staff, and which failures mean the list on screen is stale.
// The server's data.error is never shown: it carries raw uuids.

import { describe, it, expect } from "vitest";

import { blockErrorMessage, isStaleBlockError } from "../../src/services/venueBlockErrors.js";

const UUID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ACTIONS = ["list", "create", "update", "remove"];

function httpError(status, data = {}) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { error: `block ${UUID} overlaps block ${UUID}`, ...data } },
  });
}

const MESSAGES = {
  VENUE_RETIRED: "This venue has been retired, so it can no longer be blocked.",
  BLOCK_OVERLAPS_BLOCK:
    "This period overlaps another block on this venue. Choose a different period, or change that block instead.",
  BLOCK_REMOVED: "This block has already been removed. The list has been refreshed.",
  BLOCK_ENDED:
    "This block has already ended, so it can no longer be changed. The list has been refreshed.",
  BLOCK_BOOKING_CONFLICT:
    "The overlapping bookings changed since you confirmed. Review the updated list.",
};

const DEFAULTS = {
  list: "Could not load this venue's blocks. Please try again.",
  create: "Could not save the block. Please try again.",
  update: "Could not save the block. Please try again.",
  remove: "Could not remove this block. Please try again.",
};

const UNKNOWN_CONFLICT =
  "This block changed while you were working on it. The list has been refreshed.";

describe("blockErrorMessage codes", () => {
  for (const [code, message] of Object.entries(MESSAGES)) {
    it(`SCRUM17_maps_${code}_for_every_action`, () => {
      for (const action of ACTIONS) {
        expect(blockErrorMessage(httpError(409, { code }), action)).toBe(message);
      }
    });
  }

  it("the code beats the status", () => {
    expect(blockErrorMessage(httpError(404, { code: "BLOCK_REMOVED" }), "update")).toBe(
      MESSAGES.BLOCK_REMOVED,
    );
    expect(blockErrorMessage(httpError(400, { code: "VENUE_RETIRED" }), "create")).toBe(
      MESSAGES.VENUE_RETIRED,
    );
    expect(blockErrorMessage(httpError(500, { code: "BLOCK_ENDED" }), "remove")).toBe(
      MESSAGES.BLOCK_ENDED,
    );
  });

  it("an unknown code falls through to the status", () => {
    expect(blockErrorMessage(httpError(403, { code: "SOMETHING_NEW" }), "create")).toBe(
      "Only Venue Staff can manage venue blocks.",
    );
    expect(blockErrorMessage(httpError(500, { code: "SOMETHING_NEW" }), "remove")).toBe(
      DEFAULTS.remove,
    );
  });

  it("does not treat inherited object keys as codes", () => {
    expect(blockErrorMessage(httpError(409, { code: "toString" }), "update")).toBe(
      UNKNOWN_CONFLICT,
    );
  });
});

describe("blockErrorMessage statuses", () => {
  it("SCRUM17_AC4_404_wording_depends_on_the_action", () => {
    expect(blockErrorMessage(httpError(404), "list")).toBe("That venue no longer exists.");
    expect(blockErrorMessage(httpError(404), "create")).toBe("That venue no longer exists.");
    expect(blockErrorMessage(httpError(404), "update")).toBe(
      "That block no longer exists. The list has been refreshed.",
    );
    expect(blockErrorMessage(httpError(404), "remove")).toBe(
      "That block no longer exists. The list has been refreshed.",
    );
  });

  it("401 and 403 have their own messages for every action", () => {
    for (const action of ACTIONS) {
      expect(blockErrorMessage(httpError(401), action)).toBe(
        "Your session has expired. Please sign in again.",
      );
      expect(blockErrorMessage(httpError(403), action)).toBe(
        "Only Venue Staff can manage venue blocks.",
      );
    }
  });

  it("400 without a code asks the user to check the form", () => {
    expect(blockErrorMessage(httpError(400), "create")).toBe(
      "Some details were not accepted. Please check the form.",
    );
  });

  it("a 409 with no code, or an unknown one, says the list was refreshed", () => {
    for (const action of ACTIONS) {
      expect(blockErrorMessage(httpError(409), action)).toBe(UNKNOWN_CONFLICT);
      expect(blockErrorMessage(httpError(409, { code: "NEW_CODE" }), action)).toBe(
        UNKNOWN_CONFLICT,
      );
    }
  });

  it("a 500 gets the per-action default", () => {
    for (const action of ACTIONS) {
      expect(blockErrorMessage(httpError(500), action)).toBe(DEFAULTS[action]);
    }
  });

  it("a network error with no response gets the per-action default", () => {
    for (const action of ACTIONS) {
      expect(blockErrorMessage(new Error("Network Error"), action)).toBe(DEFAULTS[action]);
    }
    expect(blockErrorMessage(undefined, "create")).toBe(DEFAULTS.create);
    expect(blockErrorMessage(null, "list")).toBe(DEFAULTS.list);
  });

  it("an action it does not know gets a generic message", () => {
    expect(blockErrorMessage(httpError(500), "bogus")).toBe(
      "Something went wrong. Please try again.",
    );
  });

  // SCRUM-132: a 404 used to return undefined here, leaving the alert blank.
  it("a 404 for an action it does not know also gets the generic message, never blank", () => {
    expect(blockErrorMessage(httpError(404), "bogus")).toBe(
      "Something went wrong. Please try again.",
    );
  });
});

describe("blockErrorMessage never shows the server prose", () => {
  it("SCRUM17_no_uuid_from_data_error_reaches_the_message", () => {
    const statuses = [400, 401, 403, 404, 409, 500];
    const codes = [undefined, ...Object.keys(MESSAGES), "UNKNOWN"];
    for (const status of statuses) {
      for (const code of codes) {
        for (const action of ACTIONS) {
          const message = blockErrorMessage(httpError(status, code ? { code } : {}), action);
          expect(typeof message).toBe("string");
          expect(message).not.toMatch(UUID_PATTERN);
          expect(message).not.toContain("overlaps block");
        }
      }
    }
  });
});

describe("isStaleBlockError", () => {
  const cases = [
    ["404", httpError(404), true],
    ["404 with an unrelated code", httpError(404, { code: "VENUE_RETIRED" }), true],
    ["409 BLOCK_REMOVED", httpError(409, { code: "BLOCK_REMOVED" }), true],
    ["409 BLOCK_ENDED", httpError(409, { code: "BLOCK_ENDED" }), true],
    ["409 with no code", httpError(409), true],
    ["409 with an unknown code", httpError(409, { code: "NEW_CODE" }), true],
    ["409 BLOCK_BOOKING_CONFLICT", httpError(409, { code: "BLOCK_BOOKING_CONFLICT" }), false],
    ["409 BLOCK_OVERLAPS_BLOCK", httpError(409, { code: "BLOCK_OVERLAPS_BLOCK" }), false],
    ["409 VENUE_RETIRED", httpError(409, { code: "VENUE_RETIRED" }), false],
    ["400", httpError(400), false],
    ["401", httpError(401), false],
    ["403", httpError(403), false],
    ["500", httpError(500), false],
    ["a network error", new Error("Network Error"), false],
    ["undefined", undefined, false],
  ];

  for (const [label, err, expected] of cases) {
    it(`SCRUM17_AC4_${label.replace(/\s+/g, "_")}_is_${expected ? "stale" : "not_stale"}`, () => {
      expect(isStaleBlockError(err)).toBe(expected);
    });
  }
});
