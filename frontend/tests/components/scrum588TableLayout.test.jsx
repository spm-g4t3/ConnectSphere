// jsdom applies no CSS, so these tests pin the markup the layout rules hang on (the history class and
// note cell, the reservations scroll region). The widths themselves are checked in a real browser, see the PR.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../src/services/equipmentAvailabilityService", () => ({
  listActiveEquipmentTypes: vi.fn(),
  checkEquipmentAvailability: vi.fn(),
}));
vi.mock("../../src/services/equipmentService", () => ({
  getEquipmentHistory: vi.fn(),
}));

import * as availability from "../../src/services/equipmentAvailabilityService";
import * as equipment from "../../src/services/equipmentService";
import EquipmentAvailabilityCheck from "../../src/components/EquipmentAvailabilityCheck";
import EquipmentHistory from "../../src/components/EquipmentHistory";

describe("SCRUM588 the markup the table layout rules hang on", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("SCRUM588_AC9_history_table_carries_the_history_class_and_the_note_is_the_third_cell", async () => {
    equipment.getEquipmentHistory.mockResolvedValue([
      { id: 1, field: "damagedQuantity", oldValue: "0", newValue: "3", note: "x".repeat(200), changedBy: "0571ed91-19bd-47a4-981b", changedAt: "2026-10-05T11:29:10+00:00" },
    ]);
    render(<EquipmentHistory type={{ id: "p1", name: "Projector (HD)" }} />);

    const table = await screen.findByRole("table");
    expect(table).toHaveClass("equipment-table", "equipment-table--history");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["When", "Change", "Note", "By"]);
    expect(within(table).getAllByRole("cell")[2].textContent).toBe("x".repeat(200));
  });

  it("SCRUM588_AC9_history_with_a_missing_note_still_has_a_third_cell", async () => {
    equipment.getEquipmentHistory.mockResolvedValue([
      { id: 2, field: "retiredAt", oldValue: null, newValue: "2026-10-05T11:00:00+00:00", note: null, changedBy: null, changedAt: "2026-10-05T11:00:00+00:00" },
    ]);
    render(<EquipmentHistory type={{ id: "p1", name: "Projector (HD)" }} />);

    const cells = within(await screen.findByRole("table")).getAllByRole("cell");
    expect(cells).toHaveLength(4);
    expect(cells[2].textContent).toBe("");
  });

  it("SCRUM588_AC10_history_shows_no_table_when_there_are_no_changes", async () => {
    equipment.getEquipmentHistory.mockResolvedValue([]);
    render(<EquipmentHistory type={{ id: "p1", name: "Projector (HD)" }} />);

    expect(await screen.findByText("No changes recorded.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  async function checkWith(reservations) {
    availability.listActiveEquipmentTypes.mockResolvedValue([{ id: "p1", name: "Projector (HD)", description: null, category: "Display" }]);
    availability.checkEquipmentAvailability.mockResolvedValue({
      result: "Fully available",
      quantityRequested: 4,
      quantityAvailable: 6,
      message: null,
      breakdown: { total: 10, damaged: 1, underMaintenance: 1, damagedOrUnderMaintenance: 2, reserved: 2, available: 6 },
      reservations,
    });
    const user = userEvent.setup();
    render(<EquipmentAvailabilityCheck />);
    await screen.findByRole("option", { name: "Projector (HD)" });
    await user.selectOptions(screen.getByLabelText("Equipment type"), "p1");
    await user.type(screen.getByLabelText("Quantity"), "4");
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-12-01T10:00" } });
    fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-12-01T12:00" } });
    await user.click(screen.getByRole("button", { name: "Check availability" }));
  }

  it("SCRUM588_AC8_reservations_table_sits_in_a_labelled_focusable_scroll_region", async () => {
    await checkWith([
      { id: "r1", eventRequestId: "e1", eventName: "Graduation", quantity: 2, startAt: "2026-12-01T09:00:00+00:00", endAt: "2026-12-01T11:00:00+00:00", flagged: false },
    ]);

    const region = await screen.findByRole("region", { name: "Overlapping reservations" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).toHaveClass("availability-reservations__scroll");
    expect(within(region).getByRole("table")).toHaveClass("availability-reservations");
    expect(within(region).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Event", "Period", "Quantity", "Status"]);
  });

  it("SCRUM588_AC9_breakdown_table_is_not_inside_the_scroll_region", async () => {
    await checkWith([
      { id: "r1", eventRequestId: "e1", eventName: "Graduation", quantity: 2, startAt: "2026-12-01T09:00:00+00:00", endAt: "2026-12-01T11:00:00+00:00", flagged: false },
    ]);

    const region = await screen.findByRole("region", { name: "Overlapping reservations" });
    expect(screen.getAllByRole("table")).toHaveLength(2);
    expect(within(region).getAllByRole("table")).toHaveLength(1);
  });

  it("SCRUM588_AC10_no_scroll_region_when_nothing_overlaps", async () => {
    await checkWith([]);

    expect(await screen.findByText("No reservations overlap this period.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Overlapping reservations" })).not.toBeInTheDocument();
  });
});
