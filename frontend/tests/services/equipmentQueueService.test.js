// Tests for the equipment queue service call (SCRUM-287, part of SCRUM-284).
// It sends the right path and only the filters that were set, and returns the body.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn() },
}));

import { apiClient } from "../../src/services/apiClient";
import { QUEUE_STATUSES, getEquipmentQueue } from "../../src/services/equipmentQueueService";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("equipmentQueueService", () => {
  it("SCRUM287_AC2_asks_for_every_status_without_past_events_by_default", async () => {
    apiClient.get.mockResolvedValue({ data: { needsAction: [], requests: [] } });

    await expect(getEquipmentQueue()).resolves.toEqual({ needsAction: [], requests: [] });
    expect(apiClient.get).toHaveBeenCalledWith("/equipment-requests", { params: {} });
  });

  it("SCRUM287_AC2_sends_the_status_filter", async () => {
    apiClient.get.mockResolvedValue({ data: {} });
    await getEquipmentQueue({ status: "arranged" });
    expect(apiClient.get).toHaveBeenCalledWith("/equipment-requests", { params: { status: "arranged" } });
  });

  it("SCRUM287_AC2_sends_includePast_only_when_it_is_on", async () => {
    apiClient.get.mockResolvedValue({ data: {} });
    await getEquipmentQueue({ includePast: true });
    expect(apiClient.get).toHaveBeenCalledWith("/equipment-requests", { params: { includePast: "true" } });

    apiClient.get.mockClear();
    await getEquipmentQueue({ includePast: false });
    expect(apiClient.get).toHaveBeenCalledWith("/equipment-requests", { params: {} });
  });

  it("SCRUM287_AC2_an_empty_status_is_not_sent", async () => {
    apiClient.get.mockResolvedValue({ data: {} });
    await getEquipmentQueue({ status: "", includePast: true });
    expect(apiClient.get).toHaveBeenCalledWith("/equipment-requests", { params: { includePast: "true" } });
  });

  it("SCRUM287_AC2_lets_a_failure_reach_the_caller", async () => {
    const failure = { response: { status: 403 } };
    apiClient.get.mockRejectedValue(failure);
    await expect(getEquipmentQueue()).rejects.toBe(failure);
  });

  it("SCRUM287_AC2_the_filter_offers_the_five_statuses_the_server_knows", () => {
    expect(QUEUE_STATUSES.map((s) => s.value)).toEqual([
      "pending_review",
      "under_review",
      "arranged",
      "cannot_be_fully_arranged",
      "cancelled",
    ]);
  });
});
