// eventRequestService.lead.test.js
//
// SCRUM-486 (SCRUM-519): the three calls the Event Coordinator Lead's screens
// make. apiClient is mocked, so nothing touches the network. Neither sends the
// caller's id: the backend takes it from the token.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import {
  listUnassignedEventRequests,
  listCoordinatorWorkload,
  assignEventRequest,
} from "../../src/services/eventRequestService.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn() },
}));

const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const COORDINATOR_ID = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.post).mockReset();
});

describe("SCRUM486 the Lead's calls", () => {
  it("SCRUM486_AC2_the_queue_is_a_get_of_/event-requests/unassigned", async () => {
    const rows = [{ id: REQUEST_ID, eventName: "IS212 Industry Night" }];
    vi.mocked(apiClient.get).mockResolvedValue({ data: rows });

    await expect(listUnassignedEventRequests()).resolves.toEqual(rows);

    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith("/event-requests/unassigned");
  });

  it("SCRUM486_AC3_the_picker_is_a_get_of_/event-requests/coordinator-workload", async () => {
    const coordinators = [{ id: COORDINATOR_ID, fullName: "Priya Nair", activeEvents: 2 }];
    vi.mocked(apiClient.get).mockResolvedValue({ data: coordinators });

    await expect(listCoordinatorWorkload()).resolves.toEqual(coordinators);

    expect(apiClient.get).toHaveBeenCalledWith("/event-requests/coordinator-workload");
  });

  it("SCRUM486_AC3_an_assignment_posts_the_coordinator_and_the_note_and_nothing_else", async () => {
    const updated = { id: REQUEST_ID, assignedCoordinatorId: COORDINATOR_ID };
    vi.mocked(apiClient.post).mockResolvedValue({ data: updated });

    await expect(
      assignEventRequest(REQUEST_ID, { coordinatorId: COORDINATOR_ID, note: "Over to you" }),
    ).resolves.toEqual(updated);

    expect(apiClient.post).toHaveBeenCalledWith(`/event-requests/${REQUEST_ID}/assign`, {
      coordinatorId: COORDINATOR_ID,
      note: "Over to you",
    });
  });

  it("SCRUM486_AC4_a_refusal_reaches_the_caller_untouched", async () => {
    // The screen reads status, code and conflicts off the error, so the
    // service must not catch or rewrap it.
    const refusal = Object.assign(new Error("Request failed with status code 409"), {
      response: { status: 409, data: { code: "ALREADY_ASSIGNED", conflicts: [] } },
    });
    vi.mocked(apiClient.post).mockRejectedValue(refusal);

    await expect(assignEventRequest(REQUEST_ID, { coordinatorId: COORDINATOR_ID })).rejects.toBe(refusal);
  });
});
