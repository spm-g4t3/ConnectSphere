// Tests for the equipment availability screen (SCRUM-70, part of SCRUM-23).
// The service layer is mocked. The real datetime helper is used, and the
// expected offset timestamps are computed with it, so the tests hold in any
// time zone.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../src/services/equipmentAvailabilityService", () => ({
  listActiveEquipmentTypes: vi.fn(),
  checkEquipmentAvailability: vi.fn(),
}));

import * as service from "../../src/services/equipmentAvailabilityService";
import { toOffsetIsoString, deviceTimeZoneLabel } from "../../src/services/datetimeFormat";
import EquipmentAvailabilityCheck from "../../src/components/EquipmentAvailabilityCheck";

const START = "2026-12-01T10:00";
const END = "2026-12-01T12:00";

const types = [
  { id: "p1", name: "Projector (HD)", description: null, category: "Display" },
  { id: "m1", name: "Wireless microphone", description: null, category: "Audio" },
];

const answer = (overrides = {}) => ({
  result: "Fully available",
  quantityRequested: 4,
  quantityAvailable: 6,
  message: null,
  breakdown: { total: 10, damaged: 1, underMaintenance: 1, damagedOrUnderMaintenance: 2, reserved: 2, available: 6 },
  reservations: [],
  ...overrides,
});

const apiError = (status, data) => Object.assign(new Error("request failed"), { response: { status, data } });

async function openScreen() {
  render(<EquipmentAvailabilityCheck />);
  await screen.findByRole("option", { name: "Projector (HD)" });
}

async function fillAndSubmit(user, { quantity = "4" } = {}) {
  await user.selectOptions(screen.getByLabelText("Equipment type"), "p1");
  await user.type(screen.getByLabelText("Quantity"), quantity);
  fireEvent.change(screen.getByLabelText("Start"), { target: { value: START } });
  fireEvent.change(screen.getByLabelText("End"), { target: { value: END } });
  await user.click(screen.getByRole("button", { name: "Check availability" }));
}

beforeEach(() => {
  vi.resetAllMocks();
  service.listActiveEquipmentTypes.mockResolvedValue(types);
});


describe("the form", () => {
  it("SCRUM23_AC2_offers_the_active_equipment_types_in_the_picker", async () => {
    await openScreen();

    const picker = screen.getByLabelText("Equipment type");
    expect(within(picker).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Select an equipment type",
      "Projector (HD)",
      "Wireless microphone",
    ]);
  });

  it("SCRUM23_AC2_says_so_and_disables_the_check_when_there_are_no_active_types", async () => {
    service.listActiveEquipmentTypes.mockResolvedValue([]);
    render(<EquipmentAvailabilityCheck />);

    expect(await screen.findByText(/No active equipment types yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check availability" })).toBeDisabled();
  });

  it("SCRUM23_AC2_tells_the_user_when_the_types_cannot_be_loaded", async () => {
    service.listActiveEquipmentTypes.mockRejectedValue(apiError(500, { error: "secret driver text" }));
    render(<EquipmentAvailabilityCheck />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load the equipment types. Please try again.");
    expect(alert).not.toHaveTextContent("secret");
  });

  it("SCRUM23_AC2_says_which_time_zone_the_times_are_in", async () => {
    await openScreen();

    expect(screen.getByText(new RegExp(`Times are in your device's time zone \\(${deviceTimeZoneLabel()}\\)`))).toBeInTheDocument();
  });

  it("SCRUM23_AC2_sends_the_type_quantity_and_period_with_timezone_offsets", async () => {
    const user = userEvent.setup();
    service.checkEquipmentAvailability.mockResolvedValue(answer());
    await openScreen();

    await fillAndSubmit(user);

    expect(service.checkEquipmentAvailability).toHaveBeenCalledWith({
      equipmentTypeId: "p1",
      quantity: "4",
      startAt: toOffsetIsoString(START),
      endAt: toOffsetIsoString(END),
    });
  });

  it("SCRUM23_AC2_sends_a_blank_form_as_it_is_so_the_backend_can_list_every_fault", async () => {
    const user = userEvent.setup();
    service.checkEquipmentAvailability.mockRejectedValue(
      apiError(400, {
        details: [
          { field: "equipmentTypeId", message: "is required" },
          { field: "quantity", message: "is required" },
          { field: "startAt", message: "is required" },
          { field: "endAt", message: "is required" },
        ],
      }),
    );
    await openScreen();

    await user.click(screen.getByRole("button", { name: "Check availability" }));

    expect(service.checkEquipmentAvailability).toHaveBeenCalledWith({ equipmentTypeId: "", quantity: "", startAt: undefined, endAt: undefined });
    const alert = await screen.findByRole("alert");
    expect(within(alert).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Equipment type: is required",
      "Quantity: is required",
      "Start: is required",
      "End: is required",
    ]);
  });
});


describe("AC8: the result", () => {
  it("SCRUM23_AC8_shows_Fully_available_with_the_quantities", async () => {
    const user = userEvent.setup();
    service.checkEquipmentAvailability.mockResolvedValue(answer());
    await openScreen();

    await fillAndSubmit(user);

    expect(await screen.findByRole("heading", { name: "Fully available" })).toBeInTheDocument();
    expect(screen.getByText("4 requested, 6 available.")).toBeInTheDocument();
  });

  it("SCRUM23_AC8_shows_Partially_available_with_the_quantity_available", async () => {
    const user = userEvent.setup();
    service.checkEquipmentAvailability.mockResolvedValue(
      answer({ result: "Partially available", quantityRequested: 9, quantityAvailable: 6 }),
    );
    await openScreen();

    await fillAndSubmit(user, { quantity: "9" });

    expect(await screen.findByRole("heading", { name: "Partially available" })).toBeInTheDocument();
    expect(screen.getByText("Only 6 of 9 requested are available.")).toBeInTheDocument();
  });

  it("SCRUM23_AC8_shows_Unavailable_when_nothing_is_available", async () => {
    const user = userEvent.setup();
    service.checkEquipmentAvailability.mockResolvedValue(
      answer({
        result: "Unavailable",
        quantityRequested: 2,
        quantityAvailable: 0,
        breakdown: { total: 3, damaged: 1, underMaintenance: 2, damagedOrUnderMaintenance: 3, reserved: 0, available: 0 },
      }),
    );
    await openScreen();

    await fillAndSubmit(user, { quantity: "2" });

    expect(await screen.findByRole("heading", { name: "Unavailable" })).toBeInTheDocument();
    expect(screen.getByText("None of the 2 requested are available.")).toBeInTheDocument();
  });
});


describe("AC9: how the figure was reached", () => {
  it("SCRUM23_AC9_shows_total_damaged_or_maintenance_reserved_and_available", async () => {
    const user = userEvent.setup();
    service.checkEquipmentAvailability.mockResolvedValue(answer());
    await openScreen();

    await fillAndSubmit(user);

    await screen.findByRole("heading", { name: "Fully available" });
    const valueOf = (rowName) => within(screen.getByRole("row", { name: rowName })).getByRole("cell").textContent;
    expect(valueOf(/Total quantity/)).toBe("10");
    expect(valueOf(/Damaged or under maintenance/)).toBe("2");
    expect(screen.getByText("1 damaged, 1 under maintenance")).toBeInTheDocument();
    expect(valueOf(/Reserved in this period/)).toBe("2");
    expect(valueOf(/^Available/)).toBe("6");
  });
});


describe("AC10: the overlapping reservations", () => {
  it("SCRUM23_AC10_lists_each_with_event_name_period_quantity_and_whether_it_is_flagged", async () => {
    const user = userEvent.setup();
    service.checkEquipmentAvailability.mockResolvedValue(
      answer({
        reservations: [
          { id: "r1", eventRequestId: "e1", eventName: "Graduation", quantity: 2, startAt: "2026-12-01T09:00:00+00:00", endAt: "2026-12-01T11:00:00+00:00", flagged: false },
          { id: "r2", eventRequestId: "e2", eventName: "AGM", quantity: 1, startAt: "2026-12-01T11:00:00+00:00", endAt: "2026-12-01T13:00:00+00:00", flagged: true },
        ],
      }),
    );
    await openScreen();

    await fillAndSubmit(user);

    expect(await screen.findByRole("heading", { name: "Overlapping reservations (2)" })).toBeInTheDocument();
    const graduation = screen.getByRole("row", { name: /Graduation/ });
    expect(within(graduation).getAllByRole("cell").map((cell) => cell.textContent).filter((text, index) => index !== 1)).toEqual(["Graduation", "2", "Reserved"]);
    const agm = screen.getByRole("row", { name: /AGM/ });
    expect(within(agm).getByText("Flagged for review")).toBeInTheDocument();
    expect(within(agm).getAllByRole("cell")[1].textContent).toMatch(/\S/);
  });

  it("SCRUM23_AC10_says_so_when_nothing_overlaps", async () => {
    const user = userEvent.setup();
    service.checkEquipmentAvailability.mockResolvedValue(answer());
    await openScreen();

    await fillAndSubmit(user);

    expect(await screen.findByRole("heading", { name: "Overlapping reservations (0)" })).toBeInTheDocument();
    expect(screen.getByText("No reservations overlap this period.")).toBeInTheDocument();
  });
});


describe("AC11: an unknown or retired type", () => {
  it("SCRUM23_AC11_shows_the_message_and_no_breakdown", async () => {
    const user = userEvent.setup();
    service.checkEquipmentAvailability.mockResolvedValue({
      result: "Unavailable",
      quantityRequested: 4,
      quantityAvailable: 0,
      message: "The equipment type is retired.",
      breakdown: null,
      reservations: [],
    });
    await openScreen();

    await fillAndSubmit(user);

    expect(await screen.findByRole("heading", { name: "Unavailable" })).toBeInTheDocument();
    expect(screen.getByText("The equipment type is retired.")).toBeInTheDocument();
    expect(screen.queryByText("How this was worked out")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Overlapping reservations/ })).not.toBeInTheDocument();
  });
});


describe("errors and states", () => {
  it("SCRUM23_AC2_shows_every_validation_error_from_the_backend", async () => {
    const user = userEvent.setup();
    service.checkEquipmentAvailability.mockRejectedValue(
      apiError(400, {
        details: [
          { field: "quantity", message: "must be a whole number greater than zero" },
          { field: "endAt", message: "must be later than the start" },
        ],
      }),
    );
    await openScreen();

    await fillAndSubmit(user, { quantity: "0" });

    expect(await screen.findByText("Quantity: must be a whole number greater than zero")).toBeInTheDocument();
    expect(screen.getByText("End: must be later than the start")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Fully available" })).not.toBeInTheDocument();
  });

  it("SCRUM23_AC1_shows_the_refusal_when_the_backend_answers_403", async () => {
    const user = userEvent.setup();
    service.checkEquipmentAvailability.mockRejectedValue(apiError(403, { error: "restricted" }));
    await openScreen();

    await fillAndSubmit(user);

    expect(await screen.findByText("Only Technical Support Staff can check equipment availability.")).toBeInTheDocument();
  });

  it("SCRUM23_AC2_never_shows_the_servers_own_text_for_a_500", async () => {
    const user = userEvent.setup();
    service.checkEquipmentAvailability.mockRejectedValue(apiError(500, { error: "secret driver text" }));
    await openScreen();

    await fillAndSubmit(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not check availability. Please try again.");
    expect(alert).not.toHaveTextContent("secret");
  });

  it("SCRUM23_AC2_disables_the_button_and_says_so_while_the_check_runs", async () => {
    const user = userEvent.setup();
    let finish;
    service.checkEquipmentAvailability.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await openScreen();

    await fillAndSubmit(user);

    expect(await screen.findByRole("button", { name: "Checking..." })).toBeDisabled();
    finish(answer());
    expect(await screen.findByRole("heading", { name: "Fully available" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check availability" })).toBeEnabled();
  });

  it("SCRUM23_AC2_drops_the_result_as_soon_as_an_input_changes", async () => {
    const user = userEvent.setup();
    service.checkEquipmentAvailability.mockResolvedValue(answer());
    await openScreen();
    await fillAndSubmit(user);
    await screen.findByRole("heading", { name: "Fully available" });

    await user.type(screen.getByLabelText("Quantity"), "5");

    expect(screen.queryByRole("heading", { name: "Fully available" })).not.toBeInTheDocument();
  });

  it("SCRUM23_AC12_a_second_check_replaces_the_first_and_clears_old_errors", async () => {
    const user = userEvent.setup();
    service.checkEquipmentAvailability
      .mockRejectedValueOnce(apiError(400, { details: [{ field: "quantity", message: "is required" }] }))
      .mockResolvedValueOnce(answer());
    await openScreen();

    await user.click(screen.getByRole("button", { name: "Check availability" }));
    await screen.findByText("Quantity: is required");
    await fillAndSubmit(user);

    expect(await screen.findByRole("heading", { name: "Fully available" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Quantity: is required")).not.toBeInTheDocument());
  });
});
