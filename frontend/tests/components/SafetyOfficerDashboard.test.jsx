import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SafetyOfficerDashboard, {
  SafetyReviewDetail,
} from "../../src/components/SafetyOfficerDashboard.jsx";
import {
  getSafetyReview,
  getSafetyReviewQueue,
  submitSafetyReviewResponse,
} from "../../src/services/safetyReviewService.js";

vi.mock("../../src/services/safetyReviewService.js", () => ({
  getSafetyReview: vi.fn(),
  getSafetyReviewQueue: vi.fn(),
  submitSafetyReviewResponse: vi.fn(),
}));

vi.mock("../../src/components/CoordinatorNotifications.jsx", () => ({
  default: () => null,
}));

const queueEvent = (overrides = {}) => ({
  id: "event-1",
  eventName: "Industry Night",
  startsAt: "2026-12-01T10:00:00Z",
  endsAt: "2026-12-01T12:00:00Z",
  venues: ["Hall A"],
  expectedAttendance: 120,
  coordinatorName: "Coordinator",
  waitingSeconds: 60,
  ...overrides,
});

const reviewDetail = (overrides = {}) => ({
  event: {
    id: "event-1",
    eventName: "Industry Night",
    status: "safety_review",
    startsAt: "2026-12-01T10:00:00Z",
    endsAt: "2026-12-01T12:00:00Z",
    expectedAttendance: 120,
    accessibilityRequirements: "Step-free access",
    coordinatorNote: "Keep the east exit clear.",
    ...overrides.event,
  },
  venues: [
    {
      bookingId: "booking-1",
      name: "Hall A",
      location: "Level 2",
      capacity: 250,
      layout: "Theatre",
      emergencyAccess: "East exit",
      knownRestrictions: "No open flames",
    },
    {
      bookingId: "booking-2",
      name: "Hall B",
      location: null,
      capacity: null,
      layout: "",
      emergencyAccess: null,
      knownRestrictions: undefined,
    },
  ],
  equipment: {
    lines: [
      { id: "equipment-1", name: "Projector", quantity: 1, technicalNotes: "Dedicated circuit" },
      { id: "equipment-2", name: "Microphone", quantity: 2, technicalNotes: "" },
    ],
  },
  history: [
    {
      id: "history-1",
      outcome: "approved",
      safetyOfficerName: "Officer",
      createdAt: "2026-11-30T10:00:00Z",
      note: "Looks good.",
      affectedBookingIds: ["booking-1"],
      equipmentAffected: true,
    },
    {
      id: "history-2",
      outcome: "future_outcome",
      safetyOfficerName: null,
      createdAt: "2026-11-30T11:00:00Z",
      note: "",
      affectedBookingIds: [],
      equipmentAffected: false,
    },
  ],
  ...overrides,
});

const renderDashboard = () => render(<SafetyOfficerDashboard user={{ email: "officer@example.com" }} />);

beforeEach(() => {
  vi.clearAllMocks();
  getSafetyReviewQueue.mockResolvedValue([]);
  getSafetyReview.mockResolvedValue(reviewDetail());
  submitSafetyReviewResponse.mockResolvedValue({});
});

describe("SafetyOfficerDashboard", () => {
  it("renders queue items and formats all waiting-time ranges", async () => {
    getSafetyReviewQueue.mockResolvedValue([
      queueEvent({ id: "under-minute", eventName: "Under a minute", waitingSeconds: 59 }),
      queueEvent({ id: "one-minute", eventName: "One minute", waitingSeconds: 60 }),
      queueEvent({ id: "minutes", eventName: "Minutes", waitingSeconds: 120 }),
      queueEvent({ id: "one-hour", eventName: "One hour", waitingSeconds: 3600 }),
      queueEvent({ id: "hours", eventName: "Hours", waitingSeconds: 7200 }),
      queueEvent({ id: "one-day", eventName: "One day", waitingSeconds: 86400 }),
      queueEvent({ id: "days", eventName: "Days", waitingSeconds: 172800 }),
      queueEvent({
        id: "not-recorded",
        eventName: "Not recorded",
        startsAt: null,
        endsAt: null,
        venues: [],
        expectedAttendance: null,
        coordinatorName: null,
        waitingSeconds: null,
      }),
    ]);

    renderDashboard();

    for (const text of [
      "Signed in as officer@example.com.",
      "Waiting: Less than a minute",
      "Waiting: 1 minute",
      "Waiting: 2 minutes",
      "Waiting: 1 hour",
      "Waiting: 2 hours",
      "Waiting: 1 day",
      "Waiting: 2 days",
      "Venues: Not recorded",
      "Expected attendance: Not recorded",
      "Coordinator: Not recorded",
      "Date and time not recorded – Date and time not recorded",
    ]) {
      expect(await screen.findAllByText(text)).not.toHaveLength(0);
    }
  });

  it("shows an empty queue after loading", async () => {
    renderDashboard();
    expect(await screen.findByText("No events are waiting for a safety review.")).toBeInTheDocument();
  });

  it.each([
    [{ response: { data: { error: "Queue unavailable" } } }, "Queue unavailable"],
    [new Error("offline"), "The safety review list could not be loaded."],
  ])("shows an error when the queue fails", async (error, message) => {
    getSafetyReviewQueue.mockRejectedValue(error);
    renderDashboard();
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("loads review details, shows history and returns to the queue", async () => {
    getSafetyReviewQueue.mockResolvedValue([queueEvent()]);
    getSafetyReview.mockResolvedValue(reviewDetail());
    renderDashboard();

    fireEvent.click(await screen.findByRole("button", { name: "Review event" }));

    expect(await screen.findByText("Step-free access")).toBeInTheDocument();
    expect(screen.getByText("Looks good.")).toBeInTheDocument();
    expect(screen.getByText(/Safety Officer ·/)).toBeInTheDocument();
    expect(screen.getByText("future_outcome")).toBeInTheDocument();
    expect(screen.getByText("Affected bookings: 1; equipment request affected: yes.")).toBeInTheDocument();
    expect(screen.getByText("Affected bookings: 0; equipment request affected: no.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Back to Safety review/ }));
    expect(await screen.findByText("Industry Night")).toBeInTheDocument();
    expect(getSafetyReview).toHaveBeenCalledWith("event-1");
  });

  it("shows fallback values for a review that has no arrangements or response form", async () => {
    render(
      <SafetyReviewDetail
        detail={reviewDetail({
          event: {
            status: "approved",
            startsAt: null,
            endsAt: null,
            expectedAttendance: null,
            accessibilityRequirements: "",
            coordinatorNote: null,
          },
          venues: [],
          equipment: null,
          history: [],
        })}
        onSubmitted={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(screen.getByText("No booked venues are recorded.")).toBeInTheDocument();
    expect(screen.getByText("No arranged equipment request is recorded.")).toBeInTheDocument();
    expect(screen.getByText("No earlier safety responses.")).toBeInTheDocument();
    expect(screen.getByText("This event is now approved; no further response can be submitted.")).toBeInTheDocument();
    expect(screen.getAllByText("Not recorded").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Submit response" })).not.toBeInTheDocument();
  });

  it("submits changed arrangements and reloads the queue and review", async () => {
    getSafetyReviewQueue.mockResolvedValue([queueEvent()]);
    getSafetyReview.mockResolvedValue(reviewDetail());
    renderDashboard();

    fireEvent.click(await screen.findByRole("button", { name: "Review event" }));
    await screen.findByText("Step-free access");

    fireEvent.change(screen.getByLabelText("Response"), { target: { value: "changes_requested" } });
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "Please revise the plan." } });
    const booking = screen.getAllByLabelText("Mark this booking as affected")[0];
    fireEvent.click(booking);
    fireEvent.click(booking);
    fireEvent.click(booking);
    fireEvent.click(screen.getByLabelText("Mark the equipment request as affected"));
    fireEvent.click(screen.getByRole("button", { name: "Submit response" }));

    await screen.findByText("Response recorded: Changes requested.");
    expect(submitSafetyReviewResponse).toHaveBeenCalledWith("event-1", {
      outcome: "changes_requested",
      note: "Please revise the plan.",
      affectedBookingIds: ["booking-1"],
      equipmentAffected: true,
    });
    expect(getSafetyReviewQueue).toHaveBeenCalledTimes(2);
    expect(getSafetyReview).toHaveBeenCalledTimes(2);
  });

  it("shows the loading state while opening and submitting a review", async () => {
    let resolveReview;
    getSafetyReview.mockReturnValueOnce(new Promise((resolve) => { resolveReview = resolve; }));
    getSafetyReviewQueue.mockResolvedValue([queueEvent()]);
    renderDashboard();

    await waitFor(() => expect(getSafetyReviewQueue).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Review event" }));
    expect(screen.getByText("Loading event arrangements...")).toBeInTheDocument();
    resolveReview(reviewDetail());
    await screen.findByText("Step-free access");

    let resolveSubmit;
    submitSafetyReviewResponse.mockReturnValueOnce(new Promise((resolve) => { resolveSubmit = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Submit response" }));
    expect(screen.getByRole("button", { name: "Submitting..." })).toBeDisabled();
    resolveSubmit({});
    await screen.findByText("Response recorded: Approved.");
  });

  it.each([
    [{ response: { data: { error: "Details unavailable" } } }, "Details unavailable"],
    [new Error("offline"), "The event's safety details could not be loaded."],
  ])("shows an error when review details fail to load", async (error, message) => {
    getSafetyReviewQueue.mockResolvedValue([queueEvent()]);
    getSafetyReview.mockRejectedValue(error);
    renderDashboard();

    fireEvent.click(await screen.findByRole("button", { name: "Review event" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("refreshes stale review details after a conflict", async () => {
    getSafetyReviewQueue.mockResolvedValue([queueEvent()]);
    getSafetyReview.mockResolvedValueOnce(reviewDetail()).mockRejectedValueOnce(new Error("offline"));
    submitSafetyReviewResponse.mockRejectedValue({
      response: { status: 409, data: { error: "The review has changed." } },
    });
    renderDashboard();
    fireEvent.click(await screen.findByRole("button", { name: "Review event" }));
    await screen.findByText("Step-free access");
    fireEvent.click(screen.getByRole("button", { name: "Submit response" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The review has changed. The latest safety history could not be loaded.",
    );
    expect(getSafetyReviewQueue).toHaveBeenCalledTimes(2);
  });

  it("shows the submission error and handles a failed post-response refresh", async () => {
    getSafetyReviewQueue.mockResolvedValue([queueEvent()]);
    getSafetyReview.mockResolvedValueOnce(reviewDetail()).mockRejectedValueOnce(new Error("offline"));
    submitSafetyReviewResponse.mockResolvedValue({});
    renderDashboard();
    fireEvent.click(await screen.findByRole("button", { name: "Review event" }));
    await screen.findByText("Step-free access");
    fireEvent.change(screen.getByLabelText("Response"), { target: { value: "rejected" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Unsafe setup." } });
    fireEvent.click(screen.getByRole("button", { name: "Submit response" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The response was recorded, but the safety history could not be refreshed.",
    );
    expect(screen.getByText("Response recorded: Safety arrangement rejected.")).toBeInTheDocument();
  });

  it("uses the generic submission error when the service has no response details", async () => {
    getSafetyReviewQueue.mockResolvedValue([queueEvent()]);
    submitSafetyReviewResponse.mockRejectedValue(new Error("offline"));
    renderDashboard();
    fireEvent.click(await screen.findByRole("button", { name: "Review event" }));
    await screen.findByText("Step-free access");
    fireEvent.click(screen.getByRole("button", { name: "Submit response" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The safety review response could not be submitted. Please try again.",
    );
  });
});
