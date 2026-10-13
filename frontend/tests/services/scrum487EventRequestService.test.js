// scrum487EventRequestService.test.js
//
// SCRUM-487 (SCRUM-544): the two calls the Lead's coordinator overview makes.
// apiClient is mocked, so nothing touches the network. A file of its own,
// beside SCRUM-486's eventRequestService.lead.test.js, which stays unedited.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import {
  listAssignedEventsForLead,
  listCoordinatorOverview,
} from "../../src/services/eventRequestService.js";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn() },
}));

const COORDINATOR_ID = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.get).mockResolvedValue({ data: [] });
});

describe("SCRUM487 the overview's calls", () => {
  it("SCRUM487_AC2_the_counts_are_a_get_of_/event-requests/coordinator-overview", async () => {
    const rows = [{ id: COORDINATOR_ID, fullName: "Priya Nair", activeEvents: 1, byStatus: { approved: 1 } }];
    vi.mocked(apiClient.get).mockResolvedValue({ data: rows });

    await expect(listCoordinatorOverview()).resolves.toEqual(rows);

    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith("/event-requests/coordinator-overview");
  });

  it.each([
    ["no argument", undefined],
    ["no filters set", {}],
    ["every filter empty or off", { coordinatorId: "", status: "", includeFinished: false }],
  ])("SCRUM487_AC3_with_%s_the_list_call_is_scrum486s_with_no_params", async (_label, filters) => {
    // The request SCRUM-486 made: the path and nothing else.
    await listAssignedEventsForLead(filters);

    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiClient.get).mock.calls[0]).toEqual(["/event-requests/assigned"]);
  });

  it.each([
    ["coordinator only", { coordinatorId: COORDINATOR_ID }, { coordinatorId: COORDINATOR_ID }],
    ["status only", { status: "approved" }, { status: "approved" }],
    [
      "all three",
      { coordinatorId: COORDINATOR_ID, status: "completed", includeFinished: true },
      { coordinatorId: COORDINATOR_ID, status: "completed", includeFinished: "true" },
    ],
  ])("SCRUM487_AC3_%s_sends_exactly_those_params", async (_label, filters, params) => {
    // Only what is set, and includeFinished as the string the server reads.
    const rows = [{ id: "e1" }];
    vi.mocked(apiClient.get).mockResolvedValue({ data: rows });

    await expect(listAssignedEventsForLead(filters)).resolves.toEqual(rows);

    expect(vi.mocked(apiClient.get).mock.calls[0]).toEqual(["/event-requests/assigned", { params }]);
  });
});
