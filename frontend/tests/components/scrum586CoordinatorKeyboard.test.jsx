// scrum586CoordinatorKeyboard.test.jsx
//
// The Event Coordinator's screens by keyboard alone: opening an event from a
// list, opening and leaving each page the event screen swaps in, and each step
// that replaces its own button, leave focus on something named rather than the
// page body. No screen asks through the browser's own dialogs. Services are
// mocked. jsdom does not lay pages out, so the 360px rules are read from the
// stylesheets as text.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import CoordinatorRequestDetail from "../../src/components/CoordinatorRequestDetail.jsx";
import MyAssignedEvents from "../../src/components/MyAssignedEvents.jsx";
import ReviewQueue from "../../src/components/ReviewQueue.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import * as bookingRequestService from "../../src/services/bookingRequestService";
import * as eventEquipmentService from "../../src/services/eventEquipmentService";
import * as eventRegistrationService from "../../src/services/eventRegistrationService";
import * as eventRequestService from "../../src/services/eventRequestService";
import * as flaggedBookingService from "../../src/services/flaggedBookingService";
import * as venueService from "../../src/services/venueService";
import * as venueSuitabilityService from "../../src/services/venueSuitabilityService";
import { chooseDecision } from "../helpers/coordinatorDecision.js";
import { stubDialogElement } from "../helpers/dialog.js";

vi.mock("../../src/auth/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../../src/services/bookingRequestService");
vi.mock("../../src/services/eventEquipmentService");
vi.mock("../../src/services/eventRegistrationService");
vi.mock("../../src/services/eventRequestService");
vi.mock("../../src/services/flaggedBookingService");
vi.mock("../../src/services/venueService");
vi.mock("../../src/services/venueSuitabilityService");

// The completion page confirms in a ConfirmDialog.
stubDialogElement();

const MOCKED_SERVICES = [
  bookingRequestService,
  eventEquipmentService,
  eventRegistrationService,
  eventRequestService,
  flaggedBookingService,
  venueService,
  venueSuitabilityService,
];

const HOLDER = { id: "44444444-4444-4444-8444-444444444444", role: "event_coordinator" };
const LEAD = { id: "77777777-7777-4777-8777-777777777777", role: "event_coordinator_lead" };
const NAME = "IS212 Industry Night";
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

const GROUPS = {
  submitted: "AWAITING_REVIEW",
  under_review: "UNDER_REVIEW",
  pending_clarification: "ACTION_REQUIRED",
  approved: "APPROVED",
  confirmed: "CONFIRMED",
  completed: "COMPLETED",
  cancelled: "CANCELLED",
};

function eventRequest(status, overrides = {}) {
  return {
    id: "e1",
    organiserId: "11111111-1111-4111-8111-111111111111",
    organiserName: "Olive Organiser",
    eventName: NAME,
    proposedStart: FUTURE,
    proposedEnd: FUTURE,
    expectedAttendance: 120,
    status,
    assignedCoordinatorId: HOLDER.id,
    reviewingCoordinatorId: status === "under_review" ? HOLDER.id : null,
    submittedAt: "2026-01-02T01:00:00Z",
    updatedAt: "2026-01-03T01:00:00Z",
    decision: ["approved", "confirmed", "completed"].includes(status) ? "approved" : null,
    statusDisplay: { status, label: status, group: GROUPS[status], description: `Description of ${status}.` },
    ...overrides,
  };
}

function signIn(user) {
  vi.mocked(useAuth).mockReturnValue({ user });
}

function renderDetail(user, request, props = {}) {
  signIn(user);
  render(
    <MemoryRouter>
      <CoordinatorRequestDetail asPage request={request} onChangeRequestProcessed={vi.fn()} onReviewDecisionProcessed={vi.fn()} {...props} />
    </MemoryRouter>,
  );
  return userEvent.setup();
}

async function renderList(List) {
  signIn(HOLDER);
  render(
    <MemoryRouter>
      <List asPage />
    </MemoryRouter>,
  );
  const user = userEvent.setup();
  await screen.findAllByText(NAME);
  return user;
}

/** Presses Enter on a button the way a keyboard user does. */
async function press(user, button) {
  button.focus();
  await user.keyboard("{Enter}");
}

const eventTitle = (level = 1) => screen.getByRole("heading", { level, name: NAME });
const nextStepHeading = () => screen.getByRole("heading", { name: "Next step" });

beforeEach(() => {
  vi.resetAllMocks();
  for (const service of MOCKED_SERVICES) {
    for (const fn of Object.values(service)) if (vi.isMockFunction(fn)) fn.mockResolvedValue([]);
  }
  vi.mocked(eventRequestService.getEventReadiness).mockResolvedValue({ ready: false, items: [] });
  vi.mocked(eventRequestService.getEventCancellationImpact).mockResolvedValue({
    venueBookings: { count: 0, details: [] },
    bookingRequests: { count: 0, details: [] },
    venueHolds: { count: 0, details: [] },
    equipmentRequests: { count: 0, details: [] },
    equipmentReservations: { count: 0, details: [] },
  });
});

describe("SCRUM586 AC7 focus when an event opens from a list and closes", () => {
  it.each([
    ["the_review_queue", ReviewQueue, eventRequestService.getEventRequestQueue, "Review"],
    ["my_events", MyAssignedEvents, eventRequestService.getMyAssignedEvents, "Open"],
  ])("SCRUM586_AC7_opening_an_event_from_%s_moves_focus_to_its_title", async (_name, List, read, opener) => {
    vi.mocked(read).mockResolvedValue([eventRequest("submitted")]);
    const user = await renderList(List);

    await press(user, screen.getByRole("button", { name: opener }));

    expect(eventTitle(2)).toHaveFocus();
  });

  it.each([
    ["the_review_queue", ReviewQueue, eventRequestService.getEventRequestQueue, "Review", /Back to the review queue/],
    ["my_events", MyAssignedEvents, eventRequestService.getMyAssignedEvents, "Open", /Back to my events/],
  ])("SCRUM586_AC7_back_from_%s_returns_focus_to_the_rows_button", async (_name, List, read, opener, back) => {
    vi.mocked(read).mockResolvedValue([eventRequest("submitted", { id: "e0", eventName: "Freshers Welcome" }), eventRequest("submitted")]);
    const user = await renderList(List);
    await press(user, screen.getAllByRole("button", { name: opener })[1]);

    await press(user, screen.getByRole("button", { name: back }));

    await waitFor(() => expect(screen.getAllByRole("button", { name: opener })[1]).toHaveFocus());
  });

  it("SCRUM586_AC7_after_a_return_for_amendment_focus_goes_back_to_the_rows_review_button", async () => {
    vi.mocked(eventRequestService.getEventRequestQueue)
      .mockResolvedValueOnce([eventRequest("under_review")])
      .mockResolvedValueOnce([eventRequest("pending_clarification")]);
    const user = await renderList(ReviewQueue);
    await press(user, screen.getByRole("button", { name: "Review" }));

    await chooseDecision(user, "Return for amendment");
    await user.type(screen.getByLabelText("Note for the Organiser"), "Please add the run sheet.");
    await user.click(screen.getByRole("button", { name: "Return for amendment" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Review" })).toHaveFocus());
  });

  it("SCRUM586_AC7_when_the_row_has_left_the_queue_focus_goes_to_the_list_title", async () => {
    vi.mocked(eventRequestService.getEventRequestQueue)
      .mockResolvedValueOnce([eventRequest("under_review")])
      .mockResolvedValueOnce([]);
    const user = await renderList(ReviewQueue);
    await press(user, screen.getByRole("button", { name: "Review" }));

    await chooseDecision(user, "Return for amendment");
    await user.type(screen.getByLabelText("Note for the Organiser"), "Please add the run sheet.");
    await user.click(screen.getByRole("button", { name: "Return for amendment" }));

    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Review queue" })).toHaveFocus());
  });

  it("SCRUM586_AC7_back_to_a_finished_group_keeps_it_open_with_focus_on_the_rows_open", async () => {
    vi.mocked(eventRequestService.getMyAssignedEvents).mockResolvedValue([eventRequest("completed")]);
    const user = await renderList(MyAssignedEvents);
    const group = screen.getByText("Completed").closest("details");
    await user.click(within(group).getByText("Completed"));
    expect(group).toHaveAttribute("open");
    await press(user, within(group).getByRole("button", { name: "Open" }));

    await press(user, screen.getByRole("button", { name: /Back to my events/ }));

    // Inside a closed <details> the button could not take focus in a browser.
    const reopened = screen.getByText("Completed").closest("details");
    expect(reopened).toHaveAttribute("open");
    await waitFor(() => expect(within(reopened).getByRole("button", { name: "Open" })).toHaveFocus());
  });

  it("SCRUM586_AC7_an_event_listed_twice_returns_focus_to_the_copy_it_was_opened_from", async () => {
    const overdue = eventRequest("pending_clarification", { clarificationReplyByDate: "2020-01-01" });
    vi.mocked(eventRequestService.getMyAssignedEvents).mockResolvedValue([overdue]);
    const user = await renderList(MyAssignedEvents);
    // Once under Needs attention, once in its status group, which comes later.
    const [underNeedsAttention] = screen.getAllByRole("button", { name: "Open" });
    await press(user, underNeedsAttention);

    await press(user, screen.getByRole("button", { name: /Back to my events/ }));

    const needsAttention = screen.getByRole("region", { name: "Needs attention" });
    await waitFor(() => expect(within(needsAttention).getByRole("button", { name: "Open" })).toHaveFocus());
  });
});

// [opener, who, status, the page's title, how to leave it]
const SWAP_IN_PAGES = [
  ["Revise event details", HOLDER, eventRequest("approved"), `Significant change: ${NAME}`, "Back to event"],
  ["Edit event information", HOLDER, eventRequest("approved"), `Edit event information: ${NAME}`, "Back to event"],
  ["Cancel event", HOLDER, eventRequest("approved"), `Cancel ${NAME}`, "Back to event"],
  ["Reject event", HOLDER, eventRequest("approved"), `Reject ${NAME}`, "Back to event"],
  ["Mark as completed", HOLDER, eventRequest("confirmed", { proposedStart: PAST, proposedEnd: PAST }), `Mark ${NAME} as completed`, "Back to event"],
  ["Hand over to another coordinator", LEAD, eventRequest("approved"), `Hand over ${NAME}`, "Back to the event"],
];

describe("SCRUM586 AC2 a page swapped in takes the event title's level", () => {
  it.each(SWAP_IN_PAGES)("SCRUM586_AC2_%s_is_an_h2_when_the_event_sits_under_a_lists_h1", async (opener, who, request, heading) => {
    const user = renderDetail(who, request, { asPage: false });

    await press(user, screen.getByRole("button", { name: opener }));

    expect(await screen.findByRole("heading", { level: 2, name: heading })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
  });

  it.each(SWAP_IN_PAGES)("SCRUM586_AC2_%s_is_the_h1_on_the_events_own_page", async (opener, who, request, heading) => {
    const user = renderDetail(who, request);

    await press(user, screen.getByRole("button", { name: opener }));

    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("SCRUM586_AC2_the_cancellation_page_and_its_record_keep_the_level_under_a_list", async () => {
    vi.mocked(eventRequestService.cancelEventRequest).mockResolvedValue(eventRequest("cancelled"));
    const user = renderDetail(HOLDER, eventRequest("approved"), { asPage: false });
    await press(user, screen.getByRole("button", { name: "Cancel event" }));
    await user.type(screen.getByLabelText("Internal cancellation reason"), "Venue closed.");
    await user.click(screen.getByLabelText("The organiser’s request"));
    await user.click(screen.getByRole("button", { name: "Preview cancellation" }));
    expect(await screen.findByRole("heading", { level: 4, name: "What cancellation will affect" })).toBeInTheDocument();
    await user.click(screen.getByLabelText(/I have reviewed the impact/));
    await user.click(screen.getByRole("button", { name: "Confirm event cancellation" }));

    expect(await screen.findByRole("heading", { level: 2, name: NAME })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Event cancelled" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
  });

  it("SCRUM586_AC2_the_rejection_record_keeps_the_level_under_a_list", async () => {
    vi.mocked(eventRequestService.rejectApprovedEvent).mockResolvedValue(eventRequest("rejected", { decision: "rejected" }));
    const user = renderDetail(HOLDER, eventRequest("approved"), { asPage: false });
    await press(user, screen.getByRole("button", { name: "Reject event" }));
    await user.type(screen.getByLabelText("Reason for rejection"), "No venue.");
    await user.click(screen.getByRole("button", { name: "Reject event" }));

    expect(await screen.findByRole("heading", { level: 2, name: NAME })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Event rejected" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
  });
});

describe("SCRUM586 AC7 focus when a page opens from the event screen and closes", () => {
  it.each(SWAP_IN_PAGES)("SCRUM586_AC7_%s_moves_focus_to_its_pages_title", async (opener, who, request, heading) => {
    const user = renderDetail(who, request);

    await press(user, screen.getByRole("button", { name: opener }));

    expect(await screen.findByRole("heading", { name: heading })).toHaveFocus();
  });

  it.each(SWAP_IN_PAGES)("SCRUM586_AC7_leaving_%s_returns_focus_to_its_opener", async (opener, who, request, _heading, back) => {
    const user = renderDetail(who, request);
    await press(user, screen.getByRole("button", { name: opener }));

    await press(user, await screen.findByRole("button", { name: back }));

    await waitFor(() => expect(screen.getByRole("button", { name: opener })).toHaveFocus());
  });

  it("SCRUM586_AC7_after_a_cancellation_focus_is_on_the_recorded_page_then_on_the_event_title", async () => {
    vi.mocked(eventRequestService.cancelEventRequest).mockResolvedValue(
      eventRequest("cancelled", { cancellationReason: "Venue closed." }),
    );
    const user = renderDetail(HOLDER, eventRequest("approved"));
    await press(user, screen.getByRole("button", { name: "Cancel event" }));

    await user.type(screen.getByLabelText("Internal cancellation reason"), "Venue closed.");
    await user.click(screen.getByLabelText("The organiser’s request"));
    await user.click(screen.getByRole("button", { name: "Preview cancellation" }));
    await user.click(await screen.findByLabelText(/I have reviewed the impact/));
    await user.click(screen.getByRole("button", { name: "Confirm event cancellation" }));

    // The confirm button has gone with the form, so focus moves to the page's title.
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: NAME })).toHaveFocus());
    expect(screen.getByRole("heading", { name: "Event cancelled" })).toBeInTheDocument();

    // A cancelled event has no Cancel event button to return to.
    await press(user, screen.getByRole("button", { name: "Back to event" }));
    await waitFor(() => expect(eventTitle()).toHaveFocus());
    expect(screen.queryByRole("button", { name: "Cancel event" })).not.toBeInTheDocument();
  });

  it("SCRUM586_AC7_after_completing_an_event_focus_is_on_its_title", async () => {
    vi.mocked(eventRequestService.completeEventRequest).mockResolvedValue(eventRequest("completed"));
    const user = renderDetail(HOLDER, eventRequest("confirmed", { proposedStart: PAST, proposedEnd: PAST }));
    await press(user, screen.getByRole("button", { name: "Mark as completed" }));

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Yes, mark as completed" }));

    await waitFor(() => expect(eventTitle()).toHaveFocus());
    expect(screen.queryByRole("button", { name: "Mark as completed" })).not.toBeInTheDocument();
  });

  it("SCRUM586_AC7_after_a_handover_focus_is_back_on_hand_over", async () => {
    vi.mocked(eventRequestService.listCoordinatorWorkload).mockResolvedValue([
      { id: HOLDER.id, fullName: "Hana Holder", activeEvents: 1 },
      { id: "c2", fullName: "Priya Nair", activeEvents: 0 },
    ]);
    vi.mocked(eventRequestService.reassignEventRequest).mockResolvedValue(eventRequest("approved", { assignedCoordinatorId: "c2" }));
    const user = renderDetail(LEAD, eventRequest("approved"));
    await press(user, screen.getByRole("button", { name: "Hand over to another coordinator" }));

    await user.selectOptions(await screen.findByLabelText("Hand over to"), "c2");
    await user.click(screen.getByRole("button", { name: "Confirm handover" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Hand over to another coordinator" })).toHaveFocus());
    expect(screen.getByRole("status")).toHaveTextContent("Handed over to Priya Nair.");
  });
});

describe("SCRUM586 AC7 focus after a step that replaces its own button", () => {
  it("SCRUM586_AC7_after_start_review_focus_is_on_the_next_step_heading", async () => {
    vi.mocked(eventRequestService.startEventReview).mockResolvedValue(eventRequest("under_review"));
    const user = renderDetail(HOLDER, eventRequest("submitted"));

    await press(user, screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => expect(nextStepHeading()).toHaveFocus());
    expect(screen.getByRole("group", { name: "Your decision" })).toBeInTheDocument();
  });

  it("SCRUM586_AC7_after_a_decision_focus_is_on_the_next_step_heading", async () => {
    vi.mocked(eventRequestService.decideEventRequest).mockResolvedValue(eventRequest("approved"));
    const user = renderDetail(HOLDER, eventRequest("under_review"));

    await chooseDecision(user, "Approve request");
    await press(user, screen.getByRole("button", { name: "Approve request" }));

    await waitFor(() => expect(nextStepHeading()).toHaveFocus());
    expect(within(nextStepHeading().closest("section")).getByText("Description of approved.")).toBeInTheDocument();
  });

  it("SCRUM586_AC7_after_closing_a_clarification_on_the_event_page_focus_is_on_the_next_step_heading", async () => {
    vi.mocked(eventRequestService.closeEventClarification).mockResolvedValue(eventRequest("under_review"));
    const onReviewDecisionProcessed = vi.fn();
    const user = renderDetail(HOLDER, eventRequest("pending_clarification"), { onReviewDecisionProcessed });

    await user.type(screen.getByLabelText("Note explaining why you are closing this request"), "Answered by phone.");
    await press(user, screen.getByRole("button", { name: "Close clarification" }));

    await waitFor(() => expect(nextStepHeading()).toHaveFocus());
    expect(onReviewDecisionProcessed).toHaveBeenCalledTimes(1);
  });

  it("SCRUM586_AC7_a_failed_decision_leaves_focus_on_its_button", async () => {
    vi.mocked(eventRequestService.decideEventRequest).mockRejectedValue({ response: { status: 500 } });
    const user = renderDetail(HOLDER, eventRequest("under_review"));

    await chooseDecision(user, "Approve request");
    const submit = screen.getByRole("button", { name: "Approve request" });
    await press(user, submit);

    expect(await screen.findByRole("alert")).toHaveTextContent("The decision could not be recorded.");
    expect(submit).toHaveFocus();
  });

  it("SCRUM586_AC7_opening_the_event_page_by_its_address_leaves_focus_where_it_is", async () => {
    renderDetail(HOLDER, eventRequest("submitted"));
    await screen.findByRole("heading", { name: "Assignment history" });

    expect(document.body).toHaveFocus();
  });
});

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

// Every file this story aligned: the list screens, the event screen, the
// pages it swaps in and the Find a Venue screens.
const SCOPED_FILES = [
  "components/EventCoordinatorDashboard.jsx",
  "components/ReviewQueue.jsx",
  "components/MyAssignedEvents.jsx",
  "components/MyBookingRequests.jsx",
  "components/CoordinatorAttentionList.jsx",
  "components/EventRequestReviewPage.jsx",
  "components/CoordinatorRequestDetail.jsx",
  "components/EventCancellationPanel.jsx",
  "components/EventRejectionPanel.jsx",
  "components/EventCompletionPanel.jsx",
  "components/SignificantEventChangePanel.jsx",
  "components/EventDetailsEditPanel.jsx",
  "components/ReassignEventPanel.jsx",
  "components/EventConfirmationPanel.jsx",
  "components/SafetyCheckSubmissionPanel.jsx",
  "components/ui/Tabs.jsx",
  "components/VenueSearch.jsx",
  "components/EventVenueFinder.jsx",
  "components/BookingRequestPanel.jsx",
  "components/VenueSuitabilityPanel.jsx",
  "components/VenueSuitabilityResult.jsx",
];

/** Calls to the browser's own dialogs, bare or through window, comments left out. */
const BROWSER_DIALOG = /(?:\bwindow\s*\.\s*|(?<![\w.$]))(?:confirm|alert|prompt)\s*\(/;

describe("SCRUM586 AC7 no browser dialogs", () => {
  it.each(SCOPED_FILES)("SCRUM586_AC7_%s_never_calls_a_browser_dialog", (file) => {
    const source = readFileSync(resolve(SRC, file), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

    expect(source).not.toMatch(BROWSER_DIALOG);
  });

  it("SCRUM586_AC7_the_guard_catches_each_form_of_call", () => {
    for (const call of ["window.confirm(x)", "if (confirm('Sure?'))", "alert(message)", "window.prompt('Why?')"]) {
      expect(call).toMatch(BROWSER_DIALOG);
    }
    for (const fine of ["onConfirm()", "handleConfirm(event)", "setAlert(null)", "props.confirm()"]) {
      expect(fine).not.toMatch(BROWSER_DIALOG);
    }
  });
});

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const APP_CSS = stripComments(readFileSync(resolve(SRC, "App.css"), "utf8"));
const UI_CSS = stripComments(readFileSync(resolve(SRC, "components/ui/ui.css"), "utf8"));
/** The body of each rule for this selector, at any nesting, joined. */
const rulesFor = (selector, css) =>
  [...css.matchAll(new RegExp(`(?:^|[},])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, "gm"))]
    .map((match) => match[1])
    .join(";");
/** The rules inside every `@media (max-width: 720px)` block, joined. */
const narrowRules = (css) => [...css.matchAll(/@media \(max-width: 720px\) \{([\s\S]*?)\n\}/g)].map((match) => match[1]).join("\n");

describe("SCRUM586 AC8 the 360px rules", () => {
  it("SCRUM586_AC8_the_tabs_stay_on_one_line_and_scroll_inside_their_strip", () => {
    const list = rulesFor(".ui-tabs__list", narrowRules(UI_CSS));
    expect(list).toMatch(/flex-wrap:\s*nowrap/);
    expect(list).toMatch(/overflow-x:\s*auto/);
    expect(rulesFor(".ui-tabs__tab.ui-tabs__tab", narrowRules(UI_CSS))).toMatch(/flex:\s*none/);
  });

  it.each([".review-queue__title", ".my-assigned-events__summary", ".my-booking-requests__summary", ".coordinator-attention__summary", ".dashboard--coordinator .reassign-event > :is(h1, h2)"])(
    "SCRUM586_AC8_long_names_wrap_in_%s",
    (selector) => {
      const rule = rulesFor(selector, APP_CSS);
      expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
      expect(rule).toMatch(/min-width:\s*0/);
    },
  );

  it("SCRUM586_AC8_the_stepper_keeps_each_dot_beside_its_label", () => {
    // .dashboard li turns every row into a column at phone width.
    expect(rulesFor(".dashboard li", narrowRules(APP_CSS))).toMatch(/flex-direction:\s*column/);
    const step = rulesFor(".coordinator-request-detail .coordinator-request-detail__stepper > li.coordinator-request-detail__step", APP_CSS);
    expect(step).toMatch(/flex-direction:\s*row/);
    expect(step).toMatch(/justify-content:\s*flex-start/);
  });

  it("SCRUM586_AC8_controls_on_these_screens_are_44px_targets_at_phone_width", () => {
    const narrow = narrowRules(APP_CSS);
    const targets = narrow.split("\n").find((line) => line.includes(":is(button, select, summary"));
    expect(targets).toBeDefined();
    for (const screenClass of [".review-queue", ".my-assigned-events", ".my-booking-requests", ".coordinator-attention", ".coordinator-request-detail", ".event-cancellation-page", ".event-completion-page", ".event-significant-change-page", ".event-details-edit-page", ".reassign-event"]) {
      expect(targets).toContain(screenClass);
    }
    expect(targets).toMatch(/min-height:\s*44px/);
    expect(narrow).toMatch(/label:has\(> input:is\(\[type="checkbox"\], \[type="radio"\]\)\) \{[^}]*min-height:\s*44px/);
  });

  it("SCRUM586_AC8_the_handover_form_and_the_confirm_dialog_fit_the_width", () => {
    expect(rulesFor(".dashboard--coordinator .reassign-event__form label", APP_CSS)).toMatch(/min-width:\s*0/);
    expect(rulesFor(".dashboard--coordinator .reassign-event__form select", APP_CSS)).toMatch(/min-width:\s*0/);
    expect(rulesFor(".dashboard--coordinator .ui-confirm-dialog .ui-confirm-dialog__actions", narrowRules(APP_CSS))).toMatch(/flex-wrap:\s*wrap/);
  });

  it("SCRUM586_AC8_find_a_venue_controls_are_44px_targets_at_phone_width", () => {
    const narrow = narrowRules(APP_CSS);
    // /venue-search sits outside the coordinator's dashboard wrapper, so it has rules of its own.
    expect(rulesFor(".venue-search :is(button, select, input:not([type=\"checkbox\"], [type=\"radio\"]))", narrow)).toMatch(/min-height:\s*44px/);
    expect(rulesFor(".venue-search :is(.venue-search__calendar-link, .venue-search__context > .ui-button--link)", narrow)).toMatch(/min-height:\s*44px/);
    const checkboxRows = narrow.split("\n").filter((line) => line.includes('label:has(> input') && /min-height:\s*44px/.test(line)).join("\n");
    for (const group of [".event-venue-finder__group", ".booking-request__warning", ".venue-search__retired"]) {
      expect(checkboxRows).toContain(group);
    }
  });

  it("SCRUM586_AC8_find_a_venue_rows_and_panels_fit_the_width", () => {
    for (const selector of [".venue-search__results li", ".booking-request", ".venue-suitability-panel"]) {
      expect(rulesFor(selector, APP_CSS)).toMatch(/overflow-wrap:\s*anywhere/);
    }
    const narrow = narrowRules(APP_CSS);
    expect(rulesFor(".booking-request__details", narrow)).toMatch(/grid-template-columns:\s*1fr/);
    expect(rulesFor(".venue-search__window", narrow)).toMatch(/grid-template-columns:\s*1fr/);
    expect(rulesFor(".dashboard--coordinator .coordinator-request-detail .event-venue-finder__result-row", narrow)).toMatch(/grid-template-columns:\s*1fr/);
  });

  it("SCRUM586_AC8_the_list_screen_sections_carry_the_class_the_rules_target", async () => {
    vi.mocked(eventRequestService.getEventRequestQueue).mockResolvedValue([eventRequest("submitted")]);
    await renderList(ReviewQueue);

    expect(screen.getByRole("heading", { level: 1, name: "Review queue" }).closest("section")).toHaveClass("review-queue");
  });
});
