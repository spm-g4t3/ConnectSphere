// EventRequestReviewPage.test.jsx
//
// SCRUM-486 (SCRUM-521): one event's coordinator screen, loaded by its URL.
// The service is mocked, and so is CoordinatorRequestDetail: what is under
// test is that the page reads the id from the address, loads that event, says
// why when it cannot, and reloads when the screen reports a change. The
// screen itself has its own tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import EventRequestReviewPage from "../../src/components/EventRequestReviewPage.jsx";
import { getEventRequestForReview } from "../../src/services/eventRequestService";
import { httpError } from "../helpers/async.js";

vi.mock("../../src/services/eventRequestService", () => ({
  getEventRequestForReview: vi.fn(),
}));

vi.mock("../../src/components/CoordinatorRequestDetail", () => ({
  default: function DetailStub({ request, onChangeRequestProcessed, onReviewDecisionProcessed }) {
    return (
      <div data-testid="detail-stub">
        <p>{request.eventName}</p>
        <p>Held by {request.assignedCoordinatorId}</p>
        <button type="button" onClick={onChangeRequestProcessed}>Changed</button>
        <button type="button" onClick={onReviewDecisionProcessed}>Decided</button>
      </div>
    );
  },
}));

const ID = "22222222-2222-4222-8222-222222222222";
const EVENT = { id: ID, eventName: "IS212 Industry Night", assignedCoordinatorId: "A" };

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/event-requests/:eventRequestId" element={<EventRequestReviewPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(getEventRequestForReview).mockReset();
  vi.mocked(getEventRequestForReview).mockResolvedValue(EVENT);
});

describe("SCRUM486_AC6 an event's screen by its address", () => {
  it("SCRUM486_AC6_loads_the_event_named_in_the_address_and_shows_its_screen", async () => {
    renderAt(`/event-requests/${ID}`);

    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(await screen.findByText("IS212 Industry Night")).toBeInTheDocument();
    expect(getEventRequestForReview).toHaveBeenCalledWith(ID);
  });

  // The 404 row left this table for SCRUM444_AC4_a_404_says_the_event_isnt_available_to_you.
  it.each([
    [403, "Only Event Coordinators and the Event Coordinator Lead can open an event here."],
    [500, "This event request could not be loaded. Please try again."],
    [undefined, "This event request could not be loaded. Please try again."],
  ])("SCRUM486_AC6_a_%s_loading_the_event_reads_%j", async (status, message) => {
    vi.mocked(getEventRequestForReview).mockRejectedValue(httpError(status));
    renderAt(`/event-requests/${ID}`);

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByTestId("detail-stub")).not.toBeInTheDocument();
  });

  it("SCRUM444_AC4_a_404_says_the_event_isnt_available_to_you", async () => {
    // Was the 404 row of SCRUM486_AC6_a_%s_loading_the_event_reads_%j ("There is
    // no submitted event request at this address."). Since SCRUM-444 a 404 is
    // also an event the caller does not hold: the page a previous holder lands
    // on from an old link or a notice. Keyed on the status, never the text.
    vi.mocked(getEventRequestForReview).mockRejectedValue(httpError(404, { error: `Event request ${ID} not found` }));
    renderAt(`/event-requests/${ID}`);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "This event isn't available to you. It may have been handed over to another coordinator, or it may no longer exist.",
    );
    expect(alert).not.toHaveTextContent(/not found/);
    expect(screen.queryByTestId("detail-stub")).not.toBeInTheDocument();
  });

  it("SCRUM444_AC1_a_coordinator_it_is_not_assigned_to_never_reaches_the_decisions", async () => {
    // Replaces SCRUM355_AC5_a_coordinator_it_is_not_assigned_to_does_not_read_them
    // (CoordinatorRequestDetail.test.jsx): that coordinator's read is a 404, so
    // the screen, and its decision history, is never rendered for them.
    vi.mocked(getEventRequestForReview).mockRejectedValue(httpError(404));
    renderAt(`/event-requests/${ID}`);

    await screen.findByRole("alert");
    expect(screen.queryByTestId("detail-stub")).not.toBeInTheDocument();
    expect(screen.queryByText(/resubmission/)).not.toBeInTheDocument();
  });

  it.each(["Changed", "Decided"])("SCRUM486_AC6_reloads_the_event_when_the_screen_reports_%s", async (button) => {
    // After a handover the screen reports a change; the page reads the event
    // again and passes on where it stands now.
    const user = userEvent.setup();
    renderAt(`/event-requests/${ID}`);
    await screen.findByText("Held by A");
    vi.mocked(getEventRequestForReview).mockResolvedValue({ ...EVENT, assignedCoordinatorId: "B" });

    await user.click(screen.getByRole("button", { name: button }));

    expect(await screen.findByText("Held by B")).toBeInTheDocument();
    expect(getEventRequestForReview).toHaveBeenCalledTimes(2);
  });

  it("SCRUM486_AC6_a_reload_that_works_clears_the_last_error", async () => {
    vi.mocked(getEventRequestForReview).mockRejectedValueOnce(httpError(500));
    const view = renderAt(`/event-requests/${ID}`);
    await screen.findByRole("alert");
    view.unmount();

    renderAt(`/event-requests/${ID}`);

    expect(await screen.findByText("IS212 Industry Night")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
