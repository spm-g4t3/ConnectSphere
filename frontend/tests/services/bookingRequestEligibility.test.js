// bookingRequestEligibility.test.js
//
// SCRUM-254. When the request button is offered, from what the screen holds.
// The backend decides again; this only saves a button that can only be refused.

import { describe, it, expect } from "vitest";

import {
  BOOKABLE_EVENT_STATUSES,
  bookingRequestEligibility,
} from "../../src/services/bookingRequestEligibility.js";

const USER = "user-1";
const EVENT = {
  id: "e1",
  status: "approved",
  assignedCoordinatorId: USER,
  proposedStart: "2026-12-01T09:00:00Z",
  proposedEnd: "2026-12-01T17:00:00Z",
};

describe("bookingRequestEligibility", () => {
  it.each(BOOKABLE_EVENT_STATUSES)("SCRUM254_allows_the_assigned_coordinator_of_a_%s_event", (status) => {
    expect(bookingRequestEligibility({ ...EVENT, status }, USER)).toEqual({ eligible: true, reason: null });
  });

  it("SCRUM254_only_approved_and_confirmed_are_bookable", () => {
    expect(BOOKABLE_EVENT_STATUSES).toEqual(["approved", "confirmed"]);
  });

  it.each(["submitted", "under_review", "pending_clarification", "planning", "completed", "rejected", "cancelled"])(
    "SCRUM254_refuses_a_%s_event_and_says_why",
    (status) => {
      const result = bookingRequestEligibility({ ...EVENT, status }, USER);
      expect(result.eligible).toBe(false);
      expect(result.reason).toMatch(/approved or confirmed/);
      expect(result.reason).toContain(status.replaceAll("_", " "));
    },
  );

  it("SCRUM254_refuses_a_coordinator_who_is_not_assigned", () => {
    const result = bookingRequestEligibility(EVENT, "someone-else");
    expect(result).toMatchObject({ eligible: false });
    expect(result.reason).toMatch(/assigned to this event/);
  });

  it.each([undefined, null, ""])("SCRUM254_refuses_when_the_user_is_%j", (userId) => {
    expect(bookingRequestEligibility(EVENT, userId).eligible).toBe(false);
  });

  it("SCRUM254_an_event_with_no_assigned_coordinator_matches_nobody", () => {
    expect(bookingRequestEligibility({ ...EVENT, assignedCoordinatorId: null }, USER).eligible).toBe(false);
  });

  it.each([
    ["no start", { proposedStart: null }],
    ["no end", { proposedEnd: null }],
  ])("SCRUM254_refuses_an_event_with_%s", (_label, patch) => {
    const result = bookingRequestEligibility({ ...EVENT, ...patch }, USER);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/proposed start and end/);
  });

  it.each([undefined, null, {}])("SCRUM254_refuses_when_there_is_no_event_%j", (event) => {
    const result = bookingRequestEligibility(event, USER);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/from an event/);
  });

  it("SCRUM254_names_an_unknown_status_as_unknown", () => {
    expect(bookingRequestEligibility({ ...EVENT, status: undefined }, USER).reason).toContain("unknown");
  });
});
