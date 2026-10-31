import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import SafetyOfficerDashboard from "../../src/components/SafetyOfficerDashboard.jsx";
import SafetyReviewHistory from "../../src/components/SafetyReviewHistory.jsx";
import { SafetyReviewDetail } from "../../src/components/SafetyReviewDetail.jsx";
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

// jsdom has no showModal or close, so the reject confirmation's dialog gets
// minimal stand-ins that toggle the open attribute.
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");

function restoreDialogMethod(name, original) {
  if (original) Object.defineProperty(HTMLDialogElement.prototype, name, original);
  else delete HTMLDialogElement.prototype[name];
}

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
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value() { this.setAttribute("open", ""); },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value() { this.removeAttribute("open"); },
  });
});

afterEach(() => {
  // Unmount while the stubs exist: an open dialog's cleanup calls close().
  cleanup();
  restoreDialogMethod("showModal", originalShowModal);
  restoreDialogMethod("close", originalClose);
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

function expectEveryButtonIsShared() {
  const buttons = screen.getAllByRole("button");
  for (const button of buttons) expect(button).toHaveClass("ui-button");
}

function renderDetail(detail) {
  render(<SafetyReviewDetail detail={detail} onSubmitted={vi.fn()} onError={vi.fn()} />);
}

const OUTCOMES = [
  ["approved", "Approved", "success"],
  ["changes_requested", "Changes requested", "warning"],
  ["rejected", "Safety arrangement rejected", "danger"],
];

describe("SCRUM591_AC3 the Safety Officer screens use the shared buttons and status badges", () => {
  it("SCRUM591_AC3_safety_officer_screens_use_the_shared_button", async () => {
    const user = userEvent.setup();
    await renderQueue();
    expectEveryButtonIsShared();

    // The detail carries the response form, so Submit response is checked too.
    await user.click(rowButton("Event event-1", "Review event"));
    await screen.findByRole("heading", { level: 2, name: "Event event-1" });
    expect(screen.getByRole("button", { name: "Submit response" })).toBeInTheDocument();
    expectEveryButtonIsShared();
    expect(screen.getByRole("button", { name: /Back to Safety review/ })).toHaveClass("ui-button--link");
  });

  it("SCRUM591_AC3_review_history_screens_use_the_shared_button", async () => {
    const user = userEvent.setup();
    await renderHistory();
    expectEveryButtonIsShared();

    await user.click(rowButton("Event event-1", "View details"));
    await screen.findByRole("heading", { level: 2, name: "Event event-1" });
    expectEveryButtonIsShared();
    expect(screen.getByRole("button", { name: /Back to Review history/ })).toHaveClass("ui-button--link");
  });

  it("SCRUM591_AC3_no_screen_keeps_its_own_back_class", async () => {
    const user = userEvent.setup();
    await renderQueue();
    await user.click(rowButton("Event event-1", "Review event"));
    await screen.findByRole("heading", { level: 2, name: "Event event-1" });
    expect(document.querySelector(".safety-review__back")).toBeNull();
  });

  it.each(OUTCOMES)(
    "SCRUM591_AC3_outcomes_show_as_status_badges_with_their_tone (%s)",
    async (outcome, label, tone) => {
      getSafetyReviewHistory.mockResolvedValue([{ ...historyRow("event-1"), outcome }]);
      await renderHistory();

      const row = screen.getByText("Event event-1").closest("li");
      // The "Outcome:" text stays, so the meaning is not carried by colour alone.
      expect(row).toHaveTextContent(`Outcome: ${label}`);
      expect(within(row).getByText(label)).toHaveClass("ui-status-badge", `ui-status-badge--${tone}`);
    },
  );

  it.each(OUTCOMES)(
    "SCRUM591_AC3_detail_history_outcomes_show_as_status_badges_with_their_tone (%s)",
    (outcome, label, tone) => {
      renderDetail({
        ...detailFor("event-1"),
        history: [{
          id: "response-1",
          outcome,
          safetyOfficerName: "Riley",
          createdAt: "2026-11-01T10:00:00Z",
          affectedBookingIds: [],
          equipmentAffected: false,
        }],
      });

      expect(screen.getByText(label)).toHaveClass("ui-status-badge", `ui-status-badge--${tone}`);
    },
  );

  it("SCRUM591_AC3_a_closed_event_shows_its_status_as_a_badge_not_the_raw_value", () => {
    renderDetail(detailFor("event-1", "safety_approved"));

    const status = screen.getByRole("status");
    expect(within(status).getByText("Safety approved")).toHaveClass("ui-status-badge--success");
    expect(status).not.toHaveTextContent("safety_approved");
  });

  it("SCRUM591_AC3_an_unknown_closed_status_falls_back_to_its_raw_value_in_a_neutral_badge", () => {
    renderDetail(detailFor("event-1", "on_hold"));

    expect(within(screen.getByRole("status")).getByText("on_hold")).toHaveClass("ui-status-badge--neutral");
  });
});

function renderHistoryNow() {
  render(
    <MemoryRouter>
      <SafetyReviewHistory />
    </MemoryRouter>,
  );
}

function failure(message) {
  return Object.assign(new Error(message), { response: { data: { error: message } } });
}

describe("SCRUM591_AC4 loading, empty, error and date states follow the standard", () => {
  it("SCRUM591_AC4_lists_show_the_standard_loading_text", async () => {
    getSafetyReviewQueue.mockReturnValue(new Promise(() => {}));
    getSafetyReviewHistory.mockReturnValue(new Promise(() => {}));

    const queue = render(<SafetyOfficerDashboard user={{ name: "Riley" }} />);
    expect(screen.getByRole("status")).toHaveTextContent(/^Loading\.\.\.$/);
    queue.unmount();

    renderHistoryNow();
    expect(screen.getByRole("status")).toHaveTextContent(/^Loading\.\.\.$/);
  });

  it("SCRUM591_AC4_an_empty_queue_says_what_is_missing_and_what_happens_next", async () => {
    getSafetyReviewQueue.mockResolvedValue([]);
    render(<SafetyOfficerDashboard user={{ name: "Riley" }} />);

    expect(await screen.findByText("No events are waiting for a safety review.")).toBeInTheDocument();
    expect(screen.getByText("Events appear here when a coordinator sends them for a safety check."))
      .toBeInTheDocument();
  });

  it("SCRUM591_AC4_an_empty_history_says_what_is_missing_and_what_happens_next", async () => {
    getSafetyReviewHistory.mockResolvedValue([]);
    renderHistoryNow();

    expect(await screen.findByText("No events have been reviewed yet.")).toBeInTheDocument();
    expect(screen.getByText("An event appears here once a Safety Officer responds to it in Safety review."))
      .toBeInTheDocument();
  });

  it("SCRUM591_AC4_a_queue_that_fails_to_load_offers_try_again_and_reloads", async () => {
    const user = userEvent.setup();
    getSafetyReviewQueue.mockRejectedValueOnce(failure("Queue unavailable"));
    render(<SafetyOfficerDashboard user={{ name: "Riley" }} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Queue unavailable");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Event event-1")).toBeInTheDocument();
    expect(getSafetyReviewQueue).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM591_AC4_history_that_fails_to_load_offers_try_again_and_reloads", async () => {
    const user = userEvent.setup();
    getSafetyReviewHistory.mockRejectedValueOnce(failure("History unavailable"));
    renderHistoryNow();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("History unavailable");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Event event-1")).toBeInTheDocument();
    expect(getSafetyReviewHistory).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM591_AC4_a_review_that_fails_to_open_offers_try_again_for_that_review", async () => {
    const user = userEvent.setup();
    getSafetyReview.mockRejectedValueOnce(failure("Details unavailable"));
    await renderQueue();

    // The second row, so a retry that reopens the wrong event would fail.
    await user.click(rowButton("Event event-2", "Review event"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Details unavailable");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { level: 2, name: "Event event-2" })).toBeInTheDocument();
    expect(getSafetyReview).toHaveBeenNthCalledWith(2, "event-2");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM591_AC4_history_details_that_fail_to_open_offer_try_again_for_that_event", async () => {
    const user = userEvent.setup();
    getSafetyReview.mockRejectedValueOnce(failure("Details unavailable"));
    await renderHistory();

    await user.click(rowButton("Event event-2", "View details"));
    const alert = await screen.findByRole("alert");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { level: 2, name: "Event event-2" })).toBeInTheDocument();
    expect(getSafetyReview).toHaveBeenNthCalledWith(2, "event-2");
  });

  it("SCRUM591_AC4_a_failed_response_shows_the_error_without_try_again", async () => {
    const user = userEvent.setup();
    submitSafetyReviewResponse.mockRejectedValue(failure("The note is too long."));
    await renderQueue();

    await user.click(rowButton("Event event-1", "Review event"));
    await screen.findByRole("heading", { level: 2, name: "Event event-1" });
    await user.click(screen.getByRole("button", { name: "Submit response" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The note is too long.");
    expect(within(alert).queryByRole("button")).not.toBeInTheDocument();
  });

  it("SCRUM591_AC4_a_history_refresh_that_fails_after_a_response_offers_try_again", async () => {
    const user = userEvent.setup();
    await renderQueue();
    await user.click(rowButton("Event event-1", "Review event"));
    await screen.findByRole("heading", { level: 2, name: "Event event-1" });

    getSafetyReview.mockRejectedValueOnce(new Error("reload failed"));
    await user.click(screen.getByRole("button", { name: "Submit response" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The response was recorded, but the safety history could not be refreshed.");

    getSafetyReview.mockImplementation(async (id) => detailFor(id, "approved"));
    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByText(/No further response can be submitted/)).toBeInTheDocument();
    expect(getSafetyReview).toHaveBeenLastCalledWith("event-1");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM591_AC4_a_conflict_whose_reload_fails_offers_try_again_for_that_event", async () => {
    const user = userEvent.setup();
    submitSafetyReviewResponse.mockRejectedValue(
      Object.assign(new Error("conflict"), { response: { status: 409, data: { error: "Event changed." } } }),
    );
    await renderQueue();
    await user.click(rowButton("Event event-2", "Review event"));
    await screen.findByRole("heading", { level: 2, name: "Event event-2" });

    getSafetyReview.mockRejectedValueOnce(new Error("reload failed"));
    await user.click(screen.getByRole("button", { name: "Submit response" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Event changed. The latest safety history could not be loaded.");

    getSafetyReview.mockImplementation(async (id) => detailFor(id, "approved"));
    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByText(/No further response can be submitted/)).toBeInTheDocument();
    expect(getSafetyReview).toHaveBeenLastCalledWith("event-2");
  });

  it("SCRUM591_AC4_dates_use_the_standard_format", async () => {
    const user = userEvent.setup();
    // 01:00Z is 9:00 am in Singapore; a device-zone or device-format helper
    // would print something else in a UTC runner.
    const startsAt = "2026-01-15T01:00:00Z";
    const endsAt = "2026-01-15T03:00:00Z";
    getSafetyReviewQueue.mockResolvedValue([{ ...queueEvent("event-1"), startsAt, endsAt }]);
    getSafetyReviewHistory.mockResolvedValue([{ ...historyRow("event-1"), respondedAt: "2026-01-16T06:30:00Z" }]);
    getSafetyReview.mockResolvedValue({
      ...detailFor("event-1"),
      event: { id: "event-1", eventName: "Event event-1", status: "safety_review", startsAt, endsAt },
      history: [{
        id: "response-1",
        outcome: "changes_requested",
        safetyOfficerName: "Riley",
        createdAt: "2026-01-15T17:30:00Z",
        affectedBookingIds: [],
        equipmentAffected: false,
      }],
    });

    const queue = render(<SafetyOfficerDashboard user={{ name: "Riley" }} />);
    await screen.findByText("Event event-1");
    expect(screen.getByText("15 Jan 2026, 9:00 am – 11:00 am")).toBeInTheDocument();

    await user.click(rowButton("Event event-1", "Review event"));
    await screen.findByRole("heading", { level: 2, name: "Event event-1" });
    expect(screen.getByText("Event date and times").nextElementSibling)
      .toHaveTextContent("15 Jan 2026, 9:00 am – 11:00 am");
    expect(screen.getByText("Riley · 16 Jan 2026, 1:30 am")).toBeInTheDocument();
    queue.unmount();

    await renderHistory();
    expect(screen.getByText("Reviewed: 16 Jan 2026, 2:30 pm")).toBeInTheDocument();
  });

  it("SCRUM591_AC4_an_event_without_dates_says_not_recorded_once", async () => {
    const user = userEvent.setup();
    getSafetyReviewQueue.mockResolvedValue([{ ...queueEvent("event-1"), startsAt: null, endsAt: null }]);
    getSafetyReviewHistory.mockResolvedValue([{ ...historyRow("event-1"), startsAt: null, endsAt: null }]);

    const queue = render(<SafetyOfficerDashboard user={{ name: "Riley" }} />);
    await screen.findByText("Event event-1");
    expect(screen.getByText("Event event-1").closest("li").querySelector("p"))
      .toHaveTextContent(/^Date and time not recorded$/);

    await user.click(rowButton("Event event-1", "Review event"));
    await screen.findByRole("heading", { level: 2, name: "Event event-1" });
    expect(screen.getByText("Event date and times").nextElementSibling).toHaveTextContent(/^Not recorded$/);
    queue.unmount();

    await renderHistory();
    expect(screen.getByText("Event event-1").closest("li").querySelector("p"))
      .toHaveTextContent(/^Date and time not recorded$/);
  });
});

const REVIEW_WITH_ARRANGEMENTS = {
  event: { id: "event-1", eventName: "Event event-1", status: "safety_review" },
  venues: [
    { bookingId: "booking-1", name: "Hall A" },
    { bookingId: "booking-2", name: "Hall B" },
  ],
  equipment: { requestId: "equipment-1", lines: [{ id: "line-1", name: "PA System", quantity: 1 }] },
  history: [],
};

function renderResponseForm() {
  const onSubmitted = vi.fn();
  const onError = vi.fn();
  render(
    <SafetyReviewDetail detail={REVIEW_WITH_ARRANGEMENTS} onSubmitted={onSubmitted} onError={onError} />,
  );
  return { onSubmitted, onError };
}

const REJECT_TITLE = "Reject the safety arrangement for Event event-1?";

async function startReject(user, reason = "Exits are blocked.") {
  await user.click(screen.getByRole("radio", { name: "Reject the safety arrangement" }));
  if (reason) await user.type(screen.getByRole("textbox", { name: "Reason" }), reason);
  await user.click(screen.getByRole("button", { name: "Submit response" }));
}

describe("SCRUM591_AC3 the response is chosen from labelled choices", () => {
  it("SCRUM591_AC3_response_choices_are_radios_with_their_consequence", () => {
    renderResponseForm();

    const group = screen.getByRole("group", { name: "Response" });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(within(group).getByRole("radio", { name: "Approve" })).toBeChecked();
    expect(within(group).getByRole("radio", { name: "Approve" })).toHaveAccessibleDescription(
      "The event moves to Safety approved. The organiser and coordinator are notified.",
    );
    expect(within(group).getByRole("radio", { name: "Request changes" })).toHaveAccessibleDescription(
      "The event goes back to planning to change the items you mark. The organiser and coordinator are notified with your note.",
    );
    expect(within(group).getByRole("radio", { name: "Reject the safety arrangement" })).toHaveAccessibleDescription(
      "The arrangement cannot go ahead as planned. The event goes back to planning, and the organiser and coordinator are notified with your reason.",
    );
  });
});

describe("SCRUM591_AC8 rejecting is confirmed; other responses send straight away", () => {
  it.each([
    ["approve", "Approve", { outcome: "approved", note: "", affectedBookingIds: [], equipmentAffected: false }],
    [
      "request changes",
      "Request changes",
      { outcome: "changes_requested", note: "Update the plan.", affectedBookingIds: ["booking-2"], equipmentAffected: true },
    ],
    [
      "reject",
      "Reject the safety arrangement",
      { outcome: "rejected", note: "Update the plan.", affectedBookingIds: ["booking-2"], equipmentAffected: true },
    ],
  ])("SCRUM591_AC8_each_choice_sends_the_same_payload_as_before (%s)", async (_name, choice, payload) => {
    const user = userEvent.setup();
    const { onSubmitted } = renderResponseForm();

    await user.click(screen.getByRole("radio", { name: choice }));
    if (payload.outcome !== "approved") {
      await user.click(screen.getAllByLabelText("Mark this booking as affected")[1]);
      await user.click(screen.getByLabelText("Mark the equipment request as affected"));
      await user.type(screen.getByRole("textbox"), "Update the plan.");
    }
    await user.click(screen.getByRole("button", { name: "Submit response" }));
    if (payload.outcome === "rejected") {
      await user.click(screen.getByRole("button", { name: "Reject arrangement" }));
    }

    expect(submitSafetyReviewResponse).toHaveBeenCalledTimes(1);
    expect(submitSafetyReviewResponse).toHaveBeenCalledWith("event-1", payload);
    expect(onSubmitted).toHaveBeenCalledWith("event-1", payload.outcome);
  });

  it("SCRUM591_AC8_reject_asks_for_confirmation_before_anything_is_sent", async () => {
    const user = userEvent.setup();
    renderResponseForm();

    await startReject(user);

    const dialog = screen.getByRole("dialog", { name: REJECT_TITLE });
    expect(dialog).toHaveTextContent(
      "The organiser and coordinator are notified with your reason, and the event goes back to planning.",
    );
    expect(submitSafetyReviewResponse).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Reject arrangement" }));

    expect(submitSafetyReviewResponse).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("SCRUM591_AC8_going_back_from_the_reject_confirmation_sends_nothing_and_keeps_the_reason", async () => {
    const user = userEvent.setup();
    renderResponseForm();

    await startReject(user);
    await user.click(screen.getByRole("button", { name: "Go back" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(submitSafetyReviewResponse).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Reason" })).toHaveValue("Exits are blocked.");
    expect(screen.getByRole("radio", { name: "Reject the safety arrangement" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Submit response" })).toHaveFocus();
  });

  it("SCRUM591_AC8_a_failed_reject_closes_the_confirmation_and_shows_the_error", async () => {
    const user = userEvent.setup();
    submitSafetyReviewResponse.mockRejectedValue(failure("Event changed."));
    const { onError, onSubmitted } = renderResponseForm();

    await startReject(user);
    await user.click(screen.getByRole("button", { name: "Reject arrangement" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onError).toHaveBeenLastCalledWith({ status: undefined, message: "Event changed." });
    expect(onSubmitted).not.toHaveBeenCalled();
    // As on the direct path, focus stays with the form so the officer can fix and resend.
    expect(screen.getByRole("button", { name: "Submit response" })).toHaveFocus();
  });

  it("SCRUM591_AC8_reject_without_a_reason_does_not_open_the_confirmation", async () => {
    const user = userEvent.setup();
    renderResponseForm();

    await startReject(user, "");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(submitSafetyReviewResponse).not.toHaveBeenCalled();
  });

  it.each([["Approve"], ["Request changes"]])(
    "SCRUM591_AC8_approve_and_request_changes_submit_without_a_confirmation (%s)",
    async (choice) => {
      const user = userEvent.setup();
      renderResponseForm();

      await user.click(screen.getByRole("radio", { name: choice }));
      if (choice === "Request changes") await user.type(screen.getByRole("textbox"), "Move the PA.");
      await user.click(screen.getByRole("button", { name: "Submit response" }));

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(submitSafetyReviewResponse).toHaveBeenCalledTimes(1);
    },
  );
});

describe("SCRUM591_AC6 every control works from the keyboard and focus is never lost", () => {
  it("SCRUM591_AC6_a_recorded_response_moves_focus_to_the_closed_event_line", async () => {
    const user = userEvent.setup();
    await renderQueue();
    await user.click(rowButton("Event event-1", "Review event"));
    await screen.findByRole("heading", { level: 2, name: "Event event-1" });

    getSafetyReview.mockImplementation(async (id) => detailFor(id, "safety_approved"));
    await user.click(screen.getByRole("button", { name: "Submit response" }));

    const closedLine = await screen.findByText(/No further response can be submitted/);
    expect(closedLine).toHaveFocus();
  });

  it("SCRUM591_AC6_a_failed_response_returns_focus_to_submit", async () => {
    const user = userEvent.setup();
    // Browsers drop focus from a button once it is disabled; jsdom does not,
    // so the blur stands in for that while the response is being sent.
    submitSafetyReviewResponse.mockImplementation(async () => {
      document.activeElement.blur();
      throw failure("The note is too long.");
    });
    renderResponseForm();

    await user.click(screen.getByRole("button", { name: "Submit response" }));

    expect(screen.getByRole("button", { name: "Submit response" })).toHaveFocus();
  });

  it.each([
    ["the history refresh after a response", undefined],
    ["the reload after a conflict", { status: 409, data: { error: "Event changed." } }],
  ])("SCRUM591_AC6_a_successful_try_again_returns_focus_to_the_event_heading (%s)", async (_name, response) => {
    const user = userEvent.setup();
    if (response) submitSafetyReviewResponse.mockRejectedValue(Object.assign(new Error("conflict"), { response }));
    await renderQueue();
    await user.click(rowButton("Event event-1", "Review event"));
    await screen.findByRole("heading", { level: 2, name: "Event event-1" });

    getSafetyReview.mockRejectedValueOnce(new Error("reload failed"));
    await user.click(screen.getByRole("button", { name: "Submit response" }));
    const tryAgain = within(await screen.findByRole("alert")).getByRole("button", { name: "Try again" });

    getSafetyReview.mockImplementation(async (id) => detailFor(id, "safety_approved"));
    await user.click(tryAgain);

    await screen.findByText(/No further response can be submitted/);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Event event-1" })).toHaveFocus();
  });

  it("SCRUM591_AC6_every_control_on_an_open_review_is_reachable_with_tab", async () => {
    const user = userEvent.setup();
    getSafetyReview.mockResolvedValue(REVIEW_WITH_ARRANGEMENTS);
    await renderQueue();
    await user.click(rowButton("Event event-1", "Review event"));
    await screen.findByRole("heading", { level: 2, name: "Event event-1" });
    // Request changes shows the checkboxes; tabbing then starts from the top of the page.
    await user.click(screen.getByRole("radio", { name: "Request changes" }));
    document.activeElement.blur();

    const [bookingOne, bookingTwo] = screen.getAllByLabelText("Mark this booking as affected");
    const expected = [
      screen.getByRole("button", { name: /Back to Safety review/ }),
      bookingOne,
      bookingTwo,
      screen.getByLabelText("Mark the equipment request as affected"),
      // A radio group is one tab stop: only the chosen radio is in the order.
      screen.getByRole("radio", { name: "Request changes" }),
      screen.getByRole("textbox", { name: "Note" }),
      screen.getByRole("button", { name: "Submit response" }),
    ];
    const reached = [];
    for (let step = 0; step < expected.length; step += 1) {
      await user.tab();
      reached.push(document.activeElement);
    }

    expect(reached).toEqual(expected);
  });

  it("SCRUM591_AC6_response_choices_change_with_the_arrow_keys", async () => {
    const user = userEvent.setup();
    renderResponseForm();

    await user.click(screen.getByRole("radio", { name: "Approve" }));
    await user.keyboard("{ArrowDown}");

    expect(screen.getByRole("radio", { name: "Request changes" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Request changes" })).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Note" })).toBeRequired();
  });
});
