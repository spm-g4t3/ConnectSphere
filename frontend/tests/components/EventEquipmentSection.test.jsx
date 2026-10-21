// EventEquipmentSection.test.jsx
//
// SCRUM-247, for SCRUM-21 (Record Equipment Requirements for an Event). Named
// SCRUM21_ACn_<what_it_checks>.
//
//   AC1  -- only the assigned coordinator of an Approved event is offered
//           actions; everyone else, and every other status, gets the reason
//   AC2  -- a line is a type, a quantity and optional technical notes
//   AC3  -- a quantity that is not a whole number of 1 or more is refused
//           before any call
//   AC4  -- a type already on the event cannot be picked a second time
//   AC6  -- amend sends only what changed; remove asks first
//   AC8  -- removing the last line says it cancels the request
//   AC11 -- the event's equipment and its status are shown
//
// The service is mocked, so nothing touches the network. What these tests do
// not prove is that the server refuses the wrong person or status: the backend
// tests and the database tests prove the gate. The screen's checks are a
// convenience.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import EventEquipmentSection from "../../src/components/EventEquipmentSection.jsx";
import {
  addEquipmentLine,
  amendEquipmentLine,
  getActiveEquipmentTypes,
  getEventEquipment,
  removeEquipmentLine,
} from "../../src/services/eventEquipmentService";
import { httpError } from "../helpers/async.js";

vi.mock("../../src/services/eventEquipmentService", () => ({
  addEquipmentLine: vi.fn(),
  amendEquipmentLine: vi.fn(),
  getActiveEquipmentTypes: vi.fn(),
  getEventEquipment: vi.fn(),
  removeEquipmentLine: vi.fn(),
}));

const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const PROJECTOR_TYPE = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const MIC_TYPE = "4f2504e0-4f89-41d3-9a0c-0305e82c3302";
const PROJECTOR_LINE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MIC_LINE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const CATALOGUE = [
  { id: PROJECTOR_TYPE, name: "Projector", description: null, category: "AV" },
  { id: MIC_TYPE, name: "Microphone", description: null, category: "AV" },
];

function line(overrides = {}) {
  return {
    id: PROJECTOR_LINE,
    equipmentTypeId: PROJECTOR_TYPE,
    name: "Projector",
    quantity: 2,
    technicalNotes: null,
    typeRetired: false,
    createdAt: "2026-10-08T09:00:00+00:00",
    updatedAt: "2026-10-08T09:00:00+00:00",
    ...overrides,
  };
}

function state({ status = "pending_review", lines = [line()] } = {}) {
  return {
    request: {
      id: "55555555-5555-4555-8555-555555555555",
      status,
      statusLabel: { pending_review: "Pending review", arranged: "Arranged", cancelled: "Cancelled", cannot_be_fully_arranged: "Cannot be fully arranged" }[status] ?? status,
      createdAt: "2026-10-08T09:00:00+00:00",
      updatedAt: "2026-10-08T09:00:00+00:00",
      lines,
    },
  };
}

function renderSection(props = {}) {
  return render(
    <EventEquipmentSection requestId={REQUEST_ID} status="approved" canEdit {...props} />,
  );
}

beforeEach(() => {
  for (const fn of [addEquipmentLine, amendEquipmentLine, getActiveEquipmentTypes, getEventEquipment, removeEquipmentLine]) {
    fn.mockReset();
  }
  getEventEquipment.mockResolvedValue(state());
  getActiveEquipmentTypes.mockResolvedValue(CATALOGUE);
});


describe("AC11: what is shown", () => {
  it("SCRUM21_AC11_shows_each_line_with_its_quantity_and_the_request_status", async () => {
    getEventEquipment.mockResolvedValue(state({
      status: "arranged",
      lines: [line({ technicalNotes: "Needs HDMI" }), line({ id: MIC_LINE, equipmentTypeId: MIC_TYPE, name: "Microphone", quantity: 4 })],
    }));

    renderSection();

    expect(await screen.findByText("Needs HDMI")).toBeInTheDocument();
    expect(screen.getByText("Quantity: 2")).toBeInTheDocument();
    expect(screen.getByText("Quantity: 4")).toBeInTheDocument();
    expect(screen.getByText("Arranged")).toBeInTheDocument();
    expect(screen.getByText("No technical notes.")).toBeInTheDocument();
    expect(getEventEquipment).toHaveBeenCalledWith(REQUEST_ID);
  });

  it("SCRUM21_AC11_says_so_when_the_event_has_never_asked_for_equipment", async () => {
    getEventEquipment.mockResolvedValue({ request: null });

    renderSection();

    expect(await screen.findByText("No equipment has been requested for this event.")).toBeInTheDocument();
  });

  it("SCRUM21_AC11_says_loading_until_the_read_returns", async () => {
    getEventEquipment.mockReturnValue(new Promise(() => {}));

    renderSection();

    expect(screen.getByText("Loading equipment...")).toBeInTheDocument();
  });

  it("SCRUM21_AC11_a_failed_read_says_so_in_words_and_offers_no_empty_state", async () => {
    getEventEquipment.mockRejectedValue(httpError(500, { error: "relation secret_table exploded" }));

    renderSection();

    expect(await screen.findByText("Could not load this event's equipment.")).toBeInTheDocument();
    expect(screen.queryByText("No equipment has been requested for this event.")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/secret_table/);
  });

  it("SCRUM21_AC11_flags_a_line_whose_type_has_been_retired", async () => {
    getEventEquipment.mockResolvedValue(state({ lines: [line({ typeRetired: true })] }));

    renderSection();

    expect(await screen.findByText("This equipment type has been retired.")).toBeInTheDocument();
  });
});


describe("AC1: who is offered actions", () => {
  it("SCRUM21_AC1_the_assigned_coordinator_of_an_approved_event_can_add_edit_and_remove", async () => {
    renderSection();

    expect(await screen.findByRole("button", { name: "Edit Projector" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Projector" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add equipment" })).toBeInTheDocument();
  });

  it("SCRUM21_AC1_another_coordinator_sees_the_lines_and_the_reason_but_no_actions", async () => {
    renderSection({ canEdit: false });

    expect(await screen.findByText("Quantity: 2")).toBeInTheDocument();
    expect(screen.getByText("Only the assigned coordinator can change this event's equipment.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(getActiveEquipmentTypes).not.toHaveBeenCalled();
  });

  it.each([
    ["draft", "Equipment can be recorded once the request is approved."],
    ["submitted", "Equipment can be recorded once the request is approved."],
    ["under_review", "Equipment can be recorded once the request is approved."],
    ["pending_clarification", "Equipment can be recorded once the request is approved."],
    ["rejected", "Equipment cannot be recorded for a rejected request."],
    ["confirmed", "Equipment on a confirmed event can only be changed as a significant change."],
    ["safety_review", "Equipment on this event can only be changed as a significant change."],
    ["safety_approved", "Equipment on this event can only be changed as a significant change."],
    ["some_new_status", "Equipment cannot be changed while the event is in this status."],
  ])("SCRUM21_AC1_a_%s_event_offers_no_actions_and_says_why", async (status, text) => {
    renderSection({ status });

    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(getActiveEquipmentTypes).not.toHaveBeenCalled();
  });

  it("SCRUM21_AC1_the_actions_appear_when_the_event_becomes_approved_in_place", async () => {
    const { rerender } = renderSection({ status: "under_review" });
    await screen.findByText("Quantity: 2");
    expect(screen.queryByRole("button", { name: "Add equipment" })).not.toBeInTheDocument();

    rerender(<EventEquipmentSection requestId={REQUEST_ID} status="approved" canEdit />);

    expect(await screen.findByRole("button", { name: "Add equipment" })).toBeInTheDocument();
    expect(getActiveEquipmentTypes).toHaveBeenCalledTimes(1);
  });
});


describe("AC2 to AC4: adding a line", () => {
  async function pick(user, name) {
    await screen.findByRole("option", { name });
    await user.selectOptions(screen.getByLabelText("Equipment type"), name);
  }

  it("SCRUM21_AC2_sends_the_type_the_quantity_as_a_number_and_trimmed_notes", async () => {
    getEventEquipment.mockResolvedValue({ request: null });
    addEquipmentLine.mockResolvedValue(state({
      lines: [line({ equipmentTypeId: MIC_TYPE, name: "Microphone", quantity: 3, technicalNotes: "Wireless" })],
    }));
    const user = userEvent.setup();
    renderSection();

    await pick(user, "Microphone");
    await user.clear(screen.getByLabelText("Quantity"));
    await user.type(screen.getByLabelText("Quantity"), "3");
    await user.type(screen.getByLabelText("Technical notes (optional)"), "  Wireless  ");
    await user.click(screen.getByRole("button", { name: "Add equipment" }));

    expect(addEquipmentLine).toHaveBeenCalledWith(REQUEST_ID, {
      equipmentTypeId: MIC_TYPE,
      quantity: 3,
      technicalNotes: "Wireless",
    });
    expect(await screen.findByText("Wireless")).toBeInTheDocument();
    expect(screen.getByText("Microphone added.")).toBeInTheDocument();
  });

  it("SCRUM21_AC2_blank_notes_are_left_out_of_the_call", async () => {
    getEventEquipment.mockResolvedValue({ request: null });
    addEquipmentLine.mockResolvedValue(state());
    const user = userEvent.setup();
    renderSection();

    await pick(user, "Projector");
    await user.click(screen.getByRole("button", { name: "Add equipment" }));

    expect(addEquipmentLine).toHaveBeenCalledWith(REQUEST_ID, {
      equipmentTypeId: PROJECTOR_TYPE,
      quantity: 1,
      technicalNotes: undefined,
    });
  });

  it("SCRUM21_AC2_the_form_resets_after_a_line_is_added", async () => {
    getEventEquipment.mockResolvedValue({ request: null });
    addEquipmentLine.mockResolvedValue(state({ lines: [line({ equipmentTypeId: MIC_TYPE, name: "Microphone" })] }));
    const user = userEvent.setup();
    renderSection();

    await pick(user, "Microphone");
    await user.type(screen.getByLabelText("Technical notes (optional)"), "x");
    await user.click(screen.getByRole("button", { name: "Add equipment" }));
    await screen.findByText("Microphone added.");

    expect(screen.getByLabelText("Equipment type")).toHaveValue("");
    expect(screen.getByLabelText("Quantity")).toHaveValue(1);
    expect(screen.getByLabelText("Technical notes (optional)")).toHaveValue("");
  });

  it("SCRUM21_AC2_asks_for_a_type_before_any_call", async () => {
    const user = userEvent.setup();
    renderSection();
    await screen.findByRole("option", { name: "Microphone" });

    await user.click(screen.getByRole("button", { name: "Add equipment" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Choose an equipment type.");
    expect(addEquipmentLine).not.toHaveBeenCalled();
  });

  it.each([["0"], ["-2"], ["1.5"], [""]])(
    "SCRUM21_AC3_refuses_a_quantity_of_%j_before_any_call",
    async (typed) => {
      const user = userEvent.setup();
      renderSection();
      await pick(user, "Microphone");
      await user.clear(screen.getByLabelText("Quantity"));
      if (typed) await user.type(screen.getByLabelText("Quantity"), typed);

      await user.click(screen.getByRole("button", { name: "Add equipment" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("Enter a quantity that is a whole number of 1 or more.");
      expect(addEquipmentLine).not.toHaveBeenCalled();
    },
  );

  it("SCRUM21_AC4_does_not_offer_a_type_that_is_already_on_the_event", async () => {
    renderSection();

    await screen.findByRole("option", { name: "Microphone" });
    expect(screen.queryByRole("option", { name: "Projector" })).not.toBeInTheDocument();
  });

  it("SCRUM21_AC4_says_so_when_every_active_type_is_already_on_the_event", async () => {
    getEventEquipment.mockResolvedValue(state({
      lines: [line(), line({ id: MIC_LINE, equipmentTypeId: MIC_TYPE, name: "Microphone" })],
    }));

    renderSection();

    expect(await screen.findByText("Every active equipment type is already on this event.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add equipment" })).toBeDisabled();
  });

  it("SCRUM21_AC4_a_400_from_the_server_names_each_field_in_words", async () => {
    getEventEquipment.mockResolvedValue({ request: null });
    addEquipmentLine.mockRejectedValue(httpError(400, {
      error: `Invalid equipment details -- equipmentTypeId: is already on this event`,
      details: [{ field: "equipmentTypeId", message: "is already on this event" }],
    }));
    const user = userEvent.setup();
    renderSection();
    await pick(user, "Microphone");

    await user.click(screen.getByRole("button", { name: "Add equipment" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Equipment type: is already on this event");
  });

  it("SCRUM21_AC4_a_400_without_details_falls_back_to_a_sentence_of_its_own", async () => {
    addEquipmentLine.mockRejectedValue(httpError(400, { error: "bad" }));
    const user = userEvent.setup();
    renderSection();
    await pick(user, "Microphone");

    await user.click(screen.getByRole("button", { name: "Add equipment" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The equipment could not be saved. Try again.");
  });

  it("SCRUM21_AC1_a_409_says_the_event_moved_on_in_words_and_reads_the_list_again", async () => {
    addEquipmentLine.mockRejectedValue(httpError(409, {
      error: `Equipment can only be changed while the event is Approved. ${REQUEST_ID}`,
      code: "EVENT_NOT_APPROVED",
    }));
    const user = userEvent.setup();
    renderSection();
    await pick(user, "Microphone");

    await user.click(screen.getByRole("button", { name: "Add equipment" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/only be changed while the event is Approved/);
    expect(alert.textContent).not.toMatch(UUID);
    expect(getEventEquipment).toHaveBeenCalledTimes(2);
  });

  it("SCRUM21_AC1_a_403_says_the_event_is_no_longer_theirs", async () => {
    addEquipmentLine.mockRejectedValue(httpError(403, { error: `Only the assigned coordinator of ${REQUEST_ID}` }));
    const user = userEvent.setup();
    renderSection();
    await pick(user, "Microphone");

    await user.click(screen.getByRole("button", { name: "Add equipment" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/no longer assigned to you/);
    expect(alert.textContent).not.toMatch(UUID);
  });

  it("SCRUM21_AC1_a_500_never_shows_the_servers_own_text", async () => {
    addEquipmentLine.mockRejectedValue(httpError(500, { error: "secret driver text" }));
    const user = userEvent.setup();
    renderSection();
    await pick(user, "Microphone");

    await user.click(screen.getByRole("button", { name: "Add equipment" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The equipment could not be saved. Try again.");
    expect(document.body.textContent).not.toMatch(/secret driver text/);
    expect(getEventEquipment).toHaveBeenCalledTimes(1);
  });

  it("SCRUM21_AC2_disables_the_form_while_the_add_is_in_flight", async () => {
    let finish;
    addEquipmentLine.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    renderSection();
    await pick(user, "Microphone");

    await user.click(screen.getByRole("button", { name: "Add equipment" }));

    expect(await screen.findByRole("button", { name: "Adding..." })).toBeDisabled();
    expect(screen.getByLabelText("Quantity")).toBeDisabled();
    finish(state());
    await screen.findByText("Microphone added.");
  });

  it("SCRUM21_AC2_a_catalogue_that_will_not_load_says_so_in_words", async () => {
    getActiveEquipmentTypes.mockRejectedValue(httpError(500, { error: "secret driver text" }));

    renderSection();

    expect(await screen.findByText("Could not load the equipment catalogue.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/secret driver text/);
  });
});


describe("AC6: amending a line", () => {
  async function openEdit(user) {
    await user.click(await screen.findByRole("button", { name: "Edit Projector" }));
  }

  it("SCRUM21_AC6_edit_opens_with_the_current_values", async () => {
    getEventEquipment.mockResolvedValue(state({ lines: [line({ technicalNotes: "Needs HDMI" })] }));
    const user = userEvent.setup();
    renderSection();

    await openEdit(user);

    expect(screen.getByLabelText("Quantity for Projector")).toHaveValue(2);
    expect(screen.getByLabelText("Technical notes for Projector")).toHaveValue("Needs HDMI");
  });

  it("SCRUM21_AC6_changing_only_the_quantity_sends_only_the_quantity", async () => {
    amendEquipmentLine.mockResolvedValue(state({ lines: [line({ quantity: 5 })] }));
    const user = userEvent.setup();
    renderSection();
    await openEdit(user);

    await user.clear(screen.getByLabelText("Quantity for Projector"));
    await user.type(screen.getByLabelText("Quantity for Projector"), "5");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(amendEquipmentLine).toHaveBeenCalledWith(REQUEST_ID, PROJECTOR_LINE, { quantity: 5 });
    expect(await screen.findByText("Quantity: 5")).toBeInTheDocument();
    expect(screen.getByText("Projector updated.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Quantity for Projector")).not.toBeInTheDocument();
  });

  it("SCRUM21_AC6_changing_only_the_notes_sends_only_the_notes", async () => {
    amendEquipmentLine.mockResolvedValue(state({ lines: [line({ technicalNotes: "Tripod" })] }));
    const user = userEvent.setup();
    renderSection();
    await openEdit(user);

    await user.type(screen.getByLabelText("Technical notes for Projector"), " Tripod ");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(amendEquipmentLine).toHaveBeenCalledWith(REQUEST_ID, PROJECTOR_LINE, { technicalNotes: "Tripod" });
  });

  it("SCRUM21_AC6_clearing_the_notes_sends_null", async () => {
    getEventEquipment.mockResolvedValue(state({ lines: [line({ technicalNotes: "Needs HDMI" })] }));
    amendEquipmentLine.mockResolvedValue(state());
    const user = userEvent.setup();
    renderSection();
    await openEdit(user);

    await user.clear(screen.getByLabelText("Technical notes for Projector"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(amendEquipmentLine).toHaveBeenCalledWith(REQUEST_ID, PROJECTOR_LINE, { technicalNotes: null });
  });

  it("SCRUM21_AC6_a_save_that_changes_nothing_makes_no_call_and_closes", async () => {
    const user = userEvent.setup();
    renderSection();
    await openEdit(user);

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(amendEquipmentLine).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Quantity for Projector")).not.toBeInTheDocument();
  });

  it("SCRUM21_AC6_there_is_no_way_to_change_the_type", async () => {
    const user = userEvent.setup();
    renderSection();
    await openEdit(user);

    const form = screen.getByLabelText("Quantity for Projector").closest("form");
    expect(within(form).queryByRole("combobox")).not.toBeInTheDocument();
  });

  it.each([["0"], ["2.5"], [""]])("SCRUM21_AC3_refuses_an_amended_quantity_of_%j_before_any_call", async (typed) => {
    const user = userEvent.setup();
    renderSection();
    await openEdit(user);
    await user.clear(screen.getByLabelText("Quantity for Projector"));
    if (typed) await user.type(screen.getByLabelText("Quantity for Projector"), typed);

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a quantity that is a whole number of 1 or more.");
    expect(amendEquipmentLine).not.toHaveBeenCalled();
  });

  it("SCRUM21_AC6_cancel_closes_the_form_without_a_call", async () => {
    const user = userEvent.setup();
    renderSection();
    await openEdit(user);

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(amendEquipmentLine).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Edit Projector" })).toBeInTheDocument();
  });

  it("SCRUM21_AC6_a_404_keeps_the_form_open_says_so_in_words_and_reads_the_list_again", async () => {
    amendEquipmentLine.mockRejectedValue(httpError(404, { error: `Equipment line ${PROJECTOR_LINE} not found` }));
    const user = userEvent.setup();
    renderSection();
    await openEdit(user);
    await user.clear(screen.getByLabelText("Quantity for Projector"));
    await user.type(screen.getByLabelText("Quantity for Projector"), "9");

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/no longer exists/);
    expect(alert.textContent).not.toMatch(UUID);
    expect(getEventEquipment).toHaveBeenCalledTimes(2);
  });

  it("SCRUM21_AC6_opening_edit_on_another_line_closes_the_first", async () => {
    getEventEquipment.mockResolvedValue(state({
      lines: [line(), line({ id: MIC_LINE, equipmentTypeId: MIC_TYPE, name: "Microphone" })],
    }));
    const user = userEvent.setup();
    renderSection();
    await openEdit(user);

    await user.click(screen.getByRole("button", { name: "Edit Microphone" }));

    expect(screen.queryByLabelText("Quantity for Projector")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Quantity for Microphone")).toBeInTheDocument();
  });
});


describe("AC6 and AC8: removing a line", () => {
  it("SCRUM21_AC6_remove_asks_before_calling", async () => {
    getEventEquipment.mockResolvedValue(state({
      lines: [line(), line({ id: MIC_LINE, equipmentTypeId: MIC_TYPE, name: "Microphone" })],
    }));
    const user = userEvent.setup();
    renderSection();

    await user.click(await screen.findByRole("button", { name: "Remove Projector" }));

    expect(screen.getByText("Remove Projector from this event?")).toBeInTheDocument();
    expect(removeEquipmentLine).not.toHaveBeenCalled();
  });

  it("SCRUM21_AC6_keeping_it_backs_out_without_a_call", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Remove Projector" }));

    await user.click(screen.getByRole("button", { name: "Keep it" }));

    expect(removeEquipmentLine).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remove Projector" })).toBeInTheDocument();
  });

  it("SCRUM21_AC6_confirming_removes_the_line_and_shows_the_rest", async () => {
    getEventEquipment.mockResolvedValue(state({
      lines: [line(), line({ id: MIC_LINE, equipmentTypeId: MIC_TYPE, name: "Microphone" })],
    }));
    removeEquipmentLine.mockResolvedValue(state({
      lines: [line({ id: MIC_LINE, equipmentTypeId: MIC_TYPE, name: "Microphone" })],
    }));
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Remove Projector" }));

    await user.click(screen.getByRole("button", { name: "Yes, remove" }));

    expect(removeEquipmentLine).toHaveBeenCalledWith(REQUEST_ID, PROJECTOR_LINE);
    expect(await screen.findByText("Projector removed.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit Projector" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit Microphone" })).toBeInTheDocument();
  });

  it("SCRUM21_AC8_removing_the_last_line_warns_it_cancels_the_request_and_shows_it", async () => {
    removeEquipmentLine.mockResolvedValue(state({ status: "cancelled", lines: [] }));
    const user = userEvent.setup();
    renderSection();

    await user.click(await screen.findByRole("button", { name: "Remove Projector" }));
    expect(screen.getByText("Remove Projector? It is the last line, so the equipment request will be cancelled.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Yes, remove" }));

    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    expect(screen.getByText("No equipment has been requested for this event.")).toBeInTheDocument();
  });

  it("SCRUM21_AC6_a_refused_removal_says_why_in_words_and_reads_the_list_again", async () => {
    removeEquipmentLine.mockRejectedValue(httpError(409, { error: `event ${REQUEST_ID} is not approved` }));
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Remove Projector" }));

    await user.click(screen.getByRole("button", { name: "Yes, remove" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/only be changed while the event is Approved/);
    expect(alert.textContent).not.toMatch(UUID);
    expect(getEventEquipment).toHaveBeenCalledTimes(2);
  });

  it("SCRUM21_AC6_starting_an_edit_closes_an_open_remove_question", async () => {
    getEventEquipment.mockResolvedValue(state({
      lines: [line(), line({ id: MIC_LINE, equipmentTypeId: MIC_TYPE, name: "Microphone" })],
    }));
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Remove Projector" }));

    await user.click(screen.getByRole("button", { name: "Edit Microphone" }));

    expect(screen.queryByText("Remove Projector from this event?")).not.toBeInTheDocument();
  });

  it("SCRUM21_AC6_asking_to_remove_closes_an_open_edit", async () => {
    getEventEquipment.mockResolvedValue(state({
      lines: [line(), line({ id: MIC_LINE, equipmentTypeId: MIC_TYPE, name: "Microphone" })],
    }));
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Edit Projector" }));

    await user.click(screen.getByRole("button", { name: "Remove Microphone" }));

    expect(screen.queryByLabelText("Quantity for Projector")).not.toBeInTheDocument();
  });

  it("SCRUM21_AC6_disables_the_buttons_while_a_removal_is_in_flight", async () => {
    let finish;
    removeEquipmentLine.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole("button", { name: "Remove Projector" }));

    await user.click(screen.getByRole("button", { name: "Yes, remove" }));

    expect(await screen.findByRole("button", { name: "Removing..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Keep it" })).toBeDisabled();
    finish(state({ status: "cancelled", lines: [] }));
    await screen.findByText("Projector removed.");
  });
});


describe("SCRUM-297: what technical support decided", () => {
  it("SCRUM290_AC8_shows_reserved_against_requested_on_each_line", async () => {
    getEventEquipment.mockResolvedValue(state({ lines: [line({ quantity: 3, reserved: 1 })] }));

    renderSection();

    expect(await screen.findByText("Reserved: 1 of 3")).toBeInTheDocument();
  });

  it("SCRUM290_AC8_shows_the_reason_a_line_cannot_be_provided_and_the_outcome_above_the_lines", async () => {
    getEventEquipment.mockResolvedValue(state({
      status: "cannot_be_fully_arranged",
      lines: [line({ quantity: 3, reserved: 1, outcome: "cannot_be_provided", outcomeNote: "Only one in stock that week" })],
    }));

    renderSection();

    expect(await screen.findByText("Cannot be provided")).toBeInTheDocument();
    expect(screen.getByText("Only one in stock that week")).toBeInTheDocument();
    expect(screen.getByText(/could not arrange all of this equipment/)).toBeInTheDocument();
  });

  it("SCRUM290_AC8_says_so_when_everything_is_arranged", async () => {
    getEventEquipment.mockResolvedValue(state({ status: "arranged", lines: [line({ quantity: 2, reserved: 2 })] }));

    renderSection();

    expect(await screen.findByText("All of this equipment has been arranged.")).toBeInTheDocument();
    expect(screen.queryByText("Cannot be provided")).not.toBeInTheDocument();
  });

  it("SCRUM290_AC8_a_line_with_no_mark_shows_no_outcome", async () => {
    renderSection();

    await screen.findByText("Projector");
    expect(screen.queryByText("Cannot be provided")).not.toBeInTheDocument();
    expect(screen.queryByText(/could not arrange/)).not.toBeInTheDocument();
  });
});
