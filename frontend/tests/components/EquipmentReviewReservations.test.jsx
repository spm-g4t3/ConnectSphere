// EquipmentReviewReservations.test.jsx
//
// SCRUM-307, for SCRUM-300 (Reserve Equipment for an Event - Technical Support
// Staff). Named SCRUM300_<what_it_checks>.
//
// The service and the signed-in user are mocked, so nothing touches the network.
// The screen's buttons are a convenience: that the server refuses the wrong
// person, status or quantity is proved by the backend and database tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import EquipmentReview from "../../src/components/EquipmentReview.jsx";
import {
  getEquipmentReview,
  keepEquipmentReservation,
  moveEquipmentReservation,
  reduceEquipmentReservation,
  releaseEquipmentReservation,
  reserveEquipment,
} from "../../src/services/equipmentReviewService";
import { useAuth } from "../../src/auth/AuthContext";

vi.mock("../../src/services/equipmentReviewService", () => ({
  clearEquipmentLineOutcome: vi.fn(),
  completeEquipmentReview: vi.fn(),
  getEquipmentReview: vi.fn(),
  keepEquipmentReservation: vi.fn(),
  markEquipmentLineUnavailable: vi.fn(),
  moveEquipmentReservation: vi.fn(),
  reduceEquipmentReservation: vi.fn(),
  releaseEquipmentReservation: vi.fn(),
  reserveEquipment: vi.fn(),
  startEquipmentReview: vi.fn(),
  takeOverEquipmentReview: vi.fn(),
}));
vi.mock("../../src/auth/AuthContext", () => ({ useAuth: vi.fn() }));

const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const ME = "99999999-9999-4999-8999-999999999999";
const OTHER = "88888888-8888-4888-8888-888888888888";
const PROJECTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MIC = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RES_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RES_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const reservation = (overrides = {}) => ({
  id: RES_A,
  quantity: 2,
  startAt: "2026-11-01T10:00:00Z",
  endAt: "2026-11-01T12:00:00Z",
  flagged: false,
  flagReason: null,
  flaggedAt: null,
  ...overrides,
});

function line(overrides = {}) {
  const reservations = overrides.reservations ?? [reservation()];
  const reserved = reservations.reduce((sum, r) => sum + r.quantity, 0);
  return {
    id: PROJECTOR,
    equipmentTypeId: "t1",
    name: "Projector",
    quantity: 5,
    technicalNotes: null,
    typeRetired: false,
    reserved,
    shortBy: Math.max(0, 5 - reserved),
    flaggedCount: reservations.filter((r) => r.flagged).length,
    outcome: null,
    outcomeNote: null,
    outcomeBy: null,
    outcomeAt: null,
    availability: null,
    ...overrides,
    reservations,
  };
}

function state({ status = "under_review", reviewerId = ME, lines = [line()] } = {}) {
  return {
    event: {
      id: EVENT_ID,
      name: "Hack Night",
      proposedStart: "2026-11-01T10:00:00Z",
      proposedEnd: "2026-11-01T12:00:00Z",
      assignedCoordinatorId: "c1",
      assignedCoordinatorName: "Rae Tan",
      venue: { id: "v1", name: "Hall A" },
    },
    request: {
      id: "r1",
      status,
      statusLabel: status === "under_review" ? "Under review" : "Pending review",
      reviewerId: status === "under_review" ? reviewerId : null,
      reviewerName: "Sam Lee",
      reviewStartedAt: status === "under_review" ? "2026-10-10T09:00:00Z" : null,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      lines,
    },
  };
}

const flaggedLine = () =>
  line({
    reservations: [
      reservation({ flagged: true, flagReason: "The event date or time changed" }),
    ],
  });

const fail = (status, data) => ({ response: { status, data } });

async function open(initial) {
  getEquipmentReview.mockResolvedValue(initial);
  render(
    <MemoryRouter initialEntries={[`/equipment-review/${EVENT_ID}`]}>
      <Routes>
        <Route path="/equipment-review/:eventId" element={<EquipmentReview />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByRole("heading", { name: "Hack Night" });
}

const click = (name) => userEvent.click(screen.getByRole("button", { name }));
// The one-click reserve button: "Reserve 3 more: Projector", "Reserve 5: Projector" or just "Reserve: Projector".
const reserveBtn = (item = "Projector") =>
  screen.getByRole("button", { name: new RegExp(`^Reserve( [-\\d.]+)?( more)?: ${item}$`) });

beforeEach(() => {
  vi.resetAllMocks();
  useAuth.mockReturnValue({ user: { id: ME, role: "technical_support_staff" } });
});

describe("what is shown", () => {
  it("SCRUM300_AC2_lists_each_reservation_with_its_quantity_and_period", async () => {
    await open(state());
    expect(screen.getByRole("heading", { name: "Reservations (1)" })).toBeInTheDocument();
    expect(screen.getByText("2 reserved")).toBeInTheDocument();
  });

  it("SCRUM300_AC7_a_flagged_reservation_says_flagged_and_why", async () => {
    await open(state({ lines: [flaggedLine()] }));
    expect(screen.getByText("Flagged")).toBeInTheDocument();
    expect(screen.getByText(/The event date or time changed/)).toBeInTheDocument();
  });

  it("SCRUM300_AC7_a_banner_counts_flagged_reservations_across_lines", async () => {
    await open(
      state({
        lines: [
          flaggedLine(),
          line({
            id: MIC,
            name: "Microphone",
            quantity: 2,
            reservations: [reservation({ id: RES_B, quantity: 1, flagged: true, flagReason: "x" })],
          }),
        ],
      }),
    );
    expect(screen.getByRole("region", { name: "Next step" })).toHaveTextContent("Decide on 2 flagged reservations");
  });

  it("SCRUM300_AC7_the_banner_uses_the_singular_for_one", async () => {
    await open(state({ lines: [flaggedLine()] }));
    expect(screen.getByRole("region", { name: "Next step" })).toHaveTextContent("Decide on 1 flagged reservation");
  });

  it("SCRUM300_no_banner_when_nothing_is_flagged", async () => {
    await open(state());
    expect(screen.queryByText(/flagged/)).not.toBeInTheDocument();
  });

  it("SCRUM300_a_line_with_no_reservations_shows_no_reservation_list", async () => {
    await open(state({ lines: [line({ reservations: [] })] }));
    expect(screen.queryByRole("heading", { name: /Reservations/ })).not.toBeInTheDocument();
  });

  it("SCRUM300_a_response_without_a_reservations_key_does_not_crash", async () => {
    const withoutKey = line();
    delete withoutKey.reservations;
    await open(state({ lines: [withoutKey] }));
    expect(screen.queryByRole("heading", { name: /Reservations/ })).not.toBeInTheDocument();
  });
});

describe("AC1: only the current reviewer is offered the actions", () => {
  it("SCRUM300_AC1_someone_who_is_not_the_reviewer_sees_reservations_but_no_buttons", async () => {
    await open(state({ reviewerId: OTHER, lines: [flaggedLine()] }));
    expect(screen.getByText("2 reserved")).toBeInTheDocument();
    for (const name of [/^Reserve /, /^Move/, /^Keep/, /^Reduce/, /^Release/]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("SCRUM300_AC1_a_request_that_is_not_under_review_offers_no_reservation_buttons", async () => {
    await open(state({ status: "pending_review", lines: [flaggedLine()] }));
    for (const name of [/^Reserve /, /^Move/, /^Keep/, /^Reduce/, /^Release/]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("SCRUM300_AC7_move_and_keep_are_offered_only_on_a_flagged_reservation", async () => {
    await open(state());
    expect(screen.queryByRole("button", { name: /^Move/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Keep/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Release all: Projector" })).toBeInTheDocument();
  });

  it("SCRUM300_AC4_reduce_is_not_offered_on_a_reservation_of_one", async () => {
    await open(state({ lines: [line({ reservations: [reservation({ quantity: 1 })] })] }));
    expect(screen.queryByRole("button", { name: /^Reduce/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Release/ })).toBeInTheDocument();
  });

  it("SCRUM300_AC2_a_fully_reserved_line_has_no_reserve_button_but_keeps_its_reservation_actions", async () => {
    await open(state({ lines: [line({ reservations: [reservation({ quantity: 5 })] })] }));
    expect(screen.queryByRole("button", { name: /^Reserve /})).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Release/ })).toBeInTheDocument();
  });
});

describe("AC2: reserving", () => {
  it("SCRUM300_AC2_the_quantity_sits_beside_the_reserve_button_already_set_to_what_is_still_needed", async () => {
    await open(state());
    expect(screen.getByLabelText(/How many Projector to reserve\?/)).toHaveValue(3);
    expect(reserveBtn()).toHaveTextContent("Reserve 3 more");
  });

  it("SCRUM300_AC2_one_click_on_reserve_reserves_without_a_second_form", async () => {
    reserveEquipment.mockResolvedValue(state({ lines: [line({ reservations: [reservation({ quantity: 5 })] })] }));
    await open(state());
    await userEvent.click(reserveBtn());

    expect(reserveEquipment).toHaveBeenCalledTimes(1);
    expect(reserveEquipment).toHaveBeenCalledWith(EVENT_ID, PROJECTOR, 3);
    expect(await screen.findByText("Reserved 3 of Projector.")).toBeInTheDocument();
  });

  it("SCRUM300_AC2_a_line_with_nothing_reserved_says_Reserve_N_and_a_line_with_some_says_Reserve_N_more", async () => {
    await open(state({ lines: [line({ reservations: [] })] }));
    expect(reserveBtn()).toHaveTextContent(/^Reserve 5$/);
  });

  it("SCRUM300_AC2_the_number_picked_with_the_stepper_is_what_the_service_receives_and_the_screen_shows_the_new_state", async () => {
    const after = state({ lines: [line({ reservations: [reservation({ quantity: 3 })] })] });
    reserveEquipment.mockResolvedValue(after);
    await open(state());
    const input = screen.getByLabelText(/How many Projector/);
    await userEvent.clear(input);
    await userEvent.type(input, "1");
    await userEvent.click(reserveBtn());

    expect(reserveEquipment).toHaveBeenCalledWith(EVENT_ID, PROJECTOR, 1);
    expect(await screen.findByRole("status")).toHaveTextContent("Reserved 1 of Projector.");
    expect(screen.getByRole("heading", { name: "Reservations (1)" })).toBeInTheDocument();
  });

  it("SCRUM300_AC2_after_reserving_the_quantity_resets_to_what_is_still_needed", async () => {
    reserveEquipment.mockResolvedValue(state({ lines: [line({ reservations: [reservation({ quantity: 3 })] })] }));
    await open(state());
    const input = screen.getByLabelText(/How many Projector/);
    await userEvent.clear(input);
    await userEvent.type(input, "1");
    await userEvent.click(reserveBtn());
    await screen.findByText("Reserved 1 of Projector.");
    expect(screen.getByLabelText(/How many Projector/)).toHaveValue(2);
  });

  it.each(["", "0", "-1", "1.5"])("SCRUM300_AC2_quantity_%j_is_refused_before_any_call", async (value) => {
    await open(state());
    const input = screen.getByLabelText(/How many Projector/);
    await userEvent.clear(input);
    if (value) await userEvent.type(input, value);
    await userEvent.click(reserveBtn());
    expect(await screen.findByRole("alert")).toHaveTextContent(/whole number of 1 or more/);
    expect(reserveEquipment).not.toHaveBeenCalled();
  });

  it("SCRUM300_AC2_when_the_server_says_how_many_are_available_the_message_shows_beside_the_button", async () => {
    reserveEquipment.mockRejectedValue(
      fail(400, { error: "x", details: [{ field: "quantity", message: "Only 1 available for this period, so 3 cannot be reserved" }] }),
    );
    await open(state());
    await userEvent.click(reserveBtn());
    expect(await screen.findByRole("alert")).toHaveTextContent("Quantity: Only 1 available for this period, so 3 cannot be reserved");
    expect(screen.getByLabelText(/How many Projector/)).toBeInTheDocument();
    expect(getEquipmentReview).toHaveBeenCalledTimes(1);
  });

  it("SCRUM300_AC3_losing_the_race_for_the_last_unit_shows_the_message", async () => {
    reserveEquipment.mockRejectedValue(
      fail(400, { error: "x", details: [{ field: "quantity", message: "Only 0 available for this period, so 1 cannot be reserved" }] }),
    );
    await open(state());
    await userEvent.click(reserveBtn());
    expect(await screen.findByRole("alert")).toHaveTextContent(/Only 0 available/);
  });

  it("SCRUM300_AC1_a_409_shows_the_reason_and_reads_the_state_again", async () => {
    reserveEquipment.mockRejectedValue(fail(409, { error: "This can only be done while the request is Under review. This request is Arranged." }));
    await open(state());
    await userEvent.click(reserveBtn());
    expect(await screen.findByRole("alert")).toHaveTextContent(/Arranged/);
    expect(getEquipmentReview).toHaveBeenCalledTimes(2);
  });

  it("SCRUM300_the_reserve_controls_step_aside_while_the_change_quantity_form_is_open", async () => {
    await open(state());
    await click("Change quantity: Projector");
    expect(screen.queryByLabelText(/How many Projector to reserve/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Reserve \d+ more: Projector/ })).not.toBeInTheDocument();
  });

  it("SCRUM300_opening_the_mark_note_form_closes_an_open_reservation_form", async () => {
    await open(state());
    await click("Change quantity: Projector");
    expect(screen.getByLabelText(/New quantity/)).toBeInTheDocument();
    await click("Mark as cannot be provided: Projector");
    expect(screen.queryByLabelText(/New quantity/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Why can Projector not be provided/)).toBeInTheDocument();
    expect(reduceEquipmentReservation).not.toHaveBeenCalled();
  });

  it("SCRUM300_opening_a_reservation_form_closes_an_open_mark_note_form", async () => {
    await open(state());
    await click("Mark as cannot be provided: Projector");
    await click("Release all: Projector");
    expect(screen.queryByLabelText(/Why can Projector not be provided/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Why is it being released?")).toBeInTheDocument();
  });
});

describe("the reserve hint", () => {
  const withAvailability = (quantityAvailable, reservations = [reservation()]) =>
    state({
      lines: [
        line({
          reservations,
          availability: { result: "Partially available", quantityRequested: 5, quantityAvailable, message: null, breakdown: null, reservations: [] },
        }),
      ],
    });

  it("SCRUM300_AC2_the_hint_takes_what_the_event_already_holds_off_the_availability_figure", async () => {
    // 4 available to this event in total, 2 of them already held: 2 more can be reserved.
    await open(withAvailability(4));
    expect(screen.getByText("Only 2 can be reserved right now.")).toBeInTheDocument();
    expect(screen.getByLabelText(/How many Projector/)).toHaveValue(2);
  });

  it("SCRUM300_AC2_the_hint_never_offers_more_than_the_line_still_needs", async () => {
    await open(withAvailability(50));
    expect(screen.getByLabelText(/How many Projector/)).toHaveValue(3);
    expect(screen.queryByText(/can be reserved right now/)).not.toBeInTheDocument();
  });

  it("SCRUM300_AC2_when_none_can_be_reserved_it_says_so_and_offers_no_reserve_button", async () => {
    await open(withAvailability(2));
    expect(screen.getByText("None can be reserved right now.")).toBeInTheDocument();
    expect(screen.queryByLabelText(/How many Projector/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Reserve .*: Projector/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark as cannot be provided: Projector" })).toBeInTheDocument();
  });

  it("SCRUM300_AC2_with_no_availability_figure_there_is_no_hint_and_the_prefill_is_what_is_needed", async () => {
    await open(state());
    expect(screen.queryByText(/can be reserved right now/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/How many Projector/)).toHaveValue(3);
  });
});

describe("a refusal message does not outlive the typing that fixes it", () => {
  it("SCRUM300_the_reduce_reason_error_clears_when_the_reviewer_types", async () => {
    await open(state());
    await click("Change quantity: Projector");
    await userEvent.click(screen.getByRole("button", { name: "One fewer Projector" }));
    await userEvent.click(screen.getByRole("button", { name: "Reduce" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Add a reason.");
    await userEvent.type(screen.getByLabelText("Why is it being reduced?"), "a");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM300_the_reserve_quantity_error_clears_when_the_reviewer_types", async () => {
    await open(state());
    const input = screen.getByLabelText(/How many Projector/);
    await userEvent.clear(input);
    await userEvent.click(reserveBtn());
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await userEvent.type(input, "1");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("AC4: reducing and releasing", () => {
  it("SCRUM300_AC4_reduce_sends_the_new_quantity_and_the_reason", async () => {
    reduceEquipmentReservation.mockResolvedValue(state({ lines: [line({ reservations: [reservation({ quantity: 1 })] })] }));
    await open(state());
    await click("Change quantity: Projector");
    expect(screen.getByLabelText(/New quantity \(currently 2\)/)).toHaveValue(2);
    await userEvent.click(screen.getByRole("button", { name: "One fewer Projector" }));
    expect(screen.getByLabelText(/New quantity \(currently 2\)/)).toHaveValue(1);
    await userEvent.type(screen.getByLabelText("Why is it being reduced?"), "Only one needed");
    await userEvent.click(screen.getByRole("button", { name: "Reduce" }));

    expect(reduceEquipmentReservation).toHaveBeenCalledWith(EVENT_ID, RES_A, 1, "Only one needed");
    expect(await screen.findByRole("status")).toHaveTextContent("Reduced the Projector reservation to 1.");
  });

  it("SCRUM300_AC4_reduce_without_a_reason_is_refused_before_any_call", async () => {
    await open(state());
    await click("Change quantity: Projector");
    await userEvent.click(screen.getByRole("button", { name: "One fewer Projector" }));
    await userEvent.click(screen.getByRole("button", { name: "Reduce" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Add a reason.");
    expect(reduceEquipmentReservation).not.toHaveBeenCalled();
  });

  it("SCRUM300_AC4_a_whitespace_only_reason_counts_as_none", async () => {
    await open(state());
    await click("Change quantity: Projector");
    await userEvent.click(screen.getByRole("button", { name: "One fewer Projector" }));
    await userEvent.type(screen.getByLabelText("Why is it being reduced?"), "   ");
    await userEvent.click(screen.getByRole("button", { name: "Reduce" }));
    expect(reduceEquipmentReservation).not.toHaveBeenCalled();
  });

  it("SCRUM300_AC4_keeping_the_same_quantity_is_refused_before_any_call", async () => {
    await open(state());
    await click("Change quantity: Projector");
    await userEvent.click(screen.getByRole("button", { name: "Reduce" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/current quantity/);
    expect(reduceEquipmentReservation).not.toHaveBeenCalled();
    expect(reserveEquipment).not.toHaveBeenCalled();
  });

  it("SCRUM300_UX_changing_to_a_larger_number_reserves_the_difference_without_a_reason", async () => {
    reserveEquipment.mockResolvedValue(state({ lines: [line({ reservations: [reservation({ quantity: 2 }), reservation({ id: RES_B, quantity: 1 })] })] }));
    await open(state());
    await click("Change quantity: Projector");
    await userEvent.click(screen.getByRole("button", { name: "One more Projector" }));
    expect(screen.queryByLabelText("Why is it being reduced?")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reserve 1 more" }));
    expect(reserveEquipment).toHaveBeenCalledWith(EVENT_ID, PROJECTOR, 1);
    expect(reduceEquipmentReservation).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent("Reserved 1 more Projector.");
  });

  it("SCRUM300_UX_the_reason_box_appears_only_when_the_quantity_goes_down", async () => {
    await open(state());
    await click("Change quantity: Projector");
    expect(screen.queryByLabelText("Why is it being reduced?")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "One fewer Projector" }));
    expect(screen.getByLabelText("Why is it being reduced?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "One more Projector" }));
    expect(screen.queryByLabelText("Why is it being reduced?")).not.toBeInTheDocument();
  });

  it("SCRUM300_UX_change_quantity_cannot_go_above_what_the_item_still_needs", async () => {
    // 5 needed, 2 held: at most 3 more, so at most 5 on this reservation.
    await open(state());
    await click("Change quantity: Projector");
    const input = screen.getByLabelText(/New quantity/);
    for (let i = 0; i < 6; i++) await userEvent.click(screen.getByRole("button", { name: "One more Projector" }));
    expect(input).toHaveValue(5);
    expect(screen.getByRole("button", { name: "One more Projector" })).toBeDisabled();
  });

  it("SCRUM300_UX_a_flagged_reservation_offers_reduce_and_not_change", async () => {
    await open(state({ lines: [flaggedLine()] }));
    expect(screen.getByRole("button", { name: "Reduce quantity: Projector" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change quantity: Projector" })).not.toBeInTheDocument();
  });

  it("SCRUM300_AC4_reducing_a_flagged_reservation_to_the_same_or_a_larger_number_is_refused", async () => {
    await open(state({ lines: [flaggedLine()] }));
    await click("Reduce quantity: Projector");
    const input = screen.getByLabelText(/New quantity/);
    await userEvent.clear(input);
    await userEvent.type(input, "2");
    await userEvent.type(screen.getByLabelText("Why is it being reduced?"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Reduce" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/below 2/);
    expect(reduceEquipmentReservation).not.toHaveBeenCalled();
  });

  it("SCRUM300_AC4_release_sends_the_reason", async () => {
    releaseEquipmentReservation.mockResolvedValue(state({ lines: [line({ reservations: [] })] }));
    await open(state());
    await click("Release all: Projector");
    await userEvent.type(screen.getByLabelText("Why is it being released?"), "Wrong item");
    await userEvent.click(screen.getByRole("button", { name: "Release" }));

    expect(releaseEquipmentReservation).toHaveBeenCalledWith(EVENT_ID, RES_A, "Wrong item");
    expect(await screen.findByRole("status")).toHaveTextContent("Released the Projector reservation.");
    expect(screen.queryByRole("heading", { name: /Reservations/ })).not.toBeInTheDocument();
  });

  it("SCRUM300_AC4_release_without_a_reason_is_refused_before_any_call", async () => {
    await open(state());
    await click("Release all: Projector");
    await userEvent.click(screen.getByRole("button", { name: "Release" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Add a reason.");
    expect(releaseEquipmentReservation).not.toHaveBeenCalled();
  });

  it("SCRUM300_AC4_a_server_refusal_keeps_the_form_open_and_keeps_the_typed_reason", async () => {
    releaseEquipmentReservation.mockRejectedValue(fail(400, { error: "x", details: [{ field: "reason", message: "is required: say why" }] }));
    await open(state());
    await click("Release all: Projector");
    await userEvent.type(screen.getByLabelText("Why is it being released?"), "Wrong item");
    await userEvent.click(screen.getByRole("button", { name: "Release" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Reason: is required: say why");
    expect(screen.getByLabelText("Why is it being released?")).toHaveValue("Wrong item");
  });

  it("SCRUM300_AC4_only_one_editor_is_open_at_a_time", async () => {
    await open(state({ lines: [line({ reservations: [reservation(), reservation({ id: RES_B, quantity: 2 })] })] }));
    const [first, second] = screen.getAllByRole("button", { name: "Release all: Projector" });
    await userEvent.click(first);
    expect(screen.getAllByLabelText("Why is it being released?")).toHaveLength(1);
    await userEvent.click(second);
    expect(screen.getAllByLabelText("Why is it being released?")).toHaveLength(1);
  });

  it("SCRUM300_AC4_cancel_closes_a_reduce_form_without_a_call", async () => {
    await open(state());
    await click("Change quantity: Projector");
    await click("Cancel");
    expect(screen.queryByLabelText(/New quantity/)).not.toBeInTheDocument();
    expect(reduceEquipmentReservation).not.toHaveBeenCalled();
  });
});

describe("AC7: resolving a flagged reservation", () => {
  it("SCRUM300_AC7_move_calls_the_service_and_replaces_the_state", async () => {
    moveEquipmentReservation.mockResolvedValue(state({ lines: [line()] }));
    await open(state({ lines: [flaggedLine()] }));
    await click("Move to new time: Projector");

    expect(moveEquipmentReservation).toHaveBeenCalledWith(EVENT_ID, RES_A);
    expect(await screen.findByRole("status")).toHaveTextContent(/Moved the Projector reservation/);
    expect(screen.queryByText("Flagged")).not.toBeInTheDocument();
    expect(screen.queryByText(/reservation is flagged/)).not.toBeInTheDocument();
  });

  it("SCRUM300_AC7_keep_calls_the_service_and_replaces_the_state", async () => {
    keepEquipmentReservation.mockResolvedValue(state({ lines: [line()] }));
    await open(state({ lines: [flaggedLine()] }));
    await click("Keep old time: Projector");

    expect(keepEquipmentReservation).toHaveBeenCalledWith(EVENT_ID, RES_A);
    expect(await screen.findByRole("status")).toHaveTextContent(/Kept the Projector reservation/);
    expect(screen.queryByText("Flagged")).not.toBeInTheDocument();
  });

  it("SCRUM300_AC7_a_move_the_server_refuses_for_availability_shows_why_and_stays_flagged", async () => {
    moveEquipmentReservation.mockRejectedValue(
      fail(400, { error: "x", details: [{ field: "quantity", message: "Only 0 available for the event's current period, so 2 cannot be moved there" }] }),
    );
    await open(state({ lines: [flaggedLine()] }));
    await click("Move to new time: Projector");
    expect(await screen.findByRole("alert")).toHaveTextContent(/Only 0 available/);
    expect(screen.getByText("Flagged")).toBeInTheDocument();
  });

  it("SCRUM300_AC7_a_keep_the_server_refuses_shows_the_reason_in_words_and_reads_again", async () => {
    keepEquipmentReservation.mockRejectedValue(
      fail(409, { error: "This reservation cannot be kept. Its period no longer matches the event. Move it, reduce it or release it." }),
    );
    await open(state({ lines: [flaggedLine()] }));
    await click("Keep old time: Projector");
    expect(await screen.findByRole("alert")).toHaveTextContent(/period no longer matches/);
    expect(getEquipmentReview).toHaveBeenCalledTimes(2);
  });

  it("SCRUM300_AC7_buttons_are_disabled_while_an_action_is_running", async () => {
    let finish;
    moveEquipmentReservation.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await open(state({ lines: [flaggedLine()] }));
    await click("Move to new time: Projector");
    expect(screen.getByRole("button", { name: "Keep old time: Projector" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Release all: Projector" })).toBeDisabled();
    finish(state({ lines: [line()] }));
    expect(await screen.findByText(/Moved the Projector reservation/)).toBeInTheDocument();
  });

  it("SCRUM300_AC7_a_second_line_s_reservations_are_resolved_independently", async () => {
    moveEquipmentReservation.mockResolvedValue(state({ lines: [line(), line({ id: MIC, name: "Microphone", quantity: 2, reservations: [reservation({ id: RES_B, quantity: 1, flagged: true, flagReason: "x" })] })] }));
    await open(
      state({
        lines: [
          flaggedLine(),
          line({ id: MIC, name: "Microphone", quantity: 2, reservations: [reservation({ id: RES_B, quantity: 1, flagged: true, flagReason: "x" })] }),
        ],
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: /^Projector/ }));
    await click("Move to new time: Projector");
    expect(moveEquipmentReservation).toHaveBeenCalledWith(EVENT_ID, RES_A);
    expect(await screen.findByText("Decide on 1 flagged reservation")).toBeInTheDocument();
    expect(screen.getByText(/Moved the Projector reservation/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Microphone/ }));
    expect(screen.getByRole("button", { name: "Move to new time: Microphone" })).toBeInTheDocument();
  });
});

describe("guidance: what to do next", () => {
  const next = () => screen.getByRole("region", { name: "Next step" });
  const shortLine = (overrides = {}) => line({ reservations: [], ...overrides });

  it("SCRUM300_UX_a_pending_request_says_to_start_and_offers_the_button_there", async () => {
    await open(state({ status: "pending_review", lines: [shortLine()] }));
    expect(next()).toHaveTextContent("Start the review");
    expect(next()).toContainElement(screen.getByRole("button", { name: "Start review" }));
  });

  it("SCRUM300_UX_the_reviewer_with_short_lines_is_told_to_reserve_or_mark_them", async () => {
    await open(state({ lines: [shortLine()] }));
    expect(next()).toHaveTextContent("Reserve the rest of the equipment");
    expect(next()).toHaveTextContent("1 item still needs equipment");
  });

  it("SCRUM300_UX_a_flagged_reservation_comes_first_and_says_where_to_look", async () => {
    await open(state({ lines: [flaggedLine()] }));
    expect(next()).toHaveTextContent("Decide on 1 flagged reservation");
    expect(next()).toHaveTextContent("Needs decision");
  });

  it("SCRUM300_UX_a_fully_reserved_request_says_it_is_ready_to_complete", async () => {
    await open(state({ lines: [line({ reservations: [reservation({ quantity: 5 })] })] }));
    expect(next()).toHaveTextContent("Ready to complete");
  });

  it("SCRUM300_UX_someone_else_s_review_names_the_reviewer_and_offers_take_over_in_the_panel", async () => {
    await open(state({ reviewerId: OTHER }));
    expect(next()).toHaveTextContent("Sam Lee is reviewing this");
    expect(next()).toContainElement(screen.getByRole("button", { name: "Take over review" }));
  });
});

describe("guidance: a flagged reservation", () => {
  it("SCRUM300_UX_shows_what_it_was_reserved_for_and_what_the_event_is_now", async () => {
    await open(state({ lines: [flaggedLine()] }));
    expect(screen.getByText("Needs your decision")).toBeInTheDocument();
    expect(screen.getByText("Reserved for")).toBeInTheDocument();
    expect(screen.getByText("The event is now")).toBeInTheDocument();
  });

  it("SCRUM300_UX_each_choice_says_in_words_what_it_does", async () => {
    await open(state({ lines: [flaggedLine()] }));
    expect(screen.getByText(/Reserve the same units for the event's new date and time/)).toBeInTheDocument();
    expect(screen.getByText(/Leave the reservation as it is and clear the flag/)).toBeInTheDocument();
    expect(screen.getByText(/Give all 2 back so other events can use them/)).toBeInTheDocument();
  });

  it("SCRUM300_UX_someone_who_is_not_the_reviewer_sees_the_conflict_but_no_choices", async () => {
    await open(state({ reviewerId: OTHER, lines: [flaggedLine()] }));
    expect(screen.getByText("Needs your decision")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move to new time: Projector" })).not.toBeInTheDocument();
  });
});

describe("tabs: lines that need attention are kept apart from lines that are done", () => {
  const done = () => line({ id: MIC, name: "Microphone", reservations: [reservation({ id: RES_B, quantity: 5 })] });
  const short = () => line({ reservations: [] });
  const tab = (name) => screen.getByRole("tab", { name });

  it("SCRUM300_UX_opens_on_needs_attention_and_hides_finished_lines", async () => {
    await open(state({ lines: [short(), done()] }));
    expect(tab(/^Needs attention/)).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Projector")).toBeInTheDocument();
    expect(screen.queryByText("Microphone")).not.toBeInTheDocument();
  });

  it("SCRUM300_UX_each_tab_shows_how_many_lines_it_holds", async () => {
    await open(state({ lines: [short(), done()] }));
    expect(tab(/^Needs attention/)).toHaveTextContent("1");
    expect(tab(/^Done/)).toHaveTextContent("1");
    expect(tab(/^All/)).toHaveTextContent("2");
  });

  it("SCRUM300_UX_the_done_tab_shows_only_finished_lines", async () => {
    await open(state({ lines: [short(), done()] }));
    await userEvent.click(tab(/^Done/));
    expect(screen.getByText("Microphone")).toBeInTheDocument();
    expect(screen.queryByText("Projector")).not.toBeInTheDocument();
  });

  it("SCRUM300_UX_a_flagged_line_counts_as_needing_attention_even_when_fully_reserved", async () => {
    await open(state({ lines: [flaggedLine(), done()] }));
    expect(tab(/^Needs attention/)).toHaveTextContent("1");
    expect(screen.getByText("Needs your decision")).toBeInTheDocument();
  });

  it("SCRUM300_UX_a_line_marked_cannot_be_provided_counts_as_done", async () => {
    await open(state({ lines: [line({ reservations: [], outcome: "cannot_be_provided", outcomeNote: "No stock" })] }));
    expect(tab(/^Done/)).toHaveTextContent("1");
    expect(tab(/^Done/)).toHaveAttribute("aria-selected", "true");
  });

  it("SCRUM300_UX_with_nothing_left_to_do_it_opens_on_done_and_says_so", async () => {
    await open(state({ lines: [done()] }));
    expect(tab(/^Done/)).toHaveAttribute("aria-selected", "true");
    await userEvent.click(tab(/^Needs attention/));
    expect(screen.getByText(/Nothing needs attention/)).toBeInTheDocument();
  });

  it("SCRUM300_UX_a_line_moves_to_done_after_it_is_fully_reserved", async () => {
    await open(state({ lines: [short()] }));
    reserveEquipment.mockResolvedValue(state({ lines: [line({ reservations: [reservation({ quantity: 5 })] })] }));
    await userEvent.clear(screen.getByLabelText(/How many Projector to reserve/));
    await userEvent.type(screen.getByLabelText(/How many Projector to reserve/), "5");
    await userEvent.click(reserveBtn());
    expect(await screen.findByText("Reserved 5 of Projector.")).toBeInTheDocument();
    expect(tab(/^Done/)).toHaveTextContent("1");
    expect(tab(/^Done/)).toHaveAttribute("aria-selected", "true");
  });

  it("SCRUM300_UX_the_all_tab_shows_every_line", async () => {
    await open(state({ lines: [short(), done()] }));
    await userEvent.click(tab(/^All/));
    expect(screen.getByText("Projector")).toBeInTheDocument();
    expect(screen.getByText("Microphone")).toBeInTheDocument();
  });
});

describe("stock: one sentence, details on demand", () => {
  const withStock = (result, quantityAvailable, extra = {}) =>
    line({
      reservations: [],
      availability: { result, quantityRequested: 5, quantityAvailable, message: null, breakdown: null, reservations: [], ...extra },
    });

  it("SCRUM300_UX_a_partial_item_says_how_many_of_the_requested_are_available", async () => {
    await open(state({ lines: [withStock("Partially available", 2)] }));
    expect(screen.getByText("Only 2 of 5 available.")).toBeInTheDocument();
  });

  it("SCRUM300_UX_an_item_with_enough_says_so_once", async () => {
    await open(state({ lines: [withStock("Fully available", 9)] }));
    expect(screen.getByText("Enough in stock: 9 available.")).toBeInTheDocument();
    expect(screen.queryByText(/\d+ requested/)).not.toBeInTheDocument();
  });

  it("SCRUM300_UX_an_item_with_none_says_none_available", async () => {
    await open(state({ lines: [withStock("Unavailable", 0)] }));
    expect(screen.getByText("None available.")).toBeInTheDocument();
  });

  it("SCRUM300_UX_the_breakdown_lives_in_a_details_block", async () => {
    await open(state({ lines: [withStock("Partially available", 2, { breakdown: { total: 8, damagedOrUnderMaintenance: 2, reserved: 4 } })] }));
    expect(screen.getByText("Stock details")).toBeInTheDocument();
    expect(screen.getByText("8 in stock, 2 damaged or under maintenance, 4 reserved for this period.")).toBeInTheDocument();
  });

  it("SCRUM300_UX_notes_show_only_when_there_are_some", async () => {
    await open(state({ lines: [line({ reservations: [], technicalNotes: null })] }));
    expect(screen.queryByText(/Technical notes|No technical notes/)).not.toBeInTheDocument();
  });

  it("SCRUM300_UX_the_reserve_hint_appears_only_when_less_than_needed_can_be_reserved", async () => {
    await open(state({ lines: [withStock("Partially available", 2)] }));
    expect(screen.getByText("Only 2 can be reserved right now.")).toBeInTheDocument();
  });
});

describe("lines are closed rows and only one is open at a time", () => {
  const second = () => line({ id: MIC, name: "Microphone", reservations: [reservation({ id: RES_B, quantity: 5 })] });
  const row = (name) => screen.getByRole("button", { name });

  it("SCRUM300_UX_with_several_lines_all_start_closed_showing_a_summary", async () => {
    await open(state({ lines: [line({ reservations: [] }), flaggedLine()].map((l, i) => (i ? { ...l, id: MIC, name: "Microphone" } : l)) }));
    expect(row(/^Projector/)).toHaveAttribute("aria-expanded", "false");
    expect(row(/^Projector/)).toHaveTextContent("0 of 5 reserved");
    expect(row(/^Microphone/)).toHaveTextContent("Needs decision");
    expect(screen.queryByText(/in stock|available/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Reserve .*: Projector/ })).not.toBeInTheDocument();
  });

  it("SCRUM300_UX_opening_a_line_shows_its_details_and_closes_the_one_that_was_open", async () => {
    await open(state({ lines: [line({ reservations: [] }), { ...line({ reservations: [] }), id: MIC, name: "Microphone" }] }));
    await userEvent.click(row(/^Projector/));
    expect(row(/^Projector/)).toHaveAttribute("aria-expanded", "true");
    expect(reserveBtn("Projector")).toBeInTheDocument();

    await userEvent.click(row(/^Microphone/));
    expect(row(/^Microphone/)).toHaveAttribute("aria-expanded", "true");
    expect(row(/^Projector/)).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /^Reserve .*: Projector/ })).not.toBeInTheDocument();
    expect(reserveBtn("Microphone")).toBeInTheDocument();
  });

  it("SCRUM300_UX_clicking_the_open_line_again_closes_it", async () => {
    await open(state({ lines: [line({ reservations: [] }), { ...line({ reservations: [] }), id: MIC, name: "Microphone" }] }));
    await userEvent.click(row(/^Projector/));
    await userEvent.click(row(/^Projector/));
    expect(row(/^Projector/)).toHaveAttribute("aria-expanded", "false");
  });

  it("SCRUM300_UX_a_lone_line_opens_by_itself", async () => {
    await open(state({ lines: [line({ reservations: [] })] }));
    expect(row(/^Projector/)).toHaveAttribute("aria-expanded", "true");
  });

  it("SCRUM300_UX_closing_a_line_drops_a_half_filled_form", async () => {
    await open(state({ lines: [line(), { ...line({ reservations: [] }), id: MIC, name: "Microphone" }] }));
    await userEvent.click(row(/^Projector/));
    await click("Change quantity: Projector");
    expect(screen.getByLabelText(/New quantity/)).toBeInTheDocument();
    await userEvent.click(row(/^Projector/));
    await userEvent.click(row(/^Projector/));
    expect(screen.queryByLabelText(/New quantity/)).not.toBeInTheDocument();
  });

  it("SCRUM300_UX_the_summary_keeps_requested_and_reserved_visible_while_closed", async () => {
    await open(state({ lines: [line(), second()] }));
    await userEvent.click(screen.getByRole("tab", { name: /^All/ }));
    expect(screen.getAllByRole("button", { name: / of \d+ reserved/ })).toHaveLength(2);
  });
});

describe("the stock meter and the quantity stepper", () => {
  const withStock = (quantityAvailable) =>
    line({
      reservations: [],
      availability: { result: "Partially available", quantityRequested: 5, quantityAvailable, message: null, breakdown: { total: 8, damagedOrUnderMaintenance: 2, reserved: 4 }, reservations: [] },
    });

  it("SCRUM300_UX_the_stepper_moves_the_quantity_and_stops_at_what_is_available", async () => {
    await open(state({ lines: [withStock(2)] }));
    const input = screen.getByLabelText(/How many Projector to reserve/);
    expect(input).toHaveValue(2);
    expect(screen.getByRole("button", { name: "One more Projector" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "One fewer Projector" }));
    expect(input).toHaveValue(1);
    expect(screen.getByRole("button", { name: "One fewer Projector" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "One more Projector" }));
    expect(input).toHaveValue(2);
  });

  it("SCRUM300_UX_the_stepper_value_is_what_gets_reserved", async () => {
    reserveEquipment.mockResolvedValue(state());
    await open(state({ lines: [withStock(3)] }));
    await userEvent.click(screen.getByRole("button", { name: "One fewer Projector" }));
    await userEvent.click(reserveBtn());
    expect(reserveEquipment).toHaveBeenCalledWith(EVENT_ID, PROJECTOR, 2);
  });
});

describe("the review summary at the bottom", () => {
  it("SCRUM300_UX_the_summary_lists_every_item_and_what_it_still_needs", async () => {
    await open(
      state({
        lines: [
          line({ reservations: [reservation({ quantity: 5 })] }),
          line({ id: MIC, name: "Microphone", reservations: [] }),
        ],
      }),
    );
    expect(screen.getByRole("heading", { name: "Finish review" })).toBeInTheDocument();
    expect(screen.getByText(/Projector: 5 of 5 reserved/)).toBeInTheDocument();
    expect(screen.getByText(/Microphone: 0 of 5 reserved \(reserve more or mark it cannot be provided\)/)).toBeInTheDocument();
  });

  it("SCRUM300_UX_the_summary_flags_an_item_with_a_reservation_to_decide", async () => {
    await open(state({ lines: [flaggedLine()] }));
    expect(screen.getByText(/has a flagged reservation to decide/)).toBeInTheDocument();
  });

  it("SCRUM300_UX_the_summary_counts_a_not_provided_item_as_dealt_with", async () => {
    await open(state({ lines: [line({ reservations: [], outcome: "cannot_be_provided", outcomeNote: "No stock" })] }));
    expect(screen.getByText(/marked cannot be provided/)).toBeInTheDocument();
  });

  it("SCRUM300_UX_the_summary_is_only_for_the_reviewer", async () => {
    await open(state({ reviewerId: OTHER, lines: [line({ reservations: [] })] }));
    expect(screen.queryByRole("heading", { name: "Finish review" })).not.toBeInTheDocument();
  });
});
