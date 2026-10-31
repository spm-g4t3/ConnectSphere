import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import SafetyOfficerDashboard from "../../src/components/SafetyOfficerDashboard.jsx";
import SafetyReviewHistory from "../../src/components/SafetyReviewHistory.jsx";
import {
  getSafetyReview,
  getSafetyReviewHistory,
  getSafetyReviewQueue,
  submitSafetyReviewResponse,
} from "../../src/services/safetyReviewService";

vi.mock("../../src/services/safetyReviewService", () => ({
  getSafetyReview: vi.fn(),
  getSafetyReviewHistory: vi.fn(),
  getSafetyReviewQueue: vi.fn(),
  submitSafetyReviewResponse: vi.fn(),
}));
vi.mock("../../src/components/NotificationInbox", () => ({
  default: () => <div>Notifications</div>,
}));

function queueEvent(id) {
  return {
    id,
    eventName: `Event ${id}`,
    startsAt: "2026-12-01T10:00:00Z",
    endsAt: "2026-12-01T12:00:00Z",
    venues: ["Hall A"],
    expectedAttendance: 100,
    coordinatorName: "Casey Coordinator",
    waitingSeconds: 120,
  };
}

function historyRow(id) {
  return {
    id,
    eventName: `Event ${id}`,
    outcome: "approved",
    startsAt: "2026-12-01T10:00:00Z",
    endsAt: "2026-12-01T12:00:00Z",
    respondedAt: "2026-11-01T10:00:00Z",
  };
}

function detailFor(id, status = "safety_review") {
  return {
    event: { id, eventName: `Event ${id}`, status },
    venues: [],
    equipment: null,
    history: [],
  };
}

function rowButton(eventName, buttonName) {
  const row = screen.getByText(eventName).closest("li");
  return within(row).getByRole("button", { name: buttonName });
}

async function renderQueue() {
  render(<SafetyOfficerDashboard user={{ name: "Riley" }} />);
  await screen.findByText("Event event-1");
}

async function renderHistory() {
  render(
    <MemoryRouter>
      <SafetyReviewHistory />
    </MemoryRouter>,
  );
  await screen.findByText("Event event-1");
}

beforeEach(() => {
  vi.resetAllMocks();
  getSafetyReviewQueue.mockResolvedValue([queueEvent("event-1"), queueEvent("event-2")]);
  getSafetyReviewHistory.mockResolvedValue([historyRow("event-1"), historyRow("event-2")]);
  getSafetyReview.mockImplementation(async (id) => detailFor(id));
  submitSafetyReviewResponse.mockResolvedValue({});
});

describe("SCRUM591_AC2 one h1 per Safety Officer screen, sections at h2", () => {
  it("SCRUM591_AC2_safety_review_queue_has_one_h1_and_its_section_at_h2", async () => {
    await renderQueue();

    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("Safety review");
    expect(screen.getByRole("heading", { level: 2, name: "Waiting for review" })).toBeInTheDocument();
  });

  it("SCRUM591_AC2_review_history_has_one_h1_and_its_section_at_h2", async () => {
    await renderHistory();

    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("Review history");
    expect(screen.getByRole("heading", { level: 2, name: "Reviewed events" })).toBeInTheDocument();
  });

  it("SCRUM591_AC2_review_detail_keeps_one_h1_with_the_event_at_h2", async () => {
    const user = userEvent.setup();
    await renderQueue();

    await user.click(rowButton("Event event-1", "Review event"));

    expect(await screen.findByRole("heading", { level: 2, name: "Event event-1" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });
});

describe("SCRUM591_AC6 focus follows the user into a review and back", () => {
  it("SCRUM591_AC6_opening_a_review_moves_focus_to_the_event_heading", async () => {
    const user = userEvent.setup();
    await renderQueue();

    await user.click(rowButton("Event event-2", "Review event"));

    const heading = await screen.findByRole("heading", { level: 2, name: "Event event-2" });
    expect(heading).toHaveFocus();
  });

  it("SCRUM591_AC6_back_returns_focus_to_the_row_that_was_opened", async () => {
    const user = userEvent.setup();
    await renderQueue();

    // The second row, so focusing the first button by accident would fail.
    await user.click(rowButton("Event event-2", "Review event"));
    await screen.findByRole("heading", { level: 2, name: "Event event-2" });
    await user.click(screen.getByRole("button", { name: /Back to Safety review/ }));

    expect(rowButton("Event event-2", "Review event")).toHaveFocus();
  });

  it("SCRUM591_AC6_back_focuses_the_list_heading_when_the_row_has_left_the_queue", async () => {
    const user = userEvent.setup();
    await renderQueue();

    await user.click(rowButton("Event event-1", "Review event"));
    await screen.findByRole("heading", { level: 2, name: "Event event-1" });

    // Approving takes the event out of the queue the dashboard refetches.
    getSafetyReviewQueue.mockResolvedValue([queueEvent("event-2")]);
    getSafetyReview.mockImplementation(async (id) => detailFor(id, "approved"));
    await user.click(screen.getByRole("button", { name: "Submit response" }));
    await screen.findByText("Response recorded: Approved.");

    await user.click(screen.getByRole("button", { name: /Back to Safety review/ }));

    expect(screen.queryByText("Event event-1")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Waiting for review" })).toHaveFocus();
  });

  it("SCRUM591_AC6_back_from_history_details_returns_focus_to_the_row_that_was_opened", async () => {
    const user = userEvent.setup();
    await renderHistory();

    await user.click(rowButton("Event event-2", "View details"));
    expect(await screen.findByRole("heading", { level: 2, name: "Event event-2" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: /Back to Review history/ }));

    expect(rowButton("Event event-2", "View details")).toHaveFocus();
  });
});
