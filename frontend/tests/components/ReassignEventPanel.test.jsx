// ReassignEventPanel.test.jsx
//
// SCRUM-486: the handover panel, since SCRUM-444 the Event Coordinator Lead's
// alone (it had two callers, the holder and, since 052, the Lead).
//
// SCRUM-519 pinned the 403 message. SCRUM-521 adds who is left out of the
// list (the holder, not the caller), which list a Lead reads, and every
// status-keyed message on the path, each said so it is true for either
// caller.
//
// The panel had no tests of its own before SCRUM-519. Its SCRUM-334
// behaviour was exercised only through CoordinatorRequestDetail, and nothing
// asserted the old caller-based filter, so no existing test moved with it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { StrictMode } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import ReassignEventPanel from "../../src/components/ReassignEventPanel.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import {
  listCoordinatorWorkload,
  reassignEventRequest,
} from "../../src/services/eventRequestService";
import { deferred, httpError } from "../helpers/async.js";

vi.mock("../../src/auth/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../../src/services/eventRequestService", () => ({
  listCoordinatorWorkload: vi.fn(),
  reassignEventRequest: vi.fn(),
}));

const HOLDER = "44444444-4444-4444-8444-444444444444";
const OTHER = "66666666-6666-4666-8666-666666666666";
const THIRD = "88888888-8888-4888-8888-888888888888";
const LEAD = "77777777-7777-4777-8777-777777777777";

const REQUEST = {
  id: "22222222-2222-4222-8222-222222222222",
  eventName: "IS212 Industry Night",
  assignedCoordinatorId: HOLDER,
};

const WORKLOAD = [
  { id: HOLDER, fullName: "Priya Nair", activeEvents: 2 },
  { id: OTHER, fullName: "Omar Okafor", activeEvents: 1 },
  { id: THIRD, fullName: "Mei Tan", activeEvents: 0 },
];

function renderAs(userId, role, props = {}) {
  vi.mocked(useAuth).mockReturnValue({ user: { id: userId, role } });
  render(<ReassignEventPanel request={REQUEST} onCancel={vi.fn()} onReassigned={vi.fn()} {...props} />);
}

const optionNames = async () =>
  within(await screen.findByLabelText("Hand over to"))
    .getAllByRole("option")
    .map((option) => option.textContent)
    .filter((name) => name !== "Choose a coordinator");

beforeEach(() => {
  vi.mocked(listCoordinatorWorkload).mockReset();
  vi.mocked(listCoordinatorWorkload).mockResolvedValue(WORKLOAD);
  vi.mocked(reassignEventRequest).mockReset();
});


describe("SCRUM486_AC6 who the picker offers", () => {
  it("SCRUM444_AC3_the_leads_list_is_the_only_one_read_and_the_holder_is_left_out", async () => {
    // Was SCRUM486_AC6_the_holder_handing_over_is_left_out_as_before, where the
    // holder handed over from GET /coordinators. That list is gone (D5), and
    // the Lead hands over; the holder is still left out of the choices.
    renderAs(LEAD, "event_coordinator_lead");

    expect(await optionNames()).toEqual(["Omar Okafor, 1 active event", "Mei Tan, 0 active events"]);
    expect(listCoordinatorWorkload).toHaveBeenCalledTimes(1);
  });

  it("SCRUM486_AC6_for_a_lead_the_holder_is_left_out_not_the_caller", async () => {
    // The bug: the old filter left out the caller, which for a Lead removed
    // nobody, and offered the holder, a choice 052 refuses with 23514.
    renderAs(LEAD, "event_coordinator_lead");

    const names = await optionNames();
    expect(names.some((name) => name.startsWith("Priya Nair"))).toBe(false);
    expect(names).toEqual(["Omar Okafor, 1 active event", "Mei Tan, 0 active events"]);
  });

  it("SCRUM486_AC6_a_lead_reads_the_leads_list_never_the_coordinators", async () => {
    // GET /coordinators refuses a Lead (SCRUM-485 AC5, kept in SCRUM-519).
    renderAs(LEAD, "Event Coordinator Lead");

    expect(await optionNames()).toEqual(["Omar Okafor, 1 active event", "Mei Tan, 0 active events"]);
    expect(listCoordinatorWorkload).toHaveBeenCalledTimes(1);
  });

  it("SCRUM444_AC3_a_coordinator_who_reaches_the_panel_is_told_only_the_lead_hands_over", async () => {
    // Was SCRUM486_AC6_a_coordinator_who_does_not_hold_it_is_listed_and_the_holder_is_not.
    // The screen shows the button to the Lead alone; a coordinator who got here
    // anyway is refused the Lead's list (leadOnly), and told who may hand over.
    vi.mocked(listCoordinatorWorkload).mockRejectedValue(httpError(403));
    renderAs(OTHER, "event_coordinator");

    expect(await screen.findByRole("alert")).toHaveTextContent("Only the Event Coordinator Lead can hand an event over.");
    expect(screen.queryByLabelText("Hand over to")).not.toBeInTheDocument();
  });

  it("SCRUM486_AC6_the_holder_the_parent_names_wins_over_the_row_it_was_loaded_from", async () => {
    // After a handover from the same screen the parent knows the new holder;
    // the request row it passes may still name the old one.
    renderAs(LEAD, "event_coordinator_lead", { outgoingCoordinatorId: OTHER });

    const names = await optionNames();
    expect(names).toEqual(["Priya Nair, 2 active events", "Mei Tan, 0 active events"]);
  });

  it("SCRUM486_AC6_with_nobody_but_the_holder_there_is_nobody_to_hand_it_to", async () => {
    vi.mocked(listCoordinatorWorkload).mockResolvedValue([WORKLOAD[0]]);
    renderAs(LEAD, "event_coordinator_lead");

    expect(await screen.findByText("There is no other Event Coordinator to hand this event to.")).toBeInTheDocument();
  });

  it("SCRUM486_AC6_a_lead_hands_it_over_to_the_coordinator_chosen", async () => {
    const onReassigned = vi.fn();
    const updated = { ...REQUEST, assignedCoordinatorId: THIRD };
    vi.mocked(reassignEventRequest).mockResolvedValue(updated);
    const user = userEvent.setup();
    renderAs(LEAD, "event_coordinator_lead", { onReassigned });

    await user.selectOptions(await screen.findByLabelText("Hand over to"), THIRD);
    await user.type(screen.getByLabelText("Note for the new coordinator (optional)"), "Priya is on leave.");
    await user.click(screen.getByRole("button", { name: "Confirm handover" }));

    expect(reassignEventRequest).toHaveBeenCalledWith(REQUEST.id, { newCoordinatorId: THIRD, handoverNote: "Priya is on leave." });
    expect(onReassigned).toHaveBeenCalledWith(updated, WORKLOAD[2]);
  });
});


describe("SCRUM444_AC3 every message on the path, true for the Lead", () => {
  it("SCRUM444_AC3_a_403_says_only_the_lead_hands_over", async () => {
    // Was SCRUM486_AC6_a_403_says_who_may_hand_over_not_that_the_event_was_yours,
    // said to the holder. Since 055 a 403 means the caller is not the Lead (a
    // role changed since the screen opened), and it says who may hand over.
    vi.mocked(reassignEventRequest).mockRejectedValue(httpError(403));
    const user = userEvent.setup();
    renderAs(LEAD, "event_coordinator_lead");

    await user.selectOptions(await screen.findByLabelText("Hand over to"), OTHER);
    await user.click(screen.getByRole("button", { name: "Confirm handover" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You cannot hand this event over. Only the Event Coordinator Lead can do that.");
    expect(alert).not.toHaveTextContent(/no longer assigned to you|holds it/i);
  });

  it("SCRUM444_AC4_the_intro_says_the_holder_will_no_longer_see_it", async () => {
    // Replaces SCRUM486_AC6_the_intro_says_you_to_the_holder and
    // SCRUM486_AC6_the_intro_speaks_of_the_holder_to_a_lead, which both said the
    // holder could still view it: since SCRUM-444 AC4 they cannot.
    renderAs(LEAD, "event_coordinator_lead");

    expect(
      await screen.findByText(
        "The coordinator you choose becomes responsible for this event. The coordinator who holds it now will no longer be able to view or change it.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/still be able to view/)).not.toBeInTheDocument();
  });

  it.each([
    [403, "Only the Event Coordinator Lead can hand an event over."],
    [500, "The list of coordinators could not be loaded."],
  ])("SCRUM444_AC3_loading_the_list_for_a_lead_fails_with_%s", async (status, message) => {
    // Was SCRUM486_AC6_loading_the_list_for_a_lead_fails_with_%s: the list is
    // leadOnly, so its 403 now names the Lead alone.
    vi.mocked(listCoordinatorWorkload).mockRejectedValue(httpError(status));
    renderAs(LEAD, "event_coordinator_lead");

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Back to the event" })).toBeInTheDocument();
  });

  it.each([
    [400, "That person cannot take this event. They may no longer be an Event Coordinator, or they may already hold it. Choose someone else."],
    [403, "You cannot hand this event over. Only the Event Coordinator Lead can do that."],
    [404, "This event no longer exists."],
    [409, "This event cannot be handed over right now. Its status may not allow a handover, or it changed while you were looking at it. Go back and reopen it to see where it stands."],
    [500, "The event could not be handed over. Please try again."],
  ])("SCRUM444_AC3_a_%s_refusal_reads_true_to_the_lead", async (status, message) => {
    // Was SCRUM486_AC6_a_%s_refusal_reads_the_same_to_a_lead_and_a_holder: the
    // holder no longer hands over. None tells the Lead the event was theirs.
    vi.mocked(reassignEventRequest).mockRejectedValue(httpError(status));
    const user = userEvent.setup();

    for (const [userId, role] of [[LEAD, "event_coordinator_lead"]]) {
      vi.mocked(useAuth).mockReturnValue({ user: { id: userId, role } });
      const view = render(<ReassignEventPanel request={REQUEST} onCancel={vi.fn()} onReassigned={vi.fn()} />);

      await user.selectOptions(await screen.findByLabelText("Hand over to"), THIRD);
      await user.click(screen.getByRole("button", { name: "Confirm handover" }));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(message);
      expect(alert).not.toHaveTextContent(/yours|assigned to you/i);
      view.unmount();
    }
  });
});


describe("SCRUM486_AC6 a load that is no longer wanted", () => {
  // StrictMode runs the load effect twice, as the app does in development: the
  // first load is cancelled, so its answer must be dropped whenever it lands.
  function renderStrict() {
    vi.mocked(useAuth).mockReturnValue({ user: { id: LEAD, role: "event_coordinator_lead" } });
    render(
      <StrictMode>
        <ReassignEventPanel request={REQUEST} onCancel={vi.fn()} onReassigned={vi.fn()} />
      </StrictMode>,
    );
  }

  it("SCRUM486_AC6_a_superseded_list_arriving_late_does_not_replace_the_current_one", async () => {
    const stale = deferred();
    vi.mocked(listCoordinatorWorkload)
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(WORKLOAD);
    renderStrict();

    expect(await optionNames()).toEqual(["Omar Okafor, 1 active event", "Mei Tan, 0 active events"]);
    await act(async () => stale.resolve([{ id: THIRD, fullName: "Stale Name", activeEvents: 9 }]));

    expect(await optionNames()).toEqual(["Omar Okafor, 1 active event", "Mei Tan, 0 active events"]);
    expect(listCoordinatorWorkload).toHaveBeenCalledTimes(2);
  });

  it("SCRUM486_AC6_a_superseded_load_failing_late_shows_no_error", async () => {
    const stale = deferred();
    vi.mocked(listCoordinatorWorkload)
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(WORKLOAD);
    renderStrict();

    await screen.findByLabelText("Hand over to");
    await act(async () => stale.reject(httpError(500)));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Hand over to")).toBeInTheDocument();
  });
});


describe("SCRUM444_AC3 failures with no server answer", () => {
  it("SCRUM444_AC3_a_list_that_fails_without_a_status_says_so_and_offers_try_again", async () => {
    vi.mocked(listCoordinatorWorkload).mockRejectedValueOnce(new Error("Network Error"));
    const user = userEvent.setup();
    renderAs(LEAD, "event_coordinator_lead");

    expect(await screen.findByRole("alert")).toHaveTextContent("The list of coordinators could not be loaded.");
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await optionNames()).toEqual(["Omar Okafor, 1 active event", "Mei Tan, 0 active events"]);
    expect(listCoordinatorWorkload).toHaveBeenCalledTimes(2);
  });

  it("SCRUM444_AC3_a_handover_that_fails_without_a_status_says_try_again", async () => {
    vi.mocked(reassignEventRequest).mockRejectedValue(new Error("Network Error"));
    const user = userEvent.setup();
    renderAs(LEAD, "event_coordinator_lead");

    await user.selectOptions(await screen.findByLabelText("Hand over to"), OTHER);
    await user.click(screen.getByRole("button", { name: "Confirm handover" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The event could not be handed over. Please try again.");
    expect(screen.getByRole("button", { name: "Confirm handover" })).toBeEnabled();
  });
});


describe("SCRUM334 the handover needs a coordinator", () => {
  it("SCRUM334_submitting_without_a_choice_sends_nothing_and_asks_for_one", async () => {
    renderAs(LEAD, "event_coordinator_lead");
    const select = await screen.findByLabelText("Hand over to");
    expect(screen.getByRole("button", { name: "Confirm handover" })).toBeDisabled();

    // The disabled button is the first guard; this is the one behind it.
    fireEvent.submit(select.closest("form"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Choose who to hand this event to.");
    expect(reassignEventRequest).not.toHaveBeenCalled();
  });
});
