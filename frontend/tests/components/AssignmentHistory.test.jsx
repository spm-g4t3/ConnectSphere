// AssignmentHistory.test.jsx
//
// SCRUM-486 (SCRUM-522): the history on screen now holds two kinds of row,
// and who holds the request is not always its newest row.
//
//   AC9-06  an old automatic row reads "ConnectSphere, automatically on
//           submission"; a Lead's row names the Lead.
//   TR-03   a request resubmitted after a rejection waits for the Lead with no
//           coordinator, though its history ends with the one who held it
//           before. "Current coordinator" must say not assigned.
//
// The component had no tests of its own before this; its SCRUM-334 behaviour
// was exercised only inside the screens that mount it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

import AssignmentHistory from "../../src/components/AssignmentHistory.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import { getAssignmentHistory, getAssignmentHistoryForReview } from "../../src/services/eventRequestService";

vi.mock("../../src/auth/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../../src/services/eventRequestService", () => ({
  getAssignmentHistory: vi.fn(),
  getAssignmentHistoryForReview: vi.fn(),
}));

const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const PRIYA = "44444444-4444-4444-8444-444444444444";
const OMAR = "66666666-6666-4666-8666-666666666666";
const LEAD = "77777777-7777-4777-8777-777777777777";

/** An assignment from before SCRUM-486: by the system, on submission. */
const automatic = {
  id: "h1",
  previousCoordinatorId: null,
  previousCoordinatorName: null,
  newCoordinatorId: PRIYA,
  newCoordinatorName: "Priya Nair",
  assignedById: null,
  assignedByName: null,
  automatic: true,
  createdAt: "2026-09-20T03:00:00+00:00",
};

/** A Lead's handover, Priya to Omar. */
const leadHandover = {
  id: "h2",
  previousCoordinatorId: PRIYA,
  previousCoordinatorName: "Priya Nair",
  newCoordinatorId: OMAR,
  newCoordinatorName: "Omar Okafor",
  assignedById: LEAD,
  assignedByName: "Lena Lead",
  automatic: false,
  createdAt: "2026-10-11T03:00:00+00:00",
};

/** A Lead's first assignment, under SCRUM-486. */
const leadFirst = { ...leadHandover, id: "h3", previousCoordinatorId: null, previousCoordinatorName: null };

function renderHistory(entries, props = {}) {
  vi.mocked(getAssignmentHistory).mockResolvedValue(entries);
  vi.mocked(getAssignmentHistoryForReview).mockResolvedValue(entries);
  return render(<AssignmentHistory eventRequestId={REQUEST_ID} view="organiser" {...props} />);
}

const current = async () => (await screen.findByText("Current coordinator")).closest("p");
const entryRows = async () => within(await screen.findByRole("list")).getAllByRole("listitem");

beforeEach(() => {
  vi.mocked(useAuth).mockReturnValue({ user: { id: "someone-else" } });
  vi.mocked(getAssignmentHistory).mockReset();
  vi.mocked(getAssignmentHistoryForReview).mockReset();
});


describe("SCRUM486_AC9 who made each assignment, old rows and new", () => {
  it("SCRUM486_AC9_an_old_automatic_row_and_a_leads_row_read_differently_in_one_history", async () => {
    // AC9-06. Assigned automatically in September, handed on by a Lead in
    // October: both kinds of row on one event, as the live data has them.
    renderHistory([automatic, leadHandover], { currentCoordinatorId: OMAR });

    const [first, second] = await entryRows();
    expect(first).toHaveTextContent("by ConnectSphere, automatically on submission");
    expect(second).toHaveTextContent("by Lena Lead");
    expect(second).not.toHaveTextContent("automatically");
  });

  it("SCRUM486_AC9_a_leads_first_assignment_names_the_lead_not_the_system", async () => {
    renderHistory([leadFirst], { currentCoordinatorId: OMAR });

    const [only] = await entryRows();
    expect(only).toHaveTextContent("Assigned to Omar Okafor");
    expect(only).toHaveTextContent("by Lena Lead");
    expect(only).not.toHaveTextContent("automatically");
  });
});


describe("SCRUM486_TR03 the current coordinator comes from the request, not the newest row", () => {
  it("SCRUM486_TR03_a_resubmitted_request_waiting_for_the_lead_reads_not_assigned", async () => {
    // TR-02's request: Priya held it, it was rejected, reopened and submitted
    // again, and 041 left it with no coordinator. Its history still ends with
    // Priya. Taken from the newest row, the screen would say she holds it.
    renderHistory([automatic], { currentCoordinatorId: null });

    expect(await current()).toHaveTextContent("Not assigned yet");
    expect(await current()).not.toHaveTextContent("Priya Nair");
    // The history itself is still shown in full: Priya did hold it once.
    expect((await entryRows())[0]).toHaveTextContent("Assigned to Priya Nair");
  });

  it("SCRUM486_TR03_the_holder_is_named_from_the_entry_that_gave_it_to_them", async () => {
    renderHistory([automatic, leadHandover], { currentCoordinatorId: OMAR });

    expect(await current()).toHaveTextContent("Omar Okafor");
  });

  it("SCRUM486_TR03_with_no_id_passed_the_newest_entry_is_current_as_before", async () => {
    // The SCRUM-334 behaviour, kept for a caller that does not know the request.
    renderHistory([automatic, leadHandover]);

    expect(await current()).toHaveTextContent("Omar Okafor");
  });

  it("SCRUM486_TR03_with_no_history_and_no_id_nobody_is_current", async () => {
    renderHistory([]);

    expect(await current()).toHaveTextContent("Not assigned yet");
  });

  it("SCRUM486_TR03_a_holder_missing_from_the_history_is_shown_by_id_not_hidden", async () => {
    // Should not happen: every assignment writes a row. If it ever does, the
    // holder is still shown, as the screen shows any person with no name.
    renderHistory([automatic], { currentCoordinatorId: OMAR });

    expect(await current()).toHaveTextContent(`No name on record ${OMAR}`);
  });
});
