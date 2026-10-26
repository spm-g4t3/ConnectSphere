// Tests for the service, error and wording pieces behind the confirmation step.
//
//   - the preview call and the bodies the save calls carry
//   - the refusal "the list moved" is recognised, and its list read safely
//   - how an affected reservation is worded (event, period, quantity, coordinator)

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/services/apiClient", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));

import { apiClient } from "../../src/services/apiClient";
import {
  previewEquipmentChange,
  retireEquipment,
  updateEquipment,
  recordEquipmentCondition,
} from "../../src/services/equipmentService";
import {
  equipmentErrorMessages,
  isAffectedChangedError,
  affectedFromError,
  isStaleEquipmentError,
} from "../../src/services/equipmentErrors";
import { describeAffected, summariseAffected, impactHeading } from "../../src/services/equipmentImpactDisplay";
import { formatEventPeriod } from "../../src/services/eventPeriodFormat";

const failure = (status, data) => ({ response: { status, data } });

const R1 = "11111111-1111-4111-8111-111111111111";
const item = (overrides = {}) => ({
  reservationId: R1,
  eventRequestId: "e1",
  eventName: "Open Day",
  equipmentLineId: "l1",
  quantity: 3,
  startAt: "2026-11-05T01:00:00+00:00",
  endAt: "2026-11-05T05:00:00+00:00",
  coordinatorId: "c1",
  coordinatorName: "Cara Coordinator",
  flagged: false,
  reservedAt: "2026-10-01T00:00:00+00:00",
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe("SCRUM310 the calls", () => {
  it("SCRUM310_AC2_previews_a_change_with_a_post_to_the_change_preview_path_and_returns_the_body", async () => {
    const preview = { usableBefore: 7, usableAfter: 2, affectedCount: 0, affectedUnits: 0, affected: [] };
    apiClient.post.mockResolvedValue({ data: preview });

    await expect(previewEquipmentChange("a", { totalQuantity: 4 })).resolves.toEqual(preview);
    expect(apiClient.post).toHaveBeenCalledWith("/equipment/a/change-preview", { totalQuantity: 4 });
  });

  it.each([
    ["a total", { totalQuantity: 4 }],
    ["damage", { damagedQuantity: 2 }],
    ["maintenance", { underMaintenanceQuantity: 2 }],
    ["a retirement", { retire: true }],
  ])("SCRUM310_AC2_sends_the_body_for_%s_as_it_was_given", async (_label, body) => {
    apiClient.post.mockResolvedValue({ data: {} });

    await previewEquipmentChange("a", body);

    expect(apiClient.post.mock.calls[0][1]).toEqual(body);
  });

  it("SCRUM310_AC2_a_preview_never_uses_patch_or_a_get", async () => {
    apiClient.post.mockResolvedValue({ data: {} });

    await previewEquipmentChange("a", { retire: true });

    expect(apiClient.patch).not.toHaveBeenCalled();
    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it("SCRUM310_AC2_retires_with_the_confirmed_reservations_in_the_body", async () => {
    apiClient.post.mockResolvedValue({ data: { id: "a" } });

    await retireEquipment("a", { confirmedReservationIds: [R1] });

    expect(apiClient.post).toHaveBeenCalledWith("/equipment/a/retire", { confirmedReservationIds: [R1] });
  });

  it("SCRUM310_AC2_retires_with_an_empty_body_when_none_is_given", async () => {
    apiClient.post.mockResolvedValue({ data: { id: "a" } });

    await retireEquipment("a");

    expect(apiClient.post).toHaveBeenCalledWith("/equipment/a/retire", {});
  });

  it("SCRUM310_AC2_an_edit_and_a_condition_change_carry_the_confirmed_list_through_unchanged", async () => {
    apiClient.patch.mockResolvedValue({ data: {} });

    await updateEquipment("a", { totalQuantity: 3, note: "why", confirmedReservationIds: [R1] });
    await recordEquipmentCondition("a", { damagedQuantity: 3, note: "x", confirmedReservationIds: [] });

    expect(apiClient.patch).toHaveBeenNthCalledWith(1, "/equipment/a", {
      totalQuantity: 3,
      note: "why",
      confirmedReservationIds: [R1],
    });
    expect(apiClient.patch).toHaveBeenNthCalledWith(2, "/equipment/a/condition", {
      damagedQuantity: 3,
      note: "x",
      confirmedReservationIds: [],
    });
  });

  it("SCRUM310_AC2_lets_a_failed_preview_through_for_the_caller_to_explain", async () => {
    const err = failure(409, { code: "EQUIPMENT_ALREADY_RETIRED" });
    apiClient.post.mockRejectedValue(err);

    await expect(previewEquipmentChange("a", { retire: true })).rejects.toBe(err);
  });
});

describe("SCRUM310 the messages", () => {
  it("SCRUM310_AC2_explains_the_list_moved_refusal_and_says_nothing_was_saved", () => {
    const [message] = equipmentErrorMessages(failure(409, { code: "EQUIPMENT_AFFECTED_CHANGED", conflicts: [] }), "condition");

    expect(message).toMatch(/changed since you looked/);
    expect(message).toMatch(/Nothing was saved/);
    expect(message).toMatch(/confirm again/);
  });

  it("SCRUM310_AC2_has_a_message_for_a_failed_preview_that_says_nothing_was_saved", () => {
    expect(equipmentErrorMessages(failure(500, { error: "driver text" }), "preview")).toEqual([
      "Could not check which reservations this change affects. Nothing was saved. Please try again.",
    ]);
    expect(equipmentErrorMessages(new Error("network down"), "preview")).toEqual([
      "Could not check which reservations this change affects. Nothing was saved. Please try again.",
    ]);
  });

  it("SCRUM310_AC2_shows_every_validation_error_from_a_failed_preview", () => {
    const err = failure(400, {
      details: [{ field: "damagedQuantity", message: "must be zero or more" }, { field: "totalQuantity", message: "is required" }],
    });

    expect(equipmentErrorMessages(err, "preview")).toEqual([
      "Damaged: must be zero or more",
      "Total quantity: is required",
    ]);
  });

  it.each([
    [401, "Your session has expired. Please sign in again."],
    [403, "Only Technical Support Staff can manage the equipment catalogue."],
    [404, "That equipment type no longer exists. The list has been refreshed."],
  ])("SCRUM310_AC2_a_failed_preview_with_status_%s_uses_the_status_message", (status, message) => {
    expect(equipmentErrorMessages(failure(status, {}), "preview")).toEqual([message]);
  });

  it("SCRUM310_AC2_a_preview_of_a_type_that_is_already_retired_says_so", () => {
    expect(equipmentErrorMessages(failure(409, { code: "EQUIPMENT_ALREADY_RETIRED" }), "preview")).toEqual([
      "This type has already been retired. The list has been refreshed.",
    ]);
  });

  it("SCRUM310_AC2_never_shows_the_servers_text_for_the_list_moved_refusal", () => {
    const messages = equipmentErrorMessages(
      failure(409, { code: "EQUIPMENT_AFFECTED_CHANGED", error: "secret database prose", conflicts: [] }),
      "retire",
    );

    expect(messages.join(" ")).not.toContain("secret");
  });
});

describe("SCRUM310 recognising the list moved refusal", () => {
  it("SCRUM310_AC2_is_true_for_a_409_with_that_code", () => {
    expect(isAffectedChangedError(failure(409, { code: "EQUIPMENT_AFFECTED_CHANGED" }))).toBe(true);
  });

  it.each([
    ["a 409 with another code", failure(409, { code: "EQUIPMENT_ALREADY_RETIRED" })],
    ["a 409 with no code", failure(409, {})],
    ["a 400 carrying that code", failure(400, { code: "EQUIPMENT_AFFECTED_CHANGED" })],
    ["a 500 carrying that code", failure(500, { code: "EQUIPMENT_AFFECTED_CHANGED" })],
    ["a 409 with no body", failure(409, undefined)],
    ["a network error", new Error("network")],
    ["null", null],
    ["undefined", undefined],
    ["text", "EQUIPMENT_AFFECTED_CHANGED"],
  ])("SCRUM310_AC2_is_false_for_%s", (_label, err) => {
    expect(isAffectedChangedError(err)).toBe(false);
  });

  it("SCRUM310_AC2_the_list_moved_refusal_is_not_a_stale_row_so_the_catalogue_is_not_refetched", () => {
    expect(isStaleEquipmentError(failure(409, { code: "EQUIPMENT_AFFECTED_CHANGED" }))).toBe(false);
  });
});

describe("SCRUM310 reading the new list out of the refusal", () => {
  it("SCRUM310_AC2_returns_the_conflicts_in_order", () => {
    const a = item({ reservationId: R1 });
    const b = item({ reservationId: "22222222-2222-4222-8222-222222222222", eventName: "Gala" });

    expect(affectedFromError(failure(409, { conflicts: [a, b] }))).toEqual([a, b]);
  });

  it("SCRUM310_AC2_an_empty_list_is_an_empty_list", () => {
    expect(affectedFromError(failure(409, { conflicts: [] }))).toEqual([]);
  });

  it.each([
    ["no conflicts key", failure(409, {})],
    ["null conflicts", failure(409, { conflicts: null })],
    ["conflicts as an object", failure(409, { conflicts: { reservationId: R1 } })],
    ["conflicts as text", failure(409, { conflicts: "all" })],
    ["no body", failure(409, undefined)],
    ["no response", new Error("network")],
    ["null", null],
  ])("SCRUM310_AC2_reads_%s_as_an_empty_list", (_label, err) => {
    expect(affectedFromError(err)).toEqual([]);
  });

  it("SCRUM310_AC2_drops_entries_that_are_not_reservations", () => {
    const good = item();

    expect(
      affectedFromError(failure(409, { conflicts: [null, "x", 4, {}, { reservationId: 7 }, good, [good]] })),
    ).toEqual([good]);
  });
});

describe("SCRUM310 wording one affected reservation", () => {
  it("SCRUM310_AC2_gives_event_period_quantity_and_coordinator", () => {
    expect(describeAffected(item())).toEqual({
      id: R1,
      eventName: "Open Day",
      period: formatEventPeriod("2026-11-05T01:00:00+00:00", "2026-11-05T05:00:00+00:00"),
      quantity: "3 units",
      coordinator: "Cara Coordinator",
      alreadyFlagged: false,
    });
  });

  it("SCRUM310_AC2_writes_the_period_in_singapore_time", () => {
    const { period } = describeAffected(item());

    expect(period).toContain("5 Nov 2026");
    expect(period).toMatch(/9:00\s?am/i);
    expect(period).toMatch(/1:00\s?pm/i);
  });

  it("SCRUM310_AC2_says_one_unit_in_the_singular", () => {
    expect(describeAffected(item({ quantity: 1 })).quantity).toBe("1 unit");
  });

  it.each([
    ["no name", { eventName: null }],
    ["a blank name", { eventName: "   " }],
    ["a name that is not text", { eventName: 5 }],
  ])("SCRUM310_AC2_calls_an_event_with_%s_untitled", (_label, overrides) => {
    expect(describeAffected(item(overrides)).eventName).toBe("Untitled event");
  });

  it.each([
    ["no coordinator", { coordinatorName: null }],
    ["a blank coordinator", { coordinatorName: "  " }],
    ["a coordinator that is not text", { coordinatorName: 9 }],
  ])("SCRUM310_AC2_says_so_when_there_is_%s", (_label, overrides) => {
    expect(describeAffected(item(overrides)).coordinator).toBe("No coordinator assigned");
  });

  it("SCRUM310_AC2_trims_names", () => {
    const described = describeAffected(item({ eventName: "  Open Day ", coordinatorName: " Cara " }));

    expect(described.eventName).toBe("Open Day");
    expect(described.coordinator).toBe("Cara");
  });

  it.each([
    ["missing", {}],
    ["not a number", { quantity: "3" }],
    ["not finite", { quantity: Infinity }],
  ])("SCRUM310_AC2_reads_a_quantity_that_is_%s_as_zero_units", (_label, overrides) => {
    const base = item();
    delete base.quantity;
    expect(describeAffected({ ...base, ...overrides }).quantity).toBe("0 units");
  });

  it("SCRUM310_AC2_marks_a_reservation_that_was_already_flagged", () => {
    expect(describeAffected(item({ flagged: true })).alreadyFlagged).toBe(true);
    expect(describeAffected(item({ flagged: "yes" })).alreadyFlagged).toBe(false);
    expect(describeAffected(item({ flagged: undefined })).alreadyFlagged).toBe(false);
  });

  it("SCRUM310_AC2_a_reservation_without_dates_gets_the_not_set_wording_and_does_not_throw", () => {
    expect(describeAffected(item({ startAt: null, endAt: null })).period).toBe("Date not set");
  });
});

describe("SCRUM310 the totals", () => {
  it("SCRUM310_AC2_adds_up_reservations_and_units", () => {
    expect(summariseAffected([item({ quantity: 3 }), item({ quantity: 2 }), item({ quantity: 1 })])).toEqual({
      reservations: 3,
      units: 6,
    });
  });

  it("SCRUM310_AC7_an_empty_list_sums_to_zero", () => {
    expect(summariseAffected([])).toEqual({ reservations: 0, units: 0 });
  });

  it("SCRUM310_AC2_ignores_a_quantity_that_is_not_a_number_in_the_sum", () => {
    expect(summariseAffected([item({ quantity: 2 }), item({ quantity: "lots" })]).units).toBe(2);
  });
});

describe("SCRUM310 the sentence above the list", () => {
  it("SCRUM310_AC2_gives_the_usable_figures_and_the_counts", () => {
    expect(impactHeading([item({ quantity: 3 }), item({ quantity: 2 })], 7, 2)).toBe(
      "Usable units go from 7 to 2. 2 reservations (5 units) would no longer be covered.",
    );
  });

  it("SCRUM310_AC2_uses_the_singular_for_one_reservation_of_one_unit", () => {
    expect(impactHeading([item({ quantity: 1 })], 3, 0)).toBe(
      "Usable units go from 3 to 0. 1 reservation (1 unit) would no longer be covered.",
    );
  });

  it("SCRUM310_AC2_one_reservation_of_several_units", () => {
    expect(impactHeading([item({ quantity: 4 })], 5, 1)).toContain("1 reservation (4 units)");
  });

  it.each([
    ["unknown before", null, 2],
    ["unknown after", 7, null],
    ["both unknown", undefined, undefined],
    ["not numbers", "7", "2"],
  ])("SCRUM310_AC2_leaves_the_usable_figures_out_when_%s", (_label, before, after) => {
    const heading = impactHeading([item()], before, after);

    expect(heading).toBe("1 reservation (3 units) would no longer be covered.");
  });

  it("SCRUM310_AC7_says_nothing_is_affected_for_an_empty_list_whatever_the_figures", () => {
    expect(impactHeading([], 7, 2)).toBe("No reservations are affected by this change.");
    expect(impactHeading([], null, null)).toBe("No reservations are affected by this change.");
  });

  it("SCRUM310_AC7_zero_usable_after_is_a_figure_not_a_missing_one", () => {
    expect(impactHeading([item()], 3, 0)).toContain("from 3 to 0");
  });
});
