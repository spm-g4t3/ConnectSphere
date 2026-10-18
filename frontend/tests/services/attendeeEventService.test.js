import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../../src/services/apiClient";
import { getRegisteredEvents, getAttendeeEvent } from "../../src/services/attendeeEventService";
import { REGISTERED_EVENTS_PATH, ATTENDEE_EVENT_ROUTE, attendeeEventPath } from "../../src/services/attendeeEventRoutes";

vi.mock("../../src/services/apiClient", () => ({ apiClient: { get: vi.fn() } }));
beforeEach(() => { vi.mocked(apiClient.get).mockReset(); });

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
