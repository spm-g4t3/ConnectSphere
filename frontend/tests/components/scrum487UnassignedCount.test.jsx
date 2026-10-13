// scrum487UnassignedCount.test.jsx
//
// SCRUM-487 AC4 (SCRUM-543): the Lead's overview counts the requests waiting
// for a coordinator, at the top, with a link to the queue. Rendered inside the
// whole overview page (AssignedEvents), so "its failure leaves the list
// working" is tested where it matters. The services are mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import AssignedEvents from "../../src/components/AssignedEvents.jsx";
import {
  listAssignedEventsForLead,
  listCoordinatorOverview,
  listUnassignedEventRequests,
} from "../../src/services/eventRequestService";

vi.mock("../../src/services/eventRequestService", () => ({
  listAssignedEventsForLead: vi.fn(),
  listCoordinatorOverview: vi.fn(),
  listUnassignedEventRequests: vi.fn(),
}));

const HELD = {
  id: "22222222-2222-4222-8222-222222222222",
  eventName: "IS212 Industry Night",
  status: "approved",
  statusDisplay: { label: "Planning", group: "APPROVED" },
  proposedStart: "2026-11-01T09:00:00+08:00",
  organiserName: "Aisha Rahman",
  assignedCoordinatorId: "44444444-4444-4444-8444-444444444444",
  assignedCoordinatorName: "Priya Nair",
};

const waiting = (n) => Array.from({ length: n }, (_, i) => ({ id: `w${i}`, eventName: `Waiting ${i}` }));

const renderOverview = () =>
  render(
    <MemoryRouter>
      <AssignedEvents />
    </MemoryRouter>,
  );

/** The count's own block, so the list's status messages never match. */
const countBlock = async () =>
  (await screen.findByRole("link", { name: "Open the Unassigned Queue" })).closest("div");

beforeEach(() => {
  vi.mocked(listAssignedEventsForLead).mockReset();
  vi.mocked(listAssignedEventsForLead).mockResolvedValue([HELD]);
  vi.mocked(listCoordinatorOverview).mockReset();
  vi.mocked(listCoordinatorOverview).mockResolvedValue({ statuses: [], coordinators: [] });
  vi.mocked(listUnassignedEventRequests).mockReset();
});


describe("SCRUM487_AC4 the unassigned count at the top of the overview", () => {
  it.each([
    [1, "1 request is waiting for a coordinator."],
    [3, "3 requests are waiting for a coordinator."],
    [0, "No requests are waiting for a coordinator."],
  ])("SCRUM487_AC4_%s_waiting_reads_%j", async (n, sentence) => {
    // AC4-01, AC4-03. Counted from the queue's own read; zero is said, never
    // left blank.
    vi.mocked(listUnassignedEventRequests).mockResolvedValue(waiting(n));

    renderOverview();

    expect(await within(await countBlock()).findByText(sentence)).toBeInTheDocument();
    expect(listUnassignedEventRequests).toHaveBeenCalledTimes(1);
  });

  it("SCRUM487_AC4_the_count_links_to_the_unassigned_queue", async () => {
    // AC4-02.
    vi.mocked(listUnassignedEventRequests).mockResolvedValue(waiting(2));

    renderOverview();

    expect(await screen.findByRole("link", { name: "Open the Unassigned Queue" })).toHaveAttribute("href", "/unassigned-queue");
  });

  it("SCRUM487_AC4_the_count_says_so_while_it_loads", async () => {
    vi.mocked(listUnassignedEventRequests).mockReturnValue(new Promise(() => {}));

    renderOverview();

    expect(within(await countBlock()).getByText("Counting the requests waiting for a coordinator...")).toBeInTheDocument();
  });

  it("SCRUM487_AC4_a_failed_count_is_said_and_the_events_list_still_loads", async () => {
    // The count is a pointer to another page; its failure must not cost the
    // Lead this one.
    vi.mocked(listUnassignedEventRequests).mockRejectedValue(new Error("Network Error"));

    renderOverview();

    expect(await within(await countBlock()).findByText("The number of waiting requests could not be loaded.")).toBeInTheDocument();
    expect(await screen.findByText("IS212 Industry Night")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
