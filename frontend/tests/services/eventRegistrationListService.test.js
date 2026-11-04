import { describe, it, expect, vi, beforeEach } from "vitest";
import { apiClient } from "../../src/services/apiClient";
import { getEventRegistrations } from "../../src/services/eventRegistrationService";
import { mayHaveRegistrationList } from "../../src/services/registrationStatuses";

vi.mock("../../src/services/apiClient", () => ({ apiClient: { get: vi.fn() } }));
beforeEach(() => { vi.mocked(apiClient.get).mockReset(); });

describe("SCRUM478 registration list API service", () => {
  it("SCRUM478_AC4_sends_hide_withdrawn_only_when_asked", async () => {
    const list = { entries: [] };
    vi.mocked(apiClient.get).mockResolvedValue({ data: list });
    await expect(getEventRegistrations("a/b")).resolves.toBe(list);
    expect(apiClient.get).toHaveBeenLastCalledWith("/registration/events/a%2Fb/registrations", { params: undefined });
    await getEventRegistrations("e1", { hideWithdrawn: true });
    expect(apiClient.get).toHaveBeenLastCalledWith("/registration/events/e1/registrations", { params: { hideWithdrawn: true } });
  });

  it("SCRUM478_AC6_offers_the_link_only_where_a_list_can_exist", () => {
    expect(["approved", "confirmed", "completed", "cancelled"].every(mayHaveRegistrationList)).toBe(true);
    expect(["draft", "submitted", "safety_review", "rejected"].some(mayHaveRegistrationList)).toBe(false);
  });
});
