// AssignCoordinatorPanel.test.jsx
//
// SCRUM-486 (SCRUM-519), AC3 and AC4: the Lead's assignment picker. Both
// service calls are mocked; what is under test is what the Lead sees and what
// is sent.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import AssignCoordinatorPanel from "../../src/components/AssignCoordinatorPanel.jsx";
import { assignEventRequest, listCoordinatorWorkload } from "../../src/services/eventRequestService";
import { httpError } from "../helpers/async.js";

vi.mock("../../src/services/eventRequestService", () => ({
  assignEventRequest: vi.fn(),
  listCoordinatorWorkload: vi.fn(),
}));

const REQUEST = { id: "22222222-2222-4222-8222-222222222222", eventName: "IS212 Industry Night" };
const OMAR = { id: "44444444-4444-4444-8444-444444444444", fullName: "Omar Okafor", activeEvents: 3 };
const PRIYA = { id: "66666666-6666-4666-8666-666666666666", fullName: "Priya Nair", activeEvents: 0 };
const NAMELESS = { id: "88888888-8888-4888-8888-888888888888", fullName: null, activeEvents: 1 };

function renderPanel({ onCancel = vi.fn(), onAssigned = vi.fn() } = {}) {
  render(<AssignCoordinatorPanel request={REQUEST} onCancel={onCancel} onAssigned={onAssigned} />);
  return { onCancel, onAssigned };
}

const radios = () => screen.queryAllByRole("radio");

beforeEach(() => {
  vi.mocked(assignEventRequest).mockReset();
  vi.mocked(listCoordinatorWorkload).mockReset();
  vi.mocked(listCoordinatorWorkload).mockResolvedValue([OMAR, PRIYA, NAMELESS]);
});


describe("SCRUM486_AC3 the picker", () => {
  it("SCRUM486_AC3_lists_every_coordinator_with_their_active_events_in_the_servers_order", async () => {
    // AC3-07. The server's order, by name. Omar has the most work and is
    // still first: nothing here re-sorts by workload.
    renderPanel();

    await screen.findByRole("group", { name: "Assign to" });
    expect(radios().map((radio) => radio.closest("label").textContent)).toEqual([
      "Omar Okafor, 3 active events",
      "Priya Nair, 0 active events",
      `No name on record (${NAMELESS.id}), 1 active event`,
    ]);
  });

  it("SCRUM486_AC3_nothing_is_chosen_for_the_lead_and_nothing_is_recommended", async () => {
    // AC3: no default, no suggestion. Nothing checked, Confirm disabled until
    // the Lead chooses, and no word on the page that ranks anyone.
    renderPanel();

    await screen.findByRole("group", { name: "Assign to" });
    expect(radios().filter((radio) => radio.checked)).toEqual([]);
    expect(screen.getByRole("button", { name: "Confirm assignment" })).toBeDisabled();
    expect(document.body.textContent).not.toMatch(/recommend|suggest|best|least busy/i);
  });

  it("SCRUM486_AC3_choosing_a_coordinator_and_confirming_sends_them_and_the_note", async () => {
    // AC3-04 from the screen. The note is sent as typed.
    const updated = { ...REQUEST, assignedCoordinatorId: PRIYA.id };
    vi.mocked(assignEventRequest).mockResolvedValue(updated);
    const user = userEvent.setup();
    const { onAssigned } = renderPanel();

    await user.click(await screen.findByRole("radio", { name: "Priya Nair, 0 active events" }));
    await user.type(screen.getByLabelText("Note for the coordinator (optional)"), "Over to you");
    await user.click(screen.getByRole("button", { name: "Confirm assignment" }));

    expect(assignEventRequest).toHaveBeenCalledWith(REQUEST.id, { coordinatorId: PRIYA.id, note: "Over to you" });
    expect(onAssigned).toHaveBeenCalledWith(updated, PRIYA);
  });

  it("SCRUM486_AC3_the_note_is_optional_and_said_to_be_hidden_from_the_organiser", async () => {
    vi.mocked(assignEventRequest).mockResolvedValue({ ...REQUEST });
    const user = userEvent.setup();
    renderPanel();

    expect(await screen.findByText("Coordinators can read this note. The Organiser cannot.")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Omar Okafor, 3 active events" }));
    await user.click(screen.getByRole("button", { name: "Confirm assignment" }));

    expect(assignEventRequest).toHaveBeenCalledWith(REQUEST.id, { coordinatorId: OMAR.id, note: "" });
  });

  it("SCRUM486_AC3_confirm_is_disabled_while_the_assignment_is_in_flight", async () => {
    let settle;
    vi.mocked(assignEventRequest).mockReturnValue(new Promise((resolve) => { settle = resolve; }));
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("radio", { name: "Omar Okafor, 3 active events" }));
    await user.click(screen.getByRole("button", { name: "Confirm assignment" }));

    expect(screen.getByRole("button", { name: "Assigning..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    settle({ ...REQUEST });
  });

  it("SCRUM486_AC3_cancel_goes_back_and_sends_nothing", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderPanel();

    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(assignEventRequest).not.toHaveBeenCalled();
  });
});


describe("SCRUM486_AC3 the picker when the list cannot be shown", () => {
  it("SCRUM486_AC3_no_coordinators_says_so_and_offers_the_way_back", async () => {
    vi.mocked(listCoordinatorWorkload).mockResolvedValue([]);
    const user = userEvent.setup();
    const { onCancel } = renderPanel();

    expect(await screen.findByText("There is no Event Coordinator to assign this request to.")).toBeInTheDocument();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to the queue" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    [403, "Only the Event Coordinator Lead can assign event requests."],
    [500, "The list of coordinators could not be loaded. Please try again."],
    [undefined, "The list of coordinators could not be loaded. Please try again."],
  ])("SCRUM486_AC3_a_%s_loading_the_list_reads_%j", async (status, message) => {
    vi.mocked(listCoordinatorWorkload).mockRejectedValue(httpError(status));
    renderPanel();

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to the queue" })).toBeInTheDocument();
  });

  it("SCRUM486_AC3_a_list_that_arrives_after_the_panel_closed_is_ignored", async () => {
    // The cleanup flag: no state update on an unmounted panel, either way.
    let resolveList;
    vi.mocked(listCoordinatorWorkload).mockReturnValue(new Promise((resolve) => { resolveList = resolve; }));
    const { unmount } = render(<AssignCoordinatorPanel request={REQUEST} onCancel={vi.fn()} onAssigned={vi.fn()} />);
    unmount();
    resolveList([OMAR]);

    let rejectList;
    vi.mocked(listCoordinatorWorkload).mockReturnValue(new Promise((_resolve, reject) => { rejectList = reject; }));
    const second = render(<AssignCoordinatorPanel request={REQUEST} onCancel={vi.fn()} onAssigned={vi.fn()} />);
    second.unmount();
    rejectList(httpError(500));

    await Promise.resolve();
    expect(listCoordinatorWorkload).toHaveBeenCalledTimes(2);
  });
});


describe("SCRUM486_AC4 a refused assignment", () => {
  async function chooseAndConfirm(user) {
    await user.click(await screen.findByRole("radio", { name: "Omar Okafor, 3 active events" }));
    await user.click(screen.getByRole("button", { name: "Confirm assignment" }));
  }

  it("SCRUM486_AC4_a_lost_race_names_who_was_assigned_and_offers_only_the_way_back", async () => {
    // AC4-04. The name comes from the response's conflicts, never from its
    // message, which here says something else entirely to prove it.
    vi.mocked(assignEventRequest).mockRejectedValue(httpError(409, {
      error: "event request 2222 is already assigned to someone",
      code: "ALREADY_ASSIGNED",
      conflicts: [{ assignedCoordinatorId: PRIYA.id, assignedCoordinatorName: "Priya Nair" }],
    }));
    const user = userEvent.setup();
    const { onCancel } = renderPanel();

    await chooseAndConfirm(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This request has already been assigned to Priya Nair");
    expect(alert).not.toHaveTextContent("2222");
    // Nothing on the form can succeed now, so the form gives way.
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to the queue" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("SCRUM486_AC4_a_lost_race_to_someone_with_no_name_still_says_it_was_taken", async () => {
    vi.mocked(assignEventRequest).mockRejectedValue(httpError(409, {
      code: "ALREADY_ASSIGNED",
      conflicts: [{ assignedCoordinatorId: PRIYA.id, assignedCoordinatorName: null }],
    }));
    const user = userEvent.setup();
    renderPanel();

    await chooseAndConfirm(user);

    expect(await screen.findByRole("alert")).toHaveTextContent("already been assigned to another coordinator");
  });

  it.each([
    [409, { code: null, conflicts: [] }, "This request can no longer be assigned. It may have been withdrawn or cancelled.", true],
    [404, undefined, "This request no longer exists.", true],
    [400, undefined, "That person cannot be assigned this request.", false],
    [403, undefined, "Only the Event Coordinator Lead can assign event requests.", false],
    [500, undefined, "The request could not be assigned. Please try again.", false],
    [undefined, undefined, "The request could not be assigned. Please try again.", false],
  ])("SCRUM486_AC3_a_%s_refusal_is_said_in_words", async (status, data, message, formGone) => {
    // 409 without ALREADY_ASSIGNED and 404 end the form: the request is no
    // longer there to assign. The rest leave it, so the Lead can try again or
    // choose someone else.
    vi.mocked(assignEventRequest).mockRejectedValue(httpError(status, data));
    const user = userEvent.setup();
    const { onAssigned } = renderPanel();

    await chooseAndConfirm(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(onAssigned).not.toHaveBeenCalled();
    if (formGone) {
      expect(screen.queryByRole("group")).not.toBeInTheDocument();
    } else {
      const group = screen.getByRole("group", { name: "Assign to" });
      expect(within(group).getByRole("radio", { name: "Omar Okafor, 3 active events" })).toBeChecked();
      expect(screen.getByRole("button", { name: "Confirm assignment" })).toBeEnabled();
    }
  });

  it("SCRUM486_AC3_choosing_again_clears_the_last_refusal", async () => {
    vi.mocked(assignEventRequest).mockRejectedValue(httpError(400));
    const user = userEvent.setup();
    renderPanel();

    await chooseAndConfirm(user);
    await screen.findByRole("alert");
    await user.click(screen.getByRole("radio", { name: "Priya Nair, 0 active events" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM486_AC3_onAssigned_is_optional", async () => {
    vi.mocked(assignEventRequest).mockResolvedValue({ ...REQUEST });
    const user = userEvent.setup();
    render(<AssignCoordinatorPanel request={REQUEST} onCancel={vi.fn()} />);

    await chooseAndConfirm(user);

    expect(assignEventRequest).toHaveBeenCalledTimes(1);
  });
});
