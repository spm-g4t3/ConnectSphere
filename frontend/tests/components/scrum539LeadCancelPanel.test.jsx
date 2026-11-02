// scrum539LeadCancelPanel.test.jsx
//
// SCRUM-539 (SCRUM-579): the Event Coordinator Lead's cancel form for one row
// of the unassigned queue. The service is mocked; what the server refuses, and
// why, is proved in the backend's scrum539 suites.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import UnassignedRequestCancelPanel from "../../src/components/UnassignedRequestCancelPanel.jsx";
import { cancelEventRequest, getEventCancellationImpact } from "../../src/services/eventRequestService";
import { deferred, httpError } from "../helpers/async.js";

vi.mock("../../src/services/eventRequestService", () => ({
  cancelEventRequest: vi.fn(),
  getEventCancellationImpact: vi.fn(),
}));

const REQUEST = { id: "22222222-2222-4222-8222-222222222222", eventName: "IS212 Industry Night" };

const IMPACT = {
  venueBookings: { count: 1, details: [{ id: "b1", venueName: "Auditorium", status: "approved" }] },
  bookingRequests: { count: 0, details: [] },
  venueHolds: { count: 1, details: [{ id: "h1", venueName: "Meeting room", expiresAt: "2026-12-01T00:00:00Z" }] },
  equipmentRequests: { count: 0, details: [] },
  equipmentReservations: { count: 0, details: [] },
};

const ASSIGNED_SINCE =
  "A coordinator has been assigned to this request since you opened it, so only they can cancel it now. Go back to the queue to see where it stands.";
const NO_LONGER_WAITING =
  "This request is no longer waiting in the queue. It may already have been cancelled or assigned. Go back to the queue to see where it stands.";
const CONFIRM = "I have reviewed the impact and confirm cancelling this request.";

function renderPanel() {
  const user = userEvent.setup();
  const onCancel = vi.fn();
  const onCancelled = vi.fn();
  render(<UnassignedRequestCancelPanel request={REQUEST} onCancel={onCancel} onCancelled={onCancelled} />);
  return { user, onCancel, onCancelled };
}

const reasonBox = () => screen.getByLabelText("Cancellation reason");
const previewButton = () => screen.getByRole("button", { name: /Preview cancellation|Refresh impact preview|Loading impact/ });
const cancelButton = () => screen.getByRole("button", { name: /Cancel request|Cancelling/ });

async function fillAndPreview(user, reason = "  Organiser no longer needs it  ") {
  await user.type(reasonBox(), reason);
  await user.click(screen.getByLabelText("The organiser’s request"));
  await user.click(previewButton());
  await screen.findByLabelText("Cancellation impact preview");
}

async function confirmAndCancel(user) {
  await user.click(screen.getByLabelText(CONFIRM));
  await user.click(cancelButton());
}

beforeEach(() => {
  vi.mocked(getEventCancellationImpact).mockReset().mockResolvedValue(IMPACT);
  vi.mocked(cancelEventRequest).mockReset().mockResolvedValue({ id: REQUEST.id, status: "cancelled" });
});


describe("SCRUM539_AC1 the Lead's cancel form", () => {
  it("SCRUM539_AC1_names_the_request_and_says_the_organiser_is_told_and_it_is_final", () => {
    renderPanel();

    expect(screen.getByRole("heading", { name: "Cancel IS212 Industry Night" })).toBeInTheDocument();
    expect(screen.getByText(/no coordinator yet.*Organiser will be told.*Cancelling is final/s)).toBeInTheDocument();
    expect(screen.queryByLabelText(/message to attendees/i)).not.toBeInTheDocument();
    expect(reasonBox()).toHaveAttribute("maxLength", "4000");
  });

  it.each([
    ["a_blank_reason", "   ", true],
    ["no_initiator", "Organiser no longer needs it", false],
  ])("SCRUM539_AC1_%s_shows_the_message_and_calls_nothing", async (_label, reason, pickInitiator) => {
    const { user } = renderPanel();

    await user.type(reasonBox(), reason);
    if (pickInitiator) await user.click(screen.getByLabelText("A ConnectSphere decision"));
    // The radios are required, so a browser blocks this submit on its own;
    // submitting the form directly proves the form's own check too.
    fireEvent.submit(previewButton().closest("form"));

    expect(screen.getByRole("alert")).toHaveTextContent("A non-blank reason and cancellation initiator are required.");
    expect(getEventCancellationImpact).not.toHaveBeenCalled();
    expect(cancelEventRequest).not.toHaveBeenCalled();
  });

  it("SCRUM539_AC1_the_preview_is_asked_for_this_request_and_its_counts_are_shown", async () => {
    // D6: a request sent back to the queue can still hold bookings and holds.
    const { user } = renderPanel();

    await fillAndPreview(user);

    expect(getEventCancellationImpact).toHaveBeenCalledWith(REQUEST.id);
    expect(screen.getByText(/Venue bookings to cancel: 1/)).toBeInTheDocument();
    expect(screen.getByText(/Tentative venue holds to release: 1/)).toBeInTheDocument();
    expect(screen.getByText("Auditorium")).toBeInTheDocument();
    expect(previewButton()).toHaveTextContent("Refresh impact preview");
  });

  it("SCRUM539_AC1_cancel_waits_for_the_box_then_sends_the_trimmed_reason_and_initiator_only", async () => {
    const { user, onCancelled } = renderPanel();
    await fillAndPreview(user);

    expect(cancelButton()).toBeDisabled();
    await confirmAndCancel(user);

    expect(cancelEventRequest).toHaveBeenCalledTimes(1);
    const [id, body] = vi.mocked(cancelEventRequest).mock.calls[0];
    expect(id).toBe(REQUEST.id);
    expect(body).toEqual({ reason: "Organiser no longer needs it", initiator: "organiser_request" });
    expect(body).not.toHaveProperty("attendeeMessage");
    expect(onCancelled).toHaveBeenCalledWith({ id: REQUEST.id, status: "cancelled" });
  });

  it.each([
    ["the_reason", async (user) => user.type(reasonBox(), " more")],
    ["the_initiator", async (user) => user.click(screen.getByLabelText("A ConnectSphere decision"))],
  ])("SCRUM539_AC1_changing_%s_after_a_preview_clears_it", async (_label, change) => {
    const { user } = renderPanel();
    await fillAndPreview(user);
    await user.click(screen.getByLabelText(CONFIRM));

    await change(user);

    expect(screen.queryByLabelText("Cancellation impact preview")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(CONFIRM)).not.toBeInTheDocument();
    expect(previewButton()).toHaveTextContent("Preview cancellation");
  });

  it("SCRUM539_AC1_while_a_preview_or_cancel_is_in_flight_the_buttons_wait", async () => {
    const preview = deferred();
    vi.mocked(getEventCancellationImpact).mockReturnValueOnce(preview.promise);
    const { user } = renderPanel();
    await user.type(reasonBox(), "Organiser no longer needs it");
    await user.click(screen.getByLabelText("The organiser’s request"));
    await user.click(previewButton());

    expect(previewButton()).toHaveTextContent("Loading impact...");
    expect(previewButton()).toBeDisabled();
    preview.resolve(IMPACT);
    await screen.findByLabelText("Cancellation impact preview");

    vi.mocked(cancelEventRequest).mockReturnValueOnce(new Promise(() => {}));
    await confirmAndCancel(user);
    expect(cancelButton()).toHaveTextContent("Cancelling...");
    expect(cancelButton()).toBeDisabled();
    expect(previewButton()).toBeDisabled();
  });

  it("SCRUM539_AC1_back_returns_to_the_queue_and_sends_nothing", async () => {
    const { user, onCancel } = renderPanel();

    await user.click(screen.getByRole("button", { name: /Back to the unassigned queue/ }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(cancelEventRequest).not.toHaveBeenCalled();
  });
});


describe("SCRUM539 refusals, keyed on the status", () => {
  it("SCRUM539_AC3_a_403_from_the_cancel_says_a_coordinator_was_assigned_since", async () => {
    // AC3, AC5-01: the race was lost to an assignment.
    vi.mocked(cancelEventRequest).mockRejectedValue(httpError(403, { error: "server words" }));
    const { user, onCancelled } = renderPanel();
    await fillAndPreview(user);

    await confirmAndCancel(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(ASSIGNED_SINCE);
    expect(screen.queryByText("server words")).not.toBeInTheDocument();
    expect(onCancelled).not.toHaveBeenCalled();
    expect(cancelButton()).toBeEnabled();
  });

  it("SCRUM539_AC5_a_409_from_the_cancel_says_it_is_no_longer_waiting", async () => {
    // AC5-02, AC5-03: assigned, or already cancelled, by another Lead. The
    // server's 409 names the Lead, and is not read.
    vi.mocked(cancelEventRequest).mockRejectedValue(httpError(409, { error: "waiting for the Event Coordinator Lead" }));
    const { user } = renderPanel();
    await fillAndPreview(user);

    await confirmAndCancel(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(NO_LONGER_WAITING);
  });

  it("SCRUM539_AC3_a_403_from_the_preview_says_a_coordinator_was_assigned_since", async () => {
    vi.mocked(getEventCancellationImpact).mockRejectedValue(httpError(403));
    const { user } = renderPanel();
    await user.type(reasonBox(), "Organiser no longer needs it");
    await user.click(screen.getByLabelText("The organiser’s request"));

    await user.click(previewButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(ASSIGNED_SINCE);
    expect(screen.queryByLabelText("Cancellation impact preview")).not.toBeInTheDocument();
  });

  it.each([
    [400, "Enter a cancellation reason and select who initiated it."],
    [404, "This event request no longer exists."],
    [500, "The request could not be cancelled. No changes have been made; try again."],
  ])("SCRUM539_AC7_a_%s_from_the_cancel_shows_its_own_message", async (status, message) => {
    vi.mocked(cancelEventRequest).mockRejectedValue(httpError(status));
    const { user, onCancelled } = renderPanel();
    await fillAndPreview(user);

    await confirmAndCancel(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(onCancelled).not.toHaveBeenCalled();
  });
});
