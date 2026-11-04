// Tests for the availability service calls (SCRUM-70, part of SCRUM-23).

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn() },
}));

import { apiClient } from "../../src/services/apiClient";
import { checkEquipmentAvailability, listActiveEquipmentTypes } from "../../src/services/equipmentAvailabilityService";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("equipmentAvailabilityService", () => {
  it("SCRUM23_AC2_lists_the_active_equipment_types_for_the_picker", async () => {
    apiClient.get.mockResolvedValue({ data: [{ id: "p1", name: "Projector" }] });

    await expect(listActiveEquipmentTypes()).resolves.toEqual([{ id: "p1", name: "Projector" }]);
    expect(apiClient.get).toHaveBeenCalledWith("/equipment/active");
  });

  it("SCRUM23_AC2_sends_the_check_as_a_get_with_the_four_inputs_as_params", async () => {
    apiClient.get.mockResolvedValue({ data: { result: "Fully available" } });

    const result = await checkEquipmentAvailability({
      equipmentTypeId: "p1",
      quantity: "4",
      startAt: "2026-12-01T10:00:00+08:00",
      endAt: "2026-12-01T12:00:00+08:00",
    });

    expect(result).toEqual({ result: "Fully available" });
    expect(apiClient.get).toHaveBeenCalledWith("/equipment/availability", {
      params: {
        equipmentTypeId: "p1",
        quantity: "4",
        startAt: "2026-12-01T10:00:00+08:00",
        endAt: "2026-12-01T12:00:00+08:00",
      },
    });
  });

  it("SCRUM23_AC12_never_writes_so_there_is_no_post_put_patch_or_delete", async () => {
    apiClient.get.mockResolvedValue({ data: {} });

    await checkEquipmentAvailability({ equipmentTypeId: "p1", quantity: "1", startAt: "a", endAt: "b" });

    expect(Object.keys(apiClient)).toEqual(["get"]);
  });

  it("SCRUM23_lets_a_failed_request_through_for_the_caller_to_explain", async () => {
    const failure = Object.assign(new Error("failed"), { response: { status: 403 } });
    apiClient.get.mockRejectedValue(failure);

    await expect(checkEquipmentAvailability({})).rejects.toBe(failure);
  });
});
