import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../src/services/apiClient";
import { getRegisteredEvents, getAttendeeEvent, withdrawRegistration } from "../../src/services/attendeeEventService";
import { withdrawalFailure } from "../../src/services/withdrawalErrors";
import { httpError } from "../helpers/async.js";
import { REGISTERED_EVENTS_PATH, ATTENDEE_EVENT_ROUTE, attendeeEventPath } from "../../src/services/attendeeEventRoutes";

vi.mock("../../src/services/apiClient", () => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
beforeEach(() => { vi.mocked(apiClient.get).mockReset(); vi.mocked(apiClient.post).mockReset(); });

describe("SCRUM-24 attendee information service", () => {
  it("SCRUM24_AC1_loads_own_registrations_without_client_identity_or_availability_filters", async () => {
    const rows = [{ eventRequestId: "e1", eventName: "Registered event" }];
    vi.mocked(apiClient.get).mockResolvedValue({ data: rows });
    await expect(getRegisteredEvents()).resolves.toBe(rows);
    expect(apiClient.get).toHaveBeenCalledExactlyOnceWith("/attendee-events");
  });

  it("SCRUM24_AC2_loads_protected_information_and_encodes_the_event_id", async () => {
    const data = { eventRequestId: "e1", state: "unavailable" };
    vi.mocked(apiClient.get).mockResolvedValue({ data });
    await expect(getAttendeeEvent("a/b?c")).resolves.toBe(data);
    expect(apiClient.get).toHaveBeenCalledExactlyOnceWith("/attendee-events/a%2Fb%3Fc");
  });

  it.each(["list", "detail"])(
    "SCRUM24_AC1_service_failures_reach_the_view_without_mock_success_%s", async kind => {
      const error = new Error("Network failure");
      vi.mocked(apiClient.get).mockRejectedValue(error);
      await expect(kind === "list" ? getRegisteredEvents() : getAttendeeEvent("e1")).rejects.toBe(error);
    },
  );

  it("SCRUM24_AC1_registered_event_paths_are_separate_from_registration_previews", () => {
    expect(REGISTERED_EVENTS_PATH).toBe("/registered-events");
    expect(ATTENDEE_EVENT_ROUTE).toBe("/registered-events/:eventId");
    expect(attendeeEventPath("a/b?c")).toBe("/registered-events/a%2Fb%3Fc");
  });
});

describe("SCRUM-27 withdrawal service", () => {
  it("SCRUM27_AC3_posts_only_the_encoded_registration_id", async () => {
    const data = { id: "r1", status: "withdrawn" };
    vi.mocked(apiClient.post).mockResolvedValue({ data });
    await expect(withdrawRegistration("a/b?c")).resolves.toBe(data);
    expect(apiClient.post).toHaveBeenCalledExactlyOnceWith("/attendee-events/registrations/a%2Fb%3Fc/withdrawal");
  });

  it("SCRUM27_AC7_a_failure_reaches_the_view_unchanged", async () => {
    const error = httpError(409, { error: "Refused" });
    vi.mocked(apiClient.post).mockRejectedValue(error);
    await expect(withdrawRegistration("r1")).rejects.toBe(error);
  });

  it.each([
    [httpError(409, { error: "x", code: "WITHDRAWAL_DEADLINE_PASSED" }), /deadline for this event has passed/, true],
    [httpError(409, { error: "x", code: "WITHDRAWAL_DEADLINE_NOT_SET" }), /no withdrawal deadline/, true],
    [httpError(409, { error: "x", code: "REGISTRATION_NOT_CONFIRMED" }), /Only a confirmed registration/, true],
    [httpError(409, { error: "x", code: "ALREADY_WITHDRAWN" }), /already been withdrawn/, true],
    [httpError(409, { error: "x", code: "EVENT_NOT_ACTIVE" }), /^Registrations for this event can no longer be withdrawn/, true],
    [httpError(409, { error: "x", code: "EVENT_STARTED" }), /already started/, true],
    [httpError(409, { error: "A reason added later", code: "NEW_REASON" }), /^A reason added later$/, true],
    [httpError(404, { error: "Registration not found" }), /could not be found/, true],
    [httpError(403), /Only Attendees/, true],
    [httpError(401), /session has expired/, true],
    [httpError(409, { error: "x", code: "REGISTRATION_CHANGED" }), /Please try again/, false],
    [httpError(409, { error: "  " }), /^This registration cannot be withdrawn/, true],
    [httpError(503), /temporarily unavailable/, false],
    [httpError(500), /could not be withdrawn/, false],
    [httpError(400, { error: "Invalid withdrawal request" }), /^This registration cannot be withdrawn/, true],
    [httpError(422), /^This registration cannot be withdrawn/, true],
    [httpError(408), /could not be withdrawn/, false],
    [httpError(429), /could not be withdrawn/, false],
    [Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" }), /Could not reach the server/, false],
    [new Error("boom"), /could not be withdrawn/, false],
  ])("SCRUM27_AC7_maps_failure_%#_to_a_message_and_whether_it_is_a_rejection", (error, message, rejected) => {
    const failure = withdrawalFailure(error);
    expect(failure.message).toMatch(message);
    expect(failure.rejected).toBe(rejected);
  });

  it("SCRUM27_AC7_never_says_whether_a_missing_registration_belongs_to_someone_else", () => {
    expect(withdrawalFailure(httpError(404, { error: "anything" })))
      .toEqual(withdrawalFailure(httpError(404, { error: "Registration not found" })));
  });
});
