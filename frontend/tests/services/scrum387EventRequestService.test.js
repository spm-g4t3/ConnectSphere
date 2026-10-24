// scrum387EventRequestService.test.js
//
// SCRUM-387: the edit and the history read, against PATCH /:id/details and
// GET /:id/change-history (brief 1). apiClient is mocked, so nothing touches
// the network.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import { getEventChangeHistory, updateEventRequestDetails } from "../../src/services/eventRequestService.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), patch: vi.fn() },
}));

const EVENT_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.patch).mockReset();
});

describe("SCRUM387 event request service", () => {
  it("SCRUM387_AC9_the_edit_patches_the_details_endpoint_with_changes_expected_and_reason", async () => {
    const saved = { id: EVENT_ID, changedFields: ["purpose"] };
    vi.mocked(apiClient.patch).mockResolvedValue({ data: saved });
    const body = { changes: { purpose: "New" }, expected: { purpose: "Old" }, reason: "Why" };

    await expect(updateEventRequestDetails(EVENT_ID, { ...body, extra: "dropped" })).resolves.toBe(saved);
    expect(apiClient.patch).toHaveBeenCalledExactlyOnceWith(`/event-requests/${EVENT_ID}/details`, body);
  });

  it("SCRUM387_AC7_the_change_history_is_read_from_its_endpoint", async () => {
    const history = [{ id: "h1", field: "purpose" }];
    vi.mocked(apiClient.get).mockResolvedValue({ data: history });

    await expect(getEventChangeHistory(EVENT_ID)).resolves.toBe(history);
    expect(apiClient.get).toHaveBeenCalledExactlyOnceWith(`/event-requests/${EVENT_ID}/change-history`);
  });
});
