// changeRequestService.test.js
//
// SCRUM-402: the Organiser's change request calls. apiClient is mocked, so
// nothing touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import { getChangeRequests, submitChangeRequest } from "../../src/services/changeRequestService.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn() },
}));

const EVENT_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.post).mockReset();
});

describe("SCRUM402 change request service", () => {
  it("SCRUM402_AC1_a_group_is_posted_to_the_events_change_requests", async () => {
    const created = { id: "cr1", status: "outstanding" };
    vi.mocked(apiClient.post).mockResolvedValue({ data: created });
    const payload = { changes: [{ field: "purpose", requestedValue: "New" }], note: "Please" };

    await expect(submitChangeRequest(EVENT_ID, payload)).resolves.toBe(created);
    expect(apiClient.post).toHaveBeenCalledExactlyOnceWith(`/event-requests/${EVENT_ID}/change-requests`, payload);
  });

  it("SCRUM402_AC10_the_organisers_submissions_are_read_from_the_same_path", async () => {
    const list = [{ id: "cr1", status: "processed" }];
    vi.mocked(apiClient.get).mockResolvedValue({ data: list });

    await expect(getChangeRequests(EVENT_ID)).resolves.toBe(list);
    expect(apiClient.get).toHaveBeenCalledExactlyOnceWith(`/event-requests/${EVENT_ID}/change-requests`);
  });
});
