// scrum489SafetyCheckSubmissionPanel.test.jsx
//
// SCRUM-489 (SCRUM-557): the coordinator's submission panel. The checklist,
// the no-equipment confirmation, the note and Submit, and what each refusal
// says. The service is mocked; the server's own checks are proved in the
// backend's scrum489 suites.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import SafetyCheckSubmissionPanel from "../../src/components/SafetyCheckSubmissionPanel.jsx";
import {
  getEventReadiness,
  submitForSafetyReview,
} from "../../src/services/eventRequestService";

vi.mock("../../src/services/eventRequestService", () => ({
  getEventReadiness: vi.fn(),
  submitForSafetyReview: vi.fn(),
}));

const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const EVENT = Object.freeze({ id: EVENT_ID, eventName: "IS212 Industry Night", status: "approved" });

const VENUE_PENDING = { key: "venue", met: false, detail: "Awaiting approval", bookingId: "b1", venueName: "Room 2" };
const VENUE_MET = { key: "venue", met: true, detail: "Approved", bookingId: "b1", venueName: "Room 2" };
const EQUIPMENT_MET = { key: "equipment", met: true, detail: "Arranged", equipmentRequestId: "q1" };
const DATE_MET = { key: "date", met: true, detail: "Starts in the future" };
const DATE_PASSED = { key: "date", met: false, detail: "The event's start has passed" };
const CONFIRMATION = (met) => ({
  key: "no_equipment_confirmation",
  met,
  detail: "Confirm that this event needs no equipment",
  organiserRequirements: "Two microphones and a projector",
});

const checklist = (items) => ({ eventRequestId: EVENT_ID, ready: items.every((item) => item.met), items });
const READY = checklist([VENUE_MET, EQUIPMENT_MET, DATE_MET]);

function httpError(status, data = {}) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderPanel(props = {}) {
  const user = userEvent.setup();
  const onSubmitted = vi.fn();
  const onStale = vi.fn();
  const utils = render(
    <SafetyCheckSubmissionPanel eventRequest={EVENT} onSubmitted={onSubmitted} onStale={onStale} {...props} />,
  );
  return { user, onSubmitted, onStale, ...utils };
}

const submitButton = () => screen.getByRole("button", { name: /submit for safety check|submitting/i });
const noteBox = () => screen.getByLabelText(/note for the safety officer/i);
const checklistRows = () => within(screen.getByRole("list", { name: "Readiness checklist" })).getAllByRole("listitem");

beforeEach(() => {
  vi.mocked(getEventReadiness).mockReset();
  vi.mocked(submitForSafetyReview).mockReset();
  vi.mocked(getEventReadiness).mockResolvedValue(READY);
});


describe("SCRUM489_AC3 the readiness checklist", () => {
  it("SCRUM489_AC3_each_item_shows_met_or_outstanding_in_words_with_its_detail", async () => {
    vi.mocked(getEventReadiness).mockResolvedValue(checklist([VENUE_PENDING, EQUIPMENT_MET, DATE_PASSED]));
    renderPanel();

    const rows = await waitFor(checklistRows);

    expect(rows.map((row) => row.textContent)).toEqual([
      "VenueRoom 2OutstandingAwaiting approval",
      "EquipmentMetArranged",
      "DateOutstandingThe event's start has passed",
    ]);
    expect(getEventReadiness).toHaveBeenCalledWith(EVENT_ID, { noEquipmentConfirmed: false });
  });

  it("SCRUM489_AC3_submit_is_disabled_while_the_checklist_loads", () => {
    vi.mocked(getEventReadiness).mockReturnValue(new Promise(() => {}));
    renderPanel();

    expect(screen.getByText("Loading the checklist...")).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it("SCRUM489_AC3_submit_is_disabled_while_anything_is_outstanding", async () => {
    vi.mocked(getEventReadiness).mockResolvedValue(checklist([VENUE_PENDING, EQUIPMENT_MET, DATE_MET]));
    renderPanel();

    await waitFor(checklistRows);

    expect(submitButton()).toBeDisabled();
  });

  it("SCRUM489_AC3_submit_is_enabled_once_every_item_is_met", async () => {
    renderPanel();

    await waitFor(() => expect(submitButton()).toBeEnabled());
  });

  it("SCRUM489_AC3_a_form_submitted_while_not_ready_sends_nothing", async () => {
    // Enter in a field submits a form whatever the button says.
    vi.mocked(getEventReadiness).mockResolvedValue(checklist([VENUE_PENDING, DATE_MET]));
    renderPanel();
    await waitFor(checklistRows);

    fireEvent.submit(submitButton().closest("form"));

    expect(submitForSafetyReview).not.toHaveBeenCalled();
  });

  it("SCRUM489_AC3_a_failed_read_offers_retry_which_reads_again", async () => {
    vi.mocked(getEventReadiness).mockRejectedValueOnce(httpError(500)).mockResolvedValueOnce(READY);
    const { user } = renderPanel();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The checklist could not be loaded.");
    expect(submitButton()).toBeDisabled();

    await user.click(within(alert).getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(checklistRows()).toHaveLength(3));
    expect(getEventReadiness).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM489_AC3_a_409_event_not_ready_shows_every_returned_line_and_reads_the_checklist_again", async () => {
    // Something changed between the read and the submit.
    const outstanding = [VENUE_PENDING, { key: "equipment", met: false, detail: "Cannot be fully arranged", equipmentRequestId: "q1" }, DATE_PASSED];
    vi.mocked(getEventReadiness).mockResolvedValueOnce(READY).mockResolvedValueOnce(checklist(outstanding));
    vi.mocked(submitForSafetyReview).mockRejectedValue(httpError(409, {
      error: "server words", code: "EVENT_NOT_READY", conflicts: outstanding,
    }));
    const { user, onSubmitted } = renderPanel();
    await waitFor(() => expect(submitButton()).toBeEnabled());

    await user.click(submitButton());

    const listed = await screen.findByRole("list", { name: "Outstanding items" });
    expect(within(listed).getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      "VenueRoom 2OutstandingAwaiting approval",
      "EquipmentOutstandingCannot be fully arranged",
      "DateOutstandingThe event's start has passed",
    ]);
    await waitFor(() => expect(getEventReadiness).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(submitButton()).toBeDisabled());
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(screen.queryByText("server words")).not.toBeInTheDocument();
  });

  it("SCRUM489_AC3_a_409_event_not_ready_without_a_list_still_says_it_is_not_ready", async () => {
    vi.mocked(submitForSafetyReview).mockRejectedValue(httpError(409, { code: "EVENT_NOT_READY", conflicts: "not a list" }));
    const { user } = renderPanel();
    await waitFor(() => expect(submitButton()).toBeEnabled());

    await user.click(submitButton());

    const listed = await screen.findByRole("list", { name: "Outstanding items" });
    expect(within(listed).queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByText(/not ready for the safety check/)).toBeInTheDocument();
  });

  it("SCRUM489_AC3_an_item_of_a_kind_this_build_does_not_know_is_still_shown", async () => {
    vi.mocked(getEventReadiness).mockResolvedValue(checklist([{ key: "registration", met: false, detail: "Not open" }]));
    renderPanel();

    const rows = await waitFor(checklistRows);

    expect(rows.map((row) => row.textContent)).toEqual(["OtherOutstandingNot open"]);
  });

  it("SCRUM489_AC3_a_read_that_lands_after_a_newer_one_is_ignored", async () => {
    const first = deferred();
    vi.mocked(getEventReadiness)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(checklist([VENUE_PENDING, DATE_MET]));
    const { rerender } = renderPanel();

    // A new event id starts a new read; the first answer arrives late.
    rerender(<SafetyCheckSubmissionPanel eventRequest={{ ...EVENT, id: "33333333-3333-4333-8333-333333333333" }} />);
    await waitFor(() => expect(checklistRows()).toHaveLength(2));
    first.resolve(READY);
    await Promise.resolve();

    expect(checklistRows()).toHaveLength(2);
    expect(submitButton()).toBeDisabled();
  });

  it("SCRUM489_AC3_a_read_that_fails_after_the_panel_closes_changes_nothing", async () => {
    const first = deferred();
    vi.mocked(getEventReadiness).mockReturnValueOnce(first.promise);
    const { unmount } = renderPanel();

    unmount();
    first.reject(httpError(500));
    await Promise.resolve();

    expect(getEventReadiness).toHaveBeenCalledTimes(1);
  });
});


describe("SCRUM489_AC4 the no-equipment confirmation", () => {
  it.each([
    ["no_confirmation_item", "not_shown", [VENUE_MET, EQUIPMENT_MET, DATE_MET], false],
    ["a_confirmation_item", "shown", [VENUE_MET, CONFIRMATION(false), DATE_MET], true],
  ])("SCRUM489_AC4_with_%s_the_checkbox_is_%s", async (_label, _shownLabel, items, shown) => {
    vi.mocked(getEventReadiness).mockResolvedValue(checklist(items));
    renderPanel();
    await waitFor(checklistRows);

    expect(Boolean(screen.queryByRole("checkbox", { name: "This event needs no equipment" }))).toBe(shown);
  });

  it("SCRUM489_AC4_the_organisers_requirements_are_quoted_beside_it", async () => {
    vi.mocked(getEventReadiness).mockResolvedValue(checklist([VENUE_MET, CONFIRMATION(false), DATE_MET]));
    renderPanel();

    expect(await screen.findByText("Two microphones and a projector")).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it("SCRUM489_AC4_ticking_reads_again_with_no_equipment_confirmed_and_shows_the_servers_answer", async () => {
    vi.mocked(getEventReadiness)
      .mockResolvedValueOnce(checklist([VENUE_MET, CONFIRMATION(false), DATE_MET]))
      .mockResolvedValueOnce(checklist([VENUE_MET, CONFIRMATION(true), DATE_MET]));
    const { user } = renderPanel();
    await waitFor(checklistRows);

    await user.click(screen.getByRole("checkbox", { name: "This event needs no equipment" }));

    await waitFor(() => expect(submitButton()).toBeEnabled());
    expect(getEventReadiness).toHaveBeenLastCalledWith(EVENT_ID, { noEquipmentConfirmed: true });
    expect(checklistRows()[1]).toHaveTextContent("No equipment neededMetConfirm that this event needs no equipment");
  });

  it("SCRUM489_AC4_the_confirmation_is_sent_on_submit", async () => {
    vi.mocked(getEventReadiness)
      .mockResolvedValueOnce(checklist([VENUE_MET, CONFIRMATION(false), DATE_MET]))
      .mockResolvedValueOnce(checklist([VENUE_MET, CONFIRMATION(true), DATE_MET]));
    vi.mocked(submitForSafetyReview).mockResolvedValue({ ...EVENT, status: "safety_review" });
    const { user } = renderPanel();
    await waitFor(checklistRows);
    await user.click(screen.getByRole("checkbox", { name: "This event needs no equipment" }));
    await waitFor(() => expect(submitButton()).toBeEnabled());

    await user.click(submitButton());

    expect(submitForSafetyReview).toHaveBeenCalledWith(EVENT_ID, { note: undefined, noEquipmentConfirmed: true });
  });
});


describe("SCRUM489_AC5 the note for the Safety Officer", () => {
  it("SCRUM489_AC5_the_counter_counts_the_trimmed_note", async () => {
    const { user } = renderPanel();
    await waitFor(() => expect(submitButton()).toBeEnabled());

    expect(screen.getByText("0 / 2,000")).toBeInTheDocument();
    await user.type(noteBox(), "  East doors  ");

    expect(screen.getByText("10 / 2,000")).toBeInTheDocument();
    expect(screen.getByText(/crowd will move and where equipment will be placed/)).toBeInTheDocument();
  });

  it("SCRUM489_AC5_a_note_of_2000_characters_is_accepted_and_sent", async () => {
    vi.mocked(submitForSafetyReview).mockResolvedValue({ ...EVENT, status: "safety_review" });
    const { user } = renderPanel();
    await waitFor(() => expect(submitButton()).toBeEnabled());

    fireEvent.change(noteBox(), { target: { value: "x".repeat(2000) } });
    expect(screen.getByText("2,000 / 2,000")).toBeInTheDocument();
    await user.click(submitButton());

    expect(submitForSafetyReview).toHaveBeenCalledWith(EVENT_ID, { note: "x".repeat(2000), noEquipmentConfirmed: false });
  });

  it("SCRUM489_AC5_a_note_of_2001_characters_blocks_submit_with_a_message", async () => {
    renderPanel();
    await waitFor(() => expect(submitButton()).toBeEnabled());

    fireEvent.change(noteBox(), { target: { value: "x".repeat(2001) } });

    expect(screen.getByText("2,001 / 2,000")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The note must be 2,000 characters or fewer.");
    expect(submitButton()).toBeDisabled();
  });

  it("SCRUM489_AC5_spaces_around_2000_characters_do_not_count", async () => {
    renderPanel();
    await waitFor(() => expect(submitButton()).toBeEnabled());

    fireEvent.change(noteBox(), { target: { value: `   ${"x".repeat(2000)}   ` } });

    expect(submitButton()).toBeEnabled();
  });

  it("SCRUM489_AC5_a_whitespace_only_note_sends_no_note", async () => {
    vi.mocked(submitForSafetyReview).mockResolvedValue({ ...EVENT, status: "safety_review" });
    const { user } = renderPanel();
    await waitFor(() => expect(submitButton()).toBeEnabled());

    fireEvent.change(noteBox(), { target: { value: "   \n\t  " } });
    await user.click(submitButton());

    expect(submitForSafetyReview).toHaveBeenCalledWith(EVENT_ID, { note: undefined, noEquipmentConfirmed: false });
  });

  it("SCRUM489_AC5_the_note_is_sent_trimmed", async () => {
    vi.mocked(submitForSafetyReview).mockResolvedValue({ ...EVENT, status: "safety_review" });
    const { user } = renderPanel();
    await waitFor(() => expect(submitButton()).toBeEnabled());

    await user.type(noteBox(), "  Crowd leaves by the east doors.  ");
    await user.click(submitButton());

    expect(submitForSafetyReview).toHaveBeenCalledWith(EVENT_ID, {
      note: "Crowd leaves by the east doors.", noEquipmentConfirmed: false,
    });
  });
});


describe("SCRUM489_AC6 a successful submission", () => {
  it("SCRUM489_AC6_success_hands_the_returned_event_to_the_page", async () => {
    const updated = { ...EVENT, status: "safety_review", statusDisplay: { label: "Safety check" } };
    vi.mocked(submitForSafetyReview).mockResolvedValue(updated);
    const { user, onSubmitted, onStale } = renderPanel();
    await waitFor(() => expect(submitButton()).toBeEnabled());

    await user.click(submitButton());

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith(updated));
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    expect(onStale).not.toHaveBeenCalled();
  });

  it("SCRUM489_AC6_submit_is_disabled_and_says_so_while_sending", async () => {
    vi.mocked(submitForSafetyReview).mockReturnValue(new Promise(() => {}));
    const { user } = renderPanel();
    await waitFor(() => expect(submitButton()).toBeEnabled());

    await user.click(submitButton());

    expect(screen.getByRole("button", { name: "Submitting..." })).toBeDisabled();
  });

  it("SCRUM489_AC6_without_handlers_a_submission_still_completes", async () => {
    vi.mocked(submitForSafetyReview).mockResolvedValueOnce({ ...EVENT, status: "safety_review" })
      .mockRejectedValueOnce(httpError(409, { code: "INVALID_STATUS" }));
    const user = userEvent.setup();
    render(<SafetyCheckSubmissionPanel eventRequest={EVENT} />);
    await waitFor(() => expect(submitButton()).toBeEnabled());

    await user.click(submitButton());
    await waitFor(() => expect(submitButton()).toHaveTextContent("Submit for safety check"));
    await user.click(submitButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(/no longer Approved/);
  });
});


describe("SCRUM489 refusals, keyed on the status and the code", () => {
  it.each([
    [403, "", {}, "You are no longer this event's coordinator, so you cannot submit it."],
    [400, "", {}, "The note could not be sent. It must be 2,000 characters or fewer."],
    [409, "_with_another_code", { code: "INVALID_STATUS" }, "This event is no longer Approved, so it cannot be submitted for the safety check. The page has been refreshed to show where it stands."],
    [409, "_with_no_code", {}, "This event is no longer Approved, so it cannot be submitted for the safety check. The page has been refreshed to show where it stands."],
    [500, "", {}, "The event could not be submitted for the safety check. No changes have been made; try again."],
    [404, "", {}, "The event could not be submitted for the safety check. No changes have been made; try again."],
  ])("SCRUM489_AC1_a_%s%s_shows_its_own_message", async (status, _label, data, message) => {
    vi.mocked(submitForSafetyReview).mockRejectedValue(httpError(status, { error: "server words", ...data }));
    const { user, onSubmitted, onStale } = renderPanel();
    await waitFor(() => expect(submitButton()).toBeEnabled());

    await user.click(submitButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText("server words")).not.toBeInTheDocument();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(onStale).toHaveBeenCalledTimes(status === 409 ? 1 : 0);
  });

  it("SCRUM489_AC1_a_request_that_never_reached_the_server_shows_the_generic_message", async () => {
    vi.mocked(submitForSafetyReview).mockRejectedValue(new Error("Network Error"));
    const { user } = renderPanel();
    await waitFor(() => expect(submitButton()).toBeEnabled());

    await user.click(submitButton());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The event could not be submitted for the safety check. No changes have been made; try again.",
    );
  });
});
