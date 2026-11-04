// scrum347EventRequestService.test.js
//
// SCRUM-347: rejecting an Approved event. apiClient is mocked, so nothing
// touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import { rejectApprovedEvent } from "../../src/services/eventRequestService.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { post: vi.fn() },
}));

const EVENT_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.mocked(apiClient.post).mockReset();
});

describe("SCRUM347 event request service", () => {
  it("SCRUM347_AC3_the_rejection_posts_only_the_reason", async () => {
    const rejected = { id: EVENT_ID, status: "rejected" };
    vi.mocked(apiClient.post).mockResolvedValue({ data: rejected });

    await expect(rejectApprovedEvent(EVENT_ID, { reason: "No venue", extra: "dropped" })).resolves.toBe(rejected);
    expect(apiClient.post).toHaveBeenCalledExactlyOnceWith(`/event-requests/${EVENT_ID}/rejection`, {
      reason: "No venue",
    });
  });
});
