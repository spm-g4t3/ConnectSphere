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

beforeEach(() => {
  vi.resetAllMocks();
  useAuth.mockReturnValue({ user: { id: ME, role: "technical_support_staff" } });
});

describe("what is shown", () => {
  it("SCRUM300_AC2_lists_each_reservation_with_its_quantity_and_period", async () => {
    await open(state());
    expect(screen.getByRole("heading", { name: "Reservations (1)" })).toBeInTheDocument();
    expect(screen.getByText(/2 reserved,/)).toBeInTheDocument();
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
    expect(screen.getByText(/2 reservations are flagged/)).toBeInTheDocument();
  });

  it("SCRUM300_AC7_the_banner_uses_the_singular_for_one", async () => {
    await open(state({ lines: [flaggedLine()] }));
    expect(screen.getByText(/1 reservation is flagged/)).toBeInTheDocument();
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
    expect(screen.getByText(/2 reserved,/)).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Release the Projector reservation" })).toBeInTheDocument();
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
  it("SCRUM300_AC2_reserve_opens_a_form_prefilled_with_what_is_still_needed", async () => {
    await open(state());
    await click("Reserve Projector");
    expect(screen.getByLabelText(/How many Projector to reserve\? \(3 still needed\)/)).toHaveValue(3);
  });

  it("SCRUM300_AC2_submitting_calls_the_service_with_the_number_and_shows_the_new_state", async () => {
    const after = state({ lines: [line({ reservations: [reservation({ quantity: 2 }), reservation({ id: RES_B, quantity: 1 })] })] });
    reserveEquipment.mockResolvedValue(after);
    await open(state());
    await click("Reserve Projector");
    const input = screen.getByLabelText(/How many Projector/);
    await userEvent.clear(input);
    await userEvent.type(input, "1");
    await userEvent.click(screen.getByRole("button", { name: "Reserve" }));

    expect(reserveEquipment).toHaveBeenCalledWith(EVENT_ID, PROJECTOR, 1);
    expect(await screen.findByRole("status")).toHaveTextContent("Reserved 1 of Projector.");
    expect(screen.getByRole("heading", { name: "Reservations (2)" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/How many Projector/)).not.toBeInTheDocument();
  });

  it.each(["", "0", "-1", "1.5"])("SCRUM300_AC2_quantity_%j_is_refused_before_any_call", async (value) => {
    await open(state());
    await click("Reserve Projector");
    const input = screen.getByLabelText(/How many Projector/);
    await userEvent.clear(input);
    if (value) await userEvent.type(input, value);
    await userEvent.click(screen.getByRole("button", { name: "Reserve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/whole number greater than zero/);
    expect(reserveEquipment).not.toHaveBeenCalled();
  });

  it("SCRUM300_AC2_when_the_server_says_how_many_are_available_the_form_stays_open_with_that_message", async () => {
    reserveEquipment.mockRejectedValue(
      fail(400, { error: "x", details: [{ field: "quantity", message: "Only 1 available for this period, so 3 cannot be reserved" }] }),
    );
    await open(state());
    await click("Reserve Projector");
    await userEvent.click(screen.getByRole("button", { name: "Reserve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Quantity: Only 1 available for this period, so 3 cannot be reserved");
    expect(screen.getByLabelText(/How many Projector/)).toBeInTheDocument();
    expect(getEquipmentReview).toHaveBeenCalledTimes(1);
  });

  it("SCRUM300_AC3_losing_the_race_for_the_last_unit_shows_the_updated_availability", async () => {
    reserveEquipment.mockRejectedValue(
      fail(400, { error: "x", details: [{ field: "quantity", message: "Only 0 available for this period, so 1 cannot be reserved" }] }),
    );
    await open(state());
    await click("Reserve Projector");
    await userEvent.click(screen.getByRole("button", { name: "Reserve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Only 0 available/);
  });

  it("SCRUM300_AC1_a_409_shows_the_reason_and_reads_the_state_again", async () => {
    reserveEquipment.mockRejectedValue(fail(409, { error: "This can only be done while the request is Under review. This request is Arranged." }));
    await open(state());
    await click("Reserve Projector");
    await userEvent.click(screen.getByRole("button", { name: "Reserve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Arranged/);
    expect(getEquipmentReview).toHaveBeenCalledTimes(2);
  });

  it("SCRUM300_AC2_cancel_closes_the_form_without_a_call", async () => {
    await open(state());
    await click("Reserve Projector");
    await click("Cancel");
    expect(screen.queryByLabelText(/How many Projector/)).not.toBeInTheDocument();
    expect(reserveEquipment).not.toHaveBeenCalled();
  });

  it("SCRUM300_opening_the_mark_note_form_closes_an_open_reservation_form", async () => {
    await open(state());
    await click("Reduce the Projector reservation");
    expect(screen.getByLabelText(/New quantity/)).toBeInTheDocument();
    await click("Mark as cannot be provided: Projector");
    expect(screen.queryByLabelText(/New quantity/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Why can Projector not be provided/)).toBeInTheDocument();
    expect(reduceEquipmentReservation).not.toHaveBeenCalled();
  });

  it("SCRUM300_opening_a_reservation_form_closes_an_open_mark_note_form", async () => {
    await open(state());
    await click("Mark as cannot be provided: Projector");
    await click("Release the Projector reservation");
    expect(screen.queryByLabelText(/Why can Projector not be provided/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Why is it being released?")).toBeInTheDocument();
  });
});

describe("the reserve form hint", () => {
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
    await click("Reserve Projector");
    expect(screen.getByText("Up to 2 can be reserved right now.")).toBeInTheDocument();
    expect(screen.getByLabelText(/How many Projector/)).toHaveValue(2);
  });

  it("SCRUM300_AC2_the_hint_never_offers_more_than_the_line_still_needs", async () => {
    await open(withAvailability(50));
    await click("Reserve Projector");
    expect(screen.getByText("Up to 3 can be reserved right now.")).toBeInTheDocument();
  });

  it("SCRUM300_AC2_when_none_can_be_reserved_it_says_so_and_prefills_nothing", async () => {
    await open(withAvailability(2));
    await click("Reserve Projector");
    expect(screen.getByText("None can be reserved right now.")).toBeInTheDocument();
    expect(screen.getByLabelText(/How many Projector/)).toHaveValue(null);
  });

  it("SCRUM300_AC2_with_no_availability_figure_there_is_no_hint_and_the_prefill_is_what_is_needed", async () => {
    await open(state());
    await click("Reserve Projector");
    expect(screen.queryByText(/can be reserved right now/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/How many Projector/)).toHaveValue(3);
  });
});

describe("a refusal message does not outlive the typing that fixes it", () => {
  it("SCRUM300_the_reduce_reason_error_clears_when_the_reviewer_types", async () => {
    await open(state());
    await click("Reduce the Projector reservation");
    await userEvent.click(screen.getByRole("button", { name: "Reduce" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Add a reason.");
    await userEvent.type(screen.getByLabelText("Why is it being reduced?"), "a");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM300_the_reserve_quantity_error_clears_when_the_reviewer_types", async () => {
    await open(state());
    await click("Reserve Projector");
    const input = screen.getByLabelText(/How many Projector/);
    await userEvent.clear(input);
    await userEvent.click(screen.getByRole("button", { name: "Reserve", exact: true }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await userEvent.type(input, "1");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("AC4: reducing and releasing", () => {
  it("SCRUM300_AC4_reduce_sends_the_new_quantity_and_the_reason", async () => {
    reduceEquipmentReservation.mockResolvedValue(state({ lines: [line({ reservations: [reservation({ quantity: 1 })] })] }));
    await open(state());
    await click("Reduce the Projector reservation");
    expect(screen.getByLabelText(/New quantity \(currently 2\)/)).toHaveValue(1);
    await userEvent.type(screen.getByLabelText("Why is it being reduced?"), "Only one needed");
    await userEvent.click(screen.getByRole("button", { name: "Reduce" }));

    expect(reduceEquipmentReservation).toHaveBeenCalledWith(EVENT_ID, RES_A, 1, "Only one needed");
    expect(await screen.findByRole("status")).toHaveTextContent("Reduced the Projector reservation to 1.");
  });

  it("SCRUM300_AC4_reduce_without_a_reason_is_refused_before_any_call", async () => {
    await open(state());
    await click("Reduce the Projector reservation");
    await userEvent.click(screen.getByRole("button", { name: "Reduce" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Add a reason.");
    expect(reduceEquipmentReservation).not.toHaveBeenCalled();
  });

  it("SCRUM300_AC4_a_whitespace_only_reason_counts_as_none", async () => {
    await open(state());
    await click("Reduce the Projector reservation");
    await userEvent.type(screen.getByLabelText("Why is it being reduced?"), "   ");
    await userEvent.click(screen.getByRole("button", { name: "Reduce" }));
    expect(reduceEquipmentReservation).not.toHaveBeenCalled();
  });

  it("SCRUM300_AC4_reducing_to_the_same_or_a_larger_number_is_refused_before_any_call", async () => {
    await open(state());
    await click("Reduce the Projector reservation");
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
    await click("Release the Projector reservation");
    await userEvent.type(screen.getByLabelText("Why is it being released?"), "Wrong item");
    await userEvent.click(screen.getByRole("button", { name: "Release" }));

    expect(releaseEquipmentReservation).toHaveBeenCalledWith(EVENT_ID, RES_A, "Wrong item");
    expect(await screen.findByRole("status")).toHaveTextContent("Released the Projector reservation.");
    expect(screen.queryByRole("heading", { name: /Reservations/ })).not.toBeInTheDocument();
  });

  it("SCRUM300_AC4_release_without_a_reason_is_refused_before_any_call", async () => {
    await open(state());
    await click("Release the Projector reservation");
    await userEvent.click(screen.getByRole("button", { name: "Release" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Add a reason.");
    expect(releaseEquipmentReservation).not.toHaveBeenCalled();
  });

  it("SCRUM300_AC4_a_server_refusal_keeps_the_form_open_and_keeps_the_typed_reason", async () => {
    releaseEquipmentReservation.mockRejectedValue(fail(400, { error: "x", details: [{ field: "reason", message: "is required: say why" }] }));
    await open(state());
    await click("Release the Projector reservation");
    await userEvent.type(screen.getByLabelText("Why is it being released?"), "Wrong item");
    await userEvent.click(screen.getByRole("button", { name: "Release" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Reason: is required: say why");
    expect(screen.getByLabelText("Why is it being released?")).toHaveValue("Wrong item");
  });

  it("SCRUM300_AC4_only_one_editor_is_open_at_a_time", async () => {
    await open(state({ lines: [line({ reservations: [reservation(), reservation({ id: RES_B, quantity: 2 })] })] }));
    const [first, second] = screen.getAllByRole("button", { name: "Release the Projector reservation" });
    await userEvent.click(first);
    expect(screen.getAllByLabelText("Why is it being released?")).toHaveLength(1);
    await userEvent.click(second);
    expect(screen.getAllByLabelText("Why is it being released?")).toHaveLength(1);
  });

  it("SCRUM300_AC4_cancel_closes_a_reduce_form_without_a_call", async () => {
    await open(state());
    await click("Reduce the Projector reservation");
    await click("Cancel");
    expect(screen.queryByLabelText(/New quantity/)).not.toBeInTheDocument();
    expect(reduceEquipmentReservation).not.toHaveBeenCalled();
  });
});

describe("AC7: resolving a flagged reservation", () => {
  it("SCRUM300_AC7_move_calls_the_service_and_replaces_the_state", async () => {
    moveEquipmentReservation.mockResolvedValue(state({ lines: [line()] }));
    await open(state({ lines: [flaggedLine()] }));
    await click("Move the Projector reservation");

    expect(moveEquipmentReservation).toHaveBeenCalledWith(EVENT_ID, RES_A);
    expect(await screen.findByRole("status")).toHaveTextContent(/Moved the Projector reservation/);
    expect(screen.queryByText("Flagged")).not.toBeInTheDocument();
    expect(screen.queryByText(/reservation is flagged/)).not.toBeInTheDocument();
  });

  it("SCRUM300_AC7_keep_calls_the_service_and_replaces_the_state", async () => {
    keepEquipmentReservation.mockResolvedValue(state({ lines: [line()] }));
    await open(state({ lines: [flaggedLine()] }));
    await click("Keep the Projector reservation");

    expect(keepEquipmentReservation).toHaveBeenCalledWith(EVENT_ID, RES_A);
    expect(await screen.findByRole("status")).toHaveTextContent(/Kept the Projector reservation/);
    expect(screen.queryByText("Flagged")).not.toBeInTheDocument();
  });

  it("SCRUM300_AC7_a_move_the_server_refuses_for_availability_shows_why_and_stays_flagged", async () => {
    moveEquipmentReservation.mockRejectedValue(
      fail(400, { error: "x", details: [{ field: "quantity", message: "Only 0 available for the event's current period, so 2 cannot be moved there" }] }),
    );
    await open(state({ lines: [flaggedLine()] }));
    await click("Move the Projector reservation");
    expect(await screen.findByRole("alert")).toHaveTextContent(/Only 0 available/);
    expect(screen.getByText("Flagged")).toBeInTheDocument();
  });

  it("SCRUM300_AC7_a_keep_the_server_refuses_shows_the_reason_in_words_and_reads_again", async () => {
    keepEquipmentReservation.mockRejectedValue(
      fail(409, { error: "This reservation cannot be kept. Its period no longer matches the event. Move it, reduce it or release it." }),
    );
    await open(state({ lines: [flaggedLine()] }));
    await click("Keep the Projector reservation");
    expect(await screen.findByRole("alert")).toHaveTextContent(/period no longer matches/);
    expect(getEquipmentReview).toHaveBeenCalledTimes(2);
  });

  it("SCRUM300_AC7_buttons_are_disabled_while_an_action_is_running", async () => {
    let finish;
    moveEquipmentReservation.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await open(state({ lines: [flaggedLine()] }));
    await click("Move the Projector reservation");
    expect(screen.getByRole("button", { name: "Keep the Projector reservation" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Release the Projector reservation" })).toBeDisabled();
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
    await click("Move the Projector reservation");
    expect(moveEquipmentReservation).toHaveBeenCalledWith(EVENT_ID, RES_A);
    expect(await screen.findByText(/1 reservation is flagged/)).toBeInTheDocument();
    expect(screen.getByText(/Moved the Projector reservation/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move the Microphone reservation" })).toBeInTheDocument();
  });
});
