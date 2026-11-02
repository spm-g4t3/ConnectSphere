// Tests for the confirmation step on the equipment catalogue screen.
//
//   AC2 -- affected reservations (event, period, quantity, coordinator) are shown
//          and nothing is saved until the staff member confirms
//   AC3 -- the list shown is the one sent back as confirmed, in the order given
//   AC4 -- confirming saves the change in one request, with that list
//   AC7 -- a change that affects nothing saves without a confirmation
//
// It covers the three places a change starts (the edit form's total, the damage
// and maintenance form, and the retire button), and what happens when the list
// moves between the preview and the save, when the preview fails, and when the
// save fails. The service layer is mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../src/services/equipmentService", () => ({
  listEquipment: vi.fn(),
  createEquipment: vi.fn(),
  updateEquipment: vi.fn(),
  recordEquipmentCondition: vi.fn(),
  retireEquipment: vi.fn(),
  reinstateEquipment: vi.fn(),
  getEquipmentHistory: vi.fn(),
  previewEquipmentChange: vi.fn(),
}));

import * as service from "../../src/services/equipmentService";
import EquipmentCatalogue from "../../src/components/EquipmentCatalogue";
import { formatEventPeriod } from "../../src/services/eventPeriodFormat";

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

const speaker = {
  id: "s1",
  name: "Speaker",
  description: null,
  category: null,
  location: null,
  totalQuantity: 4,
  damagedQuantity: 0,
  underMaintenanceQuantity: 0,
  usableQuantity: 4,
  retiredAt: null,
};

const R1 = "11111111-1111-4111-8111-111111111111";
const R2 = "22222222-2222-4222-8222-222222222222";
const R3 = "33333333-3333-4333-8333-333333333333";

const reservation = (id, overrides = {}) => ({
  reservationId: id,
  eventRequestId: `e-${id.slice(0, 2)}`,
  eventName: "Open Day",
  equipmentLineId: `l-${id.slice(0, 2)}`,
  quantity: 3,
  startAt: "2026-11-05T01:00:00+00:00",
  endAt: "2026-11-05T05:00:00+00:00",
  coordinatorId: "c1",
  coordinatorName: "Cara Coordinator",
  flagged: false,
  reservedAt: "2026-10-01T00:00:00+00:00",
  ...overrides,
});

const preview = (affected, usableBefore = 6, usableAfter = 2) => ({
  usableBefore,
  usableAfter,
  affectedCount: affected.length,
  affectedUnits: affected.reduce((sum, item) => sum + item.quantity, 0),
  affected,
});

const apiError = (status, data) => Object.assign(new Error("request failed"), { response: { status, data } });
const moved = (conflicts) => apiError(409, { code: "EQUIPMENT_AFFECTED_CHANGED", error: "database prose", conflicts });

/** A promise the test settles by hand, to look at the screen while a call is in flight. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function openCatalogue() {
  render(<EquipmentCatalogue />);
  await screen.findByText("Projector (HD)");
}

async function typeInto(user, label, value) {
  const field = screen.getByLabelText(label);
  await user.clear(field);
  if (value !== "") await user.type(field, value);
}

/** Open the edit form for the projector and set the total. */
async function editTotal(user, total) {
  await user.click(screen.getByRole("button", { name: "Edit Projector (HD)" }));
  await typeInto(user, "Total quantity", total);
}

/** Open the damage form, set damaged and a note. */
async function enterDamage(user, damaged, note = "dropped") {
  await user.click(screen.getByRole("button", { name: "Damage and maintenance for Projector (HD)" }));
  await typeInto(user, "Damaged units", damaged);
  if (note !== "") await user.type(screen.getByLabelText("Note"), note);
}

const panel = () => screen.getByRole("region", { name: /Reservations affected/ });
// The reservations only: the panel's error list is a list too.
const affectedItems = () => within(screen.getByRole("list", { name: "Affected reservations" })).getAllByRole("listitem");

beforeEach(() => {
  vi.resetAllMocks();
  service.listEquipment.mockResolvedValue([projector, speaker]);
  service.previewEquipmentChange.mockResolvedValue(preview([]));
  service.updateEquipment.mockResolvedValue({});
  service.recordEquipmentCondition.mockResolvedValue({});
  service.retireEquipment.mockResolvedValue({});
});


describe("AC2: the edit form checks a smaller total", () => {
  it("SCRUM310_AC2_asks_which_reservations_the_new_total_affects_before_saving", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)]));
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await screen.findByRole("region", { name: /Reservations affected/ });
    expect(service.previewEquipmentChange).toHaveBeenCalledWith("p1", { totalQuantity: 4 });
    expect(service.updateEquipment).not.toHaveBeenCalled();
  });

  it("SCRUM310_AC2_sends_the_edited_name_with_the_total_so_a_taken_name_is_found_before_confirming", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)]));
    await openCatalogue();

    await editTotal(user, "4");
    await typeInto(user, "Name", "Projector (4K)");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await screen.findByRole("region", { name: /Reservations affected/ });
    expect(service.previewEquipmentChange).toHaveBeenCalledWith("p1", {
      name: "Projector (4K)",
      totalQuantity: 4,
    });
  });

  it("SCRUM310_AC2_a_name_the_preview_refuses_is_shown_on_the_form_and_no_list_is_offered", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockRejectedValue(
      apiError(400, { details: [{ field: "name", message: "is already used by another equipment type" }] }),
    );
    await openCatalogue();

    await editTotal(user, "4");
    await typeInto(user, "Name", "Speaker");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText(/already used by another equipment type/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Reservations affected/ })).not.toBeInTheDocument();
    expect(service.updateEquipment).not.toHaveBeenCalled();
  });

  it("SCRUM310_AC2_shows_event_period_quantity_and_coordinator_for_each_affected_reservation", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(
      preview([
        reservation(R1, { eventName: "Open Day", quantity: 3, coordinatorName: "Cara Coordinator" }),
        reservation(R2, {
          eventName: "Alumni Gala",
          quantity: 1,
          coordinatorName: "Dev Lee",
          startAt: "2026-12-01T02:00:00+00:00",
          endAt: "2026-12-01T09:00:00+00:00",
        }),
      ]),
    );
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("region", { name: /Reservations affected/ });

    const items = affectedItems();
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Open Day");
    expect(items[0]).toHaveTextContent(formatEventPeriod("2026-11-05T01:00:00+00:00", "2026-11-05T05:00:00+00:00"));
    expect(items[0]).toHaveTextContent("Quantity: 3 units");
    expect(items[0]).toHaveTextContent("Coordinator: Cara Coordinator");
    expect(items[1]).toHaveTextContent("Alumni Gala");
    expect(items[1]).toHaveTextContent(formatEventPeriod("2026-12-01T02:00:00+00:00", "2026-12-01T09:00:00+00:00"));
    expect(items[1]).toHaveTextContent("Quantity: 1 unit");
    expect(items[1]).toHaveTextContent("Coordinator: Dev Lee");
  });

  it("SCRUM310_AC2_keeps_the_order_the_backend_gave", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(
      preview([
        reservation(R3, { eventName: "Third" }),
        reservation(R1, { eventName: "First" }),
        reservation(R2, { eventName: "Second" }),
      ]),
    );
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("region", { name: /Reservations affected/ });

    const names = affectedItems().map((li) => li.querySelector("strong").textContent);
    expect(names).toEqual(["Third", "First", "Second"]);
  });

  it("SCRUM310_AC2_says_how_many_reservations_and_units_and_how_usable_changes", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(
      preview([reservation(R1, { quantity: 3 }), reservation(R2, { quantity: 2 })], 6, 2),
    );
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("region", { name: /Reservations affected/ });

    expect(panel()).toHaveTextContent("Usable units go from 6 to 2.");
    expect(panel()).toHaveTextContent("2 reservations (5 units) would no longer be covered.");
  });

  it("SCRUM310_AC2_says_what_confirming_does", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)]));
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("region", { name: /Reservations affected/ });

    expect(panel()).toHaveTextContent(/flags them as equipment unavailable/i);
    expect(panel()).toHaveTextContent(/back to Pending review/);
    expect(panel()).toHaveTextContent(/notifies the coordinators/);
    expect(panel()).toHaveTextContent(/oldest reservations are kept/);
  });

  it("SCRUM310_AC2_marks_a_reservation_that_was_already_flagged", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(
      preview([reservation(R1, { flagged: true }), reservation(R2)]),
    );
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("region", { name: /Reservations affected/ });

    const [first, second] = affectedItems();
    expect(first).toHaveTextContent("Already flagged");
    expect(second).not.toHaveTextContent("Already flagged");
  });

  it("SCRUM310_AC2_says_when_an_event_has_no_coordinator_or_no_name", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(
      preview([reservation(R1, { coordinatorName: null, eventName: "" })]),
    );
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("region", { name: /Reservations affected/ });

    expect(panel()).toHaveTextContent("Untitled event");
    expect(panel()).toHaveTextContent("Coordinator: No coordinator assigned");
  });

  it("SCRUM310_AC2_saves_nothing_while_the_list_is_on_screen", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)]));
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("region", { name: /Reservations affected/ });

    expect(service.updateEquipment).not.toHaveBeenCalled();
    expect(service.listEquipment).toHaveBeenCalledTimes(1);
  });

  it("SCRUM310_AC2_going_back_saves_nothing_and_keeps_what_was_typed", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)]));
    await openCatalogue();

    await editTotal(user, "4");
    await user.type(screen.getByLabelText(/Reason for a change/), "stock check");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Go back" }));

    expect(screen.queryByRole("region", { name: /Reservations affected/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Total quantity")).toHaveValue(4);
    expect(screen.getByLabelText(/Reason for a change/)).toHaveValue("stock check");
    expect(service.updateEquipment).not.toHaveBeenCalled();
  });

  it("SCRUM310_AC2_the_form_can_be_resubmitted_after_going_back", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)]));
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Go back" }));
    await typeInto(user, "Total quantity", "3");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("region", { name: /Reservations affected/ });

    expect(service.previewEquipmentChange).toHaveBeenNthCalledWith(2, "p1", { totalQuantity: 3 });
  });
});


describe("AC3 and AC4: confirming saves the list that was shown", () => {
  it("SCRUM310_AC4_confirming_saves_the_total_with_exactly_the_reservations_shown", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R3), reservation(R1)]));
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Confirm and flag these reservations" }));

    await waitFor(() => expect(service.updateEquipment).toHaveBeenCalledTimes(1));
    expect(service.updateEquipment).toHaveBeenCalledWith("p1", {
      totalQuantity: 4,
      confirmedReservationIds: [R3, R1],
    });
  });

  it("SCRUM310_AC4_returns_to_a_refreshed_list_after_the_save", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)]));
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Confirm and flag these reservations" }));

    expect(await screen.findByRole("heading", { name: "Equipment catalogue" })).toBeInTheDocument();
    await waitFor(() => expect(service.listEquipment).toHaveBeenCalledTimes(2));
  });

  it("SCRUM310_AC4_sends_the_reason_with_the_confirmed_total_change", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)]));
    await openCatalogue();

    await editTotal(user, "4");
    await user.type(screen.getByLabelText(/Reason for a change/), "  two lost in transit ");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Confirm and flag these reservations" }));

    await waitFor(() => expect(service.updateEquipment).toHaveBeenCalled());
    expect(service.updateEquipment).toHaveBeenCalledWith("p1", {
      totalQuantity: 4,
      note: "two lost in transit",
      confirmedReservationIds: [R1],
    });
  });

  it("SCRUM310_AC4_the_other_edited_fields_are_previewed_with_the_total_and_saved_with_it", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)]));
    await openCatalogue();

    await editTotal(user, "4");
    await typeInto(user, "Location", "Store room 9");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Confirm and flag these reservations" }));

    await waitFor(() => expect(service.updateEquipment).toHaveBeenCalled());
    expect(service.previewEquipmentChange).toHaveBeenCalledWith("p1", { totalQuantity: 4, location: "Store room 9" });
    expect(service.updateEquipment).toHaveBeenCalledWith("p1", {
      totalQuantity: 4,
      location: "Store room 9",
      confirmedReservationIds: [R1],
    });
  });

  it("SCRUM310_AC4_confirming_a_damage_change_saves_it_with_the_note_and_the_list", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1), reservation(R2)]));
    await openCatalogue();

    await enterDamage(user, "5", "flood");
    await user.click(screen.getByRole("button", { name: "Save quantities" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    expect(service.previewEquipmentChange).toHaveBeenCalledWith("p1", { damagedQuantity: 5 });
    expect(service.recordEquipmentCondition).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Confirm and flag these reservations" }));

    await waitFor(() => expect(service.recordEquipmentCondition).toHaveBeenCalledTimes(1));
    expect(service.recordEquipmentCondition).toHaveBeenCalledWith("p1", {
      damagedQuantity: 5,
      note: "flood",
      confirmedReservationIds: [R1, R2],
    });
    expect(await screen.findByRole("heading", { name: "Equipment catalogue" })).toBeInTheDocument();
  });

  it("SCRUM310_AC4_a_maintenance_change_is_previewed_and_saved_the_same_way", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)]));
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Damage and maintenance for Projector (HD)" }));
    await typeInto(user, "Under maintenance units", "4");
    await user.type(screen.getByLabelText("Note"), "servicing");
    await user.click(screen.getByRole("button", { name: "Save quantities" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Confirm and flag these reservations" }));

    await waitFor(() => expect(service.recordEquipmentCondition).toHaveBeenCalled());
    expect(service.previewEquipmentChange).toHaveBeenCalledWith("p1", { underMaintenanceQuantity: 4 });
    expect(service.recordEquipmentCondition).toHaveBeenCalledWith("p1", {
      underMaintenanceQuantity: 4,
      note: "servicing",
      confirmedReservationIds: [R1],
    });
  });

  it("SCRUM310_AC4_both_quantities_are_previewed_and_saved_together", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)]));
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Damage and maintenance for Projector (HD)" }));
    await typeInto(user, "Damaged units", "3");
    await typeInto(user, "Under maintenance units", "3");
    await user.type(screen.getByLabelText("Note"), "audit");
    await user.click(screen.getByRole("button", { name: "Save quantities" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Confirm and flag these reservations" }));

    await waitFor(() => expect(service.recordEquipmentCondition).toHaveBeenCalled());
    expect(service.previewEquipmentChange).toHaveBeenCalledWith("p1", { damagedQuantity: 3, underMaintenanceQuantity: 3 });
    expect(service.recordEquipmentCondition).toHaveBeenCalledWith("p1", {
      damagedQuantity: 3,
      underMaintenanceQuantity: 3,
      note: "audit",
      confirmedReservationIds: [R1],
    });
  });

  it("SCRUM310_AC4_the_confirm_button_is_pressed_once_so_the_save_is_sent_once", async () => {
    const user = userEvent.setup();
    const saving = deferred();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)]));
    service.updateEquipment.mockReturnValue(saving.promise);
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    const confirm = screen.getByRole("button", { name: "Confirm and flag these reservations" });
    await user.click(confirm);
    await user.click(screen.getByRole("button", { name: "Saving..." }));
    await user.click(screen.getByRole("button", { name: "Saving..." }));

    expect(service.updateEquipment).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Go back" })).toBeDisabled();

    saving.resolve({});
    expect(await screen.findByRole("heading", { name: "Equipment catalogue" })).toBeInTheDocument();
    expect(service.updateEquipment).toHaveBeenCalledTimes(1);
  });
});


describe("AC7: a change that affects nothing saves without a confirmation", () => {
  it("SCRUM310_AC7_a_total_with_no_reservations_affected_saves_at_once_with_an_empty_list", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([]));
    await openCatalogue();

    await editTotal(user, "7");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("heading", { name: "Equipment catalogue" })).toBeInTheDocument();
    expect(service.updateEquipment).toHaveBeenCalledWith("p1", { totalQuantity: 7, confirmedReservationIds: [] });
    expect(screen.queryByRole("region", { name: /Reservations affected/ })).not.toBeInTheDocument();
  });

  it("SCRUM310_AC7_a_damage_change_with_no_reservations_affected_saves_at_once", async () => {
    const user = userEvent.setup();
    await openCatalogue();

    await enterDamage(user, "2", "scratched");
    await user.click(screen.getByRole("button", { name: "Save quantities" }));

    expect(await screen.findByRole("heading", { name: "Equipment catalogue" })).toBeInTheDocument();
    expect(service.recordEquipmentCondition).toHaveBeenCalledWith("p1", {
      damagedQuantity: 2,
      note: "scratched",
      confirmedReservationIds: [],
    });
  });

  it("SCRUM310_AC7_raising_a_total_is_still_checked_and_saves_when_nothing_is_affected", async () => {
    const user = userEvent.setup();
    await openCatalogue();

    await editTotal(user, "20");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(service.updateEquipment).toHaveBeenCalled());
    expect(service.previewEquipmentChange).toHaveBeenCalledWith("p1", { totalQuantity: 20 });
  });

  it("SCRUM310_AC7_a_retirement_with_no_reservations_affected_retires_after_the_existing_confirm_only", async () => {
    const user = userEvent.setup();
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Retire Projector (HD)" }));
    expect(service.previewEquipmentChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm retire Projector (HD)" }));

    await waitFor(() => expect(service.retireEquipment).toHaveBeenCalledWith("p1", { confirmedReservationIds: [] }));
    expect(screen.queryByRole("region", { name: /Reservations affected/ })).not.toBeInTheDocument();
    await waitFor(() => expect(service.listEquipment).toHaveBeenCalledTimes(2));
  });

  it("SCRUM310_AC7_an_edit_that_leaves_the_total_alone_is_not_previewed", async () => {
    const user = userEvent.setup();
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Edit Projector (HD)" }));
    await typeInto(user, "Name", "Projector (4K)");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(service.updateEquipment).toHaveBeenCalledWith("p1", { name: "Projector (4K)" }));
    expect(service.previewEquipmentChange).not.toHaveBeenCalled();
  });

  it("SCRUM310_AC7_a_reason_typed_for_a_non_total_edit_is_not_sent", async () => {
    const user = userEvent.setup();
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Edit Projector (HD)" }));
    await typeInto(user, "Name", "Projector (4K)");
    await user.type(screen.getByLabelText(/Reason for a change/), "rename");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(service.updateEquipment).toHaveBeenCalled());
    expect(service.updateEquipment).toHaveBeenCalledWith("p1", { name: "Projector (4K)" });
  });

  it("SCRUM310_AC7_a_blank_reason_is_not_sent_with_a_total_change", async () => {
    const user = userEvent.setup();
    await openCatalogue();

    await editTotal(user, "7");
    await user.type(screen.getByLabelText(/Reason for a change/), "   ");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(service.updateEquipment).toHaveBeenCalled());
    expect(service.updateEquipment).toHaveBeenCalledWith("p1", { totalQuantity: 7, confirmedReservationIds: [] });
  });

  it("SCRUM310_AC7_creating_a_type_never_asks_which_reservations_it_affects", async () => {
    const user = userEvent.setup();
    service.createEquipment.mockResolvedValue({});
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Add equipment type" }));
    await user.type(screen.getByLabelText("Name"), "Cable");
    await user.type(screen.getByLabelText("Total quantity"), "5");
    await user.click(screen.getByRole("button", { name: "Add equipment type" }));

    await waitFor(() => expect(service.createEquipment).toHaveBeenCalled());
    expect(service.previewEquipmentChange).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/Reason for a change/)).not.toBeInTheDocument();
  });
});


describe("AC2 and AC4 for a retirement", () => {
  async function startRetire(user, name = "Projector (HD)") {
    await user.click(screen.getByRole("button", { name: `Retire ${name}` }));
    await user.click(screen.getByRole("button", { name: `Confirm retire ${name}` }));
  }

  it("SCRUM310_AC2_a_retirement_that_affects_reservations_lists_them_under_the_row_and_retires_nothing", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1), reservation(R2)], 6, 0));
    await openCatalogue();

    await startRetire(user);

    const shown = await screen.findByRole("region", { name: /Reservations affected: Projector \(HD\)/ });
    expect(service.previewEquipmentChange).toHaveBeenCalledWith("p1", { retire: true });
    expect(within(within(shown).getByRole("list", { name: "Affected reservations" })).getAllByRole("listitem")).toHaveLength(2);
    expect(shown).toHaveTextContent("Usable units go from 6 to 0.");
    expect(service.retireEquipment).not.toHaveBeenCalled();
  });

  it("SCRUM310_AC4_confirming_a_retirement_sends_the_list_that_was_shown_and_refreshes", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R2), reservation(R1)], 6, 0));
    await openCatalogue();

    await startRetire(user);
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Retire and flag these reservations" }));

    await waitFor(() => expect(service.retireEquipment).toHaveBeenCalledWith("p1", { confirmedReservationIds: [R2, R1] }));
    await waitFor(() => expect(service.listEquipment).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("region", { name: /Reservations affected/ })).not.toBeInTheDocument();
  });

  it("SCRUM310_AC2_keeping_the_type_retires_nothing_and_closes_the_list", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)], 6, 0));
    await openCatalogue();

    await startRetire(user);
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Keep this type" }));

    expect(screen.queryByRole("region", { name: /Reservations affected/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retire Projector (HD)" })).toBeEnabled();
    expect(service.retireEquipment).not.toHaveBeenCalled();
  });

  it("SCRUM310_AC2_after_keeping_the_type_it_can_be_retired_again_from_the_start", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)], 6, 0));
    await openCatalogue();

    await startRetire(user);
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Keep this type" }));
    await startRetire(user);
    await screen.findByRole("region", { name: /Reservations affected/ });

    expect(service.previewEquipmentChange).toHaveBeenCalledTimes(2);
  });

  it("SCRUM310_AC2_other_types_cannot_be_changed_while_a_list_is_waiting_for_a_decision", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)], 6, 0));
    await openCatalogue();

    await startRetire(user);
    await screen.findByRole("region", { name: /Reservations affected/ });

    expect(screen.getByRole("button", { name: "Retire Speaker" })).toBeDisabled();
  });

  it("SCRUM310_AC2_the_retire_button_shows_it_is_checking_while_the_preview_runs", async () => {
    const user = userEvent.setup();
    const checking = deferred();
    service.previewEquipmentChange.mockReturnValue(checking.promise);
    await openCatalogue();

    await startRetire(user);

    const confirm = screen.getByRole("button", { name: "Confirm retire Projector (HD)" });
    expect(confirm).toHaveTextContent("Checking...");
    expect(confirm).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel retire Projector (HD)" })).toBeDisabled();
    expect(service.retireEquipment).not.toHaveBeenCalled();

    checking.resolve(preview([]));
    await waitFor(() => expect(service.retireEquipment).toHaveBeenCalledTimes(1));
  });

  it("SCRUM310_AC2_only_the_row_being_retired_shows_a_list", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)], 4, 0));
    await openCatalogue();

    await startRetire(user, "Speaker");
    await screen.findByRole("region", { name: /Reservations affected: Speaker/ });

    expect(screen.queryByRole("region", { name: /Reservations affected: Projector/ })).not.toBeInTheDocument();
    expect(service.previewEquipmentChange).toHaveBeenCalledWith("s1", { retire: true });
  });

  it("SCRUM310_AC2_a_retired_type_has_no_retire_step_and_reinstating_is_not_previewed", async () => {
    const user = userEvent.setup();
    service.listEquipment.mockResolvedValue([projector, { ...speaker, retiredAt: "2026-10-01T00:00:00+00:00" }]);
    service.reinstateEquipment.mockResolvedValue({});
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Reinstate Speaker" }));

    await waitFor(() => expect(service.reinstateEquipment).toHaveBeenCalledWith("s1"));
    expect(service.previewEquipmentChange).not.toHaveBeenCalled();
  });

  it("SCRUM310_AC2_an_edit_button_for_a_retired_type_still_works", async () => {
    const user = userEvent.setup();
    service.listEquipment.mockResolvedValue([projector, { ...speaker, retiredAt: "2026-10-01T00:00:00+00:00" }]);
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Edit Speaker" }));
    await typeInto(user, "Total quantity", "2");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(service.updateEquipment).toHaveBeenCalledWith("s1", { totalQuantity: 2, confirmedReservationIds: [] }));
  });
});


describe("AC2: the list moved between the preview and the save", () => {
  it("SCRUM310_AC2_a_refused_save_shows_the_new_list_with_a_notice_and_saves_nothing_more", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)]));
    service.updateEquipment.mockRejectedValue(
      moved([reservation(R1), reservation(R2, { eventName: "Late booking", coordinatorName: "Eli Tan" })]),
    );
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Confirm and flag these reservations" }));

    await waitFor(() => expect(affectedItems()).toHaveLength(2));
    expect(panel()).toHaveTextContent("Late booking");
    expect(panel()).toHaveTextContent("Coordinator: Eli Tan");
    expect(screen.getByRole("alert")).toHaveTextContent(/changed since you looked/);
    expect(screen.getByRole("alert")).toHaveTextContent(/Nothing was saved/);
    expect(service.updateEquipment).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Confirm and flag these reservations" })).toBeEnabled();
  });

  it("SCRUM310_AC2_the_server_text_of_the_refusal_is_never_shown", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)]));
    service.updateEquipment.mockRejectedValue(moved([reservation(R1), reservation(R2)]));
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Confirm and flag these reservations" }));
    await waitFor(() => expect(affectedItems()).toHaveLength(2));

    expect(document.body).not.toHaveTextContent("database prose");
  });

  it("SCRUM310_AC3_confirming_the_new_list_sends_the_new_ids_and_not_the_old_ones", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)]));
    service.updateEquipment.mockRejectedValueOnce(moved([reservation(R1), reservation(R2)])).mockResolvedValueOnce({});
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Confirm and flag these reservations" }));
    await waitFor(() => expect(affectedItems()).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "Confirm and flag these reservations" }));

    await waitFor(() => expect(service.updateEquipment).toHaveBeenCalledTimes(2));
    expect(service.updateEquipment).toHaveBeenNthCalledWith(1, "p1", { totalQuantity: 4, confirmedReservationIds: [R1] });
    expect(service.updateEquipment).toHaveBeenNthCalledWith(2, "p1", { totalQuantity: 4, confirmedReservationIds: [R1, R2] });
    expect(await screen.findByRole("heading", { name: "Equipment catalogue" })).toBeInTheDocument();
  });

  it("SCRUM310_AC3_the_usable_figures_from_the_preview_stay_on_the_refreshed_list", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)], 6, 2));
    service.updateEquipment.mockRejectedValue(moved([reservation(R2, { quantity: 1 })]));
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Confirm and flag these reservations" }));
    await screen.findByRole("alert");

    expect(panel()).toHaveTextContent("Usable units go from 6 to 2. 1 reservation (1 unit) would no longer be covered.");
  });

  it("SCRUM310_AC2_a_refusal_that_leaves_no_reservations_says_so_and_offers_a_plain_save", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)]));
    service.updateEquipment.mockRejectedValueOnce(moved([])).mockResolvedValueOnce({});
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Confirm and flag these reservations" }));

    expect(await screen.findByText("No reservations are affected by this change.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Affected reservations" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(service.updateEquipment).toHaveBeenCalledTimes(2));
    expect(service.updateEquipment).toHaveBeenNthCalledWith(2, "p1", { totalQuantity: 4, confirmedReservationIds: [] });
  });

  it("SCRUM310_AC2_a_save_that_follows_an_empty_preview_but_is_refused_shows_the_list_for_a_decision", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([]));
    service.updateEquipment.mockRejectedValueOnce(moved([reservation(R1)]));
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await screen.findByRole("region", { name: /Reservations affected/ });
    expect(panel()).toHaveTextContent("1 reservation (3 units) would no longer be covered.");
    expect(panel()).not.toHaveTextContent("Usable units go from");
    expect(screen.getByRole("alert")).toHaveTextContent(/Nothing was saved/);
    expect(service.updateEquipment).toHaveBeenCalledTimes(1);
  });

  it("SCRUM310_AC2_a_refusal_with_a_malformed_list_shows_no_reservations_that_were_not_sent", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)]));
    service.updateEquipment.mockRejectedValue(apiError(409, { code: "EQUIPMENT_AFFECTED_CHANGED", conflicts: "everything" }));
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Confirm and flag these reservations" }));

    expect(await screen.findByText("No reservations are affected by this change.")).toBeInTheDocument();
    expect(service.updateEquipment).toHaveBeenCalledTimes(1);
  });

  it("SCRUM310_AC2_a_refused_damage_change_shows_the_new_list_and_confirms_it_with_the_same_note", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)]));
    service.recordEquipmentCondition
      .mockRejectedValueOnce(moved([reservation(R1), reservation(R3)]))
      .mockResolvedValueOnce({});
    await openCatalogue();

    await enterDamage(user, "5", "flood");
    await user.click(screen.getByRole("button", { name: "Save quantities" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Confirm and flag these reservations" }));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Confirm and flag these reservations" }));

    await waitFor(() => expect(service.recordEquipmentCondition).toHaveBeenCalledTimes(2));
    expect(service.recordEquipmentCondition).toHaveBeenNthCalledWith(2, "p1", {
      damagedQuantity: 5,
      note: "flood",
      confirmedReservationIds: [R1, R3],
    });
  });

  it("SCRUM310_AC2_a_refused_retirement_shows_the_new_list_and_confirms_it", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)], 6, 0));
    service.retireEquipment.mockRejectedValueOnce(moved([reservation(R2)])).mockResolvedValueOnce({});
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Retire Projector (HD)" }));
    await user.click(screen.getByRole("button", { name: "Confirm retire Projector (HD)" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Retire and flag these reservations" }));
    await screen.findByRole("alert");
    expect(panel()).toHaveTextContent("Open Day");
    await user.click(screen.getByRole("button", { name: "Retire and flag these reservations" }));

    await waitFor(() => expect(service.retireEquipment).toHaveBeenCalledTimes(2));
    expect(service.retireEquipment).toHaveBeenNthCalledWith(2, "p1", { confirmedReservationIds: [R2] });
    await waitFor(() => expect(service.listEquipment).toHaveBeenCalledTimes(2));
  });

  it("SCRUM310_AC2_a_refusal_does_not_refetch_the_catalogue", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)], 6, 0));
    service.retireEquipment.mockRejectedValue(moved([reservation(R2)]));
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Retire Projector (HD)" }));
    await user.click(screen.getByRole("button", { name: "Confirm retire Projector (HD)" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Retire and flag these reservations" }));
    await screen.findByRole("alert");

    expect(service.listEquipment).toHaveBeenCalledTimes(1);
  });
});


describe("when the preview fails nothing is saved", () => {
  it("SCRUM310_AC2_a_failed_preview_on_an_edit_shows_a_message_and_leaves_the_form_usable", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockRejectedValue(apiError(500, { error: "secret driver text" }));
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText(/Could not check which reservations this change affects/)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("secret");
    expect(service.updateEquipment).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    expect(screen.getByLabelText("Total quantity")).toHaveValue(4);
  });

  it("SCRUM310_AC2_a_failed_preview_can_be_retried_and_then_continues_as_normal", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange
      .mockRejectedValueOnce(apiError(500, {}))
      .mockResolvedValueOnce(preview([reservation(R1)]));
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText(/Could not check which reservations/);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await screen.findByRole("region", { name: /Reservations affected/ });
    expect(screen.queryByText(/Could not check which reservations/)).not.toBeInTheDocument();
  });

  it("SCRUM310_AC2_a_failed_preview_on_a_damage_change_shows_the_backends_validation_messages", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockRejectedValue(
      apiError(400, { details: [{ field: "underMaintenanceQuantity", message: "damaged plus under maintenance (11) can't exceed the total (8)" }] }),
    );
    await openCatalogue();

    await enterDamage(user, "10");
    await user.click(screen.getByRole("button", { name: "Save quantities" }));

    expect(
      await screen.findByText("Under maintenance: damaged plus under maintenance (11) can't exceed the total (8)"),
    ).toBeInTheDocument();
    expect(service.recordEquipmentCondition).not.toHaveBeenCalled();
  });

  it("SCRUM310_AC2_a_failed_preview_on_a_retirement_shows_a_message_under_the_row_and_retires_nothing", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockRejectedValue(apiError(500, { error: "driver text" }));
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Retire Projector (HD)" }));
    await user.click(screen.getByRole("button", { name: "Confirm retire Projector (HD)" }));

    expect(await screen.findByText(/Could not check which reservations this change affects/)).toBeInTheDocument();
    expect(service.retireEquipment).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Retire Projector (HD)" })).toBeEnabled();
    expect(service.listEquipment).toHaveBeenCalledTimes(1);
  });

  it("SCRUM310_AC2_a_retirement_preview_that_finds_the_type_gone_refreshes_the_list", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockRejectedValue(apiError(404, {}));
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Retire Projector (HD)" }));
    await user.click(screen.getByRole("button", { name: "Confirm retire Projector (HD)" }));

    expect(await screen.findByText("That equipment type no longer exists. The list has been refreshed.")).toBeInTheDocument();
    await waitFor(() => expect(service.listEquipment).toHaveBeenCalledTimes(2));
  });

  it.each([
    ["nothing", undefined],
    ["null", null],
    ["text", "ok"],
    ["an object with no list", { usableBefore: 1, usableAfter: 0 }],
    ["a list that is not a list", { affected: "none" }],
  ])("SCRUM310_AC2_a_preview_answer_of_%s_is_an_error_and_never_a_reason_to_save", async (_label, answer) => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(answer);
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText(/Could not check which reservations this change affects/)).toBeInTheDocument();
    expect(service.updateEquipment).not.toHaveBeenCalled();
  });

  it("SCRUM310_AC2_the_save_button_shows_it_is_checking_and_is_disabled_while_the_preview_runs", async () => {
    const user = userEvent.setup();
    const checking = deferred();
    service.previewEquipmentChange.mockReturnValue(checking.promise);
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(screen.getByRole("button", { name: "Checking..." })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Checking..." }));
    expect(service.previewEquipmentChange).toHaveBeenCalledTimes(1);

    checking.resolve(preview([]));
    await waitFor(() => expect(service.updateEquipment).toHaveBeenCalledTimes(1));
  });
});


describe("when the save fails after the list was shown", () => {
  it("SCRUM310_AC4_a_failed_save_keeps_the_list_on_screen_with_the_message_and_allows_another_try", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)]));
    service.updateEquipment.mockRejectedValueOnce(apiError(500, { error: "driver text" })).mockResolvedValueOnce({});
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Confirm and flag these reservations" }));

    expect(await screen.findByText("Could not save the equipment type. Please try again.")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("driver text");
    expect(affectedItems()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Confirm and flag these reservations" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Confirm and flag these reservations" }));
    await waitFor(() => expect(service.updateEquipment).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Could not save the equipment type. Please try again.")).not.toBeInTheDocument();
  });

  it("SCRUM310_AC4_a_failed_damage_save_shows_the_conditions_message", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)]));
    service.recordEquipmentCondition.mockRejectedValue(apiError(500, {}));
    await openCatalogue();

    await enterDamage(user, "5");
    await user.click(screen.getByRole("button", { name: "Save quantities" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Confirm and flag these reservations" }));

    expect(await screen.findByText("Could not save the quantities. Please try again.")).toBeInTheDocument();
  });

  it("SCRUM310_AC4_going_back_after_a_failed_save_returns_to_the_form_with_nothing_saved", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)]));
    service.recordEquipmentCondition.mockRejectedValue(apiError(500, {}));
    await openCatalogue();

    await enterDamage(user, "5", "flood");
    await user.click(screen.getByRole("button", { name: "Save quantities" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Confirm and flag these reservations" }));
    await screen.findByText("Could not save the quantities. Please try again.");
    await user.click(screen.getByRole("button", { name: "Go back" }));

    expect(screen.getByLabelText("Damaged units")).toHaveValue(5);
    expect(screen.getByLabelText("Note")).toHaveValue("flood");
    expect(screen.queryByText("Could not save the quantities. Please try again.")).not.toBeInTheDocument();
  });

  it("SCRUM310_AC4_a_failed_retirement_after_the_list_stays_in_front_of_the_user", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)], 6, 0));
    service.retireEquipment.mockRejectedValue(apiError(500, {}));
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Retire Projector (HD)" }));
    await user.click(screen.getByRole("button", { name: "Confirm retire Projector (HD)" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Retire and flag these reservations" }));

    expect(await screen.findByText("Could not retire this type. Please try again.")).toBeInTheDocument();
    expect(screen.getAllByText("Could not retire this type. Please try again.")).toHaveLength(1);
    expect(affectedItems()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Retire and flag these reservations" })).toBeEnabled();
  });

  it("SCRUM310_AC4_a_retirement_that_finds_the_type_already_retired_closes_the_list_and_refreshes", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)], 6, 0));
    service.retireEquipment.mockRejectedValue(apiError(409, { code: "EQUIPMENT_ALREADY_RETIRED" }));
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Retire Projector (HD)" }));
    await user.click(screen.getByRole("button", { name: "Confirm retire Projector (HD)" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Retire and flag these reservations" }));

    expect(await screen.findByText("This type has already been retired. The list has been refreshed.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Reservations affected/ })).not.toBeInTheDocument();
    await waitFor(() => expect(service.listEquipment).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Retire Speaker" })).toBeEnabled();
  });

  it("SCRUM310_AC4_a_direct_retirement_failure_after_an_empty_preview_closes_the_confirm_step_as_before", async () => {
    const user = userEvent.setup();
    service.retireEquipment.mockRejectedValue(apiError(500, {}));
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Retire Projector (HD)" }));
    await user.click(screen.getByRole("button", { name: "Confirm retire Projector (HD)" }));

    expect(await screen.findByText("Could not retire this type. Please try again.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm retire Projector (HD)" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retire Projector (HD)" })).toBeEnabled();
  });
});


describe("the damage form checks before it looks anything up", () => {
  it("SCRUM310_AC2_a_blank_note_is_refused_before_the_preview", async () => {
    const user = userEvent.setup();
    await openCatalogue();

    await enterDamage(user, "5", "");
    await user.click(screen.getByRole("button", { name: "Save quantities" }));

    expect(await screen.findByText("Note: is required")).toBeInTheDocument();
    expect(service.previewEquipmentChange).not.toHaveBeenCalled();
  });

  it("SCRUM310_AC2_a_note_of_only_spaces_is_refused_before_the_preview", async () => {
    const user = userEvent.setup();
    await openCatalogue();

    await enterDamage(user, "5", "   ");
    await user.click(screen.getByRole("button", { name: "Save quantities" }));

    expect(await screen.findByText("Note: is required")).toBeInTheDocument();
    expect(service.previewEquipmentChange).not.toHaveBeenCalled();
  });

  it("SCRUM310_AC2_no_change_is_refused_before_the_preview", async () => {
    const user = userEvent.setup();
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Damage and maintenance for Projector (HD)" }));
    await user.type(screen.getByLabelText("Note"), "x");
    await user.click(screen.getByRole("button", { name: "Save quantities" }));

    expect(screen.getByText("Change at least one quantity.")).toBeInTheDocument();
    expect(service.previewEquipmentChange).not.toHaveBeenCalled();
  });

  it("SCRUM310_AC2_a_cleared_quantity_is_sent_as_null_for_the_backend_to_judge", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockRejectedValue(
      apiError(400, { details: [{ field: "damagedQuantity", message: "must be a whole number" }] }),
    );
    await openCatalogue();

    await enterDamage(user, "", "x");
    await user.click(screen.getByRole("button", { name: "Save quantities" }));

    await screen.findByText("Damaged: must be a whole number");
    expect(service.previewEquipmentChange).toHaveBeenCalledWith("p1", { damagedQuantity: null });
  });

  it("SCRUM310_AC2_the_message_for_an_earlier_mistake_goes_away_when_the_next_try_works", async () => {
    const user = userEvent.setup();
    await openCatalogue();

    await enterDamage(user, "5", "");
    await user.click(screen.getByRole("button", { name: "Save quantities" }));
    await screen.findByText("Note: is required");
    await user.type(screen.getByLabelText("Note"), "flood");
    await user.click(screen.getByRole("button", { name: "Save quantities" }));

    await waitFor(() => expect(service.recordEquipmentCondition).toHaveBeenCalled());
    expect(screen.queryByText("Note: is required")).not.toBeInTheDocument();
  });
});


describe("quick or repeated clicks cannot save twice or skip the list", () => {
  it("SCRUM310_AC4_submitting_the_edit_form_twice_in_one_moment_asks_the_backend_once", async () => {
    const user = userEvent.setup();
    const checking = deferred();
    service.previewEquipmentChange.mockReturnValue(checking.promise);
    await openCatalogue();

    await editTotal(user, "4");
    const form = document.querySelector("form");
    act(() => {
      form.requestSubmit();
      form.requestSubmit();
    });

    expect(service.previewEquipmentChange).toHaveBeenCalledTimes(1);
    checking.resolve(preview([]));
    await waitFor(() => expect(service.updateEquipment).toHaveBeenCalledTimes(1));
  });

  it("SCRUM310_AC4_submitting_the_edit_form_again_while_it_is_checking_does_nothing", async () => {
    const user = userEvent.setup();
    const checking = deferred();
    service.previewEquipmentChange.mockReturnValue(checking.promise);
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    fireEvent.submit(document.querySelector("form"));

    expect(service.previewEquipmentChange).toHaveBeenCalledTimes(1);
    checking.resolve(preview([]));
    await waitFor(() => expect(service.updateEquipment).toHaveBeenCalledTimes(1));
  });

  it("SCRUM310_AC4_submitting_the_damage_form_again_while_it_is_checking_does_nothing", async () => {
    const user = userEvent.setup();
    const checking = deferred();
    service.previewEquipmentChange.mockReturnValue(checking.promise);
    await openCatalogue();

    await enterDamage(user, "5");
    await user.click(screen.getByRole("button", { name: "Save quantities" }));
    fireEvent.submit(document.querySelector("form"));

    expect(service.previewEquipmentChange).toHaveBeenCalledTimes(1);
    checking.resolve(preview([]));
    await waitFor(() => expect(service.recordEquipmentCondition).toHaveBeenCalledTimes(1));
  });

  it("SCRUM310_AC4_pressing_confirm_twice_in_one_moment_saves_once", async () => {
    const user = userEvent.setup();
    const saving = deferred();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)]));
    service.updateEquipment.mockReturnValue(saving.promise);
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    const confirm = screen.getByRole("button", { name: "Confirm and flag these reservations" });
    act(() => {
      confirm.click();
      confirm.click();
    });

    expect(service.updateEquipment).toHaveBeenCalledTimes(1);
    saving.resolve({});
    await screen.findByRole("heading", { name: "Equipment catalogue" });
  });

  it("SCRUM310_AC4_the_list_stays_on_screen_while_the_confirmed_save_is_running", async () => {
    const user = userEvent.setup();
    const saving = deferred();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1), reservation(R2)]));
    service.recordEquipmentCondition.mockReturnValue(saving.promise);
    await openCatalogue();

    await enterDamage(user, "5");
    await user.click(screen.getByRole("button", { name: "Save quantities" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Confirm and flag these reservations" }));

    expect(affectedItems()).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    saving.resolve({});
    await screen.findByRole("heading", { name: "Equipment catalogue" });
  });

  it("SCRUM310_AC4_a_direct_save_after_an_empty_preview_shows_saving_on_the_form_button", async () => {
    const user = userEvent.setup();
    const saving = deferred();
    service.recordEquipmentCondition.mockReturnValue(saving.promise);
    await openCatalogue();

    await enterDamage(user, "2");
    await user.click(screen.getByRole("button", { name: "Save quantities" }));

    expect(await screen.findByRole("button", { name: "Saving..." })).toBeDisabled();
    saving.resolve({});
    await screen.findByRole("heading", { name: "Equipment catalogue" });
  });
});


describe("leaving the screen part way through", () => {
  it("SCRUM310_AC2_leaving_the_form_while_it_is_checking_never_goes_on_to_save", async () => {
    const user = userEvent.setup();
    const checking = deferred();
    service.previewEquipmentChange.mockReturnValue(checking.promise);
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await user.click(screen.getByRole("button", { name: /Back to the equipment catalogue/ }));
    checking.resolve(preview([]));
    await act(async () => {});

    expect(service.updateEquipment).not.toHaveBeenCalled();
  });

  it("SCRUM310_AC2_leaving_the_form_while_a_failed_check_is_on_its_way_shows_nothing_and_saves_nothing", async () => {
    const user = userEvent.setup();
    const checking = deferred();
    service.previewEquipmentChange.mockReturnValue(checking.promise);
    await openCatalogue();

    await enterDamage(user, "5");
    await user.click(screen.getByRole("button", { name: "Save quantities" }));
    await user.click(screen.getByRole("button", { name: /Back to the equipment catalogue/ }));
    checking.reject(apiError(500, {}));
    await act(async () => {});

    expect(service.recordEquipmentCondition).not.toHaveBeenCalled();
    expect(screen.queryByText(/Could not check which reservations/)).not.toBeInTheDocument();
  });

  it("SCRUM310_AC4_a_save_already_on_its_way_still_refreshes_the_list_when_the_user_has_left", async () => {
    const user = userEvent.setup();
    const saving = deferred();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)]));
    service.updateEquipment.mockReturnValue(saving.promise);
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Confirm and flag these reservations" }));
    await user.click(screen.getByRole("button", { name: /Back to the equipment catalogue/ }));
    saving.resolve({});

    await waitFor(() => expect(service.listEquipment).toHaveBeenCalledTimes(2));
  });

  it("SCRUM310_AC4_a_save_that_fails_after_the_user_left_shows_nothing_and_does_not_crash", async () => {
    const user = userEvent.setup();
    const saving = deferred();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)]));
    service.updateEquipment.mockReturnValue(saving.promise);
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Confirm and flag these reservations" }));
    await user.click(screen.getByRole("button", { name: /Back to the equipment catalogue/ }));
    saving.reject(apiError(500, {}));
    await act(async () => {});

    expect(screen.queryByText("Could not save the equipment type. Please try again.")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Equipment catalogue" })).toBeInTheDocument();
    expect(service.listEquipment).toHaveBeenCalledTimes(1);
  });
});


describe("a refusal that leaves nothing affected, on the other two screens", () => {
  it("SCRUM310_AC2_the_damage_form_offers_a_plain_save_when_the_new_list_is_empty", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)]));
    service.recordEquipmentCondition.mockRejectedValueOnce(moved([])).mockResolvedValueOnce({});
    await openCatalogue();

    await enterDamage(user, "5");
    await user.click(screen.getByRole("button", { name: "Save quantities" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Confirm and flag these reservations" }));
    await screen.findByText("No reservations are affected by this change.");
    await user.click(screen.getByRole("button", { name: "Save quantities" }));

    await waitFor(() => expect(service.recordEquipmentCondition).toHaveBeenCalledTimes(2));
    expect(service.recordEquipmentCondition).toHaveBeenNthCalledWith(2, "p1", {
      damagedQuantity: 5,
      note: "dropped",
      confirmedReservationIds: [],
    });
  });

  it("SCRUM310_AC2_a_retirement_offers_a_plain_retire_when_the_new_list_is_empty", async () => {
    const user = userEvent.setup();
    service.previewEquipmentChange.mockResolvedValue(preview([reservation(R1)], 6, 0));
    service.retireEquipment.mockRejectedValueOnce(moved([])).mockResolvedValueOnce({});
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Retire Projector (HD)" }));
    await user.click(screen.getByRole("button", { name: "Confirm retire Projector (HD)" }));
    await screen.findByRole("region", { name: /Reservations affected/ });
    await user.click(screen.getByRole("button", { name: "Retire and flag these reservations" }));
    await screen.findByText("No reservations are affected by this change.");
    await user.click(screen.getByRole("button", { name: "Retire" }));

    await waitFor(() => expect(service.retireEquipment).toHaveBeenCalledTimes(2));
    expect(service.retireEquipment).toHaveBeenNthCalledWith(2, "p1", { confirmedReservationIds: [] });
  });
});


describe("reinstating and refreshing still report their failures", () => {
  const retiredSpeaker = { ...speaker, retiredAt: "2026-10-01T00:00:00+00:00" };

  it("SCRUM310_AC4_a_reinstate_that_finds_the_type_not_retired_explains_it_and_refreshes", async () => {
    const user = userEvent.setup();
    service.listEquipment.mockResolvedValue([projector, retiredSpeaker]);
    service.reinstateEquipment.mockRejectedValue(apiError(409, { code: "EQUIPMENT_NOT_RETIRED" }));
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Reinstate Speaker" }));

    expect(await screen.findByText("This type is not retired. The list has been refreshed.")).toBeInTheDocument();
    await waitFor(() => expect(service.listEquipment).toHaveBeenCalledTimes(2));
  });

  it("SCRUM310_AC4_a_reinstate_that_fails_otherwise_says_so_and_does_not_refresh", async () => {
    const user = userEvent.setup();
    service.listEquipment.mockResolvedValue([projector, retiredSpeaker]);
    service.reinstateEquipment.mockRejectedValue(apiError(500, { error: "driver text" }));
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Reinstate Speaker" }));

    expect(await screen.findByText("Could not reinstate this type. Please try again.")).toBeInTheDocument();
    expect(service.listEquipment).toHaveBeenCalledTimes(1);
    expect(document.body).not.toHaveTextContent("driver text");
  });

  it("SCRUM310_AC4_the_reinstate_button_shows_it_is_working", async () => {
    const user = userEvent.setup();
    const working = deferred();
    service.listEquipment.mockResolvedValue([projector, retiredSpeaker]);
    service.reinstateEquipment.mockReturnValue(working.promise);
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Reinstate Speaker" }));

    expect(screen.getByRole("button", { name: "Reinstate Speaker" })).toHaveTextContent("Reinstating...");
    expect(screen.getByRole("button", { name: "Reinstate Speaker" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retire Projector (HD)" })).toBeDisabled();
    working.resolve({});
    await waitFor(() => expect(service.listEquipment).toHaveBeenCalledTimes(2));
  });

  it("SCRUM310_AC4_a_refresh_that_fails_after_a_change_shows_the_load_message", async () => {
    const user = userEvent.setup();
    service.listEquipment.mockResolvedValueOnce([projector, speaker]).mockRejectedValueOnce(apiError(500, {}));
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Retire Projector (HD)" }));
    await user.click(screen.getByRole("button", { name: "Confirm retire Projector (HD)" }));

    expect(await screen.findByText("Could not load the equipment catalogue. Please try again.")).toBeInTheDocument();
  });
});


describe("leaving the catalogue before it has loaded", () => {
  it("SCRUM310_AC2_a_list_that_arrives_after_the_user_left_is_dropped", async () => {
    const loading = deferred();
    service.listEquipment.mockReturnValue(loading.promise);
    const { unmount } = render(<EquipmentCatalogue />);

    unmount();
    loading.resolve([projector]);
    await act(async () => {});

    expect(service.listEquipment).toHaveBeenCalledTimes(1);
  });

  it("SCRUM310_AC2_a_failure_that_arrives_after_the_user_left_is_dropped", async () => {
    const loading = deferred();
    service.listEquipment.mockReturnValue(loading.promise);
    const { unmount } = render(<EquipmentCatalogue />);

    unmount();
    loading.reject(apiError(500, {}));
    await act(async () => {});

    expect(service.listEquipment).toHaveBeenCalledTimes(1);
  });
});

describe("a plain save after a failed check", () => {
  it("SCRUM310_AC2_the_old_check_error_is_gone_once_a_change_that_needs_no_check_is_saved", async () => {
    const user = userEvent.setup();
    const saving = deferred();
    service.previewEquipmentChange.mockRejectedValueOnce(apiError(500, {}));
    service.updateEquipment.mockReturnValue(saving.promise);
    await openCatalogue();

    await editTotal(user, "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText(/Could not check which reservations/);

    await typeInto(user, "Total quantity", "8");
    await typeInto(user, "Name", "Projector (4K)");
    await user.click(screen.getByRole("button", { name: /Save/ }));

    expect(screen.queryByText(/Could not check which reservations/)).not.toBeInTheDocument();
    expect(service.updateEquipment).toHaveBeenCalledWith("p1", { name: "Projector (4K)" });
    saving.resolve({});
  });
});
