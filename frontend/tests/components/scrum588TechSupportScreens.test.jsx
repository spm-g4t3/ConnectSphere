// scrum588TechSupportScreens.test.jsx
//
// The UI standard on the Technical Support screens: one h1 per page with sections
// at h2 and no skipped heading level, the shared Button in place of each screen's
// own button classes, and StatusBadge for request and reservation statuses.
// Services are mocked.

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
import { getEquipmentReview } from "../../src/services/equipmentReviewService";
import * as equipment from "../../src/services/equipmentService";
import * as availability from "../../src/services/equipmentAvailabilityService";
import { renderAppAt } from "../helpers/renderApp.js";
import { httpError } from "../helpers/async.js";

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
// The inbox's own headings are covered by scrum584SharedScreenHeadings.
vi.mock("../../src/components/NotificationInbox", () => ({ default: () => null }));

const OLD_CLASSES = ["er-btn", "equipment-queue__status", "equipment-review__status", "availability-reservations__flag", "er-pill"];
// Tabs, quantity steppers and the line's open/close toggle are controls, not actions.
const NOT_ACTION_BUTTONS = ["er-tab", "er-stepper__btn", "er-line__toggle"];

const STATUSES = [
  ["pending_review", "Pending review", "warning"],
  ["under_review", "Under review", "info"],
  ["arranged", "Arranged", "success"],
  ["cannot_be_fully_arranged", "Cannot be fully arranged", "danger"],
  ["cancelled", "Cancelled", "neutral"],
];

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
  statuses: STATUSES.map(([value, label]) => ({ value, label })),
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

const reservation = (overrides = {}) => ({
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  quantity: 2,
  startAt: "2026-11-01T10:00:00Z",
  endAt: "2026-11-01T12:00:00Z",
  flagged: false,
  flagReason: null,
  flaggedAt: null,
  canKeep: false,
  ...overrides,
});
function line(reservations = [reservation()]) {
  const reserved = reservations.reduce((sum, r) => sum + r.quantity, 0);
  return {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
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
    availability: null,
    reservations,
  };
}
const flaggedLine = () => line([reservation({ flagged: true, flagReason: "The event date or time changed", canKeep: true })]);
const reviewState = ({ status = "under_review", statusLabel = "Under review", lines = [line()] } = {}) => ({
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
    reviewerName: "Sam Lee",
    reviewStartedAt: status === "under_review" ? "2026-10-10T09:00:00Z" : null,
    lines,
  },
});

const projector = {
  id: "p1", name: "Projector (HD)", description: "4000 lumens", category: "Display", location: "Store room 1",
  totalQuantity: 8, damagedQuantity: 1, underMaintenanceQuantity: 1, usableQuantity: 6, retiredAt: null,
};
const legacy = {
  id: "o1", name: "Overhead projector", description: null, category: null, location: null,
  totalQuantity: 2, damagedQuantity: 0, underMaintenanceQuantity: 0, usableQuantity: 2,
  retiredAt: "2026-10-01T09:00:00+00:00",
};
const affected = (overrides = {}) => ({
  reservationId: "11111111-1111-4111-8111-111111111111", eventRequestId: "e1", eventName: "Open Day",
  equipmentLineId: "l1", quantity: 3, startAt: "2026-11-05T01:00:00+00:00", endAt: "2026-11-05T05:00:00+00:00",
  coordinatorId: "c1", coordinatorName: "Cara Coordinator", flagged: false, reservedAt: "2026-10-01T00:00:00+00:00",
  ...overrides,
});
const nothingAffected = { usableBefore: 6, usableAfter: 5, affectedCount: 0, affectedUnits: 0, affected: [] };

const answer = (overrides = {}) => ({
  result: "Fully available",
  quantityRequested: 4,
  quantityAvailable: 6,
  message: null,
  breakdown: { total: 10, damaged: 1, underMaintenance: 1, damagedOrUnderMaintenance: 2, reserved: 2, available: 6 },
  reservations: [],
  ...overrides,
});

function renderReview() {
  return render(
    <MemoryRouter initialEntries={[`/equipment-review/${EVENT_ID}`]}>
      <Routes>
        <Route path="/equipment-review/:eventId" element={<EquipmentReview />} />
      </Routes>
    </MemoryRouter>,
  );
}
async function openReview(state) {
  vi.mocked(getEquipmentReview).mockResolvedValue(state);
  const view = renderReview();
  await screen.findByRole("heading", { name: "Hack Night" });
  return view;
}
async function openCatalogue() {
  const view = render(<EquipmentCatalogue />);
  await screen.findByText("Projector (HD)");
  return view;
}
async function checkAvailability(user, result) {
  vi.mocked(availability.checkEquipmentAvailability).mockResolvedValue(result);
  const view = render(<EquipmentAvailabilityCheck />);
  await screen.findByRole("option", { name: "Projector (HD)" });
  await user.selectOptions(screen.getByLabelText("Equipment type"), "p1");
  await user.type(screen.getByLabelText("Quantity"), "4");
  fireEvent.change(screen.getByLabelText("Start"), { target: { value: "2026-12-01T10:00" } });
  fireEvent.change(screen.getByLabelText("End"), { target: { value: "2026-12-01T12:00" } });
  await user.click(screen.getByRole("button", { name: "Check availability" }));
  await screen.findByRole("heading", { name: result.result });
  return view;
}

// One h1 named as given, the h2s in order, and no heading more than one level below the one before it.
function expectOutline(container, h1, h2s) {
  const headings = [...container.querySelectorAll("h1, h2, h3, h4, h5, h6")];
  const level = (h) => Number(h.tagName[1]);
  expect(headings.filter((h) => level(h) === 1).map((h) => h.textContent)).toEqual([h1]);
  expect(headings.filter((h) => level(h) === 2).map((h) => h.textContent)).toEqual(h2s);
  const skips = headings
    .map((h, i) => (i === 0 ? level(h) - 1 : level(h) - level(headings[i - 1])) > 1 && `${h.tagName} ${h.textContent}`)
    .filter(Boolean);
  expect(skips).toEqual([]);
}
function expectButton(name, variant) {
  expect(screen.getByRole("button", { name })).toHaveClass("ui-button", `ui-button--${variant}`);
}
function expectBadge(text, tone, scope = screen) {
  expect(scope.getByText(text, { selector: ".ui-status-badge" })).toHaveClass(`ui-status-badge--${tone}`);
}
// Every action is the shared Button, and none of the screen's own status or button classes remain.
function expectStandardMarkup(container) {
  const own = [...container.querySelectorAll("button:not(.ui-button)")].filter(
    (button) => !NOT_ACTION_BUTTONS.some((name) => button.classList.contains(name)),
  );
  expect(own.map((button) => button.textContent)).toEqual([]);
  for (const name of OLD_CLASSES) expect(container.innerHTML).not.toContain(name);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(useAuth).mockReturnValue({ user: { id: ME, name: "Sam", role: "technical_support_staff" } });
  vi.mocked(getEquipmentQueue).mockResolvedValue(queue([queueRow()]));
  vi.mocked(getReviewedByMe).mockResolvedValue({ requests: [reviewedRow()], total: 1, truncated: false });
  vi.mocked(equipment.listEquipment).mockResolvedValue([projector, legacy]);
  vi.mocked(equipment.previewEquipmentChange).mockResolvedValue(nothingAffected);
  vi.mocked(availability.listActiveEquipmentTypes).mockResolvedValue([{ id: "p1", name: "Projector (HD)" }]);
});

describe("SCRUM588 AC2 one h1 per Technical Support screen, sections at h2", () => {
  it("SCRUM588_AC2_dashboard_has_one_h1_and_the_lists_at_h2", async () => {
    const { container } = render(<TechnicalSupportDashboard user={{ name: "Sam" }} />, { wrapper: MemoryRouter });

    await screen.findAllByText("Annual Dinner");
    expectOutline(container, "Welcome, Sam", ["Needs action (1)", "Equipment requests", "Reviewed by me"]);
  });

  it("SCRUM588_AC2_equipment_page_has_one_h1_and_the_lists_at_h2", async () => {
    renderAppAt("/equipment", "technical_support_staff");

    await screen.findAllByText("Annual Dinner");
    expectOutline(document.querySelector(".dashboard--tech-support"), "Equipment request queue", [
      "Needs action (1)",
      "Equipment requests",
      "Reviewed by me",
    ]);
  });

  it("SCRUM588_AC2_review_screen_nests_lines_and_reservations_under_its_h2_sections", async () => {
    const { container } = await openReview(reviewState({ lines: [flaggedLine()] }));

    expect(screen.getByRole("heading", { name: "Needs your decision" })).toBeInTheDocument();
    expectOutline(container, "Equipment request review", [
      "Hack Night",
      "Decide on 1 flagged reservation",
      "Equipment requested",
      "Finish review",
    ]);
  });

  it("SCRUM588_AC2_catalogue_list_has_one_h1_and_active_and_retired_at_h2", async () => {
    const { container } = await openCatalogue();

    expectOutline(container, "Equipment catalogue", ["Active equipment", "Retired equipment"]);
  });

  it("SCRUM588_AC2_retire_check_sits_one_level_below_active_equipment", async () => {
    const user = userEvent.setup();
    vi.mocked(equipment.previewEquipmentChange).mockResolvedValue({ ...nothingAffected, affected: [affected()] });
    const { container } = await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Retire Projector (HD)" }));
    await user.click(screen.getByRole("button", { name: "Confirm retire Projector (HD)" }));

    expect(await screen.findByRole("heading", { level: 3, name: "Check before you save" })).toBeInTheDocument();
    expectOutline(container, "Equipment catalogue", ["Active equipment", "Retired equipment"]);
  });

  it.each([
    ["Add equipment type", "Add an equipment type"],
    ["Edit Projector (HD)", "Edit Projector (HD)"],
    ["Damage and maintenance for Projector (HD)", "Damage and maintenance: Projector (HD)"],
    ["History for Projector (HD)", "History: Projector (HD)"],
  ])("SCRUM588_AC2_catalogue_panel_opened_by_%s_is_titled_by_one_h1", async (opener, title) => {
    const user = userEvent.setup();
    vi.mocked(equipment.getEquipmentHistory).mockResolvedValue([]);
    const { container } = await openCatalogue();

    await user.click(screen.getByRole("button", { name: opener }));

    expectOutline(container, title, []);
  });

  it("SCRUM588_AC2_the_check_before_saving_an_edit_is_an_h2_under_the_panel_title", async () => {
    const user = userEvent.setup();
    vi.mocked(equipment.previewEquipmentChange).mockResolvedValue({ ...nothingAffected, affected: [affected()] });
    const { container } = await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Edit Projector (HD)" }));
    await user.clear(screen.getByLabelText("Total quantity"));
    await user.type(screen.getByLabelText("Total quantity"), "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await screen.findByRole("region", { name: /Reservations affected/ });
    expectOutline(container, "Edit Projector (HD)", ["Check before you save"]);
  });

  it("SCRUM588_AC2_availability_check_puts_the_form_and_the_result_at_h2", async () => {
    const user = userEvent.setup();
    const { container } = await checkAvailability(user, answer());

    expectOutline(container, "Check equipment availability", ["Choose equipment and period", "Fully available"]);
  });
});

describe("SCRUM588 AC5 the review screen has one h1 in every state", () => {
  it("SCRUM588_AC5_one_h1_while_loading", () => {
    vi.mocked(getEquipmentReview).mockReturnValue(new Promise(() => {}));
    renderReview();

    expect(screen.getByText("Loading equipment request...")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Equipment request review"]);
  });

  it("SCRUM588_AC5_one_h1_when_loading_fails", async () => {
    vi.mocked(getEquipmentReview).mockRejectedValue(httpError(500));
    renderReview();

    await screen.findByRole("alert");
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Equipment request review"]);
  });

  it("SCRUM588_AC5_one_h1_when_loaded", async () => {
    await openReview(reviewState());

    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Equipment request review"]);
  });
});

describe("SCRUM588 AC3 actions use the shared Button", () => {
  it("SCRUM588_AC3_dashboard_lists_use_no_own_button_or_status_classes", async () => {
    const { container } = render(<TechnicalSupportDashboard user={{ name: "Sam" }} />, { wrapper: MemoryRouter });

    await screen.findAllByText("Annual Dinner");
    expectStandardMarkup(container);
  });

  it("SCRUM588_AC3_list_load_failures_offer_try_again_as_secondary_buttons", async () => {
    vi.mocked(getEquipmentQueue).mockRejectedValue(httpError(500));
    vi.mocked(getReviewedByMe).mockRejectedValue(httpError(500));
    const { container } = render(<TechnicalSupportDashboard user={{ name: "Sam" }} />, { wrapper: MemoryRouter });

    const retries = await screen.findAllByRole("button", { name: "Try again" });
    expect(retries).toHaveLength(2);
    for (const retry of retries) expect(retry).toHaveClass("ui-button", "ui-button--secondary");
    expectStandardMarkup(container);
  });

  it("SCRUM588_AC3_review_start_is_primary_and_refresh_a_link", async () => {
    const { container } = await openReview(reviewState({ status: "pending_review", statusLabel: "Pending review" }));

    expectButton("Start review", "primary");
    expectButton("Refresh", "link");
    expectStandardMarkup(container);
  });

  it("SCRUM588_AC3_review_load_failure_offers_try_again_as_secondary", async () => {
    vi.mocked(getEquipmentReview).mockRejectedValue(httpError(500));
    renderReview();

    expect(await screen.findByRole("button", { name: "Try again" })).toHaveClass("ui-button", "ui-button--secondary");
  });

  it("SCRUM588_AC3_flagged_reservation_choices_are_primary_secondary_and_danger", async () => {
    const { container } = await openReview(reviewState({ lines: [flaggedLine()] }));

    expectButton("Move to new time: Projector", "primary");
    expectButton("Keep old time: Projector", "secondary");
    expectButton("Release all: Projector", "danger");
    expectButton("Complete review", "primary");
    expectStandardMarkup(container);
  });

  it("SCRUM588_AC3_release_form_submits_with_a_danger_button_and_cancel_is_secondary", async () => {
    const user = userEvent.setup();
    const { container } = await openReview(reviewState());

    await user.click(screen.getByRole("button", { name: "Release all: Projector" }));

    expectButton("Release", "danger");
    expectButton("Cancel", "secondary");
    expect(screen.getByRole("button", { name: "Release" })).toHaveAttribute("type", "submit");
    expectStandardMarkup(container);
  });

  it("SCRUM588_AC3_catalogue_actions_use_variants_by_meaning", async () => {
    const user = userEvent.setup();
    const { container } = await openCatalogue();

    expectButton("Add equipment type", "primary");
    expectButton("Edit Projector (HD)", "secondary");
    expectButton("History for Projector (HD)", "secondary");
    expectButton("Reinstate Overhead projector", "secondary");
    expectButton("Retire Projector (HD)", "danger");
    await user.click(screen.getByRole("button", { name: "Retire Projector (HD)" }));
    expectButton("Confirm retire Projector (HD)", "danger");
    expectButton("Cancel retire Projector (HD)", "secondary");
    expectStandardMarkup(container);
  });

  it("SCRUM588_AC3_the_check_before_saving_confirms_with_danger_and_goes_back_with_secondary", async () => {
    const user = userEvent.setup();
    vi.mocked(equipment.previewEquipmentChange).mockResolvedValue({ ...nothingAffected, affected: [affected()] });
    const { container } = await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Edit Projector (HD)" }));
    await user.clear(screen.getByLabelText("Total quantity"));
    await user.type(screen.getByLabelText("Total quantity"), "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await screen.findByRole("region", { name: /Reservations affected/ });
    expectButton("Confirm and flag these reservations", "danger");
    expectButton("Go back", "secondary");
    expect(screen.getByRole("button", { name: /Back to the equipment catalogue/ })).toHaveClass("ui-button--link");
    expectStandardMarkup(container);
  });

  it("SCRUM588_AC3_the_add_form_still_submits_through_its_primary_button", async () => {
    const user = userEvent.setup();
    vi.mocked(equipment.createEquipment).mockResolvedValue({});
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Add equipment type" }));
    await user.type(screen.getByLabelText("Name"), "Cable");
    await user.type(screen.getByLabelText("Total quantity"), "20");
    const submit = screen.getByRole("button", { name: "Add equipment type" });
    expect(submit).toHaveClass("ui-button", "ui-button--primary");
    await user.click(submit);

    expect(equipment.createEquipment).toHaveBeenCalledWith(expect.objectContaining({ name: "Cable", totalQuantity: 20 }));
  });

  it("SCRUM588_AC3_availability_check_submits_with_a_primary_button", async () => {
    const user = userEvent.setup();
    const { container } = await checkAvailability(user, answer());

    expectButton("Check availability", "primary");
    expect(availability.checkEquipmentAvailability).toHaveBeenCalledTimes(1);
    expectStandardMarkup(container);
  });
});

describe("SCRUM588 AC6 statuses use StatusBadge", () => {
  it.each(STATUSES)("SCRUM588_AC6_queue_row_shows_%s_as_a_badge", async (status, label, tone) => {
    vi.mocked(getEquipmentQueue).mockResolvedValue(queue([], [queueRow({ status, statusLabel: label })]));
    render(<EquipmentRequestQueue />, { wrapper: MemoryRouter });

    const row = (await screen.findByText("Annual Dinner")).closest("li");
    expectBadge(label, tone, within(row));
  });

  it.each(STATUSES)("SCRUM588_AC6_reviewed_by_me_row_shows_%s_as_a_badge", async (status, label, tone) => {
    vi.mocked(getReviewedByMe).mockResolvedValue({
      requests: [reviewedRow({ status, statusLabel: label })],
      total: 1,
      truncated: false,
    });
    render(<EquipmentReviewedByMe />, { wrapper: MemoryRouter });

    await screen.findByText("Annual Dinner");
    expectBadge(label, tone);
  });

  it.each(STATUSES)("SCRUM588_AC6_review_header_shows_%s_as_a_badge", async (status, label, tone) => {
    await openReview(reviewState({ status, statusLabel: label }));

    expectBadge(label, tone);
  });

  it("SCRUM588_AC6_a_line_with_a_flagged_reservation_shows_needs_decision_as_a_warning_badge", async () => {
    await openReview(reviewState({ lines: [flaggedLine()] }));

    expectBadge("Needs decision", "warning");
  });

  it("SCRUM588_AC6_a_line_that_cannot_be_provided_shows_not_provided_as_a_danger_badge", async () => {
    await openReview(reviewState({ lines: [{ ...line(), outcome: "cannot_be_provided" }] }));

    expectBadge("Not provided", "danger");
  });

  it("SCRUM588_AC6_overlapping_reservations_show_reserved_and_flagged_badges", async () => {
    const user = userEvent.setup();
    const { container } = await checkAvailability(
      user,
      answer({
        reservations: [
          { id: "r1", eventName: "Graduation", quantity: 2, startAt: "2026-12-01T09:00:00+00:00", endAt: "2026-12-01T11:00:00+00:00", flagged: false },
          { id: "r2", eventName: "AGM", quantity: 1, startAt: "2026-12-01T11:00:00+00:00", endAt: "2026-12-01T13:00:00+00:00", flagged: true },
        ],
      }),
    );

    expectBadge("Reserved", "success", within(screen.getByRole("row", { name: /Graduation/ })));
    expectBadge("Flagged for review", "danger", within(screen.getByRole("row", { name: /AGM/ })));
    expectStandardMarkup(container);
  });

  it("SCRUM588_AC6_an_affected_reservation_already_flagged_shows_a_danger_badge", async () => {
    const user = userEvent.setup();
    vi.mocked(equipment.previewEquipmentChange).mockResolvedValue({
      ...nothingAffected,
      affected: [affected({ flagged: true })],
    });
    await openCatalogue();

    await user.click(screen.getByRole("button", { name: "Edit Projector (HD)" }));
    await user.clear(screen.getByLabelText("Total quantity"));
    await user.type(screen.getByLabelText("Total quantity"), "4");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await screen.findByRole("region", { name: /Reservations affected/ });
    expectBadge("Already flagged", "danger");
  });
});
