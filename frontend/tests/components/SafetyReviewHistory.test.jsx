import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SafetyReviewHistory from "../../src/components/SafetyReviewHistory.jsx";
import { getSafetyReview, getSafetyReviewHistory } from "../../src/services/safetyReviewService";
import { deferred } from "../helpers/async.js";

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
      .toHaveAttribute("href", "/dashboard");
  });
});

describe("SCRUM-490 AC13 the history list and its failures", () => {
  const REVIEWED = {
    id: "event-1",
    eventName: "Industry Night",
    outcome: "rejected",
    note: "No fire marshal named for Hall A.",
    startsAt: "2026-12-01T10:00:00Z",
    endsAt: "2026-12-01T12:00:00Z",
    respondedAt: "2026-11-01T10:00:00Z",
  };

  const renderHistory = () => render(
    <MemoryRouter>
      <SafetyReviewHistory />
    </MemoryRouter>,
  );

  it("SCRUM490_AC13_a_review_with_a_note_shows_the_note_with_its_outcome", async () => {
    getSafetyReviewHistory.mockResolvedValue([REVIEWED]);
    renderHistory();

    expect(await screen.findByText("Note: No fire marshal named for Hall A.")).toBeInTheDocument();
    expect(screen.getByText("Safety arrangement rejected")).toBeInTheDocument();
  });

  it("SCRUM490_AC13_a_list_failure_with_no_server_message_says_the_history_could_not_be_loaded", async () => {
    getSafetyReviewHistory.mockRejectedValue(new Error("Network Error"));
    renderHistory();

    expect(await screen.findByRole("alert")).toHaveTextContent("The review history could not be loaded.");
  });

  it("SCRUM490_AC13_a_details_failure_with_no_server_message_says_the_details_could_not_be_loaded", async () => {
    getSafetyReviewHistory.mockResolvedValue([REVIEWED]);
    getSafetyReview.mockRejectedValue(new Error("Network Error"));
    renderHistory();

    fireEvent.click(await screen.findByRole("button", { name: "View details" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The event's safety details could not be loaded.");
  });

  it.each([
    ["resolves", (load) => load.resolve([REVIEWED])],
    ["fails", (load) => load.reject(new Error("Network Error"))],
  ])("SCRUM490_AC13_a_history_that_%s_after_the_page_is_left_is_dropped_quietly", async (_label, settle) => {
    const load = deferred();
    getSafetyReviewHistory.mockReturnValue(load.promise);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container, unmount } = renderHistory();

    unmount();
    settle(load);
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(container).toBeEmptyDOMElement();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
