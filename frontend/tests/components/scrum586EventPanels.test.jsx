// scrum586EventPanels.test.jsx
//
// The event page's separate panels follow the UI standard: shared buttons with
// danger kept for what ends or releases something, shared badges, standard
// loading, error and date text, and a ConfirmDialog in place of the inline
// "are you sure" step. The service is mocked, so nothing touches the network.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import EventCancellationPanel from "../../src/components/EventCancellationPanel.jsx";
import EventRejectionPanel from "../../src/components/EventRejectionPanel.jsx";
import EventConfirmationPanel from "../../src/components/EventConfirmationPanel.jsx";
import EventCompletionPanel from "../../src/components/EventCompletionPanel.jsx";
import EventDetailsEditPanel from "../../src/components/EventDetailsEditPanel.jsx";
import SignificantEventChangePanel from "../../src/components/SignificantEventChangePanel.jsx";
import SafetyCheckSubmissionPanel from "../../src/components/SafetyCheckSubmissionPanel.jsx";
import NeedsAttentionBadge from "../../src/components/NeedsAttentionBadge.jsx";
import ReadinessChecklist from "../../src/components/ReadinessChecklist.jsx";
import UnassignedRequestCancelPanel from "../../src/components/UnassignedRequestCancelPanel.jsx";
import {
  applySignificantEventChange,
  cancelEventRequest,
  completeEventRequest,
  confirmEventRequest,
  getEventCancellationImpact,
  getEventReadiness,
  previewSignificantEventChange,
  rejectApprovedEvent,
  submitForSafetyReview,
} from "../../src/services/eventRequestService";
import { deferred, httpError } from "../helpers/async.js";
import { stubDialogElement } from "../helpers/dialog.js";

vi.mock("../../src/services/eventRequestService", () => ({
  applySignificantEventChange: vi.fn(),
  cancelEventRequest: vi.fn(),
  completeEventRequest: vi.fn(),
  confirmEventRequest: vi.fn(),
  getEventCancellationImpact: vi.fn(),
  getEventReadiness: vi.fn(),
  getEventRequestForReview: vi.fn(),
  previewSignificantEventChange: vi.fn(),
  rejectApprovedEvent: vi.fn(),
  submitForSafetyReview: vi.fn(),
  updateEventRequestDetails: vi.fn(),
}));

// ConfirmDialog calls showModal and close, which jsdom lacks.
stubDialogElement();

// 01:00Z is 9:00 am in Singapore; a device-zone or device-format helper would
// print something else in a UTC runner.
const NINE_AM = "2026-01-15T01:00:00Z";
const ELEVEN_AM = "2026-01-15T03:00:00Z";
const STANDARD_TIME = "15 Jan 2026, 9:00 am";
const STANDARD_RANGE = "15 Jan 2026, 9:00 am – 11:00 am";

const EVENT = {
  id: "event-1",
  eventName: "IS212 Industry Night",
  status: "confirmed",
  proposedStart: "2030-06-15T01:00:00Z",
  proposedEnd: "2030-06-15T03:00:00Z",
  expectedAttendance: 100,
  venueRequirements: "",
  accessibilityRequirements: "",
  updatedAt: "2030-01-01T00:00:00Z",
};

const READY = {
  eventRequestId: EVENT.id,
  ready: true,
  items: [
    { key: "venue", met: true, detail: "Approved", bookingId: "b1", venueName: "Hall A" },
    { key: "date", met: true, detail: "Starts in the future" },
  ],
};

const IMPACT = {
  venueBookings: {
    count: 1,
    details: [{ id: "b1", venueName: "Hall A", venueLocation: "Level 1", startsAt: NINE_AM, endsAt: ELEVEN_AM }],
  },
  bookingRequests: { count: 0, details: [] },
  venueHolds: { count: 1, details: [{ id: "h1", venueName: "Room 2", expiresAt: NINE_AM }] },
  equipmentRequests: { count: 0, details: [] },
  equipmentReservations: { count: 0, details: [] },
};

const CHANGE_IMPACT = {
  statusBefore: "confirmed",
  statusAfter: "approved",
  venueBookings: [{
    id: "b1",
    venueName: "Hall A",
    startsAt: NINE_AM,
    endsAt: ELEVEN_AM,
    occupiedStartsAt: NINE_AM,
    occupiedEndsAt: ELEVEN_AM,
  }],
  equipmentReservations: [],
  pendingBookingRequests: [],
  registeredAttendeesToNotify: 0,
};

beforeEach(() => {
  vi.resetAllMocks();
  getEventReadiness.mockResolvedValue(READY);
  getEventCancellationImpact.mockResolvedValue(IMPACT);
  cancelEventRequest.mockResolvedValue({ ...EVENT, status: "cancelled" });
  rejectApprovedEvent.mockResolvedValue({ ...EVENT, status: "rejected" });
  confirmEventRequest.mockResolvedValue({ ...EVENT, status: "confirmed" });
  completeEventRequest.mockResolvedValue({ ...EVENT, status: "completed" });
  previewSignificantEventChange.mockResolvedValue(CHANGE_IMPACT);
  applySignificantEventChange.mockResolvedValue(EVENT);
  submitForSafetyReview.mockResolvedValue({ ...EVENT, status: "safety_review" });
});

function expectEveryButtonIsShared() {
  for (const button of screen.getAllByRole("button")) expect(button).toHaveClass("ui-button");
}

function renderCancellation(eventRequest = EVENT) {
  const onCancelled = vi.fn();
  render(<EventCancellationPanel eventRequest={eventRequest} onCancelled={onCancelled} onBack={vi.fn()} />);
  return { user: userEvent.setup(), onCancelled };
}

async function previewCancellation(user) {
  await user.type(screen.getByLabelText("Internal cancellation reason"), "Venue unavailable");
  await user.click(screen.getByLabelText("The organiser’s request"));
  await user.click(screen.getByRole("button", { name: "Preview cancellation" }));
  await screen.findByLabelText("Cancellation impact preview");
}

function renderRejection(eventRequest = { ...EVENT, status: "approved" }) {
  render(
    <EventRejectionPanel eventRequest={eventRequest} onRejected={vi.fn()} onBack={vi.fn()} onCancelInstead={vi.fn()} />,
  );
  return { user: userEvent.setup() };
}

function renderCompletion() {
  const onCompleted = vi.fn();
  render(<EventCompletionPanel eventRequest={EVENT} onCompleted={onCompleted} onBack={vi.fn()} />);
  return { user: userEvent.setup(), onCompleted };
}

function renderSignificantChange() {
  render(<SignificantEventChangePanel eventRequest={EVENT} onBack={vi.fn()} onApplied={vi.fn()} />);
  return { user: userEvent.setup() };
}

async function previewSignificantChange(user) {
  fireEvent.change(screen.getByLabelText("Expected attendance"), { target: { value: "150" } });
  await user.type(screen.getByLabelText("Reason for this change"), "More attendees");
  await user.click(screen.getByRole("button", { name: "Preview significant change" }));
  await screen.findByLabelText("Significant change impact preview");
}

const COMPLETE_TITLE = "Mark IS212 Industry Night as completed?";

describe("SCRUM586_AC3 the event panels use the shared Button and StatusBadge", () => {
  it("SCRUM586_AC3_every_button_on_the_review_step_panels_is_shared", async () => {
    const cancellation = renderCancellation();
    await previewCancellation(cancellation.user);
    expectEveryButtonIsShared();
    cleanup();

    const change = renderSignificantChange();
    await previewSignificantChange(change.user);
    expectEveryButtonIsShared();
  });

  it("SCRUM586_AC3_every_button_on_the_rejection_page_is_shared", async () => {
    rejectApprovedEvent.mockRejectedValue(httpError(409, { error: "Cancel it instead.", code: "CANCEL_INSTEAD" }));
    const rejection = renderRejection();
    await screen.findByText("Every essential arrangement is currently met.");
    await rejection.user.type(screen.getByLabelText("Reason for rejection"), "No venue");
    await rejection.user.click(screen.getByRole("button", { name: "Reject event" }));
    await screen.findByRole("button", { name: "Cancel event instead" });
    expectEveryButtonIsShared();
  });

  it("SCRUM586_AC3_every_button_on_the_confirm_complete_and_safety_check_panels_is_shared", async () => {
    getEventReadiness.mockRejectedValueOnce(httpError(500));
    render(<EventConfirmationPanel eventRequest={EVENT} onConfirmed={vi.fn()} />);
    await screen.findByRole("button", { name: "Try again" });
    expectEveryButtonIsShared();
    cleanup();

    const completion = renderCompletion();
    await completion.user.click(screen.getByRole("button", { name: "Continue" }));
    screen.getByRole("dialog", { name: COMPLETE_TITLE });
    expectEveryButtonIsShared();
    cleanup();

    render(<SafetyCheckSubmissionPanel eventRequest={EVENT} onSubmitted={vi.fn()} />);
    await screen.findByRole("table", { name: "Readiness checklist" });
    expectEveryButtonIsShared();
  });

  it("SCRUM586_AC3_the_edit_details_page_has_a_link_back_and_a_primary_save", () => {
    render(<EventDetailsEditPanel eventRequest={{ ...EVENT, status: "approved" }} onBack={vi.fn()} onSaved={vi.fn()} />);

    expectEveryButtonIsShared();
    expect(screen.getByRole("button", { name: "Back to event" })).toHaveClass("ui-button--link");
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveClass("ui-button--primary");
    expect(document.querySelector(".event-cancellation-page__back")).toBeNull();
  });

  it("SCRUM586_AC3_no_panel_keeps_its_own_back_or_secondary_class", async () => {
    const { user } = renderCompletion();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(document.querySelector(".event-completion-page__back, .event-completion__secondary")).toBeNull();
    cleanup();

    renderCancellation();
    renderRejection();
    renderSignificantChange();
    expect(document.querySelector(".event-cancellation-page__back")).toBeNull();
  });

  it("SCRUM586_AC3_needs_attention_is_a_danger_status_badge", () => {
    render(<NeedsAttentionBadge event={{ needsAttention: true }} />);

    expect(screen.getByText("Needs attention")).toHaveClass("ui-status-badge", "ui-status-badge--danger");
  });

  it("SCRUM586_AC3_needs_attention_shows_nothing_unless_the_server_says_so", () => {
    const { container } = render(<NeedsAttentionBadge event={{ needsAttention: false }} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("SCRUM586_AC3_readiness_checklist_uses_status_badges", () => {
    render(
      <ReadinessChecklist
        caption="Readiness checklist"
        items={[
          { key: "venue", met: true, detail: "Approved", venueName: "Hall A" },
          { key: "equipment", met: false, detail: "Pending review" },
        ]}
      />,
    );

    // Met keeps today's green and Outstanding today's red.
    expect(screen.getByText("Met")).toHaveClass("ui-status-badge", "ui-status-badge--success");
    expect(screen.getByText("Outstanding")).toHaveClass("ui-status-badge", "ui-status-badge--danger");
    expect(document.querySelector(".safety-check-submission__badge")).toBeNull();
  });
});

describe("SCRUM586_AC5 danger only for what ends the event or releases its bookings", () => {
  it("SCRUM586_AC5_the_final_cancel_is_danger_and_sends_after_the_review_without_a_dialog", async () => {
    const { user, onCancelled } = renderCancellation();
    await previewCancellation(user);

    const cancel = screen.getByRole("button", { name: "Confirm event cancellation" });
    expect(cancel).toHaveClass("ui-button--danger");
    expect(screen.getByRole("button", { name: "Refresh impact preview" })).toHaveClass("ui-button--primary");

    // The impact review with its tick is the confirmation: no dialog on top.
    expect(cancel).toBeDisabled();
    await user.click(screen.getByLabelText(/I have reviewed the impact/));
    await user.click(cancel);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(cancelEventRequest).toHaveBeenCalledExactlyOnceWith(EVENT.id, {
      reason: "Venue unavailable",
      initiator: "organiser_request",
      attendeeMessage: undefined,
    });
    await waitFor(() => expect(onCancelled).toHaveBeenCalled());
  });

  it("SCRUM586_AC5_reject_event_is_danger_and_cancel_instead_is_secondary", async () => {
    rejectApprovedEvent.mockRejectedValue(httpError(409, { error: "Cancel it instead.", code: "CANCEL_INSTEAD" }));
    const { user } = renderRejection();
    await user.type(screen.getByLabelText("Reason for rejection"), "No venue");

    const reject = screen.getByRole("button", { name: "Reject event" });
    expect(reject).toHaveClass("ui-button--danger");
    expect(reject).toHaveAttribute("type", "submit");
    await user.click(reject);

    expect(await screen.findByRole("button", { name: "Cancel event instead" })).toHaveClass("ui-button--secondary");
  });

  it("SCRUM586_AC5_confirm_complete_safety_check_and_significant_change_are_primary", async () => {
    render(<EventConfirmationPanel eventRequest={EVENT} onConfirmed={vi.fn()} />);
    const confirm = screen.getByRole("button", { name: "Confirm Event" });
    expect(confirm).toHaveClass("ui-button--primary");
    expect(confirm).toHaveAttribute("type", "submit");
    await waitFor(() => expect(confirm).toBeEnabled());
    cleanup();

    render(<SafetyCheckSubmissionPanel eventRequest={EVENT} onSubmitted={vi.fn()} />);
    const submit = screen.getByRole("button", { name: "Submit for safety check" });
    expect(submit).toHaveClass("ui-button--primary");
    expect(submit).toHaveAttribute("type", "submit");
    await screen.findByRole("table", { name: "Readiness checklist" });
    cleanup();

    const completion = renderCompletion();
    expect(screen.getByRole("button", { name: "Continue" })).toHaveAttribute("type", "submit");
    await completion.user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("button", { name: "Yes, mark as completed" })).toHaveClass("ui-button--primary");
    cleanup();

    const change = renderSignificantChange();
    await previewSignificantChange(change.user);
    expect(screen.getByRole("button", { name: "Confirm significant change" })).toHaveClass("ui-button--primary");
  });

  it("SCRUM586_AC5_back_is_a_link_and_edit_notes_is_secondary", async () => {
    const { user } = renderCompletion();
    expect(screen.getByRole("button", { name: "Back to event" })).toHaveClass("ui-button--link");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("button", { name: "Edit notes" })).toHaveClass("ui-button--secondary");
    cleanup();

    renderCancellation();
    renderCancellation({ ...EVENT, status: "cancelled", cancelledAt: NINE_AM });
    renderRejection();
    renderRejection({ ...EVENT, status: "rejected", decidedAt: NINE_AM });
    renderSignificantChange();
    const backs = screen.getAllByRole("button", { name: "Back to event" });
    expect(backs).toHaveLength(5);
    for (const back of backs) expect(back).toHaveClass("ui-button--link");
  });
});

describe("SCRUM586_AC4 loading, error and date text follow the standard", () => {
  it("SCRUM586_AC4_the_readiness_reads_show_the_standard_loading_text", () => {
    getEventReadiness.mockReturnValue(new Promise(() => {}));

    renderRejection();
    expect(screen.getByRole("status")).toHaveTextContent(/^Loading\.\.\.$/);
    cleanup();

    render(<SafetyCheckSubmissionPanel eventRequest={EVENT} onSubmitted={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(/^Loading\.\.\.$/);
  });

  it("SCRUM586_AC4_outstanding_arrangements_that_fail_to_load_offer_try_again_and_reload", async () => {
    getEventReadiness.mockRejectedValueOnce(httpError(500)).mockResolvedValueOnce({
      ...READY,
      ready: false,
      items: [{ key: "equipment", met: false, detail: "Pending review" }],
    });
    const { user } = renderRejection();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/^The outstanding arrangements could not be loaded\.Try again$/);
    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("table", { name: "Still outstanding" })).toBeInTheDocument();
    expect(getEventReadiness).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    ["the rejection page", () => renderRejection(), "Only the coordinator assigned to this event can reject it."],
    [
      "the confirmation panel",
      () => render(<EventConfirmationPanel eventRequest={EVENT} onConfirmed={vi.fn()} />),
      "Only the assigned Event Coordinator can confirm this event.",
    ],
    [
      "the safety check panel",
      () => render(<SafetyCheckSubmissionPanel eventRequest={EVENT} onSubmitted={vi.fn()} />),
      "The checklist could not be loaded.",
    ],
  ])("SCRUM586_AC4_a_refused_readiness_read_offers_no_try_again (%s)", async (_name, renderPanel, message) => {
    getEventReadiness.mockRejectedValue(httpError(403));
    renderPanel();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(within(alert).queryByRole("button")).not.toBeInTheDocument();
  });

  it.each([
    ["the confirmation panel", () => render(<EventConfirmationPanel eventRequest={EVENT} onConfirmed={vi.fn()} />)],
    ["the safety check panel", () => render(<SafetyCheckSubmissionPanel eventRequest={EVENT} onSubmitted={vi.fn()} />)],
  ])("SCRUM586_AC4_a_checklist_that_fails_to_load_says_so_once_beside_try_again (%s)", async (_name, renderPanel) => {
    getEventReadiness.mockRejectedValue(httpError(500));
    renderPanel();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/checklist could not be loaded\.Try again$/);
    expect(alert).not.toHaveTextContent(/please try again/i);
  });

  it.each([
    [
      "cancel",
      async () => {
        cancelEventRequest.mockRejectedValue(httpError(500));
        const { user } = renderCancellation();
        await previewCancellation(user);
        await user.click(screen.getByLabelText(/I have reviewed the impact/));
        await user.click(screen.getByRole("button", { name: "Confirm event cancellation" }));
      },
    ],
    [
      "cancellation preview",
      async () => {
        getEventCancellationImpact.mockRejectedValue(httpError(500));
        const { user } = renderCancellation();
        await user.type(screen.getByLabelText("Internal cancellation reason"), "Venue unavailable");
        await user.click(screen.getByLabelText("The organiser’s request"));
        await user.click(screen.getByRole("button", { name: "Preview cancellation" }));
      },
    ],
    [
      "reject",
      async () => {
        rejectApprovedEvent.mockRejectedValue(httpError(500));
        const { user } = renderRejection();
        await screen.findByText("Every essential arrangement is currently met.");
        await user.type(screen.getByLabelText("Reason for rejection"), "No venue");
        await user.click(screen.getByRole("button", { name: "Reject event" }));
      },
    ],
    [
      "confirm",
      async () => {
        confirmEventRequest.mockRejectedValue(httpError(500));
        render(<EventConfirmationPanel eventRequest={EVENT} onConfirmed={vi.fn()} />);
        const confirm = screen.getByRole("button", { name: "Confirm Event" });
        await waitFor(() => expect(confirm).toBeEnabled());
        await userEvent.click(confirm);
      },
    ],
    [
      "safety check submit",
      async () => {
        submitForSafetyReview.mockRejectedValue(httpError(500));
        render(<SafetyCheckSubmissionPanel eventRequest={EVENT} onSubmitted={vi.fn()} />);
        const submit = screen.getByRole("button", { name: "Submit for safety check" });
        await waitFor(() => expect(submit).toBeEnabled());
        await userEvent.click(submit);
      },
    ],
    [
      "significant change",
      async () => {
        applySignificantEventChange.mockRejectedValue(httpError(500));
        const { user } = renderSignificantChange();
        await previewSignificantChange(user);
        await user.click(screen.getByLabelText(/I have reviewed this impact/));
        await user.click(screen.getByRole("button", { name: "Confirm significant change" }));
      },
    ],
  ])("SCRUM586_AC4_a_failed_%s_shows_the_error_without_try_again", async (_name, act) => {
    await act();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveClass("ui-error-notice");
    expect(within(alert).queryByRole("button")).not.toBeInTheDocument();
  });

  it("SCRUM586_AC4_cancellation_dates_use_the_standard_format", async () => {
    const { user } = renderCancellation();
    await previewCancellation(user);

    const impact = screen.getByLabelText("Cancellation impact preview");
    expect(within(impact).getByText(`Hall A — Level 1, ${STANDARD_RANGE}`)).toBeInTheDocument();
    expect(within(impact).getByText(`Room 2, expires ${STANDARD_TIME}`)).toBeInTheDocument();
    cleanup();

    renderCancellation({ ...EVENT, status: "cancelled", cancelledAt: NINE_AM });
    expect(screen.getByText("Cancelled on").nextElementSibling).toHaveTextContent(STANDARD_TIME);
  });

  it("SCRUM586_AC4_an_impact_line_with_only_one_end_still_shows_it", async () => {
    getEventCancellationImpact.mockResolvedValue({
      ...IMPACT,
      venueBookings: {
        count: 2,
        details: [
          { id: "b1", venueName: "Hall A", startsAt: NINE_AM },
          { id: "b2", venueName: "Hall B", endsAt: ELEVEN_AM },
        ],
      },
    });
    const { user } = renderCancellation();
    await previewCancellation(user);

    expect(screen.getByText(`Hall A, ${STANDARD_TIME}`)).toBeInTheDocument();
    expect(screen.getByText("Hall B–15 Jan 2026, 11:00 am")).toBeInTheDocument();
  });

  it("SCRUM586_AC4_rejection_and_significant_change_dates_use_the_standard_format", async () => {
    renderRejection({ ...EVENT, status: "rejected", decidedAt: NINE_AM });
    expect(screen.getByText("Rejected on").nextElementSibling).toHaveTextContent(STANDARD_TIME);
    cleanup();

    const { user } = renderSignificantChange();
    await previewSignificantChange(user);
    expect(screen.getByText(STANDARD_RANGE)).toBeInTheDocument();
    expect(screen.getByText(`Occupied ${STANDARD_RANGE}`)).toBeInTheDocument();
  });

  it("SCRUM586_AC4_the_leads_cancel_panel_still_shows_the_cancellation_impact", async () => {
    const user = userEvent.setup();
    render(
      <UnassignedRequestCancelPanel request={{ id: EVENT.id, eventName: EVENT.eventName }} onCancel={vi.fn()} onCancelled={vi.fn()} />,
    );
    await user.type(screen.getByLabelText("Cancellation reason"), "No longer needed");
    await user.click(screen.getByLabelText("The organiser’s request"));
    await user.click(screen.getByRole("button", { name: "Preview cancellation" }));

    const impact = await screen.findByLabelText("Cancellation impact preview");
    expect(within(impact).getByRole("heading", { name: "Venue bookings to cancel: 1" })).toBeInTheDocument();
    expect(within(impact).getByText(`Hall A — Level 1, ${STANDARD_RANGE}`)).toBeInTheDocument();
    expect(within(impact).getByText(`Room 2, expires ${STANDARD_TIME}`)).toBeInTheDocument();
  });
});

function pressEscape(dialog) {
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
}

describe("SCRUM586_AC6 marking as completed is confirmed in a dialog", () => {
  it("SCRUM586_AC6_continue_opens_a_dialog_named_for_the_event_with_the_notes", async () => {
    const { user } = renderCompletion();
    await user.type(screen.getByLabelText("Closing notes (optional)"), "  Attendance 180.  ");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const dialog = screen.getByRole("dialog", { name: COMPLETE_TITLE });
    expect(dialog).toHaveTextContent("This cannot be undone.");
    expect(within(dialog).getByText("Attendance 180.", { selector: "dd" })).toBeInTheDocument();
    // Focus starts on Edit notes, so a stray Enter never completes the event.
    expect(within(dialog).getByRole("button", { name: "Edit notes" })).toHaveFocus();
    expect(completeEventRequest).not.toHaveBeenCalled();
  });

  it.each([
    ["Edit notes", (user) => user.click(screen.getByRole("button", { name: "Edit notes" }))],
    ["Escape", async () => pressEscape(screen.getByRole("dialog"))],
  ])("SCRUM586_AC6_%s_closes_the_dialog_sends_nothing_and_returns_to_the_notes", async (_name, close) => {
    const { user } = renderCompletion();
    await user.type(screen.getByLabelText("Closing notes (optional)"), "Keep me");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await close(user);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(completeEventRequest).not.toHaveBeenCalled();
    const notes = screen.getByLabelText("Closing notes (optional)");
    expect(notes).toHaveValue("Keep me");
    expect(notes).toHaveFocus();
  });

  it("SCRUM586_AC6_confirming_sends_the_same_request_as_the_inline_step_did", async () => {
    const { user, onCompleted } = renderCompletion();
    await user.type(screen.getByLabelText("Closing notes (optional)"), "  All went well.  ");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await user.click(screen.getByRole("button", { name: "Yes, mark as completed" }));

    expect(completeEventRequest).toHaveBeenCalledExactlyOnceWith(EVENT.id, { closingNotes: "All went well." });
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
  });

  it("SCRUM586_AC6_the_dialog_holds_both_buttons_and_escape_while_sending", async () => {
    const pending = deferred();
    completeEventRequest.mockReturnValue(pending.promise);
    const { user, onCompleted } = renderCompletion();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Yes, mark as completed" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Marking as completed..." })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Edit notes" })).toBeDisabled();
    pressEscape(dialog);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    pending.resolve({ ...EVENT, status: "completed" });
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
    expect(completeEventRequest).toHaveBeenCalledTimes(1);
  });

  it("SCRUM586_AC6_a_failure_closes_the_dialog_shows_the_error_and_returns_focus_to_continue", async () => {
    completeEventRequest.mockRejectedValue(httpError(403));
    const { user, onCompleted } = renderCompletion();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Yes, mark as completed" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Only the coordinator assigned to this event can mark it as completed.");
    expect(within(alert).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toHaveFocus();
    expect(onCompleted).not.toHaveBeenCalled();
  });
});

const COMPONENTS = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/components");

const SCOPED_PANELS = [
  "EventCancellationPanel.jsx",
  "EventRejectionPanel.jsx",
  "EventConfirmationPanel.jsx",
  "EventCompletionPanel.jsx",
  "SignificantEventChangePanel.jsx",
  "SafetyCheckSubmissionPanel.jsx",
  "NeedsAttentionBadge.jsx",
  "NeedsAttentionReasons.jsx",
  "ReadinessChecklist.jsx",
];

describe("SCRUM586_AC6 no event panel asks through the browser's confirm box", () => {
  it.each(SCOPED_PANELS)("SCRUM586_AC6_%s_never_calls_window_confirm", (file) => {
    const source = readFileSync(resolve(COMPONENTS, file), "utf8");

    expect(source).not.toMatch(/\bconfirm\s*\(/);
  });
});
