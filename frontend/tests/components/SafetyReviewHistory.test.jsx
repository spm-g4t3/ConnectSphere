import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SafetyReviewHistory from "../../src/components/SafetyReviewHistory.jsx";
import { getSafetyReview, getSafetyReviewHistory } from "../../src/services/safetyReviewService";

vi.mock("../../src/services/safetyReviewService", () => ({
  getSafetyReview: vi.fn(),
  getSafetyReviewHistory: vi.fn(),
  getSafetyReviewQueue: vi.fn(),
  submitSafetyReviewResponse: vi.fn(),
}));

describe("SCRUM-490 Safety review history", () => {
  it("SCRUM490_AC13_shows_read_only_details_and_links_active_reviews_to_the_queue", async () => {
    getSafetyReviewHistory.mockResolvedValue([{
      id: "event-1",
      eventName: "Industry Night",
      outcome: "changes_requested",
      startsAt: "2026-12-01T10:00:00Z",
      endsAt: "2026-12-01T12:00:00Z",
      respondedAt: "2026-11-01T10:00:00Z",
    }]);
    getSafetyReview.mockResolvedValue({
      event: {
        id: "event-1",
        eventName: "Industry Night",
        status: "safety_review",
      },
      venues: [{ bookingId: "booking-1", name: "Hall A" }],
      equipment: null,
      history: [],
    });

    render(
      <MemoryRouter>
        <SafetyReviewHistory />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "View details" }));

    expect(await screen.findByRole("heading", { name: "Industry Night" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit response" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Mark this booking as affected")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the Safety review queue" }))
      .toHaveAttribute("href", "/safety-review");
  });
});
