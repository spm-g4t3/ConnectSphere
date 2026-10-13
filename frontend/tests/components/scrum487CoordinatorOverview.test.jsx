// scrum487CoordinatorOverview.test.jsx
//
// SCRUM-487 (SCRUM-544): the Lead's coordinator overview at /assigned-events.
// AC2: every coordinator with their counts. AC3: the events list's filters,
// applied by the server. The services are mocked; the router is real, so a
// row's Open is followed to the route it names (AC6).
//
// SCRUM-486's AssignedEvents.test.jsx stays unedited beside this file: it is
// the proof that the unfiltered list still behaves as SCRUM-486 built it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";

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

const OMAR = "44444444-4444-4444-8444-444444444444";
const PRIYA = "66666666-6666-4666-8666-666666666666";

const counts = (overrides = {}) => ({
  submitted: 0, under_review: 0, pending_clarification: 0, approved: 0, confirmed: 0, ...overrides,
});

/** The response's statuses, as the server sends them (SCRUM-546, D9). */
const STATUSES = [
  { status: "submitted", label: "Requested", finished: false },
  { status: "under_review", label: "Under review", finished: false },
  { status: "pending_clarification", label: "Awaiting your response", finished: false },
  { status: "approved", label: "Planning", finished: false },
  { status: "confirmed", label: "Confirmed", finished: false },
  { status: "completed", label: "Completed", finished: true },
  { status: "rejected", label: "Rejected", finished: true },
  { status: "cancelled", label: "Cancelled", finished: true },
];

// Omar holds nothing and Priya five, in name order: a table sorted by
// workload would put Priya first.
const OVERVIEW = {
  statuses: STATUSES,
  coordinators: [
    { id: OMAR, fullName: "Omar Okafor", activeEvents: 0, byStatus: counts() },
    { id: PRIYA, fullName: "Priya Nair", activeEvents: 5, byStatus: counts({ under_review: 2, approved: 3 }) },
  ],
};

const row = (overrides) => ({
  id: "e1",
  eventName: "IS212 Industry Night",
  status: "approved",
  statusDisplay: { label: "Planning", group: "APPROVED" },
  proposedStart: "2026-11-01T09:00:00+08:00",
  organiserName: "Aisha Rahman",
  assignedCoordinatorId: PRIYA,
  assignedCoordinatorName: "Priya Nair",
  ...overrides,
});
const APPROVED_ROW = row({});
const REVIEW_ROW = row({ id: "e2", eventName: "Freshers Welcome", status: "under_review", statusDisplay: { label: "Under review", group: "UNDER_REVIEW" } });
const OMARS_ROW = row({ id: "e3", eventName: "Hack Night", assignedCoordinatorId: OMAR, assignedCoordinatorName: "Omar Okafor" });

const httpError = (status) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function EventPage() {
  const { eventRequestId } = useParams();
  return <p>Event page {eventRequestId}</p>;
}

function renderOverview() {
  return render(
    <MemoryRouter initialEntries={["/assigned-events"]}>
      <Routes>
        <Route path="/assigned-events" element={<AssignedEvents />} />
        <Route path="/event-requests/:eventRequestId" element={<EventPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const table = () => screen.findByRole("table");
const headings = (t) => within(t).getAllByRole("columnheader").map((cell) => cell.textContent);
/** Each body row's cells, the row's name first, as text. */
const bodyRows = (t) => within(t).getAllByRole("row").slice(1).map((r) =>
  [...r.querySelectorAll("th, td")].map((cell) => cell.textContent));
const coordinatorFilter = () => screen.getByRole("combobox", { name: "Coordinator" });
const statusFilter = () => screen.getByRole("combobox", { name: "Status" });
const includeFinished = () => screen.getByRole("checkbox", { name: "Include completed, rejected and cancelled" });
const optionsOf = (select) => within(select).getAllByRole("option").map((option) => option.value);
const lastFilters = () => vi.mocked(listAssignedEventsForLead).mock.calls.at(-1)[0];

beforeEach(() => {
  vi.mocked(listUnassignedEventRequests).mockReset();
  vi.mocked(listUnassignedEventRequests).mockResolvedValue([]);
  vi.mocked(listCoordinatorOverview).mockReset();
  vi.mocked(listCoordinatorOverview).mockResolvedValue(OVERVIEW);
  vi.mocked(listAssignedEventsForLead).mockReset();
  vi.mocked(listAssignedEventsForLead).mockResolvedValue([APPROVED_ROW, REVIEW_ROW]);
});


// ---------------------------------------------------------------------------
// AC2: every coordinator, with active events and the count in each status
// ---------------------------------------------------------------------------
describe("SCRUM487_AC2 the coordinators table", () => {
  it("SCRUM487_AC2_one_row_per_coordinator_with_active_events_and_a_column_per_status", async () => {
    // AC2-13. A zero is 0, never blank. One column per active status, headed
    // with the response's label. Until SCRUM-546 this test pinned the old
    // fallback: words collected from event rows, raw keys (submitted,
    // pending_clarification, confirmed) where no row had shown the status.
    renderOverview();
    await screen.findByText("IS212 Industry Night");
    const t = await table();

    expect(headings(t)).toEqual([
      "Coordinator", "Active events", "Requested", "Under review", "Awaiting your response", "Planning", "Confirmed",
    ]);
    expect(bodyRows(t)).toEqual([
      ["Omar Okafor", "0", "0", "0", "0", "0", "0"],
      ["Priya Nair", "5", "0", "2", "0", "3", "0"],
    ]);
    expect(screen.getByText("Every coordinator's events and workload.")).toBeInTheDocument();
  });

  it("SCRUM487_AC2_rows_and_columns_keep_the_servers_order", async () => {
    // Rows by name, never by workload (SCRUM-486 AC3: the system suggests
    // nobody): Priya holds more and stays second. Columns in the order the
    // server sends its statuses, here not the usual one; finished statuses are
    // never columns, as the table counts active events.
    vi.mocked(listCoordinatorOverview).mockResolvedValue({
      statuses: [
        { status: "confirmed", label: "Confirmed", finished: false },
        { status: "completed", label: "Completed", finished: true },
        { status: "submitted", label: "Requested", finished: false },
      ],
      coordinators: [
        { id: OMAR, fullName: "Omar Okafor", activeEvents: 0, byStatus: { confirmed: 0, submitted: 0 } },
        { id: PRIYA, fullName: "Priya Nair", activeEvents: 9, byStatus: { confirmed: 9, submitted: 0 } },
      ],
    });

    renderOverview();
    const t = await table();

    expect(headings(t)).toEqual(["Coordinator", "Active events", "Confirmed", "Requested"]);
    expect(bodyRows(t).map(([name]) => name)).toEqual(["Omar Okafor", "Priya Nair"]);
  });

  it("SCRUM487_AC2_a_coordinator_with_no_name_or_a_missing_count_is_said_not_left_blank", async () => {
    vi.mocked(listCoordinatorOverview).mockResolvedValue({
      statuses: [{ status: "submitted", label: "Requested", finished: false }],
      coordinators: [
        { id: OMAR, fullName: null, activeEvents: 0, byStatus: { submitted: 0 } },
        { id: PRIYA, fullName: "Priya Nair", activeEvents: 0, byStatus: {} },
      ],
    });

    renderOverview();
    const t = await table();

    expect(bodyRows(t)).toEqual([["No name on record", "0", "0"], ["Priya Nair", "0", "0"]]);
  });

  it("SCRUM487_AC2_every_column_is_headed_by_the_responses_label_with_no_event_loaded", async () => {
    // Replaces the raw-key fallback (SCRUM-546, D9). With no event rows at
    // all, nothing to collect a word from, every heading is still a word,
    // and the same word the status badges use.
    vi.mocked(listAssignedEventsForLead).mockResolvedValue([]);

    renderOverview();
    await screen.findByText("No coordinator is holding an active event.");
    const t = await table();

    expect(headings(t).slice(2)).toEqual(["Requested", "Under review", "Awaiting your response", "Planning", "Confirmed"]);
    expect(headings(t).join(" ")).not.toMatch(/_/);
  });

  it("SCRUM487_AC2_no_coordinators_is_said", async () => {
    vi.mocked(listCoordinatorOverview).mockResolvedValue({ statuses: STATUSES, coordinators: [] });

    renderOverview();

    expect(await screen.findByText("There are no Event Coordinators.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("SCRUM487_AC2_the_table_says_it_is_loading", async () => {
    vi.mocked(listCoordinatorOverview).mockReturnValue(new Promise(() => {}));

    renderOverview();

    expect(screen.getByText("Loading coordinators...")).toBeInTheDocument();
  });

  it("SCRUM487_AC2_a_failed_overview_is_said_and_the_events_still_load", async () => {
    vi.mocked(listCoordinatorOverview).mockRejectedValue(httpError(500));

    renderOverview();

    expect(await screen.findByText("The coordinators' workload could not be loaded.")).toBeInTheDocument();
    expect(await screen.findByText("IS212 Industry Night")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // The coordinator filter is still there, with its one choice.
    expect(optionsOf(coordinatorFilter())).toEqual([""]);
  });

  it("SCRUM487_AC2_the_overview_is_read_once_for_the_table_and_the_filter", async () => {
    const user = userEvent.setup();
    renderOverview();
    await table();

    await user.selectOptions(coordinatorFilter(), PRIYA);
    await screen.findByText("IS212 Industry Night");

    expect(listCoordinatorOverview).toHaveBeenCalledTimes(1);
    expect(optionsOf(coordinatorFilter())).toEqual(["", OMAR, PRIYA]);
  });
});


// ---------------------------------------------------------------------------
// AC3: the filters
// ---------------------------------------------------------------------------
describe("SCRUM487_AC3 the events list's filters", () => {
  it("SCRUM487_AC3_the_first_read_sends_no_filters", async () => {
    renderOverview();
    await screen.findByText("IS212 Industry Night");

    expect(listAssignedEventsForLead).toHaveBeenCalledTimes(1);
    expect(lastFilters()).toEqual({ coordinatorId: "", status: "", includeFinished: false });
  });

  it("SCRUM487_AC3_choosing_a_coordinator_reads_their_events", async () => {
    // AC3-17.
    const user = userEvent.setup();
    renderOverview();
    await table();
    vi.mocked(listAssignedEventsForLead).mockResolvedValue([OMARS_ROW]);

    await user.selectOptions(coordinatorFilter(), OMAR);

    expect(await screen.findByText("Hack Night")).toBeInTheDocument();
    expect(screen.queryByText("IS212 Industry Night")).not.toBeInTheDocument();
    expect(lastFilters()).toEqual({ coordinatorId: OMAR, status: "", includeFinished: false });
  });

  it("SCRUM487_AC3_choosing_a_status_reads_that_status", async () => {
    const user = userEvent.setup();
    renderOverview();
    await table();

    await user.selectOptions(statusFilter(), "approved");

    expect(lastFilters()).toEqual({ coordinatorId: "", status: "approved", includeFinished: false });
  });

  it("SCRUM487_AC3_the_status_filter_offers_the_active_statuses_and_the_finished_ones_only_when_included", async () => {
    // Labels as the table's headings; never draft.
    const user = userEvent.setup();
    renderOverview();
    await table();

    expect(optionsOf(statusFilter())).toEqual(["", "submitted", "under_review", "pending_clarification", "approved", "confirmed"]);
    expect(within(statusFilter()).getByRole("option", { name: "Planning" })).toHaveValue("approved");
    expect(within(statusFilter()).queryByRole("option", { name: "Completed" })).not.toBeInTheDocument();

    await user.click(includeFinished());

    expect(lastFilters()).toEqual({ coordinatorId: "", status: "", includeFinished: true });
    expect(optionsOf(statusFilter())).toEqual([
      "", "submitted", "under_review", "pending_clarification", "approved", "confirmed", "completed", "rejected", "cancelled",
    ]);
    expect(optionsOf(statusFilter())).not.toContain("draft");
    expect(within(statusFilter()).getByRole("option", { name: "Completed" })).toHaveValue("completed");
  });

  it("SCRUM487_AC3_every_status_option_is_named_by_the_responses_label_with_no_event_loaded", async () => {
    // Replaces the raw-key fallback for the filter too (SCRUM-546, D9).
    vi.mocked(listAssignedEventsForLead).mockResolvedValue([]);
    const user = userEvent.setup();
    renderOverview();
    await table();
    await user.click(includeFinished());

    expect(within(statusFilter()).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "All statuses", "Requested", "Under review", "Awaiting your response", "Planning", "Confirmed",
      "Completed", "Rejected", "Cancelled",
    ]);
  });

  it("SCRUM487_AC3_unticking_include_finished_resets_a_finished_status", async () => {
    const user = userEvent.setup();
    renderOverview();
    await table();

    await user.click(includeFinished());
    await user.selectOptions(statusFilter(), "completed");
    await user.click(includeFinished());

    expect(statusFilter()).toHaveValue("");
    expect(lastFilters()).toEqual({ coordinatorId: "", status: "", includeFinished: false });
  });

  it("SCRUM487_AC3_unticking_include_finished_keeps_an_active_status", async () => {
    const user = userEvent.setup();
    renderOverview();
    await table();

    await user.click(includeFinished());
    await user.selectOptions(statusFilter(), "approved");
    await user.click(includeFinished());

    expect(statusFilter()).toHaveValue("approved");
    expect(lastFilters()).toEqual({ coordinatorId: "", status: "approved", includeFinished: false });
  });

  it("SCRUM487_AC3_a_stale_answer_never_overwrites_a_newer_one", async () => {
    // The trap: two changes in quick succession, answered out of order. The
    // older answer (Omar's) arrives last and must be ignored.
    const user = userEvent.setup();
    renderOverview();
    await table();
    const omars = deferred();
    vi.mocked(listAssignedEventsForLead)
      .mockReturnValueOnce(omars.promise)
      .mockResolvedValueOnce([APPROVED_ROW]);

    await user.selectOptions(coordinatorFilter(), OMAR);
    await user.selectOptions(coordinatorFilter(), PRIYA);
    expect(await screen.findByText("IS212 Industry Night")).toBeInTheDocument();
    await act(async () => omars.resolve([OMARS_ROW]));

    expect(screen.queryByText("Hack Night")).not.toBeInTheDocument();
    expect(screen.getByText("IS212 Industry Night")).toBeInTheDocument();
  });

  it("SCRUM487_AC3_a_stale_failure_never_overwrites_a_newer_answer", async () => {
    const user = userEvent.setup();
    renderOverview();
    await table();
    let failOld;
    vi.mocked(listAssignedEventsForLead)
      .mockReturnValueOnce(new Promise((_resolve, reject) => { failOld = reject; }))
      .mockResolvedValueOnce([APPROVED_ROW]);

    await user.selectOptions(coordinatorFilter(), OMAR);
    await user.selectOptions(coordinatorFilter(), PRIYA);
    await screen.findByText("IS212 Industry Night");
    await act(async () => failOld(httpError(500)));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("IS212 Industry Night")).toBeInTheDocument();
  });

  it("SCRUM487_AC3_with_filters_set_an_empty_list_says_the_filters_found_nothing", async () => {
    const user = userEvent.setup();
    renderOverview();
    await table();
    vi.mocked(listAssignedEventsForLead).mockResolvedValue([]);

    await user.click(includeFinished());

    expect(await screen.findByText("No events match these filters.")).toBeInTheDocument();
    expect(screen.queryByText("No coordinator is holding an active event.")).not.toBeInTheDocument();
  });

  it("SCRUM487_AC3_without_filters_an_empty_list_still_says_nobody_holds_one", async () => {
    vi.mocked(listAssignedEventsForLead).mockResolvedValue([]);

    renderOverview();

    expect(await screen.findByText("No coordinator is holding an active event.")).toBeInTheDocument();
    expect(screen.queryByText("No events match these filters.")).not.toBeInTheDocument();
  });

  it("SCRUM487_AC3_a_refused_filter_is_said_in_the_pages_words", async () => {
    // A 400: never the server's text. The rows of the last good read go too,
    // so they cannot be taken for the answer to the refused filters.
    const user = userEvent.setup();
    renderOverview();
    await screen.findByText("IS212 Industry Night");
    vi.mocked(listAssignedEventsForLead).mockRejectedValue(httpError(400));

    await user.selectOptions(statusFilter(), "approved");

    expect(await screen.findByRole("alert")).toHaveTextContent("Those filters could not be applied.");
    expect(screen.queryByText("IS212 Industry Night")).not.toBeInTheDocument();
  });
});


// ---------------------------------------------------------------------------
// AC6: from the filtered overview to the event page
// ---------------------------------------------------------------------------
describe("SCRUM487_AC6 a filtered row opens the event", () => {
  it("SCRUM487_AC6_a_filtered_row_opens_the_events_page", async () => {
    // AC6-01's first step. SCRUM-486 proves Open on the unfiltered list; this
    // is the same link after the Lead has filtered by coordinator, so it
    // reaches the event page where the hand-over is.
    const user = userEvent.setup();
    renderOverview();
    await table();
    vi.mocked(listAssignedEventsForLead).mockResolvedValue([OMARS_ROW]);

    await user.selectOptions(coordinatorFilter(), OMAR);
    await user.click(await screen.findByRole("link", { name: "Open Hack Night" }));

    expect(screen.getByText("Event page e3")).toBeInTheDocument();
  });
});
