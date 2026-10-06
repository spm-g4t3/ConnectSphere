// Tests for the equipment service calls (SCRUM-280, part of SCRUM-275).
// Each function sends the right method, path and body, and returns the body.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));

import { apiClient } from "../../src/services/apiClient";
import {
  listEquipment,
  createEquipment,
  updateEquipment,
  recordEquipmentCondition,
  retireEquipment,
  reinstateEquipment,
  getEquipmentHistory,
} from "../../src/services/equipmentService";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("equipmentService", () => {
  it("SCRUM275_AC5_lists_the_whole_catalogue", async () => {
    apiClient.get.mockResolvedValue({ data: [{ id: "a" }] });

    await expect(listEquipment()).resolves.toEqual([{ id: "a" }]);
    expect(apiClient.get).toHaveBeenCalledWith("/equipment");
  });

  it("SCRUM275_AC2_creates_a_type", async () => {
    apiClient.post.mockResolvedValue({ data: { id: "a" } });

    await expect(createEquipment({ name: "Cable", totalQuantity: 3 })).resolves.toEqual({ id: "a" });
    expect(apiClient.post).toHaveBeenCalledWith("/equipment", { name: "Cable", totalQuantity: 3 });
  });

  it("SCRUM275_AC3_edits_a_type_with_only_the_changes", async () => {
    apiClient.patch.mockResolvedValue({ data: { id: "a" } });

    await updateEquipment("a", { location: "Store 2" });

    expect(apiClient.patch).toHaveBeenCalledWith("/equipment/a", { location: "Store 2" });
  });

  it("SCRUM275_AC4_records_damaged_and_maintenance_quantities_with_a_note", async () => {
    apiClient.patch.mockResolvedValue({ data: { id: "a" } });

    await recordEquipmentCondition("a", { damagedQuantity: 2, note: "dropped" });

    expect(apiClient.patch).toHaveBeenCalledWith("/equipment/a/condition", { damagedQuantity: 2, note: "dropped" });
  });

  it("SCRUM275_AC6_retires_and_reinstates_with_a_post", async () => {
    apiClient.post.mockResolvedValue({ data: { id: "a" } });

    await retireEquipment("a");
    await reinstateEquipment("a");

    expect(apiClient.post).toHaveBeenNthCalledWith(1, "/equipment/a/retire");
    expect(apiClient.post).toHaveBeenNthCalledWith(2, "/equipment/a/reinstate");
  });

  it("SCRUM275_AC8_reads_a_types_history", async () => {
    apiClient.get.mockResolvedValue({ data: [{ id: 1 }] });

    await expect(getEquipmentHistory("a")).resolves.toEqual([{ id: 1 }]);
    expect(apiClient.get).toHaveBeenCalledWith("/equipment/a/history");
  });

  it("SCRUM275_lets_a_failed_request_through_for_the_caller_to_explain", async () => {
    const failure = Object.assign(new Error("failed"), { response: { status: 403 } });
    apiClient.get.mockRejectedValue(failure);

    await expect(listEquipment()).rejects.toBe(failure);
  });
});
