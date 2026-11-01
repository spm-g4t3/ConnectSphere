// AssignedEvents.test.jsx
//
// SCRUM-486 AC6: the Event Coordinator Lead's list of assigned events, the
// way to an event's page by clicking. The service is mocked; the router is
// real, so "Open" is followed to the route it names rather than read off an
// attribute alone.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import AssignedEvents from "../../src/components/AssignedEvents.jsx";
import { listAssignedEventsForLead } from "../../src/services/eventRequestService";
import { formatTimestamp } from "../../src/services/displayFormat";
import { httpError } from "../helpers/async.js";

vi.mock("../../src/services/eventRequestService", () => ({
  listAssignedEventsForLead: vi.fn(),
}));

const HELD_BY_A = {
  id: "22222222-2222-4222-8222-222222222222",
  eventName: "IS212 Industry Night",
  status: "approved",
  statusDisplay: { label: "Planning", group: "APPROVED" },
  proposedStart: "2026-11-01T09:00:00+08:00",
  organiserName: "Aisha Rahman",
  assignedCoordinatorId: "44444444-4444-4444-8444-444444444444",
  assignedCoordinatorName: "Priya Nair",
};
const UNNAMED_UNDATED = {
  id: "33333333-3333-4333-8333-333333333333",
  eventName: "Freshers Welcome",
  status: "under_review",
  statusDisplay: { label: "Under review", group: "UNDER_REVIEW" },
  proposedStart: null,
  organiserName: null,
  assignedCoordinatorId: "66666666-6666-4666-8666-666666666666",
  assignedCoordinatorName: null,
};

function renderList() {
  return render(
    <MemoryRouter initialEntries={["/assigned-events"]}>
      <Routes>
        <Route path="/assigned-events" element={<AssignedEvents />} />
        <Route path="/event-requests/:eventRequestId" element={<p>Event page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(listAssignedEventsForLead).mockReset();
  vi.mocked(listAssignedEventsForLead).mockResolvedValue([HELD_BY_A, UNNAMED_UNDATED]);
});


describe("SCRUM486_AC6 the Lead's list of assigned events", () => {
  it("SCRUM486_AC6_each_row_names_the_event_organiser_coordinator_status_and_start", async () => {
    renderList();

    await screen.findByText("IS212 Industry Night");
    const [first, second] = screen.getAllByRole("listitem");

    expect(within(first).getByText("Organiser: Aisha Rahman")).toBeInTheDocument();
    expect(within(first).getByText("Coordinator: Priya Nair")).toBeInTheDocument();
    expect(within(first).getByText("Planning")).toHaveClass("status-badge", "status--approved");
    expect(within(first).getByText(formatTimestamp(HELD_BY_A.proposedStart))).toBeInTheDocument();
    // The server's order is kept: earliest first, undated last.
    expect(within(second).getByText("Freshers Welcome")).toBeInTheDocument();
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
  });

  it("SCRUM486_AC6_a_missing_name_or_date_is_said_never_left_blank", async () => {
    renderList();

    const row = (await screen.findByText("Freshers Welcome")).closest("li");

    expect(within(row).getByText("Organiser: No name on record")).toBeInTheDocument();
    expect(within(row).getByText("Coordinator: No name on record")).toBeInTheDocument();
    expect(within(row).getByText("Date not set")).toBeInTheDocument();
  });

  it("SCRUM486_AC6_open_links_to_the_events_page_and_goes_there", async () => {
    // A router link, not window.location: the Lead lands on the event page
    // inside the app, where the hand-over button is.
    renderList();

    const open = await screen.findByRole("link", { name: "Open IS212 Industry Night" });
    expect(open).toHaveAttribute("href", `/event-requests/${HELD_BY_A.id}`);

    await userEvent.click(open);

    expect(screen.getByText("Event page")).toBeInTheDocument();
  });

  it("SCRUM486_AC6_says_loading_until_the_list_arrives", async () => {
    let resolve;
    vi.mocked(listAssignedEventsForLead).mockReturnValue(new Promise((r) => { resolve = r; }));

    renderList();

    expect(screen.getByText("Loading...")).toBeInTheDocument();
    resolve([]);
    await screen.findByText("No coordinator is holding an active event.");
  });

  it("SCRUM486_AC6_an_empty_list_says_nothing_is_held_and_invents_no_rows", async () => {
    vi.mocked(listAssignedEventsForLead).mockResolvedValue([]);

    renderList();

    expect(await screen.findByText("No coordinator is holding an active event.")).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it.each([
    [403, "Only the Event Coordinator Lead can see the assigned events."],
    [502, "The assigned events could not be loaded. Please try again."],
  ])("SCRUM486_AC6_a_%s_is_said_and_shows_no_empty_state", async (status, message) => {
    vi.mocked(listAssignedEventsForLead).mockRejectedValue(httpError(status));

    renderList();

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText("No coordinator is holding an active event.")).not.toBeInTheDocument();
  });

  it("SCRUM486_AC6_a_failure_with_no_response_is_still_said", async () => {
    vi.mocked(listAssignedEventsForLead).mockRejectedValue(new Error("Network Error"));

    renderList();

    expect(await screen.findByRole("alert")).toHaveTextContent("The assigned events could not be loaded. Please try again.");
  });
});
