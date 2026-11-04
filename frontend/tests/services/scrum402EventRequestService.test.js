// scrum402EventRequestService.test.js
//
// SCRUM-402: the coordinator's change request calls. apiClient is mocked, so
// nothing touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import {
  getCoordinatorChangeRequests,
  previewCoordinatorChangeRequest,
  processCoordinatorChangeRequest,
} from "../../src/services/eventRequestService.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn() },
}));

const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const CHANGE_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.post).mockReset();
});

describe("SCRUM402 event request service", () => {
  it("SCRUM402_AC1_the_coordinator_reads_the_events_change_requests_from_the_review_endpoint", async () => {
    const groups = [{ id: CHANGE_ID, status: "outstanding" }];
    vi.mocked(apiClient.get).mockResolvedValue({ data: groups });

    await expect(getCoordinatorChangeRequests(EVENT_ID)).resolves.toBe(groups);
    expect(apiClient.get).toHaveBeenCalledExactlyOnceWith(`/event-requests/${EVENT_ID}/change-requests/review`);
  });

  it("SCRUM402_AC3_a_decision_posts_the_whole_decision_for_the_group", async () => {
    const processed = { id: CHANGE_ID, status: "processed" };
    vi.mocked(apiClient.post).mockResolvedValue({ data: processed });
    const decision = { decision: "declined", decisionNotes: "Not feasible" };

    await expect(processCoordinatorChangeRequest(CHANGE_ID, decision)).resolves.toBe(processed);
    expect(apiClient.post).toHaveBeenCalledExactlyOnceWith(
      `/event-requests/change-requests/${CHANGE_ID}/decision`,
      decision,
    );
  });

  it("SCRUM402_AC4_the_preview_is_a_get_that_changes_nothing", async () => {
    const preview = { ordinary: ["purpose"], significant: [] };
    vi.mocked(apiClient.get).mockResolvedValue({ data: preview });

    await expect(previewCoordinatorChangeRequest(CHANGE_ID)).resolves.toBe(preview);
    expect(apiClient.get).toHaveBeenCalledExactlyOnceWith(`/event-requests/change-requests/${CHANGE_ID}/preview`);
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});
