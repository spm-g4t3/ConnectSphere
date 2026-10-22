// UnassignedQueue.test.jsx
//
// SCRUM-486 (SCRUM-519), AC2 and AC4-04: the Event Coordinator Lead's
// unassigned queue, and the round trip through the assignment panel. The
// service is mocked; AssignCoordinatorPanel is real, so the queue is tested
// with the panel it actually opens.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import UnassignedQueue from "../../src/components/UnassignedQueue.jsx";
import {
  assignEventRequest,
  cancelEventRequest,
  getEventCancellationImpact,
  listCoordinatorWorkload,
  listUnassignedEventRequests,
} from "../../src/services/eventRequestService";
import { formatRange } from "../../src/services/displayFormat";
import { httpError } from "../helpers/async.js";

vi.mock("../../src/services/eventRequestService", () => ({
  listUnassignedEventRequests: vi.fn(),
  listCoordinatorWorkload: vi.fn(),
  assignEventRequest: vi.fn(),
  // SCRUM-539: the cancel panel each row opens.
  cancelEventRequest: vi.fn(),
  getEventCancellationImpact: vi.fn(),
}));

const NOW = new Date("2026-10-11T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const before = (ms) => new Date(NOW.getTime() - ms).toISOString();

const OLDER = {
  id: "22222222-2222-4222-8222-222222222222",
  eventName: "IS212 Industry Night",
  organiserName: "Aisha Rahman",
  proposedStart: "2026-11-01T09:00:00+08:00",
  proposedEnd: "2026-11-01T17:00:00+08:00",
  expectedAttendance: 120,
  submittedAt: before(3 * DAY),
};
const NEWER = {
  id: "33333333-3333-4333-8333-333333333333",
  eventName: "Freshers Welcome",
  organiserName: "Ben Lim",
  proposedStart: "2026-11-20T18:00:00+08:00",
  proposedEnd: "2026-11-20T22:00:00+08:00",
  expectedAttendance: 300,
  submittedAt: before(HOUR),
};
const PRIYA = { id: "66666666-6666-4666-8666-666666666666", fullName: "Priya Nair", activeEvents: 0 };

const renderQueue = () => render(<UnassignedQueue now={() => NOW} />);
const rows = () => screen.queryAllByRole("listitem");

beforeEach(() => {
  vi.mocked(listUnassignedEventRequests).mockReset();
  vi.mocked(listUnassignedEventRequests).mockResolvedValue([OLDER, NEWER]);
  vi.mocked(listCoordinatorWorkload).mockReset();
  vi.mocked(listCoordinatorWorkload).mockResolvedValue([PRIYA]);
  vi.mocked(assignEventRequest).mockReset();
  vi.mocked(cancelEventRequest).mockReset();
  vi.mocked(getEventCancellationImpact).mockReset();
});


describe("SCRUM486_AC2 the unassigned queue", () => {
  it("SCRUM486_AC2_lists_each_request_oldest_first_with_what_the_lead_needs_to_choose", async () => {
    // AC2-07. Two requests, submitted three days and one hour before the
    // injected clock. The server's order is kept: oldest first.
    renderQueue();

    await screen.findByText("IS212 Industry Night");
    const [first, second] = rows();

    expect(within(first).getByText("IS212 Industry Night")).toBeInTheDocument();
    expect(within(first).getByText("Organiser: Aisha Rahman")).toBeInTheDocument();
    expect(within(first).getByText(formatRange(OLDER.proposedStart, OLDER.proposedEnd))).toBeInTheDocument();
    expect(within(first).getByText("Expected attendance: 120")).toBeInTheDocument();
    expect(within(first).getByText("waiting 3 days")).toBeInTheDocument();

    expect(within(second).getByText("Freshers Welcome")).toBeInTheDocument();
    expect(within(second).getByText("Organiser: Ben Lim")).toBeInTheDocument();
    expect(within(second).getByText("waiting 1 hour")).toBeInTheDocument();
  });

  it("SCRUM486_AC2_an_empty_queue_says_nothing_is_waiting_and_invents_no_rows", async () => {
    // AC2-08: what the Lead sees when the queue is empty.
    vi.mocked(listUnassignedEventRequests).mockResolvedValue([]);
    renderQueue();

    expect(await screen.findByText("No event requests are waiting for a coordinator.")).toBeInTheDocument();
    expect(rows()).toEqual([]);
    expect(screen.queryByRole("button", { name: /^Assign/ })).not.toBeInTheDocument();
  });

  it("SCRUM486_AC2_a_missing_organiser_name_or_attendance_is_said_not_left_blank", async () => {
    vi.mocked(listUnassignedEventRequests).mockResolvedValue([
      { ...OLDER, organiserName: null, expectedAttendance: null },
    ]);
    renderQueue();

    expect(await screen.findByText("Organiser: No name on record")).toBeInTheDocument();
    expect(screen.getByText("Expected attendance: not given")).toBeInTheDocument();
  });

  it("SCRUM486_AC2_shows_loading_until_the_queue_arrives", async () => {
    renderQueue();

    expect(screen.getByText("Loading...")).toBeInTheDocument();
    await screen.findByText("IS212 Industry Night");
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
  });

  it.each([
    [401, "Your session has expired. Please sign in again."],
    [403, "Only the Event Coordinator Lead can see the unassigned queue."],
    [500, "The unassigned queue could not be loaded. Please try again."],
    [undefined, "The unassigned queue could not be loaded. Please try again."],
  ])("SCRUM486_AC2_a_%s_loading_the_queue_reads_%j", async (status, message) => {
    vi.mocked(listUnassignedEventRequests).mockRejectedValue(httpError(status));
    renderQueue();

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    // Not the empty message: a failed load is not an empty queue.
    expect(screen.queryByText("No event requests are waiting for a coordinator.")).not.toBeInTheDocument();
  });

  it("SCRUM486_AC2_measures_waiting_against_the_readers_clock_by_default", async () => {
    vi.mocked(listUnassignedEventRequests).mockResolvedValue([
      { ...OLDER, submittedAt: new Date(Date.now() - 2 * DAY - HOUR).toISOString() },
    ]);
    render(<UnassignedQueue />);

    expect(await screen.findByText("waiting 2 days")).toBeInTheDocument();
  });
});


describe("SCRUM486_AC2 the queue is re-read when the Lead looks again", () => {
  it("SCRUM486_AC2_refetches_when_the_tab_regains_focus_while_visible", async () => {
    renderQueue();
    await screen.findByText("IS212 Industry Night");
    vi.mocked(listUnassignedEventRequests).mockResolvedValue([NEWER]);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(listUnassignedEventRequests).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("Freshers Welcome")).toBeInTheDocument();
    expect(screen.queryByText("IS212 Industry Night")).not.toBeInTheDocument();
  });

  it("SCRUM486_AC2_does_not_refetch_for_a_hidden_tab_and_stops_listening_once_gone", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { unmount } = renderQueue();
    await screen.findByText("IS212 Industry Night");

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(listUnassignedEventRequests).toHaveBeenCalledTimes(1);

    visibility.mockReturnValue("visible");
    unmount();
    window.dispatchEvent(new Event("focus"));
    expect(listUnassignedEventRequests).toHaveBeenCalledTimes(1);
    visibility.mockRestore();
  });
});


describe("SCRUM486_AC3 assigning from the queue", () => {
  async function openFirst(user) {
    renderQueue();
    await user.click(await screen.findByRole("button", { name: "Assign IS212 Industry Night" }));
  }

  it("SCRUM486_AC3_assign_opens_the_picker_for_that_request", async () => {
    const user = userEvent.setup();
    await openFirst(user);

    expect(screen.getByRole("heading", { name: "Assign IS212 Industry Night" })).toBeInTheDocument();
    expect(await screen.findByRole("radio", { name: "Priya Nair, 0 active events" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Unassigned queue" })).not.toBeInTheDocument();
  });

  it("SCRUM486_AC3_an_assignment_returns_to_the_queue_says_who_and_re_reads_it", async () => {
    vi.mocked(assignEventRequest).mockResolvedValue({ ...OLDER, assignedCoordinatorId: PRIYA.id });
    const user = userEvent.setup();
    await openFirst(user);
    vi.mocked(listUnassignedEventRequests).mockResolvedValue([NEWER]);

    await user.click(await screen.findByRole("radio", { name: "Priya Nair, 0 active events" }));
    await user.click(screen.getByRole("button", { name: "Confirm assignment" }));

    expect(await screen.findByRole("status")).toHaveTextContent("IS212 Industry Night was assigned to Priya Nair.");
    expect(listUnassignedEventRequests).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("Freshers Welcome")).toBeInTheDocument();
    expect(screen.queryByText("IS212 Industry Night")).not.toBeInTheDocument();
  });

  it("SCRUM486_AC3_a_coordinator_with_no_name_is_still_confirmed", async () => {
    vi.mocked(listCoordinatorWorkload).mockResolvedValue([{ ...PRIYA, fullName: null }]);
    vi.mocked(assignEventRequest).mockResolvedValue({ ...OLDER });
    const user = userEvent.setup();
    await openFirst(user);

    await user.click(await screen.findByRole("radio", { name: `No name on record (${PRIYA.id}), 0 active events` }));
    await user.click(screen.getByRole("button", { name: "Confirm assignment" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "IS212 Industry Night was assigned to the coordinator you chose.",
    );
  });

  it.each([
    ["the back button", "← Back to the unassigned queue"],
    ["the panel's Cancel", "Cancel"],
  ])("SCRUM486_AC3_%s_returns_to_the_queue_unchanged_and_re_reads_it", async (_label, name) => {
    const user = userEvent.setup();
    await openFirst(user);
    await screen.findByRole("radio", { name: "Priya Nair, 0 active events" });

    await user.click(screen.getByRole("button", { name }));

    expect(await screen.findByRole("heading", { name: "Unassigned queue" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(assignEventRequest).not.toHaveBeenCalled();
    expect(listUnassignedEventRequests).toHaveBeenCalledTimes(2);
  });

  it("SCRUM486_AC4_after_a_lost_race_the_request_leaves_the_queue_on_the_way_back", async () => {
    // AC4-04. The panel names who won; back on the queue, the re-read no
    // longer has the request.
    vi.mocked(assignEventRequest).mockRejectedValue(httpError(409, {
      code: "ALREADY_ASSIGNED",
      conflicts: [{ assignedCoordinatorId: "x", assignedCoordinatorName: "Omar Okafor" }],
    }));
    const user = userEvent.setup();
    await openFirst(user);
    vi.mocked(listUnassignedEventRequests).mockResolvedValue([NEWER]);

    await user.click(await screen.findByRole("radio", { name: "Priya Nair, 0 active events" }));
    await user.click(screen.getByRole("button", { name: "Confirm assignment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already been assigned to Omar Okafor");
    await user.click(screen.getByRole("button", { name: "Back to the queue" }));

    expect(await screen.findByText("Freshers Welcome")).toBeInTheDocument();
    expect(screen.queryByText("IS212 Industry Night")).not.toBeInTheDocument();
  });

  it("SCRUM486_AC3_opening_another_request_clears_the_last_confirmation", async () => {
    vi.mocked(assignEventRequest).mockResolvedValue({ ...OLDER });
    const user = userEvent.setup();
    await openFirst(user);
    await user.click(await screen.findByRole("radio", { name: "Priya Nair, 0 active events" }));
    await user.click(screen.getByRole("button", { name: "Confirm assignment" }));
    await screen.findByRole("status");

    await user.click(screen.getByRole("button", { name: "Assign Freshers Welcome" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    await screen.findByRole("heading", { name: "Unassigned queue" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});


describe("SCRUM539_AC2 cancelling from the queue", () => {
  const EMPTY_IMPACT = {
    venueBookings: { count: 0, details: [] },
    bookingRequests: { count: 0, details: [] },
    venueHolds: { count: 0, details: [] },
    equipmentRequests: { count: 0, details: [] },
    equipmentReservations: { count: 0, details: [] },
  };

  async function openCancel(user, request = OLDER) {
    renderQueue();
    await user.click(await screen.findByRole("button", { name: `Cancel ${request.eventName}` }));
  }

  it("SCRUM539_AC1_every_row_offers_cancel_beside_assign", async () => {
    renderQueue();

    await screen.findByText("IS212 Industry Night");
    for (const [row, request] of [[rows()[0], OLDER], [rows()[1], NEWER]]) {
      const buttons = within(row).getAllByRole("button");
      expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
        `Assign ${request.eventName}`,
        `Cancel ${request.eventName}`,
      ]);
      expect(buttons[1]).toHaveTextContent("Cancel request");
    }
  });

  it("SCRUM539_AC2_cancel_request_opens_the_cancel_form_for_that_row", async () => {
    const user = userEvent.setup();

    await openCancel(user, NEWER);

    expect(screen.getByRole("heading", { name: "Cancel Freshers Welcome" })).toBeInTheDocument();
    // One panel at a time: the list and the assign picker are gone.
    expect(screen.queryByRole("heading", { name: "Unassigned queue" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^Assign / })).not.toBeInTheDocument();
    expect(listCoordinatorWorkload).not.toHaveBeenCalled();
  });

  it("SCRUM539_AC2_a_cancel_returns_to_the_queue_says_so_and_the_row_is_gone", async () => {
    // AC2-03.
    vi.mocked(getEventCancellationImpact).mockResolvedValue(EMPTY_IMPACT);
    vi.mocked(cancelEventRequest).mockResolvedValue({ ...OLDER, status: "cancelled" });
    const user = userEvent.setup();
    await openCancel(user);
    vi.mocked(listUnassignedEventRequests).mockResolvedValue([NEWER]);

    await user.type(screen.getByLabelText("Cancellation reason"), "Organiser no longer needs it");
    await user.click(screen.getByLabelText("The organiser’s request"));
    await user.click(screen.getByRole("button", { name: "Preview cancellation" }));
    await user.click(await screen.findByLabelText("I have reviewed the impact and confirm cancelling this request."));
    await user.click(screen.getByRole("button", { name: "Cancel request" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "IS212 Industry Night was cancelled. The organiser has been told.",
    );
    expect(await screen.findByText("Freshers Welcome")).toBeInTheDocument();
    expect(screen.queryByText("IS212 Industry Night")).not.toBeInTheDocument();
    expect(listUnassignedEventRequests).toHaveBeenCalledTimes(2);
  });

  it("SCRUM539_AC2_back_from_the_cancel_form_re_reads_the_queue_and_says_nothing", async () => {
    const user = userEvent.setup();
    await openCancel(user);

    await user.click(screen.getByRole("button", { name: /Back to the unassigned queue/ }));

    expect(await screen.findByRole("heading", { name: "Unassigned queue" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(listUnassignedEventRequests).toHaveBeenCalledTimes(2);
    expect(cancelEventRequest).not.toHaveBeenCalled();
  });

  it("SCRUM539_AC2_opening_cancel_clears_the_last_confirmation", async () => {
    vi.mocked(assignEventRequest).mockResolvedValue({ ...OLDER });
    const user = userEvent.setup();
    renderQueue();
    await user.click(await screen.findByRole("button", { name: "Assign IS212 Industry Night" }));
    await user.click(await screen.findByRole("radio", { name: "Priya Nair, 0 active events" }));
    await user.click(screen.getByRole("button", { name: "Confirm assignment" }));
    await screen.findByRole("status");

    await user.click(screen.getByRole("button", { name: "Cancel Freshers Welcome" }));
    await user.click(screen.getByRole("button", { name: /Back to the unassigned queue/ }));

    await screen.findByRole("heading", { name: "Unassigned queue" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
