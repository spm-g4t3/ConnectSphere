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
    expect(screen.getByText(new Date("2026-06-01T09:00:00Z").toLocaleString())).toBeInTheDocument();
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

  it("does not expose cancellation controls for an unsupported status", () => {
    render(<EventCancellationPanel eventRequest={{ ...REQUEST, status: "draft" }} />);
    expect(screen.queryByRole("heading", { name: "Cancel event" })).not.toBeInTheDocument();
  });
});
