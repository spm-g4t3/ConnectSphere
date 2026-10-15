import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SafetyReviewDetail } from "../../src/components/SafetyOfficerDashboard.jsx";
import { submitSafetyReviewResponse } from "../../src/services/safetyReviewService";

vi.mock("../../src/services/safetyReviewService", () => ({
  getSafetyReview: vi.fn(),
  getSafetyReviewQueue: vi.fn(),
  submitSafetyReviewResponse: vi.fn(),
}));

describe("SCRUM-490 Safety Officer review details", () => {
  it("SCRUM490_AC3_shows_only_the_event_and_arrangement_facts_the_review_needs", () => {
    render(
      <SafetyReviewDetail
        detail={{
          event: {
            id: "event-1",
            eventName: "IS212 Industry Night",
            status: "safety_review",
            startsAt: "2026-12-01T10:00:00Z",
            endsAt: "2026-12-01T12:00:00Z",
            expectedAttendance: 120,
            accessibilityRequirements: "Step-free access",
            coordinatorNote: "Crowd exits through the east doors.",
          },
          venues: [{
            bookingId: "booking-1",
            name: "Hall A",
            location: "Level 2",
            capacity: 250,
            layout: "Theatre",
            emergencyAccess: null,
            knownRestrictions: "No open flames",
            startsAt: "2026-12-01T09:00:00Z",
            endsAt: "2026-12-01T13:00:00Z",
          }],
          equipment: {
            lines: [{
              id: "line-1",
              name: "Projector",
              quantity: 1,
              technicalNotes: "Dedicated circuit required.",
            }],
          },
          history: [],
        }}
        onSubmitted={vi.fn()}
        onError={vi.fn()}
      />,
    );

    for (const value of [
      "IS212 Industry Night",
      "120",
      "Step-free access",
      "Crowd exits through the east doors.",
      "Hall A",
      "Level 2",
      "250",
      "Theatre",
      "No open flames",
      "Projector",
      "Dedicated circuit required.",
    ]) {
      expect(screen.getByText(value)).toBeInTheDocument();
    }

    const emergencyAccess = screen.getByText("Emergency access");
    expect(emergencyAccess.nextElementSibling).toHaveTextContent("Not recorded");
    expect(screen.queryByText("Booked for")).not.toBeInTheDocument();
    expect(screen.queryByText(/09:00/)).not.toBeInTheDocument();
    expect(screen.queryByText(/internal planning/)).not.toBeInTheDocument();
  });

  it("marks only selected arrangements and submits a requested-changes response", async () => {
    const user = userEvent.setup();
    const onSubmitted = vi.fn();
    const onError = vi.fn();
    const submitResponse = vi.fn().mockResolvedValue({});
    vi.mocked(submitSafetyReviewResponse).mockImplementation(submitResponse);
    render(
      <SafetyReviewDetail
        detail={{
          event: {
            id: "event-2",
            eventName: "Careers Fair",
            status: "safety_review",
            expectedAttendance: null,
            accessibilityRequirements: " ",
            coordinatorNote: null,
          },
          venues: [
            { bookingId: "booking-1", name: "Hall A", capacity: null },
            { bookingId: "booking-2", name: "Hall B" },
          ],
          equipment: {
            requestId: "equipment-1",
            lines: [{ id: "line-1", name: "PA System", quantity: 1, technicalNotes: " " }],
          },
          history: [
            {
              id: "response-1",
              outcome: "rejected",
              note: "Keep the exit clear.",
              safetyOfficerName: null,
              affectedBookingIds: ["booking-2"],
              equipmentAffected: true,
              createdAt: "2026-11-01T10:00:00Z",
            },
            {
              id: "response-2",
              outcome: "new_outcome",
              note: null,
              safetyOfficerName: "Riley Officer",
              affectedBookingIds: [],
              equipmentAffected: false,
              createdAt: "2026-11-02T10:00:00Z",
            },
          ],
        }}
        onSubmitted={onSubmitted}
        onError={onError}
      />,
    );

    expect(screen.getAllByText("Not recorded").length).toBeGreaterThan(0);
    expect(screen.getByText("Safety arrangement rejected")).toBeInTheDocument();
    expect(screen.getByText("new_outcome")).toBeInTheDocument();
    expect(screen.getByText(/^Safety Officer ·/)).toBeInTheDocument();
    expect(screen.getByText(/Affected bookings: 1; equipment request affected: yes/)).toBeInTheDocument();
    expect(screen.getByText(/Affected bookings: 0; equipment request affected: no/)).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox"), "changes_requested");
    const affectedBookings = screen.getAllByLabelText("Mark this booking as affected");
    await user.click(affectedBookings[0]);
    await user.click(affectedBookings[0]);
    await user.click(affectedBookings[1]);
    await user.click(screen.getByLabelText("Mark the equipment request as affected"));
    await user.type(screen.getByRole("textbox"), "Move the PA speakers.");
    await user.click(screen.getByRole("button", { name: "Submit response" }));

    expect(submitResponse).toHaveBeenCalledWith("event-2", {
      outcome: "changes_requested",
      note: "Move the PA speakers.",
      affectedBookingIds: ["booking-2"],
      equipmentAffected: true,
    });
    expect(onError).toHaveBeenCalledWith(null);
    expect(onSubmitted).toHaveBeenCalledWith("event-2", "changes_requested");
  });

  it("hides response actions when the event is no longer in Safety review", () => {
    render(
      <SafetyReviewDetail
        detail={{
          event: {
            id: "event-3",
            eventName: "Completed Review",
            status: "safety_approved",
            expectedAttendance: 0,
            accessibilityRequirements: null,
            coordinatorNote: "",
          },
          venues: [{ bookingId: "booking-3", name: "Hall C", capacity: 0 }],
          equipment: { requestId: "equipment-3", lines: [] },
          history: [],
        }}
        onSubmitted={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("This event is now safety_approved");
    expect(screen.queryByRole("button", { name: "Submit response" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Mark this booking as affected")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Mark the equipment request as affected")).not.toBeInTheDocument();
    expect(screen.getByText("No earlier safety responses.")).toBeInTheDocument();
  });

  it("reports the server error when a response fails", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    vi.mocked(submitSafetyReviewResponse).mockRejectedValue({
      response: { status: 409, data: { error: "The event is now approved." } },
    });
    render(
      <SafetyReviewDetail
        detail={{
          event: {
            id: "event-4",
            eventName: "Changed Event",
            status: "safety_review",
            expectedAttendance: 12,
          },
          venues: [],
          equipment: null,
          history: [],
        }}
        onSubmitted={vi.fn()}
        onError={onError}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Submit response" }));
    await vi.waitFor(() => expect(onError).toHaveBeenLastCalledWith({
      status: 409,
      message: "The event is now approved.",
    }));
  });
});
