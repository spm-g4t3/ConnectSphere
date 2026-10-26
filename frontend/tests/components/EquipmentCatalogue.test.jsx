// Tests for the equipment catalogue screen (SCRUM-280, part of SCRUM-275).
// "Every action in AC2 to AC8 can be done from this screen" is what these walk
// through, with the service layer mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../src/services/equipmentService", () => ({
  listEquipment: vi.fn(),
  createEquipment: vi.fn(),
  updateEquipment: vi.fn(),
  recordEquipmentCondition: vi.fn(),
  retireEquipment: vi.fn(),
  reinstateEquipment: vi.fn(),
  previewEquipmentChange: vi.fn(),
  getEquipmentHistory: vi.fn(),
}));

import * as service from "../../src/services/equipmentService";
import EquipmentCatalogue from "../../src/components/EquipmentCatalogue";

const projector = {
  id: "p1",
  name: "Projector (HD)",
  description: "4000 lumens",
  category: "Display",
  location: "Store room 1",
  totalQuantity: 8,
  damagedQuantity: 1,
  underMaintenanceQuantity: 1,
  usableQuantity: 6,
  retiredAt: null,
};

const legacy = {
  id: "o1",
  name: "Overhead projector (legacy)",
  description: null,
  category: null,
  location: null,
  totalQuantity: 2,
  damagedQuantity: 0,
  underMaintenanceQuantity: 0,
  usableQuantity: 2,
  retiredAt: "2026-10-01T09:00:00+00:00",
};

const apiError = (status, data) => Object.assign(new Error("request failed"), { response: { status, data } });

async function openCatalogue() {
  render(<EquipmentCatalogue />);
  await screen.findByText("Projector (HD)");
}

// SCRUM-314: a change is previewed before it is saved. These tests are about the
// screen's other rules, so by default nothing is affected and the save follows
// at once (AC7). The confirmation step has its own file, scrum314ConfirmationStep.
const nothingAffected = { usableBefore: 6, usableAfter: 5, affectedCount: 0, affectedUnits: 0, affected: [] };

beforeEach(() => {
  vi.resetAllMocks();
  service.listEquipment.mockResolvedValue([projector, legacy]);
  service.previewEquipmentChange.mockResolvedValue(nothingAffected);
});


describe("AC5: the list", () => {
  it("SCRUM275_AC5_lists_a_type_with_total_damaged_under_maintenance_and_usable", async () => {
    await openCatalogue();

    const row = screen.getByRole("row", { name: /Projector \(HD\)/ });
    const cells = within(row).getAllByRole("cell").map((cell) => cell.textContent);

    expect(cells.slice(0, 7)).toEqual(["Projector (HD)", "Display", "Store room 1", "8", "1", "1", "6"]);
  });

  it("SCRUM275_AC6_shows_retired_types_in_their_own_section_with_reinstate_not_retire", async () => {
    await openCatalogue();

    expect(screen.getByRole("heading", { name: "Retired equipment" })).toBeInTheDocument();
    const row = screen.getByRole("row", { name: /Overhead projector \(legacy\)/ });
    expect(within(row).getByRole("button", { name: "Reinstate Overhead projector (legacy)" })).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /^Retire / })).not.toBeInTheDocument();
  });

  it("SCRUM275_AC5_says_so_when_there_is_no_active_equipment", async () => {
    service.listEquipment.mockResolvedValue([]);
    render(<EquipmentCatalogue />);

    expect(await screen.findByText("No active equipment types yet.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Retired equipment" })).not.toBeInTheDocument();
  });

  it("SCRUM275_AC5_tells_the_user_when_the_catalogue_cannot_be_loaded", async () => {
    service.listEquipment.mockRejectedValue(apiError(500, { error: "secret driver text" }));
    render(<EquipmentCatalogue />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load the equipment catalogue. Please try again.");
    expect(alert).not.toHaveTextContent("secret");
  });
});


describe("AC2: creating a type", () => {
  it("SCRUM275_AC2_creates_a_type_and_returns_to_a_refreshed_list", async () => {
    const user = userEvent.setup();
    service.createEquipment.mockResolvedValue({});
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Add equipment type" }));
    await user.type(screen.getByLabelText("Name"), "Cable");
    await user.type(screen.getByLabelText("Total quantity"), "20");
    await user.click(screen.getByRole("button", { name: "Add equipment type" }));

    expect(await screen.findByRole("heading", { name: "Equipment catalogue" })).toBeInTheDocument();
    expect(service.createEquipment).toHaveBeenCalledWith({
      name: "Cable",
      description: "",
      category: "",
      location: "",
      totalQuantity: 20,
    });
    expect(service.listEquipment).toHaveBeenCalledTimes(2);
  });

  it("SCRUM275_AC2_shows_every_validation_error_from_the_backend", async () => {
    const user = userEvent.setup();
    service.createEquipment.mockRejectedValue(
      apiError(400, {
        details: [
          { field: "name", message: "is already used by another equipment type" },
          { field: "totalQuantity", message: "is required" },
        ],
      }),
    );
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Add equipment type" }));
    await user.click(screen.getByRole("button", { name: "Add equipment type" }));

    expect(await screen.findByText("Name: is already used by another equipment type")).toBeInTheDocument();
    expect(screen.getByText("Total quantity: is required")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add equipment type" })).toBeEnabled();
  });

  it("SCRUM275_AC2_sends_a_cleared_total_as_null_so_the_backend_can_refuse_it", async () => {
    const user = userEvent.setup();
    service.createEquipment.mockRejectedValue(apiError(400, { details: [{ field: "totalQuantity", message: "is required" }] }));
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Add equipment type" }));
    await user.type(screen.getByLabelText("Name"), "Cable");
    await user.click(screen.getByRole("button", { name: "Add equipment type" }));

    await screen.findByText("Total quantity: is required");
    expect(service.createEquipment).toHaveBeenCalledWith(expect.objectContaining({ totalQuantity: null }));
  });

  it("SCRUM275_AC2_the_back_button_returns_to_the_list_without_saving", async () => {
    const user = userEvent.setup();
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Add equipment type" }));
    await user.click(screen.getByRole("button", { name: /Back to the equipment catalogue/ }));

    expect(await screen.findByRole("heading", { name: "Equipment catalogue" })).toBeInTheDocument();
    expect(service.createEquipment).not.toHaveBeenCalled();
  });
});


describe("AC3: editing a type", () => {
  it("SCRUM275_AC3_sends_only_the_field_that_changed", async () => {
    const user = userEvent.setup();
    service.updateEquipment.mockResolvedValue({});
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Edit Projector (HD)" }));
    const location = screen.getByLabelText("Location");
    await user.clear(location);
    await user.type(location, "Store room 2");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("heading", { name: "Equipment catalogue" })).toBeInTheDocument();
    expect(service.updateEquipment).toHaveBeenCalledWith("p1", { location: "Store room 2" });
    // nothing that could leave a reservation short, so nothing to look up first
    expect(service.previewEquipmentChange).not.toHaveBeenCalled();
  });

  it("SCRUM275_AC3_says_so_when_nothing_changed_and_sends_nothing", async () => {
    const user = userEvent.setup();
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Edit Projector (HD)" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(screen.getByText("No changes to save.")).toBeInTheDocument();
    expect(service.updateEquipment).not.toHaveBeenCalled();
  });

  it("SCRUM275_AC3_shows_a_validation_error_from_the_backend", async () => {
    const user = userEvent.setup();
    service.updateEquipment.mockRejectedValue(
      apiError(400, { details: [{ field: "totalQuantity", message: "can't be below damaged plus under maintenance (2)" }] }),
    );
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Edit Projector (HD)" }));
    const total = screen.getByLabelText("Total quantity");
    await user.clear(total);
    await user.type(total, "1");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Total quantity: can't be below damaged plus under maintenance (2)")).toBeInTheDocument();
    expect(service.updateEquipment).toHaveBeenCalledTimes(1);
  });
});


describe("AC4 and AC5: damaged and under-maintenance quantities", () => {
  it("SCRUM275_AC4_records_a_changed_quantity_with_a_note_and_previews_the_usable_figure", async () => {
    const user = userEvent.setup();
    service.recordEquipmentCondition.mockResolvedValue({});
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Damage and maintenance for Projector (HD)" }));
    expect(screen.getByText("Usable after this change: 6")).toBeInTheDocument();

    const damaged = screen.getByLabelText("Damaged units");
    await user.clear(damaged);
    await user.type(damaged, "3");
    expect(screen.getByText("Usable after this change: 4")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Note"), "dropped");
    await user.click(screen.getByRole("button", { name: "Save quantities" }));

    expect(await screen.findByRole("heading", { name: "Equipment catalogue" })).toBeInTheDocument();
    expect(service.recordEquipmentCondition).toHaveBeenCalledWith("p1", {
      damagedQuantity: 3,
      note: "dropped",
      confirmedReservationIds: [],
    });
  });

  it("SCRUM275_AC4_warns_when_damaged_plus_maintenance_would_exceed_the_total", async () => {
    const user = userEvent.setup();
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Damage and maintenance for Projector (HD)" }));
    const maintenance = screen.getByLabelText("Under maintenance units");
    await user.clear(maintenance);
    await user.type(maintenance, "9");

    expect(screen.getByText("Damaged plus under maintenance is above the total (8).")).toBeInTheDocument();
  });

  it("SCRUM275_AC4_asks_for_a_note_before_looking_anything_up_or_saving", async () => {
    const user = userEvent.setup();
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Damage and maintenance for Projector (HD)" }));
    const damaged = screen.getByLabelText("Damaged units");
    await user.clear(damaged);
    await user.type(damaged, "2");
    await user.click(screen.getByRole("button", { name: "Save quantities" }));

    expect(await screen.findByText("Note: is required")).toBeInTheDocument();
    expect(service.previewEquipmentChange).not.toHaveBeenCalled();
    expect(service.recordEquipmentCondition).not.toHaveBeenCalled();
  });

  it("SCRUM275_AC4_shows_every_error_the_backend_returns_when_saving", async () => {
    const user = userEvent.setup();
    service.recordEquipmentCondition.mockRejectedValue(
      apiError(400, { details: [{ field: "damagedQuantity", message: "must be a whole number" }, { field: "note", message: "is too long" }] }),
    );
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Damage and maintenance for Projector (HD)" }));
    const damaged = screen.getByLabelText("Damaged units");
    await user.clear(damaged);
    await user.type(damaged, "2");
    await user.type(screen.getByLabelText("Note"), "x");
    await user.click(screen.getByRole("button", { name: "Save quantities" }));

    expect(await screen.findByText("Damaged: must be a whole number")).toBeInTheDocument();
    expect(screen.getByText("Note: is too long")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save quantities" })).toBeEnabled();
  });

  it("SCRUM275_AC4_says_so_when_no_quantity_changed_and_sends_nothing", async () => {
    const user = userEvent.setup();
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Damage and maintenance for Projector (HD)" }));
    await user.click(screen.getByRole("button", { name: "Save quantities" }));

    expect(screen.getByText("Change at least one quantity.")).toBeInTheDocument();
    expect(service.recordEquipmentCondition).not.toHaveBeenCalled();
  });

  it("SCRUM275_AC4_reducing_a_quantity_marks_units_usable_again", async () => {
    const user = userEvent.setup();
    service.recordEquipmentCondition.mockResolvedValue({});
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Damage and maintenance for Projector (HD)" }));
    const damaged = screen.getByLabelText("Damaged units");
    await user.clear(damaged);
    await user.type(damaged, "0");
    expect(screen.getByText("Usable after this change: 7")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Note"), "repaired");
    await user.click(screen.getByRole("button", { name: "Save quantities" }));

    await waitFor(() =>
      expect(service.recordEquipmentCondition).toHaveBeenCalledWith("p1", {
        damagedQuantity: 0,
        note: "repaired",
        confirmedReservationIds: [],
      }),
    );
  });
});


describe("AC6: retiring and reinstating", () => {
  it("SCRUM275_AC6_retires_a_type_after_a_confirmation_and_refreshes_the_list", async () => {
    const user = userEvent.setup();
    service.retireEquipment.mockResolvedValue({});
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Retire Projector (HD)" }));
    expect(service.retireEquipment).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm retire Projector (HD)" }));

    await waitFor(() => expect(service.retireEquipment).toHaveBeenCalledWith("p1", { confirmedReservationIds: [] }));
    await waitFor(() => expect(service.listEquipment).toHaveBeenCalledTimes(2));
  });

  it("SCRUM275_AC6_cancelling_the_confirmation_retires_nothing", async () => {
    const user = userEvent.setup();
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Retire Projector (HD)" }));
    await user.click(screen.getByRole("button", { name: "Cancel retire Projector (HD)" }));

    expect(service.retireEquipment).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Retire Projector (HD)" })).toBeInTheDocument();
  });

  it("SCRUM275_AC6_explains_a_409_under_the_row_and_refreshes_the_stale_list", async () => {
    const user = userEvent.setup();
    service.retireEquipment.mockRejectedValue(apiError(409, { code: "EQUIPMENT_ALREADY_RETIRED", error: "type is already retired" }));
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Retire Projector (HD)" }));
    await user.click(screen.getByRole("button", { name: "Confirm retire Projector (HD)" }));

    expect(await screen.findByText("This type has already been retired. The list has been refreshed.")).toBeInTheDocument();
    await waitFor(() => expect(service.listEquipment).toHaveBeenCalledTimes(2));
  });

  it("SCRUM275_AC6_a_failure_that_is_not_stale_shows_the_message_without_refreshing", async () => {
    const user = userEvent.setup();
    service.retireEquipment.mockRejectedValue(apiError(500, { error: "driver text" }));
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Retire Projector (HD)" }));
    await user.click(screen.getByRole("button", { name: "Confirm retire Projector (HD)" }));

    expect(await screen.findByText("Could not retire this type. Please try again.")).toBeInTheDocument();
    expect(service.listEquipment).toHaveBeenCalledTimes(1);
  });

  it("SCRUM275_AC6_reinstates_a_retired_type", async () => {
    const user = userEvent.setup();
    service.reinstateEquipment.mockResolvedValue({});
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Reinstate Overhead projector (legacy)" }));

    await waitFor(() => expect(service.reinstateEquipment).toHaveBeenCalledWith("o1"));
    await waitFor(() => expect(service.listEquipment).toHaveBeenCalledTimes(2));
  });
});


describe("AC8: the change history", () => {
  it("SCRUM275_AC8_opens_a_types_history_with_old_and_new_values_notes_and_who", async () => {
    const user = userEvent.setup();
    service.getEquipmentHistory.mockResolvedValue([
      { id: 3, field: "damagedQuantity", oldValue: "0", newValue: "3", note: "dropped", changedBy: "0571ed91-19bd-47a4-981b", changedAt: "2026-10-05T11:29:15+00:00" },
      { id: 2, field: "retiredAt", oldValue: null, newValue: "2026-10-05T11:00:00+00:00", note: null, changedBy: null, changedAt: "2026-10-05T11:00:00+00:00" },
      { id: 1, field: "created", oldValue: null, newValue: "Projector (HD)", note: null, changedBy: "0571ed91-19bd-47a4-981b", changedAt: "2026-10-05T10:00:00+00:00" },
    ]);
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "History for Projector (HD)" }));

    expect(await screen.findByText("Damaged: 0 to 3")).toBeInTheDocument();
    expect(screen.getByText("dropped")).toBeInTheDocument();
    expect(screen.getByText("Retired")).toBeInTheDocument();
    expect(screen.getByText('Created as "Projector (HD)"')).toBeInTheDocument();
    expect(screen.getAllByText("0571ed91")).toHaveLength(2);
    expect(screen.getByText("unknown")).toBeInTheDocument();
    expect(service.getEquipmentHistory).toHaveBeenCalledWith("p1");
  });

  it("SCRUM275_AC8_says_so_when_a_type_has_no_history", async () => {
    const user = userEvent.setup();
    service.getEquipmentHistory.mockResolvedValue([]);
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "History for Projector (HD)" }));

    expect(await screen.findByText("No changes recorded.")).toBeInTheDocument();
  });

  it("SCRUM275_AC8_tells_the_user_when_the_history_cannot_be_loaded", async () => {
    const user = userEvent.setup();
    service.getEquipmentHistory.mockRejectedValue(apiError(500, {}));
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "History for Projector (HD)" }));

    expect(await screen.findByText("Could not load this type's history. Please try again.")).toBeInTheDocument();
  });
});
