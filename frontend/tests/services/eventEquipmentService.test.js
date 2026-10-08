// eventEquipmentService.test.js
//
// SCRUM-247, for SCRUM-21. The service is five thin calls, so these tests pin
// what matters: the route and verb each one uses, what it sends, and that it
// hands back the response body untouched. Named SCRUM21_ACn_<what_it_checks>.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { get, post, patch, del } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get, post, patch, delete: del },
}));

const {
  addEquipmentLine,
  amendEquipmentLine,
  getActiveEquipmentTypes,
  getEventEquipment,
  removeEquipmentLine,
} = await import("../../src/services/eventEquipmentService");

const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const LINE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TYPE_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

beforeEach(() => {
  for (const fn of [get, post, patch, del]) fn.mockReset();
});

describe("the equipment calls", () => {
  it("SCRUM21_AC11_reads_the_events_equipment_and_returns_the_body", async () => {
    get.mockResolvedValue({ data: { request: null } });

    await expect(getEventEquipment(EVENT_ID)).resolves.toEqual({ request: null });
    expect(get).toHaveBeenCalledWith(`/event-requests/${EVENT_ID}/equipment`);
  });

  it("SCRUM21_AC2_adds_a_line_with_exactly_the_three_fields", async () => {
    post.mockResolvedValue({ data: { request: { id: "r1" } } });

    const result = await addEquipmentLine(EVENT_ID, {
      equipmentTypeId: TYPE_ID,
      quantity: 2,
      technicalNotes: "Needs HDMI",
      coordinatorId: "someone-else",
    });

    expect(post).toHaveBeenCalledWith(`/event-requests/${EVENT_ID}/equipment/lines`, {
      equipmentTypeId: TYPE_ID,
      quantity: 2,
      technicalNotes: "Needs HDMI",
    });
    expect(result).toEqual({ request: { id: "r1" } });
  });

  it("SCRUM21_AC6_amends_a_line_sending_only_the_keys_it_is_given", async () => {
    patch.mockResolvedValue({ data: { request: { id: "r1" } } });

    await amendEquipmentLine(EVENT_ID, LINE_ID, { quantity: 5 });

    expect(patch).toHaveBeenCalledWith(`/event-requests/${EVENT_ID}/equipment/lines/${LINE_ID}`, { quantity: 5 });
  });

  it("SCRUM21_AC6_can_clear_the_notes_by_sending_null", async () => {
    patch.mockResolvedValue({ data: {} });

    await amendEquipmentLine(EVENT_ID, LINE_ID, { technicalNotes: null });

    expect(patch.mock.calls[0][1]).toEqual({ technicalNotes: null });
  });

  it("SCRUM21_AC6_removes_a_line", async () => {
    del.mockResolvedValue({ data: { request: { status: "cancelled", lines: [] } } });

    await expect(removeEquipmentLine(EVENT_ID, LINE_ID)).resolves.toEqual({
      request: { status: "cancelled", lines: [] },
    });
    expect(del).toHaveBeenCalledWith(`/event-requests/${EVENT_ID}/equipment/lines/${LINE_ID}`);
  });

  it("SCRUM21_AC2_reads_the_active_catalogue_from_the_route_coordinators_may_read", async () => {
    get.mockResolvedValue({ data: [{ id: TYPE_ID, name: "Projector" }] });

    await expect(getActiveEquipmentTypes()).resolves.toEqual([{ id: TYPE_ID, name: "Projector" }]);
    expect(get).toHaveBeenCalledWith("/equipment/active");
  });

  it("SCRUM21_AC1_a_refusal_reaches_the_caller_with_its_response_intact", async () => {
    const refusal = Object.assign(new Error("403"), { response: { status: 403 } });
    post.mockRejectedValue(refusal);

    await expect(addEquipmentLine(EVENT_ID, { equipmentTypeId: TYPE_ID, quantity: 1 })).rejects.toBe(refusal);
  });
});
