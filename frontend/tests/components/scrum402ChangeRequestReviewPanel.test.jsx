// scrum402ChangeRequestReviewPanel.test.jsx
//
// SCRUM-402 (SCRUM-404, SCRUM-408): the coordinator's review of the Organiser's
// change requests, a submission at a time. Every refusal carries server text
// the panel must not show.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import ChangeRequestReviewPanel from "../../src/components/ChangeRequestReviewPanel.jsx";
import {
  getCoordinatorChangeRequests,
  getEventCancellationImpact,
  previewCoordinatorChangeRequest,
  processCoordinatorChangeRequest,
} from "../../src/services/eventRequestService";
import { formatTimestamp } from "../../src/services/displayFormat.js";
import { deferred, httpError } from "../helpers/async.js";

vi.mock("../../src/services/eventRequestService", () => ({
  getCoordinatorChangeRequests: vi.fn(),
  getEventCancellationImpact: vi.fn(),
  previewCoordinatorChangeRequest: vi.fn(),
  processCoordinatorChangeRequest: vi.fn(),
}));

const SERVER_TEXT = "Raw database wording the panel must never show";
const EVENT = Object.freeze({ id: "e1", status: "approved", eventName: "Tech Talk" });
const START = "2026-12-01T09:00:00Z";
const LATER = "2026-12-01T10:00:00Z";

const row = (overrides) => ({
  id: "r1", requestGroupId: "g1", changeField: "purpose", requestedChange: "Alumni networking", details: "Alumni networking",
  currentValue: "Industry networking", organiserNote: null, status: "outstanding", decision: null, decisionNotes: null,
  processedAt: null, createdAt: "2026-10-20T03:00:00Z", ...overrides,
});
const MIXED = [
  row({ organiserNote: "Our sponsor asked" }),
  row({ id: "r2", changeField: "proposed_start", requestedChange: LATER, details: LATER, currentValue: START }),
];
const IMPACT = {
  statusBefore: "approved", statusAfter: "approved",
  venueBookings: [{ id: "b1", venueName: "Hall A" }], equipmentReservations: [],
  pendingBookingRequests: [{ id: "p1", venueName: "Room 2" }], registeredAttendeesToNotify: 3,
};
const preview = (overrides = {}) => ({
  changeRequestId: "g1",
  rows: [{ id: "r1", class: "ordinary" }, { id: "r2", class: "significant" }],
  invalid: [], revertsEvent: false, impact: IMPACT, organiserNote: "Our sponsor asked", cancellationReason: null,
  ...overrides,
});

function renderPanel(props = {}, rows = MIXED) {
  vi.mocked(getCoordinatorChangeRequests).mockResolvedValue(rows);
  const user = userEvent.setup();
  const onProcessed = vi.fn();
  const onEquipmentAccepted = vi.fn();
  const utils = render(
    <ChangeRequestReviewPanel eventRequest={EVENT} canProcess onProcessed={onProcessed} onEquipmentAccepted={onEquipmentAccepted} {...props} />,
  );
  return { user, onProcessed, onEquipmentAccepted, ...utils };
}

async function openReview(user, p = preview()) {
  vi.mocked(previewCoordinatorChangeRequest).mockResolvedValueOnce(p);
  await user.click(await screen.findByRole("button", { name: "Review" }));
  return screen.findByLabelText("Change request review");
}

beforeEach(() => {
  vi.mocked(getCoordinatorChangeRequests).mockReset();
  vi.mocked(getEventCancellationImpact).mockReset();
  vi.mocked(previewCoordinatorChangeRequest).mockReset();
  vi.mocked(processCoordinatorChangeRequest).mockReset();
  vi.mocked(processCoordinatorChangeRequest).mockResolvedValue({ id: "r1", status: "processed" });
});


describe("SCRUM-402 the list", () => {
  it("SCRUM402_AC1_one_card_per_submission_with_current_and_requested_values_the_note_and_the_date", async () => {
    renderPanel();

    const card = (await screen.findByText("Our sponsor asked", { exact: false })).closest("li");
    expect(within(card).getByText("Purpose")).toBeInTheDocument();
    expect(within(card).getByText("Industry networking")).toBeInTheDocument();
    expect(within(card).getByText("Alumni networking")).toBeInTheDocument();
    expect(within(card).getByText(formatTimestamp(START, "Not set"))).toBeInTheDocument();
    expect(within(card).getByText(formatTimestamp(LATER, "Not set"))).toBeInTheDocument();
    expect(card).toHaveTextContent(`Submitted ${formatTimestamp("2026-10-20T03:00:00Z", "Not recorded")}`);
    expect(getCoordinatorChangeRequests).toHaveBeenCalledWith("e1");
  });

  it("SCRUM402_AC1_open_submissions_come_before_processed_ones_and_processed_ones_show_their_outcome", async () => {
    renderPanel({}, [
      row({ id: "old", requestGroupId: "old", changeField: "other", requestedChange: "A photographer", details: "A photographer",
        currentValue: null, status: "processed", decision: "approved", decisionNotes: "Arranged with Media", processedAt: "2026-10-21T03:00:00Z" }),
      row({ id: "new", requestGroupId: "new", changeField: "description", requestedChange: "", details: "", currentValue: null }),
    ]);

    const cards = (await screen.findAllByRole("listitem")).filter((li) => li.classList.contains("change-request-review__group"));
    expect(cards[0]).toHaveTextContent("Description");
    expect(cards[0]).toHaveTextContent("Not set → Not set");
    expect(cards[1]).toHaveTextContent("Accepted | Arranged with Media");
    expect(cards[1]).toHaveTextContent("A photographer");
    expect(within(cards[1]).queryByRole("button", { name: "Review" })).not.toBeInTheDocument();
  });

  it("SCRUM402_AC1_says_loading_then_when_there_are_none_and_when_the_read_fails", async () => {
    const pending = deferred();
    vi.mocked(getCoordinatorChangeRequests).mockReturnValueOnce(pending.promise);
    const { rerender } = render(<ChangeRequestReviewPanel eventRequest={EVENT} canProcess />);
    expect(screen.getByText("Loading change requests...")).toBeInTheDocument();
    pending.resolve([]);
    expect(await screen.findByText("No change requests have been submitted for this event.")).toBeInTheDocument();

    vi.mocked(getCoordinatorChangeRequests).mockRejectedValueOnce(new Error("boom"));
    rerender(<ChangeRequestReviewPanel eventRequest={{ ...EVENT, id: "e2" }} canProcess />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load organiser change requests.");
  });

  it("SCRUM402_AC1_a_list_read_that_lands_after_unmounting_is_ignored", async () => {
    const ok = deferred();
    const failing = deferred();
    vi.mocked(getCoordinatorChangeRequests).mockReturnValueOnce(ok.promise).mockReturnValueOnce(failing.promise);

    render(<ChangeRequestReviewPanel eventRequest={EVENT} canProcess />).unmount();
    render(<ChangeRequestReviewPanel eventRequest={{ ...EVENT, id: "e2" }} canProcess />).unmount();
    ok.resolve(MIXED);
    failing.reject(new Error("late"));
    await Promise.allSettled([ok.promise, failing.promise]);

    expect(screen.queryByText("Purpose")).not.toBeInTheDocument();
  });

  it("SCRUM402_AC9_a_something_else_row_from_before_the_groups_shows_its_text", async () => {
    renderPanel({ canProcess: false }, [{ id: "o1", changeField: "other", details: "A photographer, please", status: "outstanding", createdAt: "2026-10-10T03:00:00Z" }]);

    expect(await screen.findByText("A photographer, please")).toBeInTheDocument();
  });

  it("SCRUM402_AC2_the_lead_and_other_coordinators_read_it_with_no_buttons", async () => {
    renderPanel({ canProcess: false });

    await screen.findByText("Our sponsor asked", { exact: false });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it.each(["submitted", "cancelled", "rejected", "completed"])(
    "SCRUM402_AC2_an_event_that_is_%s_offers_no_review",
    async (status) => {
      renderPanel({ eventRequest: { ...EVENT, status } });

      await screen.findByText("Our sponsor asked", { exact: false });
      expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument();
      if (status === "submitted") {
        expect(screen.getByText("Start the review to process change requests.")).toBeInTheDocument();
      }
    },
  );

  it("SCRUM402_AC1_a_row_from_before_the_groups_is_its_own_card_shown_by_its_text", async () => {
    renderPanel({ canProcess: false }, [{ id: "cr1", fieldLabel: "Venue", details: "A larger room.", status: "outstanding", createdAt: "2026-10-10T03:00:00Z", changeField: "venue" }]);

    expect(await screen.findByText("A larger room.")).toBeInTheDocument();
  });
});


describe("SCRUM-402 the review", () => {
  it("SCRUM402_AC4_tags_each_field_and_shows_the_impact_in_395s_style", async () => {
    const { user } = renderPanel();

    const review = await openReview(user);

    expect(previewCoordinatorChangeRequest).toHaveBeenCalledWith("g1");
    expect(within(review).getByText("Applied directly")).toBeInTheDocument();
    expect(within(review).getByText("Re-checks bookings")).toBeInTheDocument();
    expect(within(review).getByRole("group", { name: "Venue bookings to flag: 1" })).toBeInTheDocument();
    expect(within(review).getByRole("group", { name: "Registered attendees to notify: 3" })).toBeInTheDocument();
    expect(within(review).getByText("Hall A: flagged for review")).toBeInTheDocument();
    expect(within(review).getByText("Room 2: a pending request still for the old time")).toBeInTheDocument();
    expect(within(review).queryByText(/returns this event to Approved/)).not.toBeInTheDocument();
  });

  it("SCRUM402_AC4_an_impact_with_nothing_listed_shows_only_its_counts_and_bookings_without_a_name_read", async () => {
    const { user } = renderPanel();

    const review = await openReview(user, preview({
      impact: { venueBookings: [{ id: "b1" }], pendingBookingRequests: [{ id: "p1" }] },
    }));

    expect(within(review).getByText("Venue: flagged for review")).toBeInTheDocument();
    expect(within(review).getByText("Venue: a pending request still for the old time")).toBeInTheDocument();
    expect(within(review).getByRole("group", { name: "Registered attendees to notify: 0" })).toBeInTheDocument();
    expect(within(review).getByRole("group", { name: "Equipment reservations to flag: 0" })).toBeInTheDocument();
  });

  it("SCRUM402_AC4_an_impact_with_no_lists_shows_zero_counts", async () => {
    const { user } = renderPanel();

    const review = await openReview(user, preview({ impact: { statusAfter: "approved" } }));

    expect(within(review).getByRole("group", { name: "Venue bookings to flag: 0" })).toBeInTheDocument();
    expect(within(review).queryByText(/flagged for review/)).not.toBeInTheDocument();
  });

  it("SCRUM402_AC4_a_preview_with_no_rows_or_impact_still_opens", async () => {
    const { user } = renderPanel();

    const review = await openReview(user, preview({ rows: undefined, invalid: undefined, impact: null }));

    expect(within(review).queryByLabelText("Significant change impact preview")).not.toBeInTheDocument();
    expect(within(review).getByRole("button", { name: "Accept" })).toBeEnabled();
  });

  it("SCRUM402_AC5_invalid_values_disable_accept_and_point_to_decline", async () => {
    const { user } = renderPanel();

    const review = await openReview(user, preview({
      invalid: [{ field: "proposedEnd", message: "must be later than the proposed start" }], impact: null,
    }));

    expect(within(review).getByRole("alert")).toHaveTextContent("proposedEnd: must be later than the proposed start");
    expect(within(review).getByRole("alert")).toHaveTextContent("You can decline it with a reason instead");
    expect(within(review).getByRole("button", { name: "Accept" })).toBeDisabled();
    expect(within(review).getByRole("button", { name: "Decline" })).toBeEnabled();
  });

  it("SCRUM402_AC4_a_returning_event_is_warned_of", async () => {
    const { user } = renderPanel();

    const review = await openReview(user, preview({ revertsEvent: true }));

    expect(within(review).getByText("Accepting returns this event to Approved.")).toBeInTheDocument();
  });

  it("SCRUM402_AC4_close_review_returns_to_the_card", async () => {
    const { user } = renderPanel();
    await openReview(user);

    await user.click(screen.getByRole("button", { name: "Close review" }));

    expect(screen.queryByLabelText("Change request review")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review" })).toBeInTheDocument();
  });

  it("SCRUM402_AC4_a_preview_that_fails_says_so_in_the_panels_words", async () => {
    vi.mocked(previewCoordinatorChangeRequest).mockRejectedValueOnce(
      httpError(409, { error: SERVER_TEXT, code: "REVIEW_NOT_STARTED" }),
    );
    const { user } = renderPanel();

    await user.click(await screen.findByRole("button", { name: "Review" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Start the review of this event before processing its change requests.");
    expect(screen.queryByText(SERVER_TEXT)).not.toBeInTheDocument();
  });
});


describe("SCRUM-402 accept and decline", () => {
  it("SCRUM402_AC4_accept_sends_the_previews_impact_then_rereads_the_list_and_the_event", async () => {
    const { user, onProcessed } = renderPanel();
    await openReview(user);

    await user.type(screen.getByLabelText("Note to the organiser (optional)"), "  As asked  ");
    await user.click(screen.getByRole("button", { name: "Accept" }));

    expect(processCoordinatorChangeRequest).toHaveBeenCalledWith("g1", { decision: "approved", decisionNotes: "As asked", expectedImpact: IMPACT });
    expect(await screen.findByRole("status")).toHaveTextContent("Change request accepted. The organiser has been told.");
    expect(onProcessed).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(getCoordinatorChangeRequests).toHaveBeenCalledTimes(2));
  });

  it("SCRUM402_AC5_an_ordinary_only_accept_sends_no_impact_and_no_empty_note", async () => {
    const { user } = renderPanel();
    await openReview(user, preview({ rows: [{ id: "r1", class: "ordinary" }], impact: null }));

    await user.click(screen.getByRole("button", { name: "Accept" }));

    expect(processCoordinatorChangeRequest).toHaveBeenCalledWith("g1", { decision: "approved", decisionNotes: undefined });
  });

  it("SCRUM402_AC4_a_changed_impact_reloads_the_preview_and_says_so_rather_than_retrying", async () => {
    vi.mocked(processCoordinatorChangeRequest).mockRejectedValueOnce(
      httpError(409, { error: SERVER_TEXT, code: "SIGNIFICANT_CHANGE_IMPACT_CHANGED" }),
    );
    const { user } = renderPanel();
    await openReview(user);
    vi.mocked(previewCoordinatorChangeRequest).mockResolvedValueOnce(preview({
      impact: { ...IMPACT, venueBookings: [{ id: "b1", venueName: "Hall A" }, { id: "b2", venueName: "Hall B" }] },
    }));

    await user.click(screen.getByRole("button", { name: "Accept" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The preview has been refreshed; check it and accept again.");
    expect(await screen.findByRole("group", { name: "Venue bookings to flag: 2" })).toBeInTheDocument();
    expect(processCoordinatorChangeRequest).toHaveBeenCalledTimes(1);
    expect(previewCoordinatorChangeRequest).toHaveBeenCalledTimes(2);
  });

  it("SCRUM402_AC4_a_reload_that_fails_after_a_changed_impact_says_so", async () => {
    vi.mocked(processCoordinatorChangeRequest).mockRejectedValueOnce(
      httpError(409, { error: SERVER_TEXT, code: "SIGNIFICANT_CHANGE_IMPACT_CHANGED" }),
    );
    const { user } = renderPanel();
    await openReview(user);
    vi.mocked(previewCoordinatorChangeRequest).mockRejectedValueOnce(httpError(500, { error: SERVER_TEXT }));

    await user.click(screen.getByRole("button", { name: "Accept" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The change request could not be reviewed. Please try again.");
  });

  it("SCRUM402_AC10_an_already_processed_group_closes_the_review_and_rereads_the_list", async () => {
    vi.mocked(processCoordinatorChangeRequest).mockRejectedValueOnce(
      httpError(409, { error: SERVER_TEXT, code: "CHANGE_REQUEST_ALREADY_PROCESSED" }),
    );
    const { user } = renderPanel();
    await openReview(user);

    await user.click(screen.getByRole("button", { name: "Accept" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This change request has already been processed. The list has been refreshed.");
    expect(screen.queryByLabelText("Change request review")).not.toBeInTheDocument();
    await waitFor(() => expect(getCoordinatorChangeRequests).toHaveBeenCalledTimes(2));
  });

  it.each([
    ["REVIEW_NOT_STARTED", httpError(409, { error: SERVER_TEXT, code: "REVIEW_NOT_STARTED" }), "Start the review of this event before processing its change requests."],
    ["EVENT_STATUS_NOT_ALLOWED", httpError(409, { error: SERVER_TEXT, code: "EVENT_STATUS_NOT_ALLOWED" }), "no longer allows its change requests to be processed"],
    ["EVENT_HOLDS_ARRANGEMENTS", httpError(409, { error: SERVER_TEXT, code: "EVENT_HOLDS_ARRANGEMENTS" }), "Release them, or decline the change request."],
    ["an_unknown_409_code", httpError(409, { error: SERVER_TEXT, code: "SOMETHING_NEW" }), "This event or change request has changed."],
    ["a_400", httpError(400, { error: SERVER_TEXT }), "can't be applied as it stands"],
    ["a_401", httpError(401, { error: SERVER_TEXT }), "Your session has expired."],
    ["a_403", httpError(403, { error: SERVER_TEXT }), "You're no longer the coordinator for this event."],
    ["a_404", httpError(404, { error: SERVER_TEXT }), "This change request no longer exists."],
    ["a_500", httpError(500, { error: SERVER_TEXT }), "The change request could not be processed. Please try again."],
  ])("SCRUM402_AC2_%s_is_said_in_the_panels_own_words", async (_label, err, message) => {
    vi.mocked(processCoordinatorChangeRequest).mockRejectedValueOnce(err);
    const { user } = renderPanel();
    await openReview(user);

    await user.click(screen.getByRole("button", { name: "Accept" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText(SERVER_TEXT)).not.toBeInTheDocument();
  });

  it("SCRUM402_AC3_decline_needs_a_reason_of_at_most_2000_characters", async () => {
    const { user, onProcessed } = renderPanel();
    await openReview(user);

    await user.click(screen.getByRole("button", { name: "Decline" }));
    const confirm = screen.getByRole("button", { name: "Confirm decline" });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText("Reason for declining"), "x");
    await user.clear(screen.getByLabelText("Reason for declining"));
    await user.click(screen.getByLabelText("Reason for declining"));
    await user.paste("x".repeat(2001));
    expect(screen.getByText("The reason must be 2,000 characters or fewer.")).toBeInTheDocument();
    expect(confirm).toBeDisabled();
    await user.clear(screen.getByLabelText("Reason for declining"));
    await user.type(screen.getByLabelText("Reason for declining"), "  Not this term  ");
    await user.click(confirm);

    expect(processCoordinatorChangeRequest).toHaveBeenCalledWith("g1", { decision: "rejected", decisionNotes: "Not this term" });
    expect(await screen.findByRole("status")).toHaveTextContent("Change request declined. The organiser has been told.");
    expect(onProcessed).toHaveBeenCalled();
  });

  it("SCRUM402_AC9_something_else_needs_a_note_to_accept", async () => {
    const { user } = renderPanel({}, [row({ changeField: "other", requestedChange: "A photographer", details: "A photographer", currentValue: null })]);
    await openReview(user, preview({ rows: [{ id: "r1", class: "other" }], impact: null }));

    const accept = screen.getByRole("button", { name: "Accept" });
    expect(accept).toBeDisabled();
    await user.type(screen.getByLabelText("Note to the organiser (required)"), "Arranged with Media");
    await user.click(accept);

    expect(processCoordinatorChangeRequest).toHaveBeenCalledWith("g1", { decision: "approved", decisionNotes: "Arranged with Media" });
  });

  it("SCRUM402_AC3_a_note_over_2000_characters_disables_accept", async () => {
    const { user } = renderPanel();
    await openReview(user);

    await user.click(screen.getByLabelText("Note to the organiser (optional)"));
    await user.paste("y".repeat(2001));

    expect(screen.getByText("The note must be 2,000 characters or fewer.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
  });
});


describe("SCRUM-402 cancellation and equipment", () => {
  const CANCELLATION = [row({ changeField: "cancellation", requestedChange: "Cancel it", details: "Cancel it", currentValue: null })];
  const CANCEL_IMPACT = {
    venueBookings: { count: 1, details: [{ id: "b1", venueName: "Hall A" }] }, bookingRequests: { count: 0 },
    venueHolds: { count: 0 }, equipmentRequests: { count: 0 }, equipmentReservations: { count: 0 },
  };

  it("SCRUM402_AC7_accept_opens_a_confirmation_with_the_impact_and_the_prefilled_reason", async () => {
    vi.mocked(getEventCancellationImpact).mockResolvedValueOnce(CANCEL_IMPACT);
    const { user, onProcessed } = renderPanel({}, CANCELLATION);
    await openReview(user, preview({ rows: [{ id: "r1", class: "cancellation" }], impact: null, cancellationReason: "We lost our speaker" }));
    expect(screen.queryByLabelText(/Note to the organiser/)).not.toBeInTheDocument();
    expect(screen.getByText("Cancels the event")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Accept" }));

    expect(getEventCancellationImpact).toHaveBeenCalledWith("e1");
    expect(await screen.findByLabelText("Cancellation impact preview")).toHaveTextContent("Venue bookings to cancel: 1");
    const reason = screen.getByLabelText("Cancellation reason");
    expect(reason).toHaveValue("We lost our speaker");
    await user.clear(reason);
    await user.type(reason, "Speaker withdrew");
    await user.click(screen.getByRole("button", { name: "Confirm cancellation" }));

    expect(processCoordinatorChangeRequest).toHaveBeenCalledWith("g1", { decision: "approved", decisionNotes: "Speaker withdrew" });
    expect(await screen.findByRole("status")).toHaveTextContent("the event has been cancelled");
    expect(onProcessed).toHaveBeenCalled();
  });

  it("SCRUM402_AC7_a_blank_reason_cannot_confirm_and_a_missing_prefill_starts_empty", async () => {
    vi.mocked(getEventCancellationImpact).mockResolvedValueOnce(CANCEL_IMPACT);
    const { user } = renderPanel({}, CANCELLATION);
    await openReview(user, preview({ rows: [{ id: "r1", class: "cancellation" }], impact: null, cancellationReason: undefined }));

    await user.click(screen.getByRole("button", { name: "Accept" }));

    expect(await screen.findByLabelText("Cancellation reason")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Confirm cancellation" })).toBeDisabled();
  });

  it("SCRUM402_AC7_a_cancellation_impact_that_fails_to_load_says_so", async () => {
    vi.mocked(getEventCancellationImpact).mockRejectedValueOnce(httpError(403, { error: SERVER_TEXT }));
    const { user } = renderPanel({}, CANCELLATION);
    await openReview(user, preview({ rows: [{ id: "r1", class: "cancellation" }], impact: null, cancellationReason: "Why" }));

    await user.click(screen.getByRole("button", { name: "Accept" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("You're no longer the coordinator for this event.");
    expect(screen.queryByLabelText("Cancellation reason")).not.toBeInTheDocument();
  });

  it("SCRUM402_AC8_in_planning_an_accepted_equipment_change_hands_off_to_the_equipment_section", async () => {
    const { user, onEquipmentAccepted } = renderPanel({}, [
      row({ changeField: "equipment", requestedChange: "Two more microphones", details: "Two more microphones", currentValue: null }),
    ]);
    await openReview(user, preview({ rows: [{ id: "r1", class: "equipment" }], impact: null }));

    await user.click(screen.getByRole("button", { name: "Accept" }));

    await waitFor(() => expect(onEquipmentAccepted).toHaveBeenCalledWith("Two more microphones"));
  });

  it("SCRUM402_AC8_in_review_it_says_the_lines_open_once_approved_rather_than_moving", async () => {
    const { user, onEquipmentAccepted } = renderPanel({ eventRequest: { ...EVENT, status: "under_review" } }, [
      row({ changeField: "equipment", requestedChange: "Two more microphones", details: "Two more microphones", currentValue: null }),
    ]);
    await openReview(user, preview({ rows: [{ id: "r1", class: "equipment" }], impact: null }));

    await user.click(screen.getByRole("button", { name: "Accept" }));

    expect(await screen.findByRole("status")).toHaveTextContent("the equipment lines can be edited once the event is approved");
    expect(onEquipmentAccepted).not.toHaveBeenCalled();
  });

  it("SCRUM402_AC8_an_equipment_row_from_before_the_groups_hands_off_its_text", async () => {
    const { user, onEquipmentAccepted } = renderPanel({}, [
      { id: "r1", changeField: "equipment", details: "A projector", status: "outstanding", createdAt: "2026-10-20T03:00:00Z" },
    ]);
    vi.mocked(previewCoordinatorChangeRequest).mockResolvedValueOnce(preview({ changeRequestId: "r1", rows: [{ id: "r1", class: "equipment" }], impact: null }));
    await user.click(await screen.findByRole("button", { name: "Review" }));
    await screen.findByLabelText("Change request review");

    await user.click(screen.getByRole("button", { name: "Accept" }));

    await waitFor(() => expect(onEquipmentAccepted).toHaveBeenCalledWith("A projector"));
  });

  it("SCRUM402_AC1_it_works_with_no_callbacks", async () => {
    vi.mocked(getCoordinatorChangeRequests).mockResolvedValue([
      row({ changeField: "equipment", requestedChange: "Mics", details: "Mics", currentValue: null }),
    ]);
    const user = userEvent.setup();
    render(<ChangeRequestReviewPanel eventRequest={EVENT} canProcess />);
    await openReview(user, preview({ rows: [{ id: "r1", class: "equipment" }], impact: null }));

    await user.click(screen.getByRole("button", { name: "Accept" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Change request accepted.");
  });
});
