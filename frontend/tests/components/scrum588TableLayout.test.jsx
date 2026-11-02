// scrum588TableLayout.test.jsx
//
// Review follow-up on #104: two layout faults in the equipment tables.
//
//   1. Check availability: the screen sets overflow-wrap: anywhere, which let the reservations
//      table's columns shrink to one letter (QUANTI/TY, 10 shown as 1/0, badges broken letter
//      by letter). Only the event name may break mid-word now, and a phone scrolls the table
//      inside its card.
//   2. Catalogue history: one very long unbroken note pushed past the card on a wide screen.
//      The note column now breaks anywhere at every width, and only that column.
//
// jsdom applies no CSS, so the stylesheets are read as text; the markup the rules hang on is
// rendered and checked.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
const css = (file) => readFileSync(resolve(SRC, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const availabilityCss = css("components/EquipmentAvailabilityCheck.css");
const catalogueCss = css("components/EquipmentCatalogue.css");

/** Every rule with this declaration, as its selector. Flat parse: a rule inside @media still reads as itself. */
function selectorsWith(sheet, declaration) {
  return [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , body]) => body.includes(declaration))
    .map(([, selector]) => selector.trim().replace(/\s+/g, " "));
}

describe("SCRUM588 the availability reservations table keeps its columns", () => {
  it("SCRUM588_LAYOUT_table_cells_wrap_at_spaces_not_mid_word", () => {
    expect(availabilityCss).toMatch(
      /\.availability-check :is\(\.availability-breakdown, \.availability-reservations\) :is\(th, td\) \{ overflow-wrap: break-word; \}/,
    );
  });

  it("SCRUM588_LAYOUT_only_the_screen_and_the_event_name_may_break_anywhere", () => {
    expect(selectorsWith(availabilityCss, "overflow-wrap: anywhere").sort()).toEqual(
      [".availability-check", ".availability-check .availability-reservations td:first-child"].sort(),
    );
  });

  it("SCRUM588_LAYOUT_the_event_and_period_columns_keep_a_readable_minimum_width", () => {
    expect(availabilityCss).toMatch(/\.availability-reservations td:first-child \{[^}]*min-width: 8em/);
    expect(availabilityCss).toMatch(/\.availability-reservations td:nth-child\(2\) \{ min-width: 11em; \}/);
  });

  it("SCRUM588_LAYOUT_a_narrow_screen_scrolls_the_table_inside_its_card_and_shows_focus", () => {
    expect(availabilityCss).toMatch(/\.availability-reservations__scroll \{ overflow-x: auto; \}/);
    expect(availabilityCss).toMatch(/\.availability-reservations__scroll:focus-visible \{ outline: 3px solid var\(--color-accent\)/);
  });
});

describe("SCRUM588 the catalogue history note breaks anywhere, and only the note", () => {
  it("SCRUM588_LAYOUT_the_history_note_column_breaks_anywhere_at_every_width", () => {
    expect(selectorsWith(catalogueCss, "overflow-wrap: anywhere")).toContain(".equipment-table--history td:nth-child(3)");
  });

  it("SCRUM588_LAYOUT_the_history_rule_does_not_touch_the_date_change_or_by_columns", () => {
    const historyRules = [...catalogueCss.matchAll(/(\.equipment-table--history[^{}]*)\{/g)].map((m) => m[1].trim());
    expect(historyRules).toEqual([".equipment-table--history td:nth-child(3)"]);
  });

  it("SCRUM588_LAYOUT_the_main_catalogue_table_still_wraps_at_spaces_so_its_number_columns_hold", () => {
    expect(catalogueCss).toMatch(/\.equipment-table :is\(th, td\) \{ overflow-wrap: break-word; \}/);
    expect(selectorsWith(catalogueCss, "overflow-wrap: anywhere")).not.toContain(".equipment-table td");
  });

  it("SCRUM588_LAYOUT_the_history_note_gets_no_minimum_width_that_would_overflow_a_phone", () => {
    const rule = [...catalogueCss.matchAll(/\.equipment-table--history td:nth-child\(3\) \{([^{}]*)\}/g)][0][1];
    expect(rule).not.toMatch(/min-width/);
  });
});

describe("SCRUM588 the markup the layout rules hang on", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("SCRUM588_LAYOUT_history_table_carries_the_history_class_and_the_note_is_the_third_cell", async () => {
    equipment.getEquipmentHistory.mockResolvedValue([
      { id: 1, field: "damagedQuantity", oldValue: "0", newValue: "3", note: "x".repeat(200), changedBy: "0571ed91-19bd-47a4-981b", changedAt: "2026-10-05T11:29:10+00:00" },
    ]);
    render(<EquipmentHistory type={{ id: "p1", name: "Projector (HD)" }} />);

    const table = await screen.findByRole("table");
    expect(table).toHaveClass("equipment-table", "equipment-table--history");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["When", "Change", "Note", "By"]);
    expect(within(table).getAllByRole("cell")[2].textContent).toBe("x".repeat(200));
  });

  it("SCRUM588_LAYOUT_history_with_a_missing_note_still_has_a_third_cell", async () => {
    equipment.getEquipmentHistory.mockResolvedValue([
      { id: 2, field: "retiredAt", oldValue: null, newValue: "2026-10-05T11:00:00+00:00", note: null, changedBy: null, changedAt: "2026-10-05T11:00:00+00:00" },
    ]);
    render(<EquipmentHistory type={{ id: "p1", name: "Projector (HD)" }} />);

    const cells = within(await screen.findByRole("table")).getAllByRole("cell");
    expect(cells).toHaveLength(4);
    expect(cells[2].textContent).toBe("");
  });

  it("SCRUM588_LAYOUT_history_has_no_table_to_style_when_there_are_no_changes", async () => {
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

  it("SCRUM588_LAYOUT_reservations_table_sits_in_a_labelled_focusable_scroll_region", async () => {
    await checkWith([
      { id: "r1", eventRequestId: "e1", eventName: "Graduation", quantity: 2, startAt: "2026-12-01T09:00:00+00:00", endAt: "2026-12-01T11:00:00+00:00", flagged: false },
    ]);

    const region = await screen.findByRole("region", { name: "Overlapping reservations" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).toHaveClass("availability-reservations__scroll");
    expect(within(region).getByRole("table")).toHaveClass("availability-reservations");
    expect(within(region).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Event", "Period", "Quantity", "Status"]);
  });

  it("SCRUM588_LAYOUT_breakdown_table_is_not_inside_the_scroll_region", async () => {
    await checkWith([
      { id: "r1", eventRequestId: "e1", eventName: "Graduation", quantity: 2, startAt: "2026-12-01T09:00:00+00:00", endAt: "2026-12-01T11:00:00+00:00", flagged: false },
    ]);

    const region = await screen.findByRole("region", { name: "Overlapping reservations" });
    expect(screen.getAllByRole("table")).toHaveLength(2);
    expect(within(region).getAllByRole("table")).toHaveLength(1);
  });

  it("SCRUM588_LAYOUT_no_scroll_region_when_nothing_overlaps", async () => {
    await checkWith([]);

    expect(await screen.findByText("No reservations overlap this period.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Overlapping reservations" })).not.toBeInTheDocument();
  });
});
