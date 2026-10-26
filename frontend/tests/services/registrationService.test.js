import { describe, it, expect, vi, beforeEach } from "vitest";
import { apiClient } from "../../src/services/apiClient";
import { joinWaitlist, registerForEvent } from "../../src/services/registrationService";

vi.mock("../../src/services/apiClient", () => ({ apiClient: { post: vi.fn() } }));
beforeEach(() => { vi.mocked(apiClient.post).mockReset(); });

describe("SCRUM36 registration API service", () => {
  it("SCRUM36_AC3_posts_only_the_event_path_and_returns_the_server_registration", async () => {
    const registration = { id: "r1", eventRequestId: "e1", status: "registered" };
    vi.mocked(apiClient.post).mockResolvedValue({ data: registration });
    await expect(registerForEvent("e1")).resolves.toBe(registration);
    expect(apiClient.post).toHaveBeenCalledExactlyOnceWith("/open-events/e1/registrations");
  });

  it("SCRUM36_AC3_encodes_the_event_id", async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ data: {} });
    await registerForEvent("a/b?c");
    expect(apiClient.post).toHaveBeenCalledWith("/open-events/a%2Fb%3Fc/registrations");
  });

  it("SCRUM36_AC7_preserves_server_failures", async () => {
    const error = { response: { status: 409, data: { error: "Event is full", code: "EVENT_FULL" } } };
    vi.mocked(apiClient.post).mockRejectedValue(error);
    await expect(registerForEvent("e1")).rejects.toBe(error);
  });
});

describe("SCRUM460 waiting-list API service", () => {
  it("SCRUM460_AC1_posts_to_the_events_waiting_list_and_returns_the_place", async () => {
    const place = { id: "r1", status: "waitlisted", waitlistPosition: 1 };
    vi.mocked(apiClient.post).mockResolvedValue({ data: place });
    await expect(joinWaitlist("a/b")).resolves.toBe(place);
    expect(apiClient.post).toHaveBeenCalledExactlyOnceWith("/open-events/a%2Fb/waitlist");
  });
});
