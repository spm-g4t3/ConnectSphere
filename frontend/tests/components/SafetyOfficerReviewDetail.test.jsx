import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SafetyReviewDetail } from "../../src/components/SafetyOfficerDashboard.jsx";

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
});
