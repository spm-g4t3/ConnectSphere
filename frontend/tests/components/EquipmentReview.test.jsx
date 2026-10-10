// EquipmentReview.test.jsx
//
// SCRUM-296, for SCRUM-290 (Review an Equipment Request - Technical Support
// Staff). Named SCRUM290_<what_it_checks>.
//
// The service and the signed-in user are mocked, so nothing touches the network.
// The screen's buttons are a convenience; that the server refuses the wrong
// person or status is proved by the backend and database tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import EquipmentReview from "../../src/components/EquipmentReview.jsx";
import {
  clearEquipmentLineOutcome,
  completeEquipmentReview,
  getEquipmentReview,
  markEquipmentLineUnavailable,
  startEquipmentReview,
  takeOverEquipmentReview,
} from "../../src/services/equipmentReviewService";
import { useAuth } from "../../src/auth/AuthContext";

vi.mock("../../src/services/equipmentReviewService", () => ({
  clearEquipmentLineOutcome: vi.fn(),
  completeEquipmentReview: vi.fn(),
  getEquipmentReview: vi.fn(),
  markEquipmentLineUnavailable: vi.fn(),
  startEquipmentReview: vi.fn(),
  takeOverEquipmentReview: vi.fn(),
}));
vi.mock("../../src/auth/AuthContext", () => ({ useAuth: vi.fn() }));

const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const ME = "99999999-9999-4999-8999-999999999999";
const OTHER = "88888888-8888-4888-8888-888888888888";
const PROJECTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MIC = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const availability = (result, requested, available) => ({
  result,
  quantityRequested: requested,
  quantityAvailable: available,
  message: null,
  breakdown: { total: 10, damaged: 0, underMaintenance: 0, damagedOrUnderMaintenance: 0, reserved: 10 - available, available },
  reservations: [],
});

function line(overrides = {}) {
  return {
    id: PROJECTOR,
    equipmentTypeId: "t1",
    name: "Projector",
    quantity: 3,
    technicalNotes: "HDMI please",
    typeRetired: false,
    reserved: 1,
    shortBy: 2,
    outcome: null,
    outcomeNote: null,
    outcomeBy: null,
    outcomeAt: null,
    availability: availability("Partially available", 3, 2),
    ...overrides,
  };
}

function state({ status = "pending_review", statusLabel = "Pending review", reviewerId = null, lines = [line()] } = {}) {
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
      statusLabel,
      reviewerId,
      reviewerName: reviewerId ? "Sam Lee" : null,
      reviewStartedAt: reviewerId ? "2026-10-10T09:00:00Z" : null,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      lines,
    },
  };
}

const underReview = (extra = {}) => state({ status: "under_review", statusLabel: "Under review", reviewerId: ME, ...extra });

function fail(status, data) {
  return { response: { status, data } };
}

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

beforeEach(() => {
  vi.resetAllMocks();
  useAuth.mockReturnValue({ user: { id: ME, role: "technical_support_staff" } });
});

describe("EquipmentReview: what is shown", () => {
  it("SCRUM290_shows_event_venue_coordinator_and_status", async () => {
    await open(state());
    expect(getEquipmentReview).toHaveBeenCalledWith(EVENT_ID);
    expect(screen.getByText("Venue: Hall A")).toBeInTheDocument();
    expect(screen.getByText("Coordinator: Rae Tan")).toBeInTheDocument();
    expect(screen.getByText("Pending review")).toBeInTheDocument();
  });

  it("SCRUM290_says_when_no_venue_is_booked", async () => {
    const s = state();
    s.event.venue = null;
    await open(s);
    expect(screen.getByText("No venue booked.")).toBeInTheDocument();
  });

  it("SCRUM290_shows_each_line_with_requested_reserved_and_availability", async () => {
    await open(state({ lines: [line(), line({ id: MIC, name: "Microphone", quantity: 1, reserved: 1, shortBy: 0, availability: availability("Fully available", 1, 5) })] }));
    expect(screen.getByText("Requested: 3")).toBeInTheDocument();
    expect(screen.getByText("Reserved: 1 of 3")).toBeInTheDocument();
    expect(screen.getByText("Partially available")).toBeInTheDocument();
    expect(screen.getByText("Only 2 of 3 requested are available.")).toBeInTheDocument();
    expect(screen.getByText("Fully available")).toBeInTheDocument();
    expect(screen.getAllByText("HDMI please")).toHaveLength(2);
  });

  it("SCRUM290_lists_overlapping_reservations", async () => {
    const a = availability("Partially available", 3, 2);
    a.reservations = [{ id: "x", eventName: "Gala", quantity: 8, startAt: "2026-11-01T09:00:00Z", endAt: "2026-11-01T13:00:00Z", flagged: true }];
    await open(state({ lines: [line({ availability: a })] }));
    expect(screen.getByText("Overlapping reservations (1)")).toBeInTheDocument();
    expect(screen.getByText(/Gala: 8/)).toHaveTextContent("(flagged for review)");
  });

  it("SCRUM290_a_missing_request_is_said_plainly", async () => {
    getEquipmentReview.mockResolvedValue({ event: null, request: null });
    render(
      <MemoryRouter initialEntries={[`/equipment-review/${EVENT_ID}`]}>
        <Routes>
          <Route path="/equipment-review/:eventId" element={<EquipmentReview />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("This event has no equipment request to review.")).toBeInTheDocument();
  });

  it("SCRUM290_a_load_failure_offers_try_again", async () => {
    getEquipmentReview.mockRejectedValueOnce(fail(500, {}));
    render(
      <MemoryRouter initialEntries={[`/equipment-review/${EVENT_ID}`]}>
        <Routes>
          <Route path="/equipment-review/:eventId" element={<EquipmentReview />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Could not load this equipment request.")).toBeInTheDocument();
    getEquipmentReview.mockResolvedValue(state());
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Hack Night" })).toBeInTheDocument();
  });
});

describe("EquipmentReview: starting and taking over", () => {
  it("SCRUM290_start_review_replaces_the_state", async () => {
    await open(state());
    startEquipmentReview.mockResolvedValue(underReview());
    await userEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(startEquipmentReview).toHaveBeenCalledWith(EVENT_ID);
    expect(await screen.findByText(/You are reviewing this request/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start review" })).not.toBeInTheDocument();
  });

  it("SCRUM290_cannot_be_fully_arranged_offers_review_again", async () => {
    await open(state({ status: "cannot_be_fully_arranged", statusLabel: "Cannot be fully arranged" }));
    expect(screen.getByRole("button", { name: "Review again" })).toBeInTheDocument();
  });

  it("SCRUM290_someone_elses_review_shows_their_name_and_take_over_only", async () => {
    await open(state({ status: "under_review", statusLabel: "Under review", reviewerId: OTHER }));
    expect(screen.getByText(/Being reviewed by Sam Lee/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Take over review" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cannot be provided" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Complete review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start review" })).not.toBeInTheDocument();
  });

  it("SCRUM290_take_over_makes_the_user_the_reviewer", async () => {
    await open(state({ status: "under_review", statusLabel: "Under review", reviewerId: OTHER }));
    takeOverEquipmentReview.mockResolvedValue(underReview());
    await userEvent.click(screen.getByRole("button", { name: "Take over review" }));
    expect(takeOverEquipmentReview).toHaveBeenCalledWith(EVENT_ID);
    expect(await screen.findByRole("button", { name: "Complete review" })).toBeInTheDocument();
  });

  it("SCRUM290_a_refused_start_says_why_and_reads_again", async () => {
    await open(state());
    startEquipmentReview.mockRejectedValue(fail(409, { error: "Sam Lee is already reviewing this request." }));
    getEquipmentReview.mockResolvedValue(state({ status: "under_review", statusLabel: "Under review", reviewerId: OTHER }));
    await userEvent.click(screen.getByRole("button", { name: "Start review" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sam Lee is already reviewing this request.");
    expect(await screen.findByRole("button", { name: "Take over review" })).toBeInTheDocument();
  });

  it("SCRUM290_refresh_reads_the_state_again", async () => {
    await open(state());
    getEquipmentReview.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(getEquipmentReview).toHaveBeenCalledTimes(1);
  });
});

describe("EquipmentReview: marking lines", () => {
  it("SCRUM290_pending_review_offers_no_line_actions", async () => {
    await open(state());
    expect(screen.queryByRole("button", { name: /Cannot be provided/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reserve" })).not.toBeInTheDocument();
  });

  it("SCRUM290_reviewer_sees_a_disabled_reserve_and_a_mark_button_on_short_lines_only", async () => {
    await open(underReview({ lines: [line(), line({ id: MIC, name: "Microphone", quantity: 1, reserved: 1, shortBy: 0 })] }));
    expect(screen.getAllByRole("button", { name: "Reserve" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Reserve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Mark as cannot be provided: Projector" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Microphone/ })).not.toBeInTheDocument();
  });

  it("SCRUM290_a_blank_note_is_refused_before_any_call", async () => {
    await open(underReview());
    await userEvent.click(screen.getByRole("button", { name: "Mark as cannot be provided: Projector" }));
    await userEvent.type(screen.getByLabelText(/Why can Projector not be provided/), "   ");
    await userEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Add a note");
    expect(markEquipmentLineUnavailable).not.toHaveBeenCalled();
  });

  it("SCRUM290_saving_a_note_sends_it_trimmed_and_shows_the_mark", async () => {
    await open(underReview());
    markEquipmentLineUnavailable.mockResolvedValue(
      underReview({ lines: [line({ outcome: "cannot_be_provided", outcomeNote: "None in stock" })] }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Mark as cannot be provided: Projector" }));
    await userEvent.type(screen.getByLabelText(/Why can Projector not be provided/), "  None in stock ");
    await userEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(markEquipmentLineUnavailable).toHaveBeenCalledWith(EVENT_ID, PROJECTOR, "None in stock");
    expect(await screen.findByText("None in stock")).toBeInTheDocument();
    expect(screen.getByText("Projector marked as cannot be provided.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove mark on Projector" })).toBeInTheDocument();
  });

  it("SCRUM290_a_refused_note_stays_in_the_form_with_the_server_reason", async () => {
    await open(underReview());
    markEquipmentLineUnavailable.mockRejectedValue(fail(400, { details: [{ field: "note", message: "must be 1000 characters or fewer" }] }));
    await userEvent.click(screen.getByRole("button", { name: "Mark as cannot be provided: Projector" }));
    await userEvent.type(screen.getByLabelText(/Why can Projector not be provided/), "x");
    await userEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Note: must be 1000 characters or fewer");
    expect(screen.getByLabelText(/Why can Projector not be provided/)).toBeInTheDocument();
  });

  it("SCRUM290_remove_mark_clears_the_outcome", async () => {
    await open(underReview({ lines: [line({ outcome: "cannot_be_provided", outcomeNote: "None in stock" })] }));
    clearEquipmentLineOutcome.mockResolvedValue(underReview());
    await userEvent.click(screen.getByRole("button", { name: "Remove mark on Projector" }));
    expect(clearEquipmentLineOutcome).toHaveBeenCalledWith(EVENT_ID, PROJECTOR);
    expect(await screen.findByText("The mark on Projector was removed.")).toBeInTheDocument();
    expect(screen.queryByText("None in stock")).not.toBeInTheDocument();
  });

  it("SCRUM290_cancel_closes_the_form_without_a_call", async () => {
    await open(underReview());
    await userEvent.click(screen.getByRole("button", { name: "Mark as cannot be provided: Projector" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText(/Why can Projector/)).not.toBeInTheDocument();
    expect(markEquipmentLineUnavailable).not.toHaveBeenCalled();
  });
});

describe("EquipmentReview: completing", () => {
  it("SCRUM290_complete_asks_first_and_says_what_will_happen_when_lines_are_short", async () => {
    await open(underReview());
    await userEvent.click(screen.getByRole("button", { name: "Complete review" }));
    expect(screen.getByText(/1 line is not fully reserved/)).toBeInTheDocument();
    expect(completeEquipmentReview).not.toHaveBeenCalled();
  });

  it("SCRUM290_complete_says_arranged_when_nothing_is_short", async () => {
    await open(underReview({ lines: [line({ reserved: 3, shortBy: 0 })] }));
    await userEvent.click(screen.getByRole("button", { name: "Complete review" }));
    expect(screen.getByText(/will be marked Arranged/)).toBeInTheDocument();
  });

  it("SCRUM290_confirming_completes_and_shows_the_new_status", async () => {
    await open(underReview());
    completeEquipmentReview.mockResolvedValue(
      state({ status: "cannot_be_fully_arranged", statusLabel: "Cannot be fully arranged", lines: [line({ outcome: "cannot_be_provided", outcomeNote: "None" })] }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Complete review" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, complete review" }));
    expect(completeEquipmentReview).toHaveBeenCalledWith(EVENT_ID);
    expect(await screen.findByText("Cannot be fully arranged")).toBeInTheDocument();
    expect(screen.getByText("Review completed.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Complete review" })).not.toBeInTheDocument();
  });

  it("SCRUM290_missing_notes_are_named_when_completion_is_refused", async () => {
    await open(underReview());
    completeEquipmentReview.mockRejectedValue(fail(400, { details: [{ field: "lines", message: "Projector needs a note" }] }));
    await userEvent.click(screen.getByRole("button", { name: "Complete review" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, complete review" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Projector needs a note");
    expect(screen.getByRole("button", { name: "Yes, complete review" })).toBeInTheDocument();
  });

  it("SCRUM290_a_stale_completion_is_explained_and_the_state_read_again", async () => {
    await open(underReview());
    completeEquipmentReview.mockRejectedValue(fail(403, {}));
    getEquipmentReview.mockResolvedValue(state({ status: "under_review", statusLabel: "Under review", reviewerId: OTHER }));
    await userEvent.click(screen.getByRole("button", { name: "Complete review" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, complete review" }));
    expect(await screen.findByText(/Being reviewed by Sam Lee/)).toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(within(alert.parentElement).getByRole("alert")).toHaveTextContent("Only the staff member reviewing");
  });

  it("SCRUM290_arranged_requests_offer_no_actions", async () => {
    await open(state({ status: "arranged", statusLabel: "Arranged", lines: [line({ reserved: 3, shortBy: 0 })] }));
    expect(screen.queryByRole("button", { name: "Start review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Complete review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Take over review" })).not.toBeInTheDocument();
  });
});
