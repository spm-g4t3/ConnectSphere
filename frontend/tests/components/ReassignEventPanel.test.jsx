// ReassignEventPanel.test.jsx
//
// SCRUM-486: the handover panel for its two callers, the coordinator who
// holds the event and, since 052, the Event Coordinator Lead.
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
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import ReassignEventPanel from "../../src/components/ReassignEventPanel.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import {
  listCoordinatorWorkload,
  listCoordinators,
  reassignEventRequest,
} from "../../src/services/eventRequestService";

vi.mock("../../src/auth/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../../src/services/eventRequestService", () => ({
  listCoordinators: vi.fn(),
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

const COORDINATORS = [
  { id: HOLDER, fullName: "Priya Nair" },
  { id: OTHER, fullName: "Omar Okafor" },
  { id: THIRD, fullName: "Mei Tan" },
];
const WORKLOAD = [
  { id: HOLDER, fullName: "Priya Nair", activeEvents: 2 },
  { id: OTHER, fullName: "Omar Okafor", activeEvents: 1 },
  { id: THIRD, fullName: "Mei Tan", activeEvents: 0 },
];

const httpError = (status) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });

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
  vi.mocked(listCoordinators).mockReset();
  vi.mocked(listCoordinators).mockResolvedValue(COORDINATORS);
  vi.mocked(listCoordinatorWorkload).mockReset();
  vi.mocked(listCoordinatorWorkload).mockResolvedValue(WORKLOAD);
  vi.mocked(reassignEventRequest).mockReset();
});


describe("SCRUM486_AC6 who the picker offers", () => {
  it("SCRUM486_AC6_the_holder_handing_over_is_left_out_as_before", async () => {
    // The holder is the caller here, so this is the person the old filter
    // left out too: the coordinator case is unchanged.
    renderAs(HOLDER, "event_coordinator");

    expect(await optionNames()).toEqual(["Omar Okafor", "Mei Tan"]);
    expect(listCoordinators).toHaveBeenCalledTimes(1);
    expect(listCoordinatorWorkload).not.toHaveBeenCalled();
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

    await optionNames();
    expect(listCoordinatorWorkload).toHaveBeenCalledTimes(1);
    expect(listCoordinators).not.toHaveBeenCalled();
  });

  it("SCRUM486_AC6_a_coordinator_who_does_not_hold_it_is_listed_and_the_holder_is_not", async () => {
    // Not a caller the screen shows the button to, but if one reached this
    // panel they are a valid choice and the holder is not.
    renderAs(OTHER, "event_coordinator");

    expect(await optionNames()).toEqual(["Omar Okafor", "Mei Tan"]);
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


describe("SCRUM486_AC6 every message on the path, true for either caller", () => {
  it("SCRUM486_AC6_a_403_says_who_may_hand_over_not_that_the_event_was_yours", async () => {
    // SCRUM-519's case, kept by name: the holder whose event moved on gets
    // the 403, and it says who may hand over, not "no longer assigned to you".
    vi.mocked(reassignEventRequest).mockRejectedValue(httpError(403));
    const user = userEvent.setup();
    renderAs(HOLDER, "event_coordinator");

    await user.selectOptions(await screen.findByLabelText("Hand over to"), OTHER);
    await user.click(screen.getByRole("button", { name: "Confirm handover" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Only the coordinator who holds it, or the Event Coordinator Lead, can do that",
    );
    expect(alert).toHaveTextContent("Go back and reopen it to see who holds it now.");
    expect(alert).not.toHaveTextContent(/no longer assigned to you/i);
  });

  it("SCRUM486_AC6_the_intro_says_you_to_the_holder", async () => {
    renderAs(HOLDER, "event_coordinator");

    expect(
      await screen.findByText(
        "The coordinator you choose becomes responsible for this event. You will still be able to view it, but not change it.",
      ),
    ).toBeInTheDocument();
  });

  it("SCRUM486_AC6_the_intro_speaks_of_the_holder_to_a_lead", async () => {
    // A Lead never could change it, so "you will no longer" would be untrue.
    renderAs(LEAD, "event_coordinator_lead");

    expect(
      await screen.findByText(
        "The coordinator you choose becomes responsible for this event. The coordinator who holds it now will still be able to view it, but not change it.",
      ),
    ).toBeInTheDocument();
  });

  it.each([
    [401, "Your session has expired. Please sign in again."],
    [403, "Only Event Coordinators and the Event Coordinator Lead can hand an event over."],
    [500, "The list of coordinators could not be loaded. Please try again."],
  ])("SCRUM486_AC6_loading_the_list_for_a_lead_fails_with_%s", async (status, message) => {
    // The 403 said "Only Event Coordinators can hand an event over" until
    // SCRUM-521, false since 052 let the Lead.
    vi.mocked(listCoordinatorWorkload).mockRejectedValue(httpError(status));
    renderAs(LEAD, "event_coordinator_lead");

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Back to the event" })).toBeInTheDocument();
  });

  it.each([
    [400, "That person cannot take this event. They may no longer be an Event Coordinator, or they may already hold it. Choose someone else."],
    [401, "Your session has expired. Please sign in again."],
    [403, "You cannot hand this event over. Only the coordinator who holds it, or the Event Coordinator Lead, can do that, and it may have been handed to someone else. Go back and reopen it to see who holds it now."],
    [404, "This event no longer exists."],
    [409, "This event cannot be handed over right now. Its status may not allow a handover, or it changed while you were looking at it. Go back and reopen it to see where it stands."],
    [500, "The event could not be handed over. Please try again."],
  ])("SCRUM486_AC6_a_%s_refusal_reads_the_same_to_a_lead_and_a_holder", async (status, message) => {
    // Every handover refusal, for both callers, and none tells a Lead the
    // event was theirs. The 409 is a lost race or a status: "changed while
    // you were looking at it", never "yours".
    vi.mocked(reassignEventRequest).mockRejectedValue(httpError(status));
    const user = userEvent.setup();

    for (const [userId, role] of [[LEAD, "event_coordinator_lead"], [HOLDER, "event_coordinator"]]) {
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
