// scrum588TechSupportStates.test.jsx
//
// The UI standard's loading, empty and error states, display dates and
// ConfirmDialog on the Technical Support screens, and that the two dialogs send
// exactly what the inline confirms they replace sent. Services are mocked.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import TechnicalSupportDashboard from "../../src/components/TechnicalSupportDashboard.jsx";
import EquipmentRequestQueue from "../../src/components/EquipmentRequestQueue.jsx";
import EquipmentReviewedByMe from "../../src/components/EquipmentReviewedByMe.jsx";
import EquipmentReview from "../../src/components/EquipmentReview.jsx";
import EquipmentCatalogue from "../../src/components/EquipmentCatalogue.jsx";
import EquipmentAvailabilityCheck from "../../src/components/EquipmentAvailabilityCheck.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import { getEquipmentQueue, getReviewedByMe } from "../../src/services/equipmentQueueService";
import { completeEquipmentReview, getEquipmentReview } from "../../src/services/equipmentReviewService";
import * as equipment from "../../src/services/equipmentService";
import * as availability from "../../src/services/equipmentAvailabilityService";
import { deferred, httpError } from "../helpers/async.js";
import { stubDialogElement } from "../helpers/dialog.js";

vi.mock("../../src/auth/AuthContext", async () => (await import("../helpers/authMock.js")).authContextMock());
vi.mock("../../src/services/equipmentQueueService", () => ({ getEquipmentQueue: vi.fn(), getReviewedByMe: vi.fn() }));
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
vi.mock("../../src/services/equipmentAvailabilityService", () => ({
  listActiveEquipmentTypes: vi.fn(),
  checkEquipmentAvailability: vi.fn(),
}));
vi.mock("../../src/components/NotificationInbox", () => ({ default: () => null }));

const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const ME = "99999999-9999-4999-8999-999999999999";
const STATUSES = [
  { value: "pending_review", label: "Pending review" },
  { value: "under_review", label: "Under review" },
];

// 10:00Z to 12:00Z is 6:00 pm to 8:00 pm on 10 Jan in Singapore.
const queueRow = (overrides = {}) => ({
  eventRequestId: "11111111-1111-4111-8111-111111111111",
  eventName: "Annual Dinner",
  proposedStart: "2030-01-10T10:00:00+00:00",
  proposedEnd: "2030-01-10T12:00:00+00:00",
  venues: [{ id: "v1", name: "Hall A" }],
  coordinator: { id: "c1", name: "Rae Tan" },
  itemCount: 3,
  status: "pending_review",
  statusLabel: "Pending review",
  reviewer: null,
  flaggedCount: 0,
  flagReasons: [],
  ...overrides,
});
const queue = (needsAction, requests = needsAction) => ({
  needsAction,
  needsActionTotal: needsAction.length,
  needsActionTruncated: false,
  requests,
  requestsTotal: requests.length,
  requestsTruncated: false,
  statuses: STATUSES,
});
const reviewedRow = (overrides = {}) => ({
  requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  eventRequestId: "11111111-1111-4111-8111-111111111111",
  eventName: "Annual Dinner",
  proposedStart: "2030-01-10T10:00:00+00:00",
  proposedEnd: "2030-01-10T12:00:00+00:00",
  status: "under_review",
  statusLabel: "Under review",
  lastWorkedAt: "2030-01-05T01:00:00+00:00",
  returnedToPending: false,
  interruptedReason: null,
  interruptedAt: null,
  ...overrides,
});

// A line one short, so Complete review asks first.
const line = (overrides = {}) => ({
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  equipmentTypeId: "t1",
  name: "Projector",
  quantity: 2,
  technicalNotes: null,
  typeRetired: false,
  reserved: 1,
  shortBy: 1,
  flaggedCount: 0,
  outcome: "cannot_be_provided",
  outcomeNote: "Only one in stock",
  availability: null,
  reservations: [
    {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      quantity: 1,
      startAt: "2026-11-01T10:00:00Z",
      endAt: "2026-11-01T12:00:00Z",
      flagged: false,
      flagReason: null,
      flaggedAt: null,
      canKeep: false,
    },
  ],
  ...overrides,
});
const reviewState = (lines = [line()]) => ({
  event: {
    id: EVENT_ID,
    name: "Hack Night",
    proposedStart: "2026-11-01T10:00:00Z",
    proposedEnd: "2026-11-01T12:00:00Z",
    assignedCoordinatorName: "Rae Tan",
    venue: { id: "v1", name: "Hall A" },
  },
  request: {
    id: "r1",
    status: "under_review",
    statusLabel: "Under review",
    reviewerId: ME,
    reviewerName: "Sam Lee",
    reviewStartedAt: "2026-10-10T09:00:00Z",
    lines,
  },
});

const projector = {
  id: "p1", name: "Projector (HD)", description: null, category: "Display", location: "Store room 1",
  totalQuantity: 8, damagedQuantity: 1, underMaintenanceQuantity: 1, usableQuantity: 6, retiredAt: null,
};
const nothingAffected = { usableBefore: 6, usableAfter: 5, affectedCount: 0, affectedUnits: 0, affected: [] };
const someAffected = {
  usableBefore: 6,
  usableAfter: 0,
  affected: [
    {
      reservationId: "11111111-1111-4111-8111-111111111111", eventRequestId: "e1", eventName: "Open Day",
      equipmentLineId: "l1", quantity: 3, startAt: "2026-11-05T01:00:00+00:00", endAt: "2026-11-05T05:00:00+00:00",
      coordinatorId: "c1", coordinatorName: "Cara Coordinator", flagged: false, reservedAt: "2026-10-01T00:00:00+00:00",
    },
  ],
};

const RETIRE_MESSAGE =
  "It can no longer be reserved, and you can reinstate it later. If events have it reserved, you will see them before anything is saved.";
const COMPLETE_MESSAGE =
  '1 item is not fully reserved. Each needs a "Cannot be provided" note, and the request will be marked Cannot be fully arranged. Reservations already made are kept.';

function renderQueue() {
  return render(<EquipmentRequestQueue />, { wrapper: MemoryRouter });
}
function renderReviewed() {
  return render(<EquipmentReviewedByMe />, { wrapper: MemoryRouter });
}
function renderReview() {
  return render(
    <MemoryRouter initialEntries={[`/equipment-review/${EVENT_ID}`]}>
      <Routes>
        <Route path="/equipment-review/:eventId" element={<EquipmentReview />} />
      </Routes>
    </MemoryRouter>,
  );
}
async function openReview(state = reviewState()) {
  vi.mocked(getEquipmentReview).mockResolvedValue(state);
  renderReview();
  await screen.findByRole("heading", { name: "Hack Night" });
}
async function openCatalogue() {
  render(<EquipmentCatalogue />);
  await screen.findByText("Projector (HD)");
}
function renderAvailability() {
  return render(<EquipmentAvailabilityCheck />, { wrapper: MemoryRouter });
}
async function openRetireDialog(user) {
  await user.click(screen.getByRole("button", { name: "Retire Projector (HD)" }));
  return screen.getByRole("dialog", { name: "Retire Projector (HD)?" });
}
async function openCompleteDialog(user) {
  await user.click(screen.getByRole("button", { name: "Complete review" }));
  return screen.getByRole("dialog", { name: "Complete this review?" });
}
// The ErrorNotice's own text, without its button's.
const noticeMessage = (alert) => alert.querySelector(".ui-error-notice__message")?.textContent;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(useAuth).mockReturnValue({ user: { id: ME, name: "Sam", role: "technical_support_staff" } });
  vi.mocked(getEquipmentQueue).mockResolvedValue(queue([queueRow()]));
  vi.mocked(getReviewedByMe).mockResolvedValue({ requests: [reviewedRow()], total: 1, truncated: false });
  vi.mocked(equipment.listEquipment).mockResolvedValue([projector]);
  vi.mocked(equipment.previewEquipmentChange).mockResolvedValue(nothingAffected);
  vi.mocked(equipment.retireEquipment).mockResolvedValue({});
  vi.mocked(availability.listActiveEquipmentTypes).mockResolvedValue([{ id: "p1", name: "Projector (HD)" }]);
});

// ConfirmDialog calls showModal and close, which jsdom lacks.
stubDialogElement();

describe("SCRUM588 AC4 loading", () => {
  it("SCRUM588_AC4_the_dashboard_lists_each_show_exactly_loading", () => {
    vi.mocked(getEquipmentQueue).mockReturnValue(new Promise(() => {}));
    vi.mocked(getReviewedByMe).mockReturnValue(new Promise(() => {}));
    render(<TechnicalSupportDashboard user={{ name: "Sam" }} />, { wrapper: MemoryRouter });

    expect(screen.getAllByRole("status").map((status) => status.textContent)).toEqual(["Loading...", "Loading..."]);
  });

  it.each([
    ["review", () => vi.mocked(getEquipmentReview).mockReturnValue(new Promise(() => {})), renderReview],
    ["catalogue", () => vi.mocked(equipment.listEquipment).mockReturnValue(new Promise(() => {})), () => render(<EquipmentCatalogue />)],
    ["availability_check", () => vi.mocked(availability.listActiveEquipmentTypes).mockReturnValue(new Promise(() => {})), renderAvailability],
  ])("SCRUM588_AC4_the_%s_shows_exactly_loading", (_, hold, renderScreen) => {
    hold();
    renderScreen();

    expect(screen.getByRole("status")).toHaveTextContent(/^Loading\.\.\.$/);
  });

  it("SCRUM588_AC4_history_shows_exactly_loading", async () => {
    const user = userEvent.setup();
    vi.mocked(equipment.getEquipmentHistory).mockReturnValue(new Promise(() => {}));
    await openCatalogue();
    await user.click(screen.getByRole("button", { name: "History for Projector (HD)" }));

    expect(screen.getByRole("status")).toHaveTextContent(/^Loading\.\.\.$/);
  });
});

describe("SCRUM588 AC4 errors", () => {
  it.each([
    ["equipment_requests", getEquipmentQueue, renderQueue, "The equipment requests could not be loaded.", () => queue([queueRow()])],
    ["reviewed_requests", getReviewedByMe, renderReviewed, "Your reviewed requests could not be loaded.", () => ({ requests: [reviewedRow()], total: 1, truncated: false })],
  ])("SCRUM588_AC4_failed_%s_say_so_once_and_try_again_reads_again", async (_, read, renderScreen, message, answer) => {
    const user = userEvent.setup();
    vi.mocked(read).mockRejectedValueOnce(httpError(500, {})).mockResolvedValueOnce(answer());
    renderScreen();

    const alert = await screen.findByRole("alert");
    // The button says Try again, so the message does not say it as well.
    expect(noticeMessage(alert)).toBe(message);
    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect((await screen.findAllByText("Annual Dinner")).length).toBeGreaterThan(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM588_AC4_a_failed_review_read_offers_try_again_and_reads_again", async () => {
    const user = userEvent.setup();
    vi.mocked(getEquipmentReview).mockRejectedValueOnce(httpError(500, {})).mockResolvedValueOnce(reviewState());
    renderReview();

    const alert = await screen.findByRole("alert");
    expect(noticeMessage(alert)).toBe("Could not load this equipment request.");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { name: "Hack Night" })).toBeInTheDocument();
  });

  it("SCRUM588_AC4_a_failed_catalogue_read_says_so_once_and_try_again_reads_again", async () => {
    const user = userEvent.setup();
    vi.mocked(equipment.listEquipment).mockRejectedValueOnce(httpError(500, {})).mockResolvedValueOnce([projector]);
    render(<EquipmentCatalogue />);

    const alert = await screen.findByRole("alert");
    expect(noticeMessage(alert)).toBe("Could not load the equipment catalogue.");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Projector (HD)")).toBeInTheDocument();
    expect(equipment.listEquipment).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM588_AC4_a_failed_history_read_says_so_once_and_try_again_reads_the_same_type_again", async () => {
    const user = userEvent.setup();
    vi.mocked(equipment.getEquipmentHistory).mockRejectedValueOnce(httpError(500, {})).mockResolvedValueOnce([]);
    await openCatalogue();
    await user.click(screen.getByRole("button", { name: "History for Projector (HD)" }));

    const alert = await screen.findByRole("alert");
    expect(noticeMessage(alert)).toBe("Could not load this type's history.");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("No changes recorded.")).toBeInTheDocument();
    expect(equipment.getEquipmentHistory).toHaveBeenCalledTimes(2);
    expect(equipment.getEquipmentHistory).toHaveBeenLastCalledWith("p1");
  });

  it("SCRUM588_AC4_failed_equipment_types_say_so_once_and_try_again_reads_again", async () => {
    const user = userEvent.setup();
    vi.mocked(availability.listActiveEquipmentTypes)
      .mockRejectedValueOnce(httpError(500, {}))
      .mockResolvedValueOnce([{ id: "p1", name: "Projector (HD)" }]);
    renderAvailability();

    const alert = await screen.findByRole("alert");
    expect(noticeMessage(alert)).toBe("Could not load the equipment types.");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("option", { name: "Projector (HD)" })).toBeInTheDocument();
    expect(availability.listActiveEquipmentTypes).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["queue_403", () => vi.mocked(getEquipmentQueue).mockRejectedValue(httpError(403, {})), renderQueue],
    ["queue_400", () => vi.mocked(getEquipmentQueue).mockRejectedValue(httpError(400, {})), renderQueue],
    ["review_404", () => vi.mocked(getEquipmentReview).mockRejectedValue(httpError(404, {})), renderReview],
    ["review_400", () => vi.mocked(getEquipmentReview).mockRejectedValue(httpError(400, {})), renderReview],
  ])("SCRUM588_AC4_a_%s_offers_no_try_again_since_it_would_answer_the_same", async (_, fail, renderScreen) => {
    fail();
    renderScreen();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveClass("ui-error-notice");
    expect(within(alert).queryByRole("button")).not.toBeInTheDocument();
  });

  it("SCRUM588_AC4_a_refused_action_on_the_review_is_an_error_notice_without_try_again", async () => {
    const user = userEvent.setup();
    vi.mocked(completeEquipmentReview).mockRejectedValue(httpError(500, {}));
    await openReview();
    await user.click(within(await openCompleteDialog(user)).getByRole("button", { name: "Yes, complete review" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveClass("ui-error-notice");
    // Complete review, still on screen, is the retry.
    expect(within(alert).queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("SCRUM588 AC4 empty states", () => {
  const nextStepOf = (message) => screen.getByText(message).closest(".ui-empty-state").querySelector(".ui-empty-state__next-step");

  it("SCRUM588_AC4_empty_queue_lists_say_what_appears_there", async () => {
    vi.mocked(getEquipmentQueue).mockResolvedValue(queue([], []));
    renderQueue();

    await screen.findByText("Nothing needs your action.");
    expect(nextStepOf("Nothing needs your action.")).toHaveTextContent(
      "Requests waiting for review, or with a flagged reservation, appear here.",
    );
    expect(nextStepOf("No equipment requests for upcoming events.")).toHaveTextContent(
      "New requests appear here when coordinators request equipment for an event.",
    );
  });

  it("SCRUM588_AC4_a_filter_that_matches_nothing_says_to_change_it", async () => {
    const user = userEvent.setup();
    vi.mocked(getEquipmentQueue).mockResolvedValue(queue([], []));
    renderQueue();
    await screen.findByText("No equipment requests for upcoming events.");

    await user.selectOptions(screen.getByLabelText("Status"), "under_review");

    expect(await screen.findByText("No equipment requests match these filters.")).toBeInTheDocument();
    expect(nextStepOf("No equipment requests match these filters.")).toHaveTextContent("Change or clear the filters.");
  });

  it("SCRUM588_AC4_nothing_reviewed_yet_says_what_appears_there", async () => {
    vi.mocked(getReviewedByMe).mockResolvedValue({ requests: [], total: 0, truncated: false });
    renderReviewed();

    await screen.findByText("You have not reviewed any equipment requests yet.");
    expect(nextStepOf("You have not reviewed any equipment requests yet.")).toHaveTextContent(
      "Requests you start or take over appear here.",
    );
  });

  it("SCRUM588_AC4_an_empty_catalogue_says_to_add_a_type_without_a_second_add_button", async () => {
    vi.mocked(equipment.listEquipment).mockResolvedValue([]);
    render(<EquipmentCatalogue />);

    await screen.findByText("No active equipment types yet.");
    expect(nextStepOf("No active equipment types yet.")).toHaveTextContent("Add an equipment type to start.");
    expect(screen.getAllByRole("button", { name: "Add equipment type" })).toHaveLength(1);
  });

  it("SCRUM588_AC4_an_empty_history_says_what_will_appear", async () => {
    const user = userEvent.setup();
    vi.mocked(equipment.getEquipmentHistory).mockResolvedValue([]);
    await openCatalogue();
    await user.click(screen.getByRole("button", { name: "History for Projector (HD)" }));

    await screen.findByText("No changes recorded.");
    expect(nextStepOf("No changes recorded.")).toHaveTextContent("Changes to this equipment type will appear here.");
  });

  it("SCRUM588_AC4_no_active_types_links_to_the_catalogue_as_a_primary_button", async () => {
    vi.mocked(availability.listActiveEquipmentTypes).mockResolvedValue([]);
    renderAvailability();

    await screen.findByText("No active equipment types yet.");
    expect(nextStepOf("No active equipment types yet.")).toHaveTextContent("Add one in the equipment catalogue first.");
    const link = screen.getByRole("link", { name: "Open the equipment catalogue" });
    expect(link).toHaveAttribute("href", "/equipment-catalogue");
    expect(link).toHaveClass("ui-button", "ui-button--primary");
  });
});

describe("SCRUM588 AC4 dates in the standard display format", () => {
  it("SCRUM588_AC4_queue_and_reviewed_rows_show_the_standard_range", async () => {
    render(<TechnicalSupportDashboard user={{ name: "Sam" }} />, { wrapper: MemoryRouter });

    const rows = await screen.findAllByText("10 Jan 2030, 6:00 pm – 8:00 pm");
    // Needs action, Equipment requests and Reviewed by me.
    expect(rows).toHaveLength(3);
    expect(screen.getByText("Last worked on: 5 Jan 2030, 9:00 am")).toBeInTheDocument();
  });

  it("SCRUM588_AC4_a_period_past_midnight_shows_both_dates_and_one_without_dates_reads_date_not_set", async () => {
    vi.mocked(getEquipmentQueue).mockResolvedValue(
      queue(
        [],
        [
          // 15:00Z to 17:00Z is 11:00 pm on 10 Jan to 1:00 am on 11 Jan in Singapore.
          queueRow({ proposedStart: "2030-01-10T15:00:00+00:00", proposedEnd: "2030-01-10T17:00:00+00:00" }),
          queueRow({ eventRequestId: "e2", eventName: "Undated", proposedStart: null, proposedEnd: null }),
        ],
      ),
    );
    renderQueue();

    expect(await screen.findByText("10 Jan 2030, 11:00 pm – 11 Jan 2030, 1:00 am")).toBeInTheDocument();
    expect(screen.getByText("Date not set")).toBeInTheDocument();
  });

  it("SCRUM588_AC4_the_review_shows_the_event_period_and_review_start_in_the_standard_format", async () => {
    await openReview();

    expect(screen.getByText("When").nextElementSibling).toHaveTextContent(/^1 Nov 2026, 6:00 pm – 8:00 pm$/);
    expect(screen.getByText("You are reviewing this request (since 10 Oct 2026, 5:00 pm).")).toBeInTheDocument();
  });

  it("SCRUM588_AC4_history_shows_when_each_change_was_made_in_the_standard_format", async () => {
    const user = userEvent.setup();
    vi.mocked(equipment.getEquipmentHistory).mockResolvedValue([
      { id: 1, field: "created", oldValue: null, newValue: "Projector (HD)", note: null, changedBy: null, changedAt: "2026-10-05T11:29:15+00:00" },
    ]);
    await openCatalogue();
    await user.click(screen.getByRole("button", { name: "History for Projector (HD)" }));

    expect(await screen.findByRole("cell", { name: "5 Oct 2026, 7:29 pm" })).toBeInTheDocument();
  });

  it("SCRUM588_AC4_an_overlapping_reservation_shows_the_standard_range", async () => {
    const user = userEvent.setup();
    vi.mocked(availability.checkEquipmentAvailability).mockResolvedValue({
      result: "Partially available",
      quantityRequested: 4,
      quantityAvailable: 3,
      message: null,
      breakdown: { total: 5, damaged: 0, underMaintenance: 0, damagedOrUnderMaintenance: 0, reserved: 2, available: 3 },
      reservations: [
        { id: "x1", eventName: "Alumni Gala", startAt: "2026-12-01T02:00:00+00:00", endAt: "2026-12-01T09:00:00+00:00", quantity: 2, flagged: false },
      ],
    });
    renderAvailability();
    await screen.findByRole("option", { name: "Projector (HD)" });
    await user.selectOptions(screen.getByLabelText("Equipment type"), "p1");
    await user.type(screen.getByLabelText("Quantity"), "4");
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-12-01T10:00" } });
    fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-12-01T12:00" } });
    await user.click(screen.getByRole("button", { name: "Check availability" }));

    expect(await screen.findByRole("cell", { name: "1 Dec 2026, 10:00 am – 5:00 pm" })).toBeInTheDocument();
  });
});

describe("SCRUM588 AC3 confirmations use ConfirmDialog", () => {
  it("SCRUM588_AC3_retire_asks_in_a_danger_dialog_named_for_the_type", async () => {
    const user = userEvent.setup();
    await openCatalogue();

    const dialog = await openRetireDialog(user);
    expect(dialog).toHaveTextContent(RETIRE_MESSAGE);
    expect(within(dialog).getByRole("button", { name: "Confirm retire" })).toHaveClass("ui-button--danger");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveClass("ui-button--secondary");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("SCRUM588_AC3_complete_review_asks_in_a_dialog_with_its_existing_wording", async () => {
    const user = userEvent.setup();
    await openReview();

    const dialog = await openCompleteDialog(user);
    expect(dialog).toHaveTextContent(COMPLETE_MESSAGE);
    // Not destructive: reservations already made are kept.
    expect(within(dialog).getByRole("button", { name: "Yes, complete review" })).toHaveClass("ui-button--primary");
    expect(within(dialog).getByRole("button", { name: "Not yet" })).toHaveClass("ui-button--secondary");
    expect(within(dialog).getByRole("button", { name: "Not yet" })).toHaveFocus();
  });
});

describe("SCRUM588 AC10 the dialogs send what the inline confirms sent", () => {
  it("SCRUM588_AC10_cancelling_or_escaping_the_retire_dialog_sends_nothing", async () => {
    const user = userEvent.setup();
    await openCatalogue();

    await user.click(within(await openRetireDialog(user)).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent(await openRetireDialog(user), new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    expect(equipment.previewEquipmentChange).not.toHaveBeenCalled();
    expect(equipment.retireEquipment).not.toHaveBeenCalled();
  });

  it("SCRUM588_AC10_confirming_retire_checks_then_retires_once_and_closes", async () => {
    const user = userEvent.setup();
    const checking = deferred();
    vi.mocked(equipment.previewEquipmentChange).mockReturnValue(checking.promise);
    await openCatalogue();

    const dialog = await openRetireDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Confirm retire" }));
    // Held while the check runs, Escape included.
    expect(within(dialog).getByRole("button", { name: "Checking..." })).toBeDisabled();
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    checking.resolve(nothingAffected);

    await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(equipment.previewEquipmentChange).toHaveBeenCalledTimes(1);
    expect(equipment.previewEquipmentChange).toHaveBeenCalledWith("p1", { retire: true });
    expect(equipment.retireEquipment).toHaveBeenCalledTimes(1);
    expect(equipment.retireEquipment).toHaveBeenCalledWith("p1", { confirmedReservationIds: [] });
  });

  it("SCRUM588_AC10_when_reservations_are_affected_the_dialog_gives_way_to_the_list_under_the_row", async () => {
    const user = userEvent.setup();
    vi.mocked(equipment.previewEquipmentChange).mockResolvedValue(someAffected);
    await openCatalogue();

    await user.click(within(await openRetireDialog(user)).getByRole("button", { name: "Confirm retire" }));

    expect(await screen.findByRole("region", { name: "Reservations affected: Projector (HD)" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(equipment.retireEquipment).not.toHaveBeenCalled();
  });

  it("SCRUM588_AC10_not_yet_closes_the_complete_dialog_and_sends_nothing", async () => {
    const user = userEvent.setup();
    await openReview();

    await user.click(within(await openCompleteDialog(user)).getByRole("button", { name: "Not yet" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(completeEquipmentReview).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Complete review" })).toBeEnabled();
  });

  it("SCRUM588_AC10_confirming_completes_the_review_once_for_this_event", async () => {
    const user = userEvent.setup();
    const completing = deferred();
    vi.mocked(completeEquipmentReview).mockReturnValue(completing.promise);
    await openReview();

    const dialog = await openCompleteDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Yes, complete review" }));
    const busy = within(dialog).getByRole("button", { name: "Completing..." });
    expect(busy).toBeDisabled();
    await user.click(busy);
    completing.resolve({
      ...reviewState(),
      request: { ...reviewState().request, status: "cannot_be_fully_arranged", statusLabel: "Cannot be fully arranged" },
    });

    expect(await screen.findByText("Review completed.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(completeEquipmentReview).toHaveBeenCalledTimes(1);
    expect(completeEquipmentReview).toHaveBeenCalledWith(EVENT_ID);
  });
});
