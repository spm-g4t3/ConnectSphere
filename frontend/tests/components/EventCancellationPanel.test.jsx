import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import EventCancellationPanel from "../../src/components/EventCancellationPanel.jsx";
import {
  cancelEventRequest,
  getEventCancellationImpact,
} from "../../src/services/eventRequestService";

vi.mock("../../src/services/eventRequestService", () => ({
  cancelEventRequest: vi.fn(),
  getEventCancellationImpact: vi.fn(),
}));

const REQUEST = {
  id: "event-1",
  status: "approved",
  cancellationReason: null,
  cancelledAt: null,
};

const IMPACT = {
  venueBookings: { count: 1, details: [{ id: "booking-1", venueName: "Auditorium", status: "approved" }] },
  bookingRequests: { count: 1, details: [{ id: "booking-2", venueName: "Seminar room", status: "pending" }] },
  venueHolds: { count: 1, details: [{ id: "hold-1", venueName: "Meeting room", expiresAt: "2026-12-01T00:00:00Z" }] },
  equipmentRequests: {
    count: 1,
    details: [{
      id: "equipment-1",
      status: "approved",
      lines: [{ id: "line-1", equipmentName: "Projector", quantity: 2 }],
    }],
  },
  equipmentReservations: { count: 2, details: [{ id: "reservation-1", equipmentName: "Projector", quantity: 2 }] },
};

describe("EventCancellationPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getEventCancellationImpact).mockResolvedValue(IMPACT);
    vi.mocked(cancelEventRequest).mockResolvedValue({
      ...REQUEST,
      status: "cancelled",
      cancellationReason: "Organiser withdrew",
      cancelledAt: "2026-06-01T09:00:00Z",
    });
  });

  it("previews the impact and requires a separate explicit confirmation", async () => {
    const user = userEvent.setup();
    const onCancelled = vi.fn();
    render(<EventCancellationPanel eventRequest={REQUEST} onCancelled={onCancelled} />);

    await user.type(screen.getByLabelText("Internal cancellation reason"), "Organiser withdrew");
    await user.click(screen.getByLabelText("The organiser’s request"));
    await user.type(screen.getByLabelText("Optional message to attendees"), "We hope to see you soon.");
    await user.click(screen.getByRole("button", { name: "Preview cancellation" }));

    expect(await screen.findByText("Auditorium")).toBeInTheDocument();
    expect(screen.getByText(/Venue bookings to cancel: 1/)).toBeInTheDocument();
    expect(screen.getByText(/Tentative venue holds to release: 1/)).toBeInTheDocument();
    expect(screen.getByText(/Meeting room/)).toBeInTheDocument();
    expect(screen.getAllByText(/Projector \(quantity 2\)/)).toHaveLength(2);
    expect(cancelEventRequest).not.toHaveBeenCalled();

    const confirmButton = screen.getByRole("button", { name: "Confirm event cancellation" });
    expect(confirmButton).toBeDisabled();
    await user.click(screen.getByLabelText(
      "I have reviewed the impact and explicitly confirm cancelling this event.",
    ));
    await user.click(confirmButton);

    expect(cancelEventRequest).toHaveBeenCalledWith("event-1", {
      reason: "Organiser withdrew",
      initiator: "organiser_request",
      attendeeMessage: "We hope to see you soon.",
    });
    expect(onCancelled).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
  });

  it("invalidates a preview when cancellation inputs change", async () => {
    const user = userEvent.setup();
    render(<EventCancellationPanel eventRequest={REQUEST} />);

    await user.type(screen.getByLabelText("Internal cancellation reason"), "Reason");
    await user.click(screen.getByLabelText("A ConnectSphere decision"));
    await user.click(screen.getByRole("button", { name: "Preview cancellation" }));
    expect(await screen.findByText("Auditorium")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Internal cancellation reason"), " updated");
    expect(screen.queryByText("Auditorium")).not.toBeInTheDocument();
    expect(cancelEventRequest).not.toHaveBeenCalled();
  });

  it("shows actionable guidance when the preview server fails", async () => {
    const user = userEvent.setup();
    vi.mocked(getEventCancellationImpact).mockRejectedValue({
      response: {
        status: 500,
        data: { error: "Unexpected server error" },
      },
    });
    render(<EventCancellationPanel eventRequest={REQUEST} />);

    await user.type(screen.getByLabelText("Internal cancellation reason"), "Reason");
    await user.click(screen.getByLabelText("The organiser’s request"));
    await user.click(screen.getByRole("button", { name: "Preview cancellation" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The server could not load the cancellation preview (500).",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "contact your ConnectSphere administrator and provide event request ID: event-1",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("backend error log");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Unexpected server error");
    expect(cancelEventRequest).not.toHaveBeenCalled();
  });

  it("states the event's actual status when cancellation is refused", async () => {
    const user = userEvent.setup();
    vi.mocked(cancelEventRequest).mockRejectedValue({
      response: {
        status: 409,
        data: { error: "Event request event-1 has status completed, which cannot be cancelled" },
      },
    });
    render(<EventCancellationPanel eventRequest={REQUEST} />);

    await user.type(screen.getByLabelText("Internal cancellation reason"), "Reason");
    await user.click(screen.getByLabelText("The organiser’s request"));
    await user.click(screen.getByRole("button", { name: "Preview cancellation" }));
    await screen.findByText("Auditorium");
    await user.click(screen.getByLabelText(
      "I have reviewed the impact and explicitly confirm cancelling this event.",
    ));
    await user.click(screen.getByRole("button", { name: "Confirm event cancellation" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      'This event has status "completed", which cannot be cancelled.',
    );
  });

  it("shows cancellation details for an already cancelled event", () => {
    render(
      <EventCancellationPanel
        eventRequest={{
          ...REQUEST,
          status: "cancelled",
          cancellationReason: "Organiser withdrew",
          cancelledAt: "2026-06-01T09:00:00Z",
        }}
      />,
    );

    expect(screen.getByText("Event cancelled")).toBeInTheDocument();
    expect(screen.getByText("Organiser withdrew")).toBeInTheDocument();
    expect(screen.getByText("1 Jun 2026, 5:00 pm")).toBeInTheDocument();
    expect(getEventCancellationImpact).not.toHaveBeenCalled();
  });

  it.each(["safety_review", "safety_approved"])(
    "SCRUM561_AC3_%s_exposes_the_cancellation_controls_and_previews_the_impact",
    async (status) => {
      const user = userEvent.setup();
      render(<EventCancellationPanel eventRequest={{ ...REQUEST, eventName: "Night Run", status }} />);

      expect(screen.getByRole("heading", { name: "Cancel Night Run" })).toBeInTheDocument();
      await user.type(screen.getByLabelText("Internal cancellation reason"), "Called off in safety check");
      await user.click(screen.getByLabelText("The organiser’s request"));
      await user.click(screen.getByRole("button", { name: "Preview cancellation" }));

      expect(await screen.findByText("Auditorium")).toBeInTheDocument();
      expect(getEventCancellationImpact).toHaveBeenCalledWith("event-1");
    },
  );

  it("SCRUM539_AC4_the_coordinators_cancel_form_keeps_its_403_text", async () => {
    // AC4-06: the Lead's queue panel words its own 403; the coordinator's is unchanged.
    const user = userEvent.setup();
    vi.mocked(cancelEventRequest).mockRejectedValue({ response: { status: 403, data: {} } });
    render(<EventCancellationPanel eventRequest={REQUEST} />);

    await user.type(screen.getByLabelText("Internal cancellation reason"), "Reason");
    await user.click(screen.getByLabelText("The organiser’s request"));
    await user.click(screen.getByRole("button", { name: "Preview cancellation" }));
    await screen.findByText("Auditorium");
    await user.click(screen.getByLabelText(
      "I have reviewed the impact and explicitly confirm cancelling this event.",
    ));
    await user.click(screen.getByRole("button", { name: "Confirm event cancellation" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only the coordinator assigned to this event can cancel it.",
    );
  });

  it("does not expose cancellation controls for an unsupported status", () => {
    render(<EventCancellationPanel eventRequest={{ ...REQUEST, status: "draft" }} />);
    expect(screen.queryByRole("heading", { name: "Cancel event" })).not.toBeInTheDocument();
  });

  async function previewWith(user) {
    await user.type(screen.getByLabelText("Internal cancellation reason"), "Reason");
    await user.click(screen.getByLabelText("The organiser’s request"));
    await user.click(screen.getByRole("button", { name: "Preview cancellation" }));
  }

  it.each([
    ["a 403 with the server's reason", { status: 403, data: { error: "You are not assigned to this event." } }, "You are not assigned to this event."],
    ["a bare 403", { status: 403, data: {} }, "Only the coordinator currently assigned to this event can preview its cancellation."],
    ["a 404 with the server's reason", { status: 404, data: { error: "Event request event-1 not found." } }, "Event request event-1 not found."],
    ["a bare 404", { status: 404 }, "This event request or its cancellation preview is not available."],
    ["a 400 with the server's reason", { status: 400, data: { error: "Reason is too long." } }, "Reason is too long."],
    ["a bare 422", { status: 422, data: {} }, "The cancellation preview request failed (422). Check the reason and try again."],
  ])("SCRUM370_AC1_a_refused_preview_on_%s_says_why_and_that_nothing_changed", async (_case, response, message) => {
    const user = userEvent.setup();
    vi.mocked(getEventCancellationImpact).mockRejectedValue({ response });
    render(<EventCancellationPanel eventRequest={REQUEST} />);

    await previewWith(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(`${message} No changes have been made.`);
    expect(screen.queryByRole("button", { name: "Confirm event cancellation" })).not.toBeInTheDocument();
  });

  it("SCRUM370_AC3_a_preview_that_cannot_reach_the_server_says_to_check_the_connection", async () => {
    const user = userEvent.setup();
    vi.mocked(getEventCancellationImpact).mockRejectedValue(new Error("Network Error"));
    render(<EventCancellationPanel eventRequest={REQUEST} />);

    await previewWith(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The cancellation preview request could not reach the server. Check your connection and try again. No changes have been made.",
    );
  });

  it("SCRUM370_AC2_a_blank_reason_is_refused_before_any_preview_is_read", async () => {
    const user = userEvent.setup();
    render(<EventCancellationPanel eventRequest={REQUEST} />);

    await user.type(screen.getByLabelText("Internal cancellation reason"), "   ");
    await user.click(screen.getByLabelText("A ConnectSphere decision"));
    await user.click(screen.getByRole("button", { name: "Preview cancellation" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A non-blank reason and cancellation initiator are required.",
    );
    expect(getEventCancellationImpact).not.toHaveBeenCalled();
  });

  it("SCRUM370_AC3_the_preview_names_an_item_and_its_lines_even_when_their_names_are_missing", async () => {
    const user = userEvent.setup();
    vi.mocked(getEventCancellationImpact).mockResolvedValue({
      ...IMPACT,
      venueHolds: { details: [] },
      equipmentRequests: {
        count: 1,
        details: [{ id: "equipment-1", lines: [{ id: "line-1", quantity: 3 }] }],
      },
    });
    render(<EventCancellationPanel eventRequest={REQUEST} />);

    await previewWith(user);

    expect(await screen.findByText(/Tentative venue holds to release: 0/)).toBeInTheDocument();
    expect(screen.getByText("Item — Equipment (quantity 3)")).toBeInTheDocument();
  });

  it("SCRUM370_AC1_a_conflict_without_a_status_in_it_keeps_the_general_conflict_text", async () => {
    const user = userEvent.setup();
    vi.mocked(cancelEventRequest).mockRejectedValue({
      response: { status: 409, data: { error: "The event changed while you were cancelling it." } },
    });
    render(<EventCancellationPanel eventRequest={REQUEST} />);

    await previewWith(user);
    await screen.findByText("Auditorium");
    await user.click(screen.getByLabelText(
      "I have reviewed the impact and explicitly confirm cancelling this event.",
    ));
    await user.click(screen.getByRole("button", { name: "Confirm event cancellation" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This event has changed and can no longer be cancelled in its current status. Reopen it to see where it stands.",
    );
  });
});
