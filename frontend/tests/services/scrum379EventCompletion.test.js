// scrum379EventCompletion.test.js
//
// SCRUM-384 (SCRUM-379 AC1, AC2): the helpers behind the coordinator's Mark as completed screens.
// Time is passed in as `now`, or the clock is frozen, so no test reads the real clock.

import { describe, it, expect, vi, afterEach } from "vitest";

import {
  CLOSING_NOTES_MAX_LENGTH,
  COMPLETABLE_STATUS,
  canMarkCompleted,
  closingNotesOf,
  completionErrorMessage,
  eventHasEnded,
} from "../../src/services/eventCompletion.js";
import { SESSION_EXPIRED } from "../../src/services/apiErrors.js";

const NOW = new Date("2030-06-15T09:00:00Z");
const at = (seconds) => new Date(NOW.getTime() + seconds * 1000).toISOString();

const refusal = (status, data = {}) => ({ response: { status, data } });

describe("SCRUM379 eventHasEnded", () => {
  it("SCRUM379_AC1_an_end_in_the_past_has_ended", () => {
    expect(eventHasEnded(at(-3600), NOW)).toBe(true);
  });

  it("SCRUM379_AC1_an_end_one_second_ago_has_ended", () => {
    expect(eventHasEnded(at(-1), NOW)).toBe(true);
  });

  it("SCRUM379_AC1_an_end_exactly_now_has_ended_as_the_server_counts_it", () => {
    expect(eventHasEnded(at(0), NOW)).toBe(true);
  });

  it("SCRUM379_AC1_an_end_one_second_ahead_has_not_ended", () => {
    expect(eventHasEnded(at(1), NOW)).toBe(false);
  });

  it("SCRUM379_AC1_an_end_far_in_the_future_has_not_ended", () => {
    expect(eventHasEnded("2099-01-01T00:00:00Z", NOW)).toBe(false);
  });

  it.each([null, undefined, "", "not a date"])("SCRUM379_AC1_%s_has_not_ended", (value) => {
    expect(eventHasEnded(value, NOW)).toBe(false);
  });

  it("SCRUM379_AC1_an_instant_with_an_offset_is_compared_as_an_instant", () => {
    // 16:59:59 in Singapore is 08:59:59 UTC, one second before NOW; 17:00:01 is one second after.
    expect(eventHasEnded("2030-06-15T16:59:59+08:00", NOW)).toBe(true);
    expect(eventHasEnded("2030-06-15T17:00:01+08:00", NOW)).toBe(false);
  });

  describe("with no time given it reads the clock, which is frozen here", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("SCRUM379_AC1_it_uses_the_frozen_clock_one_second_either_side", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);

      expect(eventHasEnded(at(-1))).toBe(true);
      expect(eventHasEnded(at(0))).toBe(true);
      expect(eventHasEnded(at(1))).toBe(false);
    });
  });
});

describe("SCRUM379 canMarkCompleted", () => {
  const ended = { status: "confirmed", proposedEnd: at(-60) };

  it("SCRUM379_AC1_is_offered_to_the_assigned_coordinator_for_a_confirmed_event_that_has_ended", () => {
    expect(COMPLETABLE_STATUS).toBe("confirmed");
    expect(canMarkCompleted(ended, { isAssignedCoordinator: true, now: NOW })).toBe(true);
  });

  it("SCRUM379_AC1_is_not_offered_to_anyone_else", () => {
    expect(canMarkCompleted(ended, { isAssignedCoordinator: false, now: NOW })).toBe(false);
  });

  it("SCRUM379_AC1_is_not_offered_before_the_event_has_ended", () => {
    expect(canMarkCompleted({ ...ended, proposedEnd: at(60) }, { isAssignedCoordinator: true, now: NOW })).toBe(false);
  });

  it("SCRUM379_AC1_is_not_offered_for_an_event_with_no_end_time", () => {
    expect(canMarkCompleted({ ...ended, proposedEnd: null }, { isAssignedCoordinator: true, now: NOW })).toBe(false);
  });

  it.each([
    "draft", "submitted", "under_review", "pending_clarification", "approved",
    "safety_review", "safety_approved", "completed", "cancelled", "rejected",
  ])("SCRUM379_AC1_is_not_offered_for_a_%s_event_even_if_its_end_has_passed", (status) => {
    expect(canMarkCompleted({ ...ended, status }, { isAssignedCoordinator: true, now: NOW })).toBe(false);
  });

  it("SCRUM379_AC1_a_missing_event_is_not_completable", () => {
    expect(canMarkCompleted(null, { isAssignedCoordinator: true, now: NOW })).toBe(false);
  });
});

describe("SCRUM379 closingNotesOf", () => {
  it("SCRUM379_AC2_notes_are_returned_as_recorded", () => {
    expect(closingNotesOf({ closingNotes: "Attendance 180." })).toEqual({ recorded: true, text: "Attendance 180." });
  });

  it("SCRUM379_AC2_line_breaks_are_kept", () => {
    expect(closingNotesOf({ closingNotes: "One\n\nTwo" }).text).toBe("One\n\nTwo");
  });

  it("SCRUM379_AC2_null_means_the_event_has_no_notes", () => {
    expect(closingNotesOf({ closingNotes: null })).toEqual({ recorded: false, text: null });
  });

  it("SCRUM379_AC2_a_blank_string_means_no_notes", () => {
    expect(closingNotesOf({ closingNotes: "   " })).toEqual({ recorded: false, text: null });
  });

  it("SCRUM379_AC2_an_event_without_the_field_gives_null_so_nothing_is_claimed_about_it", () => {
    expect(closingNotesOf({ status: "completed" })).toBeNull();
    expect(closingNotesOf(undefined)).toBeNull();
    expect(closingNotesOf(null)).toBeNull();
  });
});

describe("SCRUM379 completionErrorMessage", () => {
  it("SCRUM379_AC3_an_event_final_refusal_is_shown_as_the_server_worded_it", () => {
    const message = "This event is completed and can no longer be changed";
    expect(completionErrorMessage(refusal(409, { error: message, code: "EVENT_FINAL" }))).toBe(message);
  });

  it("SCRUM379_AC3_a_cancelled_event_final_refusal_is_shown_as_worded", () => {
    const message = "This event is cancelled and can no longer be changed";
    expect(completionErrorMessage(refusal(409, { error: message, code: "EVENT_FINAL" }))).toBe(message);
  });

  it("SCRUM379_AC1_an_event_that_has_not_ended_says_so", () => {
    const message = completionErrorMessage(refusal(409, { error: "Event request x has not ended yet, so it cannot be marked as completed" }));
    expect(message).toMatch(/has not ended yet/);
    expect(message).not.toMatch(/Event request x/);
  });

  it("SCRUM379_AC1_an_event_that_is_not_confirmed_says_so", () => {
    const message = completionErrorMessage(refusal(409, {
      error: "Event request x has status approved, and only a Confirmed event can be marked as completed",
    }));
    expect(message).toMatch(/no longer Confirmed/);
  });

  it("SCRUM379_AC1_any_other_conflict_says_the_event_changed", () => {
    expect(completionErrorMessage(refusal(409, { error: "Something else" }))).toMatch(/has changed/);
    expect(completionErrorMessage(refusal(409))).toMatch(/has changed/);
  });

  it("SCRUM379_AC1_a_conflict_with_a_code_other_than_final_is_not_shown_raw", () => {
    const message = completionErrorMessage(refusal(409, { error: "Event request 1234 internals", code: "OTHER" }));
    expect(message).not.toContain("1234");
  });

  it("SCRUM379_AC1_a_403_names_the_assigned_coordinator", () => {
    expect(completionErrorMessage(refusal(403))).toBe("Only the coordinator assigned to this event can mark it as completed.");
  });

  it("SCRUM379_AC1_a_401_is_the_session_message", () => {
    expect(completionErrorMessage(refusal(401))).toBe(SESSION_EXPIRED);
  });

  it("SCRUM379_AC1_a_404_says_the_event_is_gone", () => {
    expect(completionErrorMessage(refusal(404))).toBe("This event request no longer exists.");
  });

  it("SCRUM379_AC2_a_400_shows_the_servers_reason", () => {
    expect(completionErrorMessage(refusal(400, { error: "Closing notes can be at most 2000 characters" })))
      .toBe("Closing notes can be at most 2000 characters");
  });

  it("SCRUM379_AC2_a_400_without_a_reason_has_its_own_wording", () => {
    expect(completionErrorMessage(refusal(400))).toMatch(/closing notes could not be saved/i);
  });

  it("SCRUM379_AC1_a_server_error_says_nothing_changed", () => {
    expect(completionErrorMessage(refusal(500))).toMatch(/No changes have been made/);
  });

  it("SCRUM379_AC1_no_response_does_not_claim_nothing_changed", () => {
    const message = completionErrorMessage(new Error("Network Error"));
    expect(message).toMatch(/may not have been completed/);
    expect(message).not.toMatch(/No changes have been made/);
  });

  it("SCRUM379_AC2_the_notes_limit_matches_the_server", () => {
    expect(CLOSING_NOTES_MAX_LENGTH).toBe(2000);
  });
});
