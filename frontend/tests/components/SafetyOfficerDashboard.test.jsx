import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SafetyOfficerDashboard from "../../src/components/SafetyOfficerDashboard.jsx";
import {
  getSafetyReview,
  getSafetyReviewQueue,
  submitSafetyReviewResponse,
} from "../../src/services/safetyReviewService";

vi.mock("../../src/services/safetyReviewService", () => ({
  getSafetyReview: vi.fn(),
  getSafetyReviewQueue: vi.fn(),
  submitSafetyReviewResponse: vi.fn(),
}));
vi.mock("../../src/components/CoordinatorNotifications", () => ({
  default: () => <div>Notifications</div>,
}));

const DETAIL = {
  event: {
    id: "event-1",
    eventName: "Industry Night",
    status: "safety_review",
    startsAt: "2026-12-01T10:00:00Z",
    endsAt: "2026-12-01T12:00:00Z",
    expectedAttendance: 120,
    accessibilityRequirements: "Step-free access",
    coordinatorNote: "Keep the east exit clear.",
  },
  venues: [],
  equipment: null,
  history: [],
};

function queueEvent(id, waitingSeconds, overrides = {}) {
  return {
    id,
    eventName: `Event ${id}`,
    startsAt: "2026-12-01T10:00:00Z",
    endsAt: "2026-12-01T12:00:00Z",
    venues: ["Hall A"],
    expectedAttendance: 100,
    coordinatorName: "Casey Coordinator",
    waitingSeconds,
    ...overrides,
  };
}

function failure(message, status) {
  return Object.assign(new Error(message), {
    response: { data: message ? { error: message } : {}, status },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  getSafetyReviewQueue.mockResolvedValue([]);
  getSafetyReview.mockResolvedValue(DETAIL);
  submitSafetyReviewResponse.mockResolvedValue({});
});

describe("SCRUM-490 Safety Officer dashboard", () => {
  it("shows the queue, missing facts, and all waiting-time labels", async () => {
    getSafetyReviewQueue.mockResolvedValue([
      queueEvent("minute", 0, { venues: [], expectedAttendance: null, coordinatorName: null }),
      queueEvent("one-minute", 60),
      queueEvent("minutes", 120),
      queueEvent("one-hour", 3600),
      queueEvent("hours", 7200),
      queueEvent("one-day", 86400),
      queueEvent("days", 172800),
      queueEvent("invalid", "not a number"),
    ]);

    render(<SafetyOfficerDashboard user={{ name: "Riley" }} />);

    expect(await screen.findByText("Event minute")).toBeInTheDocument();
    expect(screen.getByText("Signed in as Riley.")).toBeInTheDocument();
    expect(screen.getAllByText("Waiting: Less than a minute")).toHaveLength(2);
    expect(screen.getByText("Waiting: 1 minute")).toBeInTheDocument();
    expect(screen.getByText("Waiting: 2 minutes")).toBeInTheDocument();
    expect(screen.getByText("Waiting: 1 hour")).toBeInTheDocument();
    expect(screen.getByText("Waiting: 2 hours")).toBeInTheDocument();
    expect(screen.getByText("Waiting: 1 day")).toBeInTheDocument();
    expect(screen.getByText("Waiting: 2 days")).toBeInTheDocument();
    const minuteRow = screen.getByText("Event minute").closest("li");
    expect(within(minuteRow).getByText("Venues: Not recorded")).toBeInTheDocument();
    expect(within(minuteRow).getByText("Expected attendance: Not recorded")).toBeInTheDocument();
    expect(within(minuteRow).getByText("Coordinator: Not recorded")).toBeInTheDocument();
  });

  it("shows the empty queue and falls back to the user's email", async () => {
    render(<SafetyOfficerDashboard user={{ email: "riley@example.com" }} />);

    expect(await screen.findByText("No events are waiting for a safety review.")).toBeInTheDocument();
    expect(screen.getByText("Signed in as riley@example.com.")).toBeInTheDocument();
    expect(screen.getByText("Notifications")).toBeInTheDocument();
  });

  it.each([
    ["service message", failure("Queue unavailable", 500), "Queue unavailable"],
    ["default message", new Error("no response"), "The safety review list could not be loaded."],
  ])("shows the queue error using the %s", async (_name, error, message) => {
    getSafetyReviewQueue.mockRejectedValue(error);
    render(<SafetyOfficerDashboard user={{ name: "Riley" }} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("opens and closes a review, then handles a response and refreshes the history", async () => {
    const user = userEvent.setup();
    getSafetyReviewQueue.mockResolvedValue([queueEvent("event-1", 60)]);
    render(<SafetyOfficerDashboard user={{ name: "Riley" }} />);

    await user.click(await screen.findByRole("button", { name: "Review event" }));
    expect(await screen.findByRole("heading", { name: "Industry Night" })).toBeInTheDocument();
    expect(screen.getByText("No booked venues are recorded.")).toBeInTheDocument();
    expect(screen.getByText("No arranged equipment request is recorded.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Submit response" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Response recorded: Approved.");
    expect(submitSafetyReviewResponse).toHaveBeenCalledWith("event-1", {
      outcome: "approved",
      note: "",
      affectedBookingIds: [],
      equipmentAffected: false,
    });
    expect(getSafetyReviewQueue).toHaveBeenCalledTimes(2);
    expect(getSafetyReview).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole("button", { name: /Back to Safety review/ }));
    expect(await screen.findByText("Event event-1")).toBeInTheDocument();
  });

  it.each([
    ["detail message", failure("Details unavailable", 500), "Details unavailable"],
    ["default detail message", new Error("no response"), "The event's safety details could not be loaded."],
  ])("shows the %s when opening an event fails", async (_name, error, message) => {
    const user = userEvent.setup();
    getSafetyReviewQueue.mockResolvedValue([queueEvent("event-1", 0)]);
    getSafetyReview.mockRejectedValue(error);
    render(<SafetyOfficerDashboard user={{ name: "Riley" }} />);

    await user.click(await screen.findByRole("button", { name: "Review event" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: /Back to Safety review/ })).toBeInTheDocument();
  });

  it("reports a failed response and refreshes the current review after a conflict", async () => {
    const user = userEvent.setup();
    getSafetyReviewQueue.mockResolvedValue([queueEvent("event-1", 60)]);
    submitSafetyReviewResponse.mockRejectedValue(failure("Event is now approved.", 409));
    render(<SafetyOfficerDashboard user={{ name: "Riley" }} />);

    await user.click(await screen.findByRole("button", { name: "Review event" }));
    await user.click(screen.getByRole("button", { name: "Submit response" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Event is now approved.");
    expect(getSafetyReviewQueue).toHaveBeenCalledTimes(2);
    expect(getSafetyReview).toHaveBeenCalledTimes(2);
  });

  it("reports when a conflict refresh cannot load the latest review", async () => {
    const user = userEvent.setup();
    getSafetyReviewQueue.mockResolvedValue([queueEvent("event-1", 60)]);
    getSafetyReview.mockResolvedValueOnce(DETAIL).mockRejectedValueOnce(new Error("reload failed"));
    submitSafetyReviewResponse.mockRejectedValue(failure("Event changed.", 409));
    render(<SafetyOfficerDashboard user={{ name: "Riley" }} />);

    await user.click(await screen.findByRole("button", { name: "Review event" }));
    await user.click(screen.getByRole("button", { name: "Submit response" }));

    expect(await screen.findByRole("alert"))
      .toHaveTextContent("Event changed. The latest safety history could not be loaded.");
  });

  it("shows the response service fallback for an unstructured failure", async () => {
    const user = userEvent.setup();
    getSafetyReviewQueue.mockResolvedValue([queueEvent("event-1", 60)]);
    submitSafetyReviewResponse.mockRejectedValue(new Error("network failure"));
    render(<SafetyOfficerDashboard user={{ name: "Riley" }} />);

    await user.click(await screen.findByRole("button", { name: "Review event" }));
    await user.click(screen.getByRole("button", { name: "Submit response" }));

    expect(await screen.findByRole("alert"))
      .toHaveTextContent("The safety review response could not be submitted. Please try again.");
    expect(getSafetyReviewQueue).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["request changes", "changes_requested", "Changes requested"],
    ["reject", "rejected", "Safety arrangement rejected"],
  ])("records the %s outcome with its label", async (_name, outcome, label) => {
    const user = userEvent.setup();
    getSafetyReviewQueue.mockResolvedValue([queueEvent("event-1", 60)]);
    render(<SafetyOfficerDashboard user={{ name: "Riley" }} />);

    await user.click(await screen.findByRole("button", { name: "Review event" }));
    await user.selectOptions(screen.getByRole("combobox"), outcome);
    await user.type(screen.getByRole("textbox"), "Update the plan.");
    await user.click(screen.getByRole("button", { name: "Submit response" }));

    expect(await screen.findByRole("status")).toHaveTextContent(`Response recorded: ${label}.`);
  });

  it("surfaces a conflict if the latest safety history cannot be loaded after a response", async () => {
    const user = userEvent.setup();
    getSafetyReviewQueue.mockResolvedValue([queueEvent("event-1", 60)]);
    getSafetyReview.mockResolvedValueOnce(DETAIL).mockRejectedValueOnce(new Error("reload failed"));
    render(<SafetyOfficerDashboard user={{ name: "Riley" }} />);

    await user.click(await screen.findByRole("button", { name: "Review event" }));
    await user.click(screen.getByRole("button", { name: "Submit response" }));

    expect(await screen.findByRole("alert"))
      .toHaveTextContent("The response was recorded, but the safety history could not be refreshed.");
  });
});
