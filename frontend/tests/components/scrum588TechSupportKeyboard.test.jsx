// scrum588TechSupportKeyboard.test.jsx
//
// The Technical Support screens by keyboard alone: Tab reaches the controls in
// reading order, the review tabs say which is selected, both dialogs work with
// Enter, Tab and Escape, and focus never falls to the page body when the
// control that had it goes away. Services are mocked. The focus ring and the
// 360px layout are CSS, so they are checked in the manual walk-through.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import EquipmentRequestQueue from "../../src/components/EquipmentRequestQueue.jsx";
import EquipmentReviewedByMe from "../../src/components/EquipmentReviewedByMe.jsx";
import EquipmentReview from "../../src/components/EquipmentReview.jsx";
import EquipmentCatalogue from "../../src/components/EquipmentCatalogue.jsx";
import EquipmentAvailabilityCheck from "../../src/components/EquipmentAvailabilityCheck.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import { getEquipmentQueue, getReviewedByMe } from "../../src/services/equipmentQueueService";
import {
  completeEquipmentReview,
  getEquipmentReview,
  markEquipmentLineUnavailable,
  startEquipmentReview,
} from "../../src/services/equipmentReviewService";
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

const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const ME = "99999999-9999-4999-8999-999999999999";

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
  statuses: [
    { value: "pending_review", label: "Pending review" },
    { value: "under_review", label: "Under review" },
  ],
});
const reviewed = () => ({
  requests: [
    {
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      eventRequestId: "33333333-3333-4333-8333-333333333333",
      eventName: "Careers Fair",
      proposedStart: "2030-01-10T10:00:00+00:00",
      proposedEnd: "2030-01-10T12:00:00+00:00",
      status: "under_review",
      statusLabel: "Under review",
      lastWorkedAt: "2030-01-05T01:00:00+00:00",
      returnedToPending: false,
      interruptedReason: null,
      interruptedAt: null,
    },
  ],
  total: 1,
  truncated: false,
});

// One short line marked "cannot be provided", with one reservation of two units.
const line = (overrides = {}) => ({
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  equipmentTypeId: "t1",
  name: "Projector",
  quantity: 3,
  technicalNotes: null,
  typeRetired: false,
  reserved: 2,
  shortBy: 1,
  flaggedCount: 0,
  outcome: "cannot_be_provided",
  outcomeNote: "Only two in stock",
  availability: null,
  reservations: [
    {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      quantity: 2,
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
const reviewState = ({ lines = [line()], status = "under_review", statusLabel = "Under review" } = {}) => ({
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
    status,
    statusLabel,
    reviewerId: status === "under_review" ? ME : null,
    reviewerName: status === "under_review" ? "Sam Lee" : null,
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

function renderQueuePage() {
  return render(
    <MemoryRouter>
      <h1>Equipment request queue</h1>
      <EquipmentRequestQueue />
      <EquipmentReviewedByMe />
    </MemoryRouter>,
  );
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
const button = (name) => screen.getByRole("button", { name });

/** Presses Tab once per expected element and checks each one takes focus in turn. */
async function expectTabOrder(user, elements) {
  for (const element of elements) {
    await user.tab();
    expect(element).toHaveFocus();
  }
}

/** Opens the retire dialog from the keyboard: focus Retire, press Enter. */
async function openRetireDialogByKeyboard(user) {
  button("Retire Projector (HD)").focus();
  await user.keyboard("{Enter}");
  return screen.getByRole("dialog", { name: "Retire Projector (HD)?" });
}
async function openCompleteDialogByKeyboard(user) {
  button("Complete review").focus();
  await user.keyboard("{Enter}");
  return screen.getByRole("dialog", { name: "Complete this review?" });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(useAuth).mockReturnValue({ user: { id: ME, name: "Sam", role: "technical_support_staff" } });
  vi.mocked(getEquipmentQueue).mockResolvedValue(queue([queueRow()]));
  vi.mocked(getReviewedByMe).mockResolvedValue(reviewed());
  vi.mocked(equipment.listEquipment).mockResolvedValue([projector]);
  vi.mocked(equipment.previewEquipmentChange).mockResolvedValue(nothingAffected);
  vi.mocked(equipment.retireEquipment).mockResolvedValue({});
  vi.mocked(equipment.getEquipmentHistory).mockResolvedValue([]);
  vi.mocked(availability.listActiveEquipmentTypes).mockResolvedValue([{ id: "p1", name: "Projector (HD)" }]);
});

// ConfirmDialog calls showModal and close, which jsdom lacks.
stubDialogElement();

describe("SCRUM588 AC8 Tab reaches the controls in reading order", () => {
  it("SCRUM588_AC8_tab_reaches_the_queue_page_controls_in_reading_order", async () => {
    const user = userEvent.setup();
    renderQueuePage();
    await screen.findByText("Careers Fair");
    const [needsOpen, allOpen] = screen.getAllByRole("link", { name: "Open Annual Dinner" });

    await expectTabOrder(user, [
      needsOpen,
      screen.getByLabelText("Status"),
      screen.getByLabelText("Include past events"),
      allOpen,
      screen.getByRole("link", { name: "Open Careers Fair" }),
    ]);
  });

  it("SCRUM588_AC8_tab_reaches_the_review_controls_in_reading_order", async () => {
    const user = userEvent.setup();
    await openReview();

    // The steppers are disabled at their limits, so Tab passes them by.
    await expectTabOrder(user, [
      button("Refresh"),
      screen.getByRole("tab", { name: /Needs attention/ }),
      screen.getByRole("tab", { name: /Done/ }),
      screen.getByRole("tab", { name: /All/ }),
      screen.getByRole("button", { name: /Projector/, expanded: true }),
      button("Change quantity: Projector"),
      button("Release all: Projector"),
      screen.getByLabelText("How many Projector to reserve?"),
      button("Reserve 1 more: Projector"),
      button("Edit note for Projector"),
      button("Remove mark on Projector"),
      button("Complete review"),
    ]);
  });

  it("SCRUM588_AC8_review_tabs_switch_with_enter_or_space_and_say_which_is_selected", async () => {
    const user = userEvent.setup();
    await openReview(
      reviewState({
        lines: [
          line({ id: "l-short", name: "Projector", outcome: null, outcomeNote: null }),
          line({ id: "l-done", name: "Speaker", shortBy: 0, reserved: 3, outcome: null, outcomeNote: null }),
        ],
      }),
    );
    const tab = (name) => screen.getByRole("tab", { name });
    expect(tab(/Needs attention/)).toHaveAttribute("aria-selected", "true");

    tab(/Done/).focus();
    await user.keyboard("{Enter}");
    expect(tab(/Done/)).toHaveAttribute("aria-selected", "true");
    expect(tab(/Needs attention/)).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Speaker");
    expect(screen.getByRole("tabpanel")).not.toHaveTextContent("Projector");

    await user.tab();
    await user.keyboard(" ");
    expect(tab(/All/)).toHaveAttribute("aria-selected", "true");
    expect(tab(/All/)).toHaveFocus();
  });
});

describe("SCRUM588 AC8 the retire dialog by keyboard", () => {
  it("SCRUM588_AC8_cancel_or_escape_on_the_retire_dialog_returns_focus_to_that_rows_retire_button", async () => {
    const user = userEvent.setup();
    await openCatalogue();

    await openRetireDialogByKeyboard(user);
    // Focus starts on Cancel, so Enter cancels.
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(button("Retire Projector (HD)")).toHaveFocus();

    fireEvent(await openRetireDialogByKeyboard(user), new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(button("Retire Projector (HD)")).toHaveFocus();
    expect(equipment.retireEquipment).not.toHaveBeenCalled();
  });

  it("SCRUM588_AC8_retiring_with_nothing_affected_moves_focus_to_the_types_reinstate_button", async () => {
    const user = userEvent.setup();
    vi.mocked(equipment.listEquipment)
      .mockResolvedValueOnce([projector])
      .mockResolvedValueOnce([{ ...projector, retiredAt: "2026-10-01T00:00:00Z" }]);
    await openCatalogue();

    await openRetireDialogByKeyboard(user);
    await user.tab();
    expect(button("Confirm retire")).toHaveFocus();
    await user.keyboard("{Enter}");

    await vi.waitFor(() => expect(button("Reinstate Projector (HD)")).toHaveFocus());
    expect(equipment.retireEquipment).toHaveBeenCalledWith("p1", { confirmedReservationIds: [] });
  });

  it("SCRUM588_AC8_retiring_with_reservations_affected_moves_focus_to_check_before_you_save_and_back_on_keep", async () => {
    const user = userEvent.setup();
    vi.mocked(equipment.previewEquipmentChange).mockResolvedValue(someAffected);
    await openCatalogue();

    await openRetireDialogByKeyboard(user);
    await user.tab();
    await user.keyboard("{Enter}");

    await vi.waitFor(() => expect(screen.getByRole("heading", { name: "Check before you save" })).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    button("Keep this type").focus();
    await user.keyboard("{Enter}");
    expect(button("Retire Projector (HD)")).toHaveFocus();
    expect(equipment.retireEquipment).not.toHaveBeenCalled();
  });
});

describe("SCRUM588 AC8 the complete review dialog by keyboard", () => {
  it("SCRUM588_AC8_not_yet_or_escape_returns_focus_to_complete_review", async () => {
    const user = userEvent.setup();
    await openReview();

    await openCompleteDialogByKeyboard(user);
    expect(button("Not yet")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(button("Complete review")).toHaveFocus();

    fireEvent(await openCompleteDialogByKeyboard(user), new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(button("Complete review")).toHaveFocus();
    expect(completeEquipmentReview).not.toHaveBeenCalled();
  });

  it("SCRUM588_AC8_completing_moves_focus_to_the_review_completed_notice", async () => {
    const user = userEvent.setup();
    vi.mocked(completeEquipmentReview).mockResolvedValue(
      reviewState({ status: "cannot_be_fully_arranged", statusLabel: "Cannot be fully arranged" }),
    );
    await openReview();

    await openCompleteDialogByKeyboard(user);
    await user.tab();
    await user.keyboard("{Enter}");

    // Complete review itself is gone: the review is no longer in progress.
    await vi.waitFor(() => expect(screen.getByText("Review completed.")).toHaveFocus());
    expect(screen.queryByRole("button", { name: "Complete review" })).not.toBeInTheDocument();
  });

  it("SCRUM588_AC8_a_refused_completion_moves_focus_to_the_error_notice", async () => {
    const user = userEvent.setup();
    vi.mocked(completeEquipmentReview).mockRejectedValue(httpError(500, {}));
    await openReview();

    await openCompleteDialogByKeyboard(user);
    await user.tab();
    await user.keyboard("{Enter}");

    const alert = await screen.findByRole("alert");
    await vi.waitFor(() => expect(alert.parentElement).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("SCRUM588 AC8 focus around the catalogue panels", () => {
  it.each([
    ["add", "Add equipment type", "Add an equipment type"],
    ["edit", "Edit Projector (HD)", "Edit Projector (HD)"],
    ["damage", "Damage and maintenance for Projector (HD)", "Damage and maintenance: Projector (HD)"],
    ["history", "History for Projector (HD)", "History: Projector (HD)"],
  ])("SCRUM588_AC8_the_%s_panel_takes_focus_on_its_title_and_back_returns_it_to_the_opener", async (_, opener, title) => {
    const user = userEvent.setup();
    await openCatalogue();

    button(opener).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("heading", { level: 1, name: title })).toHaveFocus();

    button("← Back to the equipment catalogue").focus();
    await user.keyboard("{Enter}");
    expect(button(opener)).toHaveFocus();
  });

  it("SCRUM588_AC8_saving_an_edit_returns_focus_to_its_edit_button", async () => {
    const user = userEvent.setup();
    vi.mocked(equipment.updateEquipment).mockResolvedValue({});
    await openCatalogue();
    button("Edit Projector (HD)").focus();
    await user.keyboard("{Enter}");

    await user.type(screen.getByLabelText("Category"), " screens");
    await user.keyboard("{Enter}");

    await vi.waitFor(() => expect(button("Edit Projector (HD)")).toHaveFocus());
    expect(equipment.updateEquipment).toHaveBeenCalledWith("p1", { category: "Display screens" });
  });
});

describe("SCRUM588 AC8 focus after review actions", () => {
  it("SCRUM588_AC8_starting_a_review_moves_focus_to_the_notice", async () => {
    const user = userEvent.setup();
    vi.mocked(startEquipmentReview).mockResolvedValue(reviewState());
    await openReview(reviewState({ status: "pending_review", statusLabel: "Pending review" }));

    button("Start review").focus();
    await user.keyboard("{Enter}");

    await vi.waitFor(() => expect(screen.getByText("You are now reviewing this request.")).toHaveFocus());
  });

  it("SCRUM588_AC8_opening_the_note_form_focuses_its_heading_and_cancel_returns_to_the_line", async () => {
    const user = userEvent.setup();
    await openReview();

    button("Edit note for Projector").focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("heading", { name: "Projector cannot be provided" })).toHaveFocus();

    button("Cancel").focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: /Projector/, expanded: true })).toHaveFocus();
  });

  it("SCRUM588_AC8_a_refused_note_moves_focus_to_the_forms_error", async () => {
    const user = userEvent.setup();
    vi.mocked(markEquipmentLineUnavailable).mockRejectedValue(httpError(500, {}));
    await openReview();
    button("Edit note for Projector").focus();
    await user.keyboard("{Enter}");

    button("Save note").focus();
    await user.keyboard("{Enter}");

    await vi.waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
    expect(markEquipmentLineUnavailable).toHaveBeenCalledTimes(1);
  });
});

// Each screen: the read that fails once, how to render it, and the heading Try again focuses.
const RETRY_SCREENS = [
  ["equipment_requests", getEquipmentQueue, () => queue([queueRow()]), renderQueuePage, { level: 2, name: "Needs action (1)" }],
  ["reviewed_by_me", getReviewedByMe, reviewed, renderQueuePage, { level: 2, name: "Reviewed by me" }],
  ["review", getEquipmentReview, () => reviewState(), renderReview, { level: 1, name: "Equipment request review" }],
  ["catalogue", equipment.listEquipment, () => [projector], () => render(<EquipmentCatalogue />), { level: 2, name: "Active equipment" }],
  [
    "availability_check",
    availability.listActiveEquipmentTypes,
    () => [{ id: "p1", name: "Projector (HD)" }],
    () => render(<EquipmentAvailabilityCheck />, { wrapper: MemoryRouter }),
    { level: 2, name: "Choose equipment and period" },
  ],
];

describe("SCRUM588 AC8 Try again moves focus to the heading", () => {
  it.each(RETRY_SCREENS)("SCRUM588_AC8_try_again_on_%s_focuses_its_heading_after_the_reload", async (_, read, answer, renderScreen, heading) => {
    const user = userEvent.setup();
    vi.mocked(read).mockRejectedValueOnce(httpError(500, {})).mockResolvedValueOnce(answer());
    renderScreen();

    const retry = within(await screen.findByRole("alert")).getByRole("button", { name: "Try again" });
    retry.focus();
    await user.keyboard("{Enter}");

    await vi.waitFor(() => expect(screen.getByRole("heading", heading)).toHaveFocus());
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(RETRY_SCREENS)("SCRUM588_AC8_a_first_load_of_%s_leaves_focus_where_it_is", async (_, read, answer, renderScreen, heading) => {
    vi.mocked(read).mockResolvedValue(answer());
    renderScreen();

    await screen.findByRole("heading", heading);
    expect(document.body).toHaveFocus();
  });

  it("SCRUM588_AC8_try_again_on_history_focuses_the_panel_title_after_the_reload", async () => {
    const user = userEvent.setup();
    vi.mocked(equipment.getEquipmentHistory).mockRejectedValueOnce(httpError(500, {})).mockResolvedValueOnce([]);
    await openCatalogue();
    await user.click(button("History for Projector (HD)"));

    const retry = within(await screen.findByRole("alert")).getByRole("button", { name: "Try again" });
    retry.focus();
    await user.keyboard("{Enter}");

    await screen.findByText("No changes recorded.");
    expect(screen.getByRole("heading", { level: 1, name: "History: Projector (HD)" })).toHaveFocus();
  });
});

describe("SCRUM588 AC4 one read per Try again", () => {
  it("SCRUM588_AC4_a_double_click_on_the_catalogue_try_again_sends_one_read", async () => {
    const user = userEvent.setup();
    const reading = deferred();
    vi.mocked(equipment.listEquipment).mockRejectedValueOnce(httpError(500, {})).mockReturnValueOnce(reading.promise);
    render(<EquipmentCatalogue />);

    // Try again stays on screen while the read runs.
    await user.dblClick(within(await screen.findByRole("alert")).getByRole("button", { name: "Try again" }));
    reading.resolve([projector]);

    expect(await screen.findByText("Projector (HD)")).toBeInTheDocument();
    expect(equipment.listEquipment).toHaveBeenCalledTimes(2);
  });
});
