// scrum355EventRequestService.test.js
//
// SCRUM-355: the two calls revise and resubmit makes. apiClient is mocked, so
// nothing touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import { reopenEventRequest, getEventDecisionHistory, updateEventRequest } from "../../src/services/eventRequestService.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));

const EVENT_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.post).mockReset();
  vi.mocked(apiClient.patch).mockReset();
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

  it("SCRUM355_AC3_a_draft_edit_patches_the_request_with_the_fields_given", async () => {
    const saved = { id: EVENT_ID, status: "draft", purpose: null };
    vi.mocked(apiClient.patch).mockResolvedValue({ data: saved });
    const input = { eventName: "Revised", purpose: null };

    await expect(updateEventRequest(EVENT_ID, input)).resolves.toBe(saved);
    expect(apiClient.patch).toHaveBeenCalledExactlyOnceWith(`/event-requests/${EVENT_ID}`, input);
  });
});
