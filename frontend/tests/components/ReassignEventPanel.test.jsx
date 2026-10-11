// ReassignEventPanel.test.jsx
//
// SCRUM-486 (SCRUM-519): the handover panel's 403 message. Before 041 only
// the coordinator holding an event could hand it over, so a 403 meant "this
// is no longer yours" and the panel said "This event is no longer assigned to
// you". 041 lets the Event Coordinator Lead hand over any event too, and the
// route now admits a Lead, so the message has to be true for either caller.
//
// The panel's other behaviour is SCRUM-334's and is exercised through
// CoordinatorRequestDetail; this file pins only what SCRUM-519 changed.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import ReassignEventPanel from "../../src/components/ReassignEventPanel.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import { listCoordinators, reassignEventRequest } from "../../src/services/eventRequestService";

vi.mock("../../src/auth/AuthContext", () => ({ useAuth: vi.fn() }));
vi.mock("../../src/services/eventRequestService", () => ({
  listCoordinators: vi.fn(),
  reassignEventRequest: vi.fn(),
}));

const REQUEST = { id: "22222222-2222-4222-8222-222222222222", eventName: "IS212 Industry Night" };
const ME = "44444444-4444-4444-8444-444444444444";
const PRIYA = { id: "66666666-6666-4666-8666-666666666666", fullName: "Priya Nair" };

const forbidden = () =>
  Object.assign(new Error("Request failed with status code 403"), { response: { status: 403 } });

beforeEach(() => {
  vi.mocked(useAuth).mockReturnValue({ user: { id: ME, role: "event_coordinator" } });
  vi.mocked(listCoordinators).mockReset();
  vi.mocked(listCoordinators).mockResolvedValue([{ id: ME, fullName: "Omar Okafor" }, PRIYA]);
  vi.mocked(reassignEventRequest).mockReset();
});

describe("SCRUM486_AC6 a refused handover", () => {
  it("SCRUM486_AC6_a_403_says_who_may_hand_over_not_that_the_event_was_yours", async () => {
    vi.mocked(reassignEventRequest).mockRejectedValue(forbidden());
    const user = userEvent.setup();
    render(<ReassignEventPanel request={REQUEST} onCancel={vi.fn()} onReassigned={vi.fn()} />);

    await user.selectOptions(await screen.findByLabelText("Hand over to"), PRIYA.id);
    await user.click(screen.getByRole("button", { name: "Confirm handover" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Only the coordinator who holds it, or the Event Coordinator Lead, can do that",
    );
    expect(alert).toHaveTextContent("Go back and reopen it to see who holds it now.");
    // The old wording, wrong said to a Lead, who never held the event.
    expect(alert).not.toHaveTextContent(/no longer assigned to you/i);
  });
});
