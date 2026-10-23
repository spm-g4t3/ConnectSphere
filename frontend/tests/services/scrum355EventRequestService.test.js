// scrum355EventRequestService.test.js
//
// SCRUM-355: the two calls revise and resubmit makes. apiClient is mocked, so
// nothing touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import { reopenEventRequest, getEventDecisionHistory } from "../../src/services/eventRequestService.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn() },
}));

const EVENT_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.post).mockReset();
});

describe("SCRUM355 event request service", () => {
  it("SCRUM355_AC1_reopen_posts_to_the_reopen_endpoint_with_no_body", async () => {
    const draft = { id: EVENT_ID, status: "draft" };
    vi.mocked(apiClient.post).mockResolvedValue({ data: draft });

    await expect(reopenEventRequest(EVENT_ID)).resolves.toBe(draft);
    expect(apiClient.post).toHaveBeenCalledExactlyOnceWith(`/event-requests/${EVENT_ID}/reopen`);
  });

  it("SCRUM355_AC3_the_decision_history_is_read_from_its_endpoint", async () => {
    const history = [{ id: "d1", decision: "rejected" }];
    vi.mocked(apiClient.get).mockResolvedValue({ data: history });

    await expect(getEventDecisionHistory(EVENT_ID)).resolves.toBe(history);
    expect(apiClient.get).toHaveBeenCalledExactlyOnceWith(`/event-requests/${EVENT_ID}/decision-history`);
  });
});
