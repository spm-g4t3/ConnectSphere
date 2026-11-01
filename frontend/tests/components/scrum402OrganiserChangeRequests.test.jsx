// scrum402OrganiserChangeRequests.test.jsx
//
// SCRUM-402 (SCRUM-408, AC1, AC7, AC10): the Organiser's change request form,
// several fields in one request with a note, and their status list, one card
// per submission. Every refusal carries server text the form must not show.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import ChangeRequestForm from "../../src/components/ChangeRequestForm.jsx";
import ChangeRequestStatusList from "../../src/components/ChangeRequestStatusList.jsx";
import { getChangeRequests, submitChangeRequest } from "../../src/services/changeRequestService";
import { formatTimestamp } from "../../src/services/displayFormat.js";
import { httpError } from "../helpers/async.js";

vi.mock("../../src/services/changeRequestService", () => ({
  submitChangeRequest: vi.fn(),
  getChangeRequests: vi.fn(),
}));

const SERVER_TEXT = "Raw database wording the form must never show";
const rows = () => screen.getAllByRole("group", { name: /^Change \d/ });
const fieldOf = (i) => within(rows()[i]).getByLabelText("What needs to change?");

async function choose(user, i, option) {
  await user.selectOptions(fieldOf(i), option);
}
async function describeAs(user, i, text) {
  await user.type(within(rows()[i]).getByRole("textbox"), text);
}

beforeEach(() => {
  vi.mocked(submitChangeRequest).mockReset();
  vi.mocked(submitChangeRequest).mockResolvedValue([]);
  vi.mocked(getChangeRequests).mockReset();
});


describe("SCRUM-402 the Organiser's form", () => {
  it("SCRUM402_AC1_several_fields_and_a_note_go_as_one_group", async () => {
    const user = userEvent.setup();
    const onSubmitted = vi.fn();
    render(<ChangeRequestForm eventRequestId="e1" onSubmitted={onSubmitted} />);

    await choose(user, 0, "purpose");
    await describeAs(user, 0, "  Alumni networking  ");
    await user.click(screen.getByRole("button", { name: "Add another change" }));
    await choose(user, 1, "proposedStart");
    fireEvent.change(within(rows()[1]).getByLabelText("Describe the change"), { target: { value: "2026-12-02T09:00" } });
    await user.click(screen.getByRole("button", { name: "Add another change" }));
    await choose(user, 2, "expectedAttendance");
    await user.type(within(rows()[2]).getByRole("spinbutton"), "150");
    await user.type(screen.getByLabelText("Note for the coordinator (optional)"), "  Our sponsor asked  ");
    await user.click(screen.getByRole("button", { name: "Submit change request" }));

    expect(submitChangeRequest).toHaveBeenCalledWith("e1", {
      changes: [
        { field: "purpose", details: "Alumni networking" },
        { field: "proposed_start", details: new Date("2026-12-02T09:00").toISOString() },
        { field: "expected_attendance", details: "150" },
      ],
      note: "Our sponsor asked",
    });
    expect(await screen.findByText("Your change request has been submitted.")).toBeInTheDocument();
    expect(onSubmitted).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Request another change" }));
    expect(rows()).toHaveLength(1);
  });

  it("SCRUM402_AC1_no_note_sends_none_and_a_row_can_be_removed", async () => {
    const user = userEvent.setup();
    render(<ChangeRequestForm eventRequestId="e1" />);
    await choose(user, 0, "purpose");
    await describeAs(user, 0, "One");
    await user.click(screen.getByRole("button", { name: "Add another change" }));
    await choose(user, 1, "description");
    await describeAs(user, 1, "Two");

    await user.click(within(rows()[0]).getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Submit change request" }));

    expect(submitChangeRequest).toHaveBeenCalledWith("e1", { changes: [{ field: "description", details: "Two" }] });
  });

  it("SCRUM402_AC1_at_most_nine_changes", async () => {
    const user = userEvent.setup();
    render(<ChangeRequestForm eventRequestId="e1" />);

    for (let i = 1; i < 9; i += 1) await user.click(screen.getByRole("button", { name: "Add another change" }));

    expect(rows()).toHaveLength(9);
    expect(screen.getByRole("button", { name: "Add another change" })).toBeDisabled();
  });

  it("SCRUM402_AC7_cancel_the_event_stands_alone_and_asks_why", async () => {
    const user = userEvent.setup();
    render(<ChangeRequestForm eventRequestId="e1" />);
    await choose(user, 0, "purpose");
    await user.click(screen.getByRole("button", { name: "Add another change" }));

    await choose(user, 1, "cancelEvent");

    expect(rows()).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Add another change" })).not.toBeInTheDocument();
    expect(within(rows()[0]).getByLabelText("Why do you want to cancel?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Submit change request" }));
    expect(screen.getByText("Say why you want to cancel.")).toBeInTheDocument();
    expect(submitChangeRequest).not.toHaveBeenCalled();

    await user.type(within(rows()[0]).getByLabelText("Why do you want to cancel?"), "We lost our speaker");
    await user.click(screen.getByRole("button", { name: "Submit change request" }));
    expect(submitChangeRequest).toHaveBeenCalledWith("e1", { changes: [{ field: "cancellation", details: "We lost our speaker" }] });
  });

  it.each([
    ["accessibility_and_something_else", "accessibilityRequirements", "other", "Put accessibility and other changes in one 'Something else' entry."],
    ["the_same_field_twice", "purpose", "purpose", "This field is already in this request."],
  ])("SCRUM402_AC1_%s_is_refused_in_the_form", async (_label, first, second, message) => {
    const user = userEvent.setup();
    render(<ChangeRequestForm eventRequestId="e1" />);
    await choose(user, 0, first);
    await describeAs(user, 0, "A");
    await user.click(screen.getByRole("button", { name: "Add another change" }));
    await choose(user, 1, second);
    await describeAs(user, 1, "B");

    await user.click(screen.getByRole("button", { name: "Submit change request" }));

    expect(within(rows()[1]).getByText(message)).toBeInTheDocument();
    expect(submitChangeRequest).not.toHaveBeenCalled();
  });

  it("SCRUM402_AC1_a_blank_row_and_a_long_note_are_refused_before_sending", async () => {
    const user = userEvent.setup();
    render(<ChangeRequestForm eventRequestId="e1" />);

    await user.click(screen.getByRole("button", { name: "Submit change request" }));
    expect(screen.getByText("Choose what you'd like to change.")).toBeInTheDocument();

    await choose(user, 0, "purpose");
    await user.click(screen.getByRole("button", { name: "Submit change request" }));
    expect(screen.getByText("Describe the change you're requesting.")).toBeInTheDocument();

    await describeAs(user, 0, "New");
    fireEvent.change(screen.getByLabelText("Note for the coordinator (optional)"), { target: { value: "x".repeat(2001) } });
    await user.click(screen.getByRole("button", { name: "Submit change request" }));
    expect(screen.getByRole("alert")).toHaveTextContent("The note must be 2,000 characters or fewer.");
    expect(submitChangeRequest).not.toHaveBeenCalled();
  });

  it("SCRUM402_AC1_accessibility_says_it_travels_as_something_else", async () => {
    const user = userEvent.setup();
    render(<ChangeRequestForm eventRequestId="e1" />);

    await choose(user, 0, "accessibilityRequirements");

    expect(screen.getByText(/This will be recorded as "Something else"/)).toBeInTheDocument();
  });

  it("SCRUM402_AC1_a_400s_faults_go_beside_their_rows_and_the_rest_in_a_list", async () => {
    vi.mocked(submitChangeRequest).mockRejectedValueOnce(httpError(400, {
      error: SERVER_TEXT,
      details: [
        { field: "changes[1].requestedChange", message: "must be a positive whole number of attendees" },
        { field: "note", message: "must be 2,000 characters or fewer" },
      ],
    }));
    const user = userEvent.setup();
    render(<ChangeRequestForm eventRequestId="e1" />);
    await choose(user, 0, "purpose");
    await describeAs(user, 0, "New");
    await user.click(screen.getByRole("button", { name: "Add another change" }));
    await choose(user, 1, "expectedAttendance");
    await user.type(within(rows()[1]).getByRole("spinbutton"), "5");

    await user.click(screen.getByRole("button", { name: "Submit change request" }));

    expect(await within(rows()[1]).findByText("must be a positive whole number of attendees")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("must be 2,000 characters or fewer");
    expect(screen.queryByText(SERVER_TEXT)).not.toBeInTheDocument();
  });

  it.each([
    ["a_400_with_no_details", httpError(400, { error: SERVER_TEXT }), "can't be submitted as written"],
    ["a_401", httpError(401, { error: SERVER_TEXT }), "Your session has expired."],
    ["a_403", httpError(403, { error: SERVER_TEXT }), "This event can't be changed from your account."],
    ["a_404", httpError(404, { error: SERVER_TEXT }), "This event can't be found."],
    ["a_500", httpError(500, { error: SERVER_TEXT }), "Could not submit your change request. Please try again."],
  ])("SCRUM402_AC1_%s_is_said_in_the_forms_own_words", async (_label, err, message) => {
    vi.mocked(submitChangeRequest).mockRejectedValueOnce(err);
    const user = userEvent.setup();
    render(<ChangeRequestForm eventRequestId="e1" />);
    await choose(user, 0, "purpose");
    await describeAs(user, 0, "New");

    await user.click(screen.getByRole("button", { name: "Submit change request" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText(SERVER_TEXT)).not.toBeInTheDocument();
  });
});


describe("SCRUM-402 the Organiser's list", () => {
  const cr = (overrides) => ({
    id: "r1", requestGroupId: "g1", changeField: "purpose", details: "Alumni networking", status: "outstanding",
    decision: null, decisionNotes: null, organiserNote: null, processedAt: null, createdAt: "2026-10-20T03:00:00Z", ...overrides,
  });

  it("SCRUM402_AC10_one_card_per_submission_with_its_fields_and_note", async () => {
    vi.mocked(getChangeRequests).mockResolvedValue([
      cr({ organiserNote: "Our sponsor asked" }),
      cr({ id: "r2", changeField: "expected_attendance", details: "150" }),
    ]);

    render(<ChangeRequestStatusList eventRequestId="e1" />);

    const card = (await screen.findByText("Our sponsor asked")).closest(".change-request-status-list__item");
    expect(card).toHaveTextContent("Purpose");
    expect(card).toHaveTextContent("Expected attendance");
    expect(card).toHaveTextContent("150");
    expect(card).toHaveTextContent("Outstanding");
    expect(card).toHaveTextContent(`Requested ${formatTimestamp("2026-10-20T03:00:00Z", "")}`);
    expect(screen.getAllByText(/^Outstanding$/)).toHaveLength(1);
  });

  it.each([
    ["approved", "Accepted", "Coordinator note:"],
    ["rejected", "Declined", "Coordinator's reason:"],
    ["event_cancelled", "Closed: the event was cancelled", "Coordinator note:"],
    ["event_rejected", "Closed: the event was rejected", "Coordinator note:"],
    ["a_value_from_a_later_story", "Closed", "Coordinator note:"],
  ])("SCRUM402_AC10_the_outcome_%s_reads_as_%s_with_the_coordinators_words_and_date", async (decision, label, noteLabel) => {
    vi.mocked(getChangeRequests).mockResolvedValue([cr({
      status: "processed", decision, decisionNotes: "Seen to", processedAt: "2026-10-22T03:00:00Z",
    })]);

    render(<ChangeRequestStatusList eventRequestId="e1" />);

    expect(await screen.findByText(`Outcome: ${label}`)).toBeInTheDocument();
    expect(screen.getByText(noteLabel)).toBeInTheDocument();
    expect(screen.getByText(/processed/)).toHaveTextContent(formatTimestamp("2026-10-22T03:00:00Z", ""));
  });

  it("SCRUM402_AC10_an_unknown_status_and_a_row_from_before_the_groups_still_read", async () => {
    vi.mocked(getChangeRequests).mockResolvedValue([{ id: "old", changeField: "venue", requestedChange: "A larger room", status: "paused", createdAt: null }]);

    render(<ChangeRequestStatusList eventRequestId="e1" />);

    expect(await screen.findByText("A larger room")).toBeInTheDocument();
    expect(screen.getByText("paused")).toBeInTheDocument();
    expect(screen.getByText(/Requested on an unrecorded date/)).toBeInTheDocument();
  });

  it("SCRUM402_AC10_says_when_there_are_none_and_when_the_read_fails", async () => {
    vi.mocked(getChangeRequests).mockResolvedValueOnce([]);
    const { unmount } = render(<ChangeRequestStatusList eventRequestId="e1" />);
    expect(await screen.findByText("You haven't requested any changes for this event.")).toBeInTheDocument();
    unmount();

    vi.mocked(getChangeRequests).mockRejectedValueOnce(new Error("boom"));
    render(<ChangeRequestStatusList eventRequestId="e1" />);
    expect(await screen.findByText("Could not load your change requests.")).toBeInTheDocument();
  });
});
