// scrum379EventCompletionPanel.test.jsx
//
// SCRUM-384 (SCRUM-379 AC1, AC2, AC3): the Mark as completed panel. Optional closing notes, a
// confirmation step before anything is sent, the server's refusals shown, and no way to send twice.
// The service is mocked, so nothing touches the network.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import EventCompletionPanel from "../../src/components/EventCompletionPanel.jsx";
import { completeEventRequest } from "../../src/services/eventRequestService";

vi.mock("../../src/services/eventRequestService", () => ({
  completeEventRequest: vi.fn(),
}));

const EVENT = {
  id: "22222222-2222-4222-8222-222222222222",
  eventName: "IS212 Industry Night",
  status: "confirmed",
  // 09:00 to 11:00 in Singapore.
  proposedStart: "2030-06-15T01:00:00Z",
  proposedEnd: "2030-06-15T03:00:00Z",
};

const COMPLETED = { ...EVENT, status: "completed", closingNotes: "All went well." };

const refusal = (status, data = {}) => Object.assign(new Error("request failed"), { response: { status, data } });

const notesBox = () => screen.getByLabelText("Closing notes (optional)");
const continueButton = () => screen.getByRole("button", { name: "Continue" });
const confirmButton = () => screen.getByRole("button", { name: "Yes, mark as completed" });

function renderPanel(props = {}) {
  const onCompleted = vi.fn();
  const onBack = vi.fn();
  const user = userEvent.setup();
  render(<EventCompletionPanel eventRequest={EVENT} onCompleted={onCompleted} onBack={onBack} {...props} />);
  return { user, onCompleted, onBack };
}

beforeEach(() => {
  vi.mocked(completeEventRequest).mockReset();
  vi.mocked(completeEventRequest).mockResolvedValue(COMPLETED);
});

describe("SCRUM379 the notes step", () => {
  it("SCRUM379_AC1_names_the_event_and_says_completing_is_final", () => {
    renderPanel();

    expect(screen.getByRole("heading", { level: 1, name: "Mark IS212 Industry Night as completed" })).toBeInTheDocument();
    expect(screen.getByText(/Completing it is final/)).toBeInTheDocument();
  });

  it("SCRUM379_AC1_shows_when_the_event_ran_in_singapore_time", () => {
    renderPanel();

    expect(screen.getByText(/2030-06-15 09:00 – 11:00 \(Singapore time\)/)).toBeInTheDocument();
  });

  it("SCRUM379_AC1_an_event_with_no_recorded_period_says_so_instead_of_a_blank", () => {
    renderPanel({ eventRequest: { ...EVENT, proposedStart: null, proposedEnd: null } });

    expect(screen.getByText(/at a time that is not recorded/)).toBeInTheDocument();
  });

  it("SCRUM379_AC2_the_notes_box_is_labelled_optional_and_starts_empty", () => {
    renderPanel();

    expect(notesBox()).toHaveValue("");
    expect(notesBox()).not.toBeRequired();
  });

  it("SCRUM379_AC2_says_who_can_see_the_notes", () => {
    renderPanel();

    expect(screen.getByText(/Only coordinators can see these notes\./)).toBeInTheDocument();
  });

  it("SCRUM379_AC2_counts_the_characters_typed", async () => {
    const { user } = renderPanel();

    await user.type(notesBox(), "Hello");

    expect(screen.getByText(/5 of 2000 characters/)).toBeInTheDocument();
  });

  it("SCRUM379_AC1_nothing_is_sent_by_opening_the_panel_or_by_continuing", async () => {
    const { user } = renderPanel();

    await user.click(continueButton());

    expect(completeEventRequest).not.toHaveBeenCalled();
  });

  it("SCRUM379_AC1_the_back_button_leaves_without_sending", async () => {
    const { user, onBack } = renderPanel();

    await user.click(screen.getByRole("button", { name: "Back to event" }));

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(completeEventRequest).not.toHaveBeenCalled();
  });

  it("SCRUM379_AC1_there_is_no_back_button_when_the_parent_gives_no_handler", () => {
    renderPanel({ onBack: undefined });

    expect(screen.queryByRole("button", { name: "Back to event" })).not.toBeInTheDocument();
  });
});

describe("SCRUM379 the confirmation step", () => {
  it("SCRUM379_AC1_continuing_asks_for_confirmation_and_says_it_cannot_be_undone", async () => {
    const { user } = renderPanel();

    await user.click(continueButton());

    expect(screen.getByRole("group", { name: "Confirm completion" })).toBeInTheDocument();
    expect(screen.getByText(/This\s+cannot be undone/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Closing notes (optional)")).not.toBeInTheDocument();
  });

  it("SCRUM379_AC2_the_summary_shows_the_notes_as_they_will_be_sent", async () => {
    const { user } = renderPanel();

    await user.type(notesBox(), "  Attendance 180.  ");
    await user.click(continueButton());

    expect(screen.getByText("Attendance 180.", { selector: "dd" })).toBeInTheDocument();
  });

  it("SCRUM379_AC2_the_summary_says_when_there_are_no_notes", async () => {
    const { user } = renderPanel();

    await user.click(continueButton());

    expect(screen.getByText("No closing notes.")).toBeInTheDocument();
  });

  it("SCRUM379_AC2_whitespace_only_notes_count_as_no_notes", async () => {
    const { user } = renderPanel();

    await user.type(notesBox(), "   ");
    await user.click(continueButton());

    expect(screen.getByText("No closing notes.")).toBeInTheDocument();
  });

  it("SCRUM379_AC2_going_back_keeps_what_was_typed_and_sends_nothing", async () => {
    const { user } = renderPanel();

    await user.type(notesBox(), "Keep me");
    await user.click(continueButton());
    await user.click(screen.getByRole("button", { name: "Edit notes" }));

    expect(notesBox()).toHaveValue("Keep me");
    expect(completeEventRequest).not.toHaveBeenCalled();
  });

  it("SCRUM379_AC2_the_notes_can_be_edited_after_going_back_and_the_new_text_is_sent", async () => {
    const { user } = renderPanel();

    await user.type(notesBox(), "First");
    await user.click(continueButton());
    await user.click(screen.getByRole("button", { name: "Edit notes" }));
    await user.type(notesBox(), " and second");
    await user.click(continueButton());
    await user.click(confirmButton());

    expect(completeEventRequest).toHaveBeenCalledExactlyOnceWith(EVENT.id, { closingNotes: "First and second" });
  });
});

describe("SCRUM379 sending", () => {
  it("SCRUM379_AC1_confirming_sends_the_event_id_and_the_trimmed_notes_once", async () => {
    const { user } = renderPanel();

    await user.type(notesBox(), "  All went well.  ");
    await user.click(continueButton());
    await user.click(confirmButton());

    expect(completeEventRequest).toHaveBeenCalledExactlyOnceWith(EVENT.id, { closingNotes: "All went well." });
  });

  it("SCRUM379_AC2_closing_notes_are_optional_so_confirming_with_none_sends_none", async () => {
    const { user } = renderPanel();

    await user.click(continueButton());
    await user.click(confirmButton());

    expect(completeEventRequest).toHaveBeenCalledExactlyOnceWith(EVENT.id, { closingNotes: "" });
  });

  it("SCRUM379_AC1_the_parent_is_given_the_completed_event", async () => {
    const { user, onCompleted } = renderPanel();

    await user.click(continueButton());
    await user.click(confirmButton());

    await waitFor(() => expect(onCompleted).toHaveBeenCalledExactlyOnceWith(COMPLETED));
  });

  it("SCRUM379_AC1_the_confirm_button_is_disabled_while_sending_so_a_double_click_sends_once", async () => {
    let finish;
    vi.mocked(completeEventRequest).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { user, onCompleted } = renderPanel();

    await user.click(continueButton());
    await user.click(confirmButton());
    const sending = screen.getByRole("button", { name: "Marking as completed..." });
    expect(sending).toBeDisabled();
    fireEvent.click(sending);
    fireEvent.click(sending);
    expect(screen.getByRole("button", { name: "Edit notes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Back to event" })).toBeDisabled();

    finish(COMPLETED);
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
    expect(completeEventRequest).toHaveBeenCalledTimes(1);
  });

  it("SCRUM379_AC1_a_success_shows_no_error", async () => {
    const { user, onCompleted } = renderPanel();

    await user.click(continueButton());
    await user.click(confirmButton());

    await waitFor(() => expect(onCompleted).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("SCRUM379 refusals", () => {
  async function failWith(error) {
    vi.mocked(completeEventRequest).mockRejectedValue(error);
    const harness = renderPanel();
    await harness.user.click(continueButton());
    await harness.user.click(confirmButton());
    return harness;
  }

  it("SCRUM379_AC3_an_event_final_refusal_is_shown_as_the_server_worded_it", async () => {
    const message = "This event is completed and can no longer be changed";
    const { onCompleted } = await failWith(refusal(409, { error: message, code: "EVENT_FINAL" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it("SCRUM379_AC3_a_cancelled_event_refusal_is_shown_as_worded", async () => {
    const message = "This event is cancelled and can no longer be changed";
    await failWith(refusal(409, { error: message, code: "EVENT_FINAL" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("SCRUM379_AC1_an_event_that_has_not_ended_says_so", async () => {
    await failWith(refusal(409, { error: "Event request x has not ended yet, so it cannot be marked as completed" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/has not ended yet/);
  });

  it("SCRUM379_AC1_a_403_says_only_the_assigned_coordinator_can", async () => {
    await failWith(refusal(403));

    expect(await screen.findByRole("alert")).toHaveTextContent("Only the coordinator assigned to this event can mark it as completed.");
  });

  it("SCRUM379_AC1_a_server_error_says_nothing_changed", async () => {
    await failWith(refusal(500));

    expect(await screen.findByRole("alert")).toHaveTextContent(/No changes have been made/);
  });

  it("SCRUM379_AC1_no_response_does_not_claim_nothing_changed", async () => {
    await failWith(new Error("Network Error"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/may not have been completed/);
    expect(alert).not.toHaveTextContent(/No changes have been made/);
  });

  it("SCRUM379_AC1_after_a_failure_the_panel_stays_open_with_the_notes_and_can_try_again", async () => {
    vi.mocked(completeEventRequest).mockRejectedValueOnce(refusal(500));
    const { user, onCompleted } = renderPanel();
    await user.type(notesBox(), "Keep these");
    await user.click(continueButton());
    await user.click(confirmButton());
    await screen.findByRole("alert");

    expect(confirmButton()).toBeEnabled();
    expect(screen.getByText("Keep these", { selector: "dd" })).toBeInTheDocument();

    await user.click(confirmButton());

    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
    expect(completeEventRequest).toHaveBeenCalledTimes(2);
    expect(vi.mocked(completeEventRequest).mock.calls[1]).toEqual([EVENT.id, { closingNotes: "Keep these" }]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM379_AC1_going_back_clears_the_error", async () => {
    const { user } = await failWith(refusal(500));
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: "Edit notes" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("SCRUM379 the notes limit", () => {
  const LIMIT = 2000;

  it("SCRUM379_AC2_exactly_the_limit_is_allowed", () => {
    renderPanel();

    fireEvent.change(notesBox(), { target: { value: "a".repeat(LIMIT) } });

    expect(continueButton()).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/2000 of 2000 characters/)).toBeInTheDocument();
  });

  it("SCRUM379_AC2_one_over_the_limit_holds_Continue_back_and_says_why", () => {
    renderPanel();

    fireEvent.change(notesBox(), { target: { value: "a".repeat(LIMIT + 1) } });

    expect(continueButton()).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Closing notes can be at most 2000 characters. Shorten them to continue.");
    expect(notesBox()).toHaveAttribute("aria-invalid", "true");
  });

  it("SCRUM379_AC2_shortening_the_notes_clears_the_warning", () => {
    renderPanel();
    fireEvent.change(notesBox(), { target: { value: "a".repeat(LIMIT + 1) } });

    fireEvent.change(notesBox(), { target: { value: "a".repeat(LIMIT) } });

    expect(continueButton()).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM379_AC2_the_limit_counts_characters_the_way_the_server_does_so_emoji_count_once", () => {
    renderPanel();

    // 2000 emoji is 4000 UTF-16 units but 2000 characters, which is within the limit.
    fireEvent.change(notesBox(), { target: { value: "😀".repeat(LIMIT) } });

    expect(continueButton()).toBeEnabled();
    expect(screen.getByText(/2000 of 2000 characters/)).toBeInTheDocument();
  });

  it("SCRUM379_AC2_surrounding_blanks_do_not_count_against_the_limit", () => {
    renderPanel();

    fireEvent.change(notesBox(), { target: { value: `   ${"a".repeat(LIMIT)}   ` } });

    expect(continueButton()).toBeEnabled();
  });

  it("SCRUM379_AC2_nothing_is_sent_while_over_the_limit", async () => {
    const { user } = renderPanel();
    fireEvent.change(notesBox(), { target: { value: "a".repeat(LIMIT + 1) } });

    await user.click(continueButton());

    expect(screen.queryByRole("group", { name: "Confirm completion" })).not.toBeInTheDocument();
    expect(completeEventRequest).not.toHaveBeenCalled();
  });
});
