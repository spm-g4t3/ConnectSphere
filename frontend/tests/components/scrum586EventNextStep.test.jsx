// scrum586EventNextStep.test.jsx
//
// The event screen says what happens now in a "Next step" card, the first thing
// in its main column, and shows where the event stands in a progress stepper at
// the top of the "Event facts" rail. The header keeps only the event's identity
// and the action openers, as shared Buttons. A review is decided by choosing one
// of three radio cards, then one submit button named and coloured after the
// choice, which sends exactly what the old per-outcome button sent. The Lead
// sees the same card and stepper. Every service is mocked.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

import CoordinatorRequestDetail from "../../src/components/CoordinatorRequestDetail.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import * as bookingRequestService from "../../src/services/bookingRequestService";
import * as eventEquipmentService from "../../src/services/eventEquipmentService";
import * as eventRegistrationService from "../../src/services/eventRegistrationService";
import * as eventRequestService from "../../src/services/eventRequestService";
import * as flaggedBookingService from "../../src/services/flaggedBookingService";
import * as venueService from "../../src/services/venueService";
import * as venueSuitabilityService from "../../src/services/venueSuitabilityService";
import { chooseDecision, decide } from "../helpers/coordinatorDecision.js";

vi.mock("../../src/auth/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../../src/services/bookingRequestService");
vi.mock("../../src/services/eventEquipmentService");
vi.mock("../../src/services/eventRegistrationService");
vi.mock("../../src/services/eventRequestService");
vi.mock("../../src/services/flaggedBookingService");
vi.mock("../../src/services/venueService");
vi.mock("../../src/services/venueSuitabilityService");

const MOCKED_SERVICES = [
  bookingRequestService,
  eventEquipmentService,
  eventRegistrationService,
  eventRequestService,
  flaggedBookingService,
  venueService,
  venueSuitabilityService,
];

const ID = "22222222-2222-4222-8222-222222222222";
const HOLDER = { id: "44444444-4444-4444-8444-444444444444", role: "event_coordinator" };
const LEAD = { id: "77777777-7777-4777-8777-777777777777", role: "event_coordinator_lead" };
const future = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

function eventRequest(status, overrides = {}) {
  return {
    id: ID,
    organiserId: "11111111-1111-4111-8111-111111111111",
    organiserName: "Olive Organiser",
    eventName: "IS212 Industry Night",
    purpose: "Connect students with industry.",
    proposedStart: future(),
    proposedEnd: future(),
    expectedAttendance: 120,
    status,
    assignedCoordinatorId: HOLDER.id,
    reviewingCoordinatorId: status === "under_review" ? HOLDER.id : null,
    submittedAt: "2026-01-02T01:00:00Z",
    decision: ["approved", "safety_review", "safety_approved", "confirmed", "completed"].includes(status) ? "approved" : null,
    statusDisplay: { status, label: status, group: "UNDER_REVIEW", description: `Description of ${status}.` },
    ...overrides,
  };
}

function renderDetail(user, request) {
  vi.mocked(useAuth).mockReturnValue({ user });
  return render(
    <MemoryRouter>
      <CoordinatorRequestDetail request={request} asPage onChangeRequestProcessed={vi.fn()} onReviewDecisionProcessed={vi.fn()} />
    </MemoryRouter>,
  );
}

const nextStep = () => screen.getByRole("region", { name: "Next step" });
const header = () => screen.getByRole("heading", { level: 1, name: "IS212 Industry Night" }).closest("header");
const stepper = () => within(screen.getByRole("complementary", { name: "Event facts" })).getByRole("list", { name: "Progress" });

/** Each step's visible label, with "(done)" for a finished one, and which is current. */
function readStepper() {
  const items = within(stepper()).getAllByRole("listitem");
  return {
    steps: items.map((item) => item.textContent.trim()),
    current: items.filter((item) => item.getAttribute("aria-current") === "step").map((item) => item.textContent),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  for (const service of MOCKED_SERVICES) {
    for (const fn of Object.values(service)) if (vi.isMockFunction(fn)) fn.mockResolvedValue([]);
  }
  vi.mocked(eventRequestService.getEventReadiness).mockResolvedValue({ ready: false, items: [] });
});

describe("SCRUM586_AC2 the Next step card", () => {
  it("SCRUM586_AC2_the_card_comes_first_in_the_main_column_and_holds_the_status_description", () => {
    renderDetail(HOLDER, eventRequest("submitted"));

    const card = nextStep();
    expect(card.parentElement).toHaveClass("coordinator-request-detail__main");
    expect(card.parentElement.firstElementChild).toBe(card);
    expect(within(card).getByRole("heading", { level: 2, name: "Next step" })).toBeInTheDocument();
    expect(within(card).getByText("Description of submitted.")).toBeInTheDocument();
    // The header keeps only identity and openers.
    expect(header()).not.toHaveTextContent("Description of submitted.");
  });

  it.each([
    ["submitted, the holder", HOLDER, "submitted", (card) => within(card).getByRole("button", { name: "Start review" })],
    ["submitted, the Lead", LEAD, "submitted", (card) => within(card).getByText("Waiting for the assigned coordinator to start the review.")],
    ["under review, the holder", HOLDER, "under_review", (card) => within(card).getByRole("group", { name: "Your decision" })],
    ["under review, the Lead", LEAD, "under_review", (card) => within(card).getByText("Only the assigned coordinator can decide this request.")],
    ["pending clarification, the holder", HOLDER, "pending_clarification", (card) => within(card).getByRole("button", { name: "Close clarification" })],
    ["pending clarification, the Lead", LEAD, "pending_clarification", (card) => within(card).getByRole("heading", { name: "Waiting for organiser reply" })],
    ["approved, the holder", HOLDER, "approved", (card) => within(card).getByRole("heading", { level: 3, name: "Submit for the safety check" })],
    ["safety approved, the holder", HOLDER, "safety_approved", (card) => within(card).getByRole("heading", { level: 3, name: "Confirm Event" })],
  ])("SCRUM586_AC2_the_card_shows_what_happens_now (%s)", (_name, user, status, find) => {
    renderDetail(user, eventRequest(status));

    expect(find(nextStep())).toBeInTheDocument();
  });

  it("SCRUM586_AC2_a_confirmed_event_not_yet_ended_says_when_it_can_be_completed_in_the_card", () => {
    renderDetail(HOLDER, eventRequest("confirmed"));

    expect(within(nextStep()).getByText(/You can mark this event as completed once it has ended/)).toBeInTheDocument();
  });

  it("SCRUM586_AC2_a_decided_event_shows_its_decision_below_the_card_not_in_it", () => {
    renderDetail(HOLDER, eventRequest("rejected", { decision: "rejected", decisionNote: "Too large." }));

    const decision = screen.getByRole("heading", { name: "Decision", hidden: true });
    expect(nextStep()).not.toContainElement(decision);
    expect(nextStep().compareDocumentPosition(decision) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("SCRUM586_AC2_no_card_is_drawn_when_it_would_be_empty", () => {
    renderDetail(LEAD, eventRequest("cancelled", {
      decision: "approved",
      statusDisplay: { status: "cancelled", label: "Cancelled", group: "CANCELLED", description: "" },
    }));

    expect(screen.queryByRole("region", { name: "Next step" })).not.toBeInTheDocument();
  });
});

describe("SCRUM586_AC2 the progress stepper", () => {
  it.each([
    ["submitted", ["Submitted", "Under review", "Approved", "Safety check", "Confirmed", "Completed"], "Submitted"],
    ["under_review", ["Submitted (done)", "Under review", "Approved", "Safety check", "Confirmed", "Completed"], "Under review"],
    ["pending_clarification", ["Submitted (done)", "Under review: waiting for the organiser", "Approved", "Safety check", "Confirmed", "Completed"], "Under review: waiting for the organiser"],
    ["approved", ["Submitted (done)", "Under review (done)", "Approved", "Safety check", "Confirmed", "Completed"], "Approved"],
    ["safety_review", ["Submitted (done)", "Under review (done)", "Approved (done)", "Safety check", "Confirmed", "Completed"], "Safety check"],
    ["safety_approved", ["Submitted (done)", "Under review (done)", "Approved (done)", "Safety check", "Confirmed", "Completed"], "Safety check"],
    ["confirmed", ["Submitted (done)", "Under review (done)", "Approved (done)", "Safety check (done)", "Confirmed", "Completed"], "Confirmed"],
    ["completed", ["Submitted (done)", "Under review (done)", "Approved (done)", "Safety check (done)", "Confirmed (done)", "Completed"], "Completed"],
    ["rejected", ["Submitted (done)", "Under review (done)", "Rejected"], "Rejected"],
    ["cancelled", ["Submitted (done)", "Cancelled"], "Cancelled"],
  ])("SCRUM586_AC2_the_stepper_marks_the_current_step (%s)", (status, steps, current) => {
    renderDetail(HOLDER, eventRequest(status));

    expect(readStepper()).toEqual({ steps, current: [current] });
  });

  it("SCRUM586_AC2_an_unknown_status_marks_no_step_and_does_not_crash", () => {
    renderDetail(HOLDER, eventRequest("postponed"));

    expect(readStepper()).toEqual({
      steps: ["Submitted", "Under review", "Approved", "Safety check", "Confirmed", "Completed"],
      current: [],
    });
  });

  it("SCRUM586_AC2_the_lead_sees_the_same_card_and_stepper", () => {
    renderDetail(LEAD, eventRequest("pending_clarification"));

    expect(within(nextStep()).getByText("Description of pending_clarification.")).toBeInTheDocument();
    expect(within(nextStep()).queryByRole("button", { name: "Close clarification" })).not.toBeInTheDocument();
    expect(readStepper().current).toEqual(["Under review: waiting for the organiser"]);
  });
});

describe("SCRUM586_AC3 shared components", () => {
  it.each(["approved", "confirmed"])("SCRUM586_AC3_every_button_in_the_header_is_a_shared_button (%s)", (status) => {
    renderDetail(HOLDER, eventRequest(status, { proposedEnd: "2026-01-15T03:00:00Z" }));

    const buttons = within(header()).getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button).toHaveClass("ui-button");
  });

  it.each(["submitted", "under_review"])("SCRUM586_AC3_every_button_in_the_next_step_card_is_a_shared_button (%s)", async (status) => {
    renderDetail(HOLDER, eventRequest(status));

    const buttons = within(nextStep()).getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button).toHaveClass("ui-button");
  });

  it("SCRUM586_AC3_close_clarification_is_a_shared_button", () => {
    renderDetail(HOLDER, eventRequest("pending_clarification"));

    expect(within(nextStep()).getByRole("button", { name: "Close clarification" })).toHaveClass("ui-button", "ui-button--primary");
  });
});

describe("SCRUM586_AC5 button variants", () => {
  it("SCRUM586_AC5_the_openers_are_secondary", () => {
    renderDetail(HOLDER, eventRequest("approved"));

    for (const name of ["Revise event details", "Edit event information", "Cancel event", "Reject event"]) {
      expect(within(header()).getByRole("button", { name })).toHaveClass("ui-button--secondary");
    }
  });

  it("SCRUM586_AC5_mark_as_completed_is_primary", () => {
    renderDetail(HOLDER, eventRequest("confirmed", { proposedEnd: "2026-01-15T03:00:00Z" }));

    expect(within(header()).getByRole("button", { name: "Mark as completed" })).toHaveClass("ui-button--primary");
  });

  it("SCRUM586_AC5_start_review_is_primary", () => {
    renderDetail(HOLDER, eventRequest("submitted"));

    expect(within(nextStep()).getByRole("button", { name: "Start review" })).toHaveClass("ui-button--primary");
  });

  it.each([
    ["Approve request", "ui-button--primary"],
    ["Reject request", "ui-button--danger"],
    ["Return for amendment", "ui-button--primary"],
  ])("SCRUM586_AC5_the_submit_is_named_and_coloured_after_the_choice (%s)", async (name, variant) => {
    const user = userEvent.setup();
    renderDetail(HOLDER, eventRequest("under_review"));

    await chooseDecision(user, name);

    const submit = within(nextStep()).getByRole("button", { name });
    expect(submit).toHaveClass(variant);
    expect(submit).toBeEnabled();
  });
});

describe("SCRUM586_AC5 deciding with the radio cards", () => {
  const NOTE = "Numbers look right.";

  it("SCRUM586_AC5_nothing_is_chosen_at_first_and_submit_is_disabled", async () => {
    const user = userEvent.setup();
    renderDetail(HOLDER, eventRequest("under_review"));

    for (const radio of within(nextStep()).getAllByRole("radio")) expect(radio).not.toBeChecked();
    const submit = within(nextStep()).getByRole("button", { name: "Submit decision" });
    expect(submit).toBeDisabled();
    await user.click(submit);

    expect(eventRequestService.decideEventRequest).not.toHaveBeenCalled();
    expect(eventRequestService.requestEventClarification).not.toHaveBeenCalled();
  });

  it("SCRUM586_AC5_each_choice_is_a_labelled_radio_with_its_hint", () => {
    renderDetail(HOLDER, eventRequest("under_review"));

    const approve = within(nextStep()).getByRole("radio", { name: "Approve" });
    expect(approve.closest("label")).not.toBeNull();
    expect(approve).toHaveAccessibleDescription("Accept the request. The note is optional.");
    expect(within(nextStep()).getByRole("radio", { name: "Reject" })).toBeInTheDocument();
    expect(within(nextStep()).getByRole("radio", { name: "Return for amendment" })).toBeInTheDocument();
  });

  it.each([
    ["Approve request", "approved"],
    ["Reject request", "rejected"],
  ])("SCRUM586_AC5_%s_sends_the_same_decision_as_before", async (name, decision) => {
    vi.mocked(eventRequestService.decideEventRequest).mockResolvedValue(eventRequest(decision, { decision }));
    const user = userEvent.setup();
    renderDetail(HOLDER, eventRequest("under_review"));

    await user.type(within(nextStep()).getByLabelText("Note for the Organiser"), NOTE);
    await decide(user, name);

    await waitFor(() => expect(eventRequestService.decideEventRequest).toHaveBeenCalledWith(ID, { decision, decisionNote: NOTE }));
    expect(eventRequestService.requestEventClarification).not.toHaveBeenCalled();
  });

  it("SCRUM586_AC5_return_for_amendment_sends_the_note_fields_and_reply_by_date", async () => {
    vi.mocked(eventRequestService.requestEventClarification).mockResolvedValue(eventRequest("pending_clarification"));
    const user = userEvent.setup();
    renderDetail(HOLDER, eventRequest("under_review"));

    await chooseDecision(user, "Return for amendment");
    await user.type(within(nextStep()).getByLabelText("Note for the Organiser"), NOTE);
    await user.click(within(nextStep()).getByRole("checkbox", { name: "Purpose" }));
    fireEvent.change(within(nextStep()).getByLabelText("Optional reply-by date"), { target: { value: "2099-01-31" } });
    await user.click(within(nextStep()).getByRole("button", { name: "Return for amendment" }));

    await waitFor(() => expect(eventRequestService.requestEventClarification).toHaveBeenCalledWith(ID, NOTE, "2099-01-31", ["purpose"]));
    expect(eventRequestService.decideEventRequest).not.toHaveBeenCalled();
  });

  it("SCRUM586_AC5_the_amendment_fields_and_reply_by_date_show_only_for_a_return", async () => {
    const user = userEvent.setup();
    renderDetail(HOLDER, eventRequest("under_review"));

    expect(screen.queryByLabelText("Optional reply-by date")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Fields that need changing" })).not.toBeInTheDocument();
    await chooseDecision(user, "Return for amendment");
    expect(screen.getByLabelText("Optional reply-by date")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Fields that need changing" })).toBeInTheDocument();
    await chooseDecision(user, "Approve request");
    expect(screen.queryByLabelText("Optional reply-by date")).not.toBeInTheDocument();
  });

  it("SCRUM586_AC5_a_rejection_without_a_reason_is_still_refused_before_the_call", async () => {
    const user = userEvent.setup();
    renderDetail(HOLDER, eventRequest("under_review"));

    await decide(user, "Reject request");

    expect(await within(nextStep()).findByRole("alert")).toHaveTextContent("Add a reason before rejecting this request.");
    expect(eventRequestService.decideEventRequest).not.toHaveBeenCalled();
  });

  it("SCRUM586_AC5_the_submit_says_saving_while_the_decision_is_sent", async () => {
    vi.mocked(eventRequestService.decideEventRequest).mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    renderDetail(HOLDER, eventRequest("under_review"));

    await decide(user, "Approve request");

    expect(within(nextStep()).getByRole("button", { name: "Saving..." })).toBeDisabled();
  });
});
