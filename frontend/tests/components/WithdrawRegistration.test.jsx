import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AttendeeEventInformation from "../../src/components/AttendeeEventInformation";
import { getAttendeeEvent, withdrawRegistration } from "../../src/services/attendeeEventService";
import { deferred, httpError } from "../helpers/async.js";

vi.mock("../../src/services/attendeeEventService", () => ({
  getAttendeeEvent: vi.fn(), withdrawRegistration: vi.fn(),
}));

const REGISTRATION = "r1";
const event = {
  eventRequestId: "e1", registrationId: REGISTRATION, state: "confirmed", eventName: "Open day",
  startsAt: "2030-05-06T01:00:00Z", endsAt: "2030-05-06T03:00:00Z",
  venues: [{ bookingId: "b1", name: "Hall A", location: "Building A" }],
};
const notFound = httpError(404, { error: "Event information not found" });

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/registered-events/e1"]}>
      <Routes><Route path="/registered-events/:eventId" element={<AttendeeEventInformation />} /></Routes>
    </MemoryRouter>,
  );
}

async function openConfirmation(user) {
  await user.click(await screen.findByRole("button", { name: "Withdraw registration" }));
  return screen.getByRole("button", { name: "Confirm withdrawal" });
}

beforeEach(() => {
  vi.mocked(getAttendeeEvent).mockReset().mockResolvedValue(event);
  vi.mocked(withdrawRegistration).mockReset();
});

describe("SCRUM-27 attendee withdrawal action", () => {
  it("SCRUM27_AC1_offers_withdrawal_only_for_an_active_registration_the_backend_returned", async () => {
    vi.mocked(getAttendeeEvent).mockResolvedValue({ ...event, registrationId: undefined });
    renderPage();
    await screen.findByText("Hall A");
    expect(screen.queryByRole("button", { name: "Withdraw registration" })).not.toBeInTheDocument();
  });

  it("SCRUM27_AC1_asks_for_confirmation_and_keeping_the_registration_sends_nothing", async () => {
    const user = userEvent.setup();
    renderPage();
    await openConfirmation(user);
    expect(screen.getByText(/Your place will be released/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep my registration" }));
    expect(withdrawRegistration).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Withdraw registration" })).toBeInTheDocument();
    expect(screen.getByText("Hall A")).toBeInTheDocument();
  });

  it("SCRUM27_AC3_shows_pending_without_success_and_sends_one_request_however_often_clicked", async () => {
    const user = userEvent.setup();
    const reply = deferred();
    vi.mocked(withdrawRegistration).mockReturnValue(reply.promise);
    renderPage();
    const confirm = await openConfirmation(user);
    await user.click(confirm);
    await user.click(confirm);

    expect(withdrawRegistration).toHaveBeenCalledExactlyOnceWith(REGISTRATION);
    expect(screen.getByRole("button", { name: "Withdrawing..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Keep my registration" })).toBeDisabled();
    expect(screen.queryByText("Your registration has been withdrawn.")).not.toBeInTheDocument();
    expect(screen.getByText("Hall A")).toBeInTheDocument();
    await act(async () => reply.reject(httpError(503, {})));
  });

  it("SCRUM27_AC8_confirms_only_after_the_backend_succeeds_then_refreshes_the_event", async () => {
    const user = userEvent.setup();
    vi.mocked(withdrawRegistration).mockResolvedValue({ id: REGISTRATION, status: "withdrawn", placesLeft: 1, isFull: false });
    vi.mocked(getAttendeeEvent).mockResolvedValueOnce(event).mockRejectedValueOnce(notFound);
    renderPage();
    await user.click(await openConfirmation(user));

    expect(await screen.findByText("Your registration has been withdrawn.")).toHaveAttribute("role", "status");
    await waitFor(() => expect(getAttendeeEvent).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Hall A")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Withdraw/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM27_AC8_keeps_the_confirmation_when_the_refresh_itself_fails", async () => {
    const user = userEvent.setup();
    vi.mocked(withdrawRegistration).mockResolvedValue({ id: REGISTRATION, status: "withdrawn" });
    vi.mocked(getAttendeeEvent).mockResolvedValueOnce(event).mockRejectedValueOnce(httpError(500, {}));
    renderPage();
    await user.click(await openConfirmation(user));
    expect(await screen.findByText("Your registration has been withdrawn.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it.each([
    ["the backend's reason", httpError(409, { error: "The withdrawal deadline for this event has passed", code: "WITHDRAWAL_DEADLINE_PASSED" }),
      "The withdrawal deadline for this event has passed"],
    ["an expired session", httpError(401, {}), "Your session has expired. Please sign in again."],
    ["a network failure", Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" }),
      "Could not reach the server. Check your connection and try again."],
    ["an unexpected failure", httpError(500, {}), "Your registration could not be withdrawn. It has not changed; please try again."],
  ])("SCRUM27_AC7_on_failure_shows_%s_and_leaves_the_registration_displayed", async (_case, error, message) => {
    const user = userEvent.setup();
    vi.mocked(withdrawRegistration).mockRejectedValue(error);
    renderPage();
    await user.click(await openConfirmation(user));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText("Your registration has been withdrawn.")).not.toBeInTheDocument();
    expect(screen.getByText("Hall A")).toBeInTheDocument();
    expect(getAttendeeEvent).toHaveBeenCalledTimes(1);
    // The attendee can try again: the action is back, not stuck pending.
    expect(screen.getByRole("button", { name: "Withdraw registration" })).toBeEnabled();
  });
});
