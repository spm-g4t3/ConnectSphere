import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  const withdrawnReply = { id: REGISTRATION, status: "withdrawn", placesLeft: 1, isFull: false };
  const successBox = () => screen.getByText("Your registration has been withdrawn.").closest("[role='status']");

  it("SCRUM27_AC8_confirms_after_the_backend_succeeds_with_the_refreshed_status_withdrawn", async () => {
    const user = userEvent.setup();
    vi.mocked(withdrawRegistration).mockResolvedValue(withdrawnReply);
    vi.mocked(getAttendeeEvent).mockResolvedValueOnce(event).mockRejectedValueOnce(notFound);
    renderPage();
    await user.click(await openConfirmation(user));

    await screen.findByText("Your registration has been withdrawn.");
    expect(successBox()).toHaveClass("browse-event-details__success");
    expect(within(successBox()).getByText("Registration status").nextElementSibling).toHaveTextContent("Withdrawn");
    expect(within(successBox()).getByRole("link", { name: "Browse open events" })).toHaveAttribute("href", "/open-events");
    expect(screen.getByRole("link", { name: "Back to registered events" })).toHaveAttribute("href", "/registered-events");
    // The page still names the event the attendee withdrew from.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Open day");

    // The server re-read, not this page, decides what is left: no stale Confirmed details or action.
    await waitFor(() => expect(getAttendeeEvent).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Loading...")).not.toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Confirmed arrangements" })).not.toBeInTheDocument();
    expect(screen.queryByText("Hall A")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Withdraw/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("SCRUM27_AC8_shows_one_confirmation_even_after_later_refreshes", async () => {
    const user = userEvent.setup();
    vi.mocked(withdrawRegistration).mockResolvedValue(withdrawnReply);
    vi.mocked(getAttendeeEvent).mockResolvedValueOnce(event).mockRejectedValue(notFound);
    renderPage();
    await user.click(await openConfirmation(user));
    await screen.findByText("Your registration has been withdrawn.");

    fireEvent.focus(window);
    await waitFor(() => expect(getAttendeeEvent).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByText("Loading...")).not.toBeInTheDocument());
    expect(screen.getAllByText("Your registration has been withdrawn.")).toHaveLength(1);
  });

  it("SCRUM27_AC8_drops_the_confirmation_when_the_server_later_shows_an_active_registration", async () => {
    const user = userEvent.setup();
    vi.mocked(withdrawRegistration).mockResolvedValue(withdrawnReply);
    vi.mocked(getAttendeeEvent).mockResolvedValueOnce(event).mockRejectedValueOnce(notFound)
      .mockResolvedValueOnce({ ...event, registrationId: "r2" });
    renderPage();
    await user.click(await openConfirmation(user));
    await screen.findByText("Your registration has been withdrawn.");

    // Registered again elsewhere: the server's answer replaces the stale notice.
    fireEvent.focus(window);
    expect(await screen.findByText("Hall A")).toBeInTheDocument();
    expect(screen.queryByText("Your registration has been withdrawn.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Withdraw registration" })).toBeInTheDocument();
  });

  it("SCRUM27_AC8_a_reply_that_is_not_withdrawn_is_not_reported_as_success", async () => {
    const user = userEvent.setup();
    vi.mocked(withdrawRegistration).mockResolvedValue({ id: REGISTRATION, status: "registered" });
    renderPage();
    await user.click(await openConfirmation(user));

    expect(await screen.findByRole("alert")).toHaveTextContent("Your registration could not be withdrawn.");
    expect(screen.queryByText("Your registration has been withdrawn.")).not.toBeInTheDocument();
    expect(screen.getByText("Hall A")).toBeInTheDocument();
    expect(getAttendeeEvent).toHaveBeenCalledTimes(1);
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

  // What the page must still show after any failure: the registration as loaded,
  // no success, no spinner, and no re-read that could replace it.
  function expectRegistrationUnchanged() {
    expect(screen.queryByText("Your registration has been withdrawn.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Withdrawing..." })).not.toBeInTheDocument();
    expect(screen.getByText("Hall A")).toBeInTheDocument();
    expect(getAttendeeEvent).toHaveBeenCalledTimes(1);
  }

  it.each([
    ["an expired deadline", httpError(409, { error: "x", code: "WITHDRAWAL_DEADLINE_PASSED" }),
      "The withdrawal deadline for this event has passed, so your registration can no longer be withdrawn. You are still registered."],
    ["no deadline set", httpError(409, { error: "x", code: "WITHDRAWAL_DEADLINE_NOT_SET" }),
      "This event has no withdrawal deadline, so registrations cannot be withdrawn. You are still registered."],
    ["a non-confirmed registration", httpError(409, { error: "x", code: "REGISTRATION_NOT_CONFIRMED" }),
      "Only a confirmed registration can be withdrawn, and this registration is not confirmed."],
    ["an already withdrawn registration", httpError(409, { error: "x", code: "ALREADY_WITHDRAWN" }),
      "This registration has already been withdrawn."],
    ["a missing or someone else's registration", httpError(404, { error: "Registration not found" }),
      "This registration could not be found. It may already have been withdrawn or cancelled."],
    ["a caller who is not an attendee", httpError(403, { error: "This action is restricted to Attendees" }),
      "Only Attendees can withdraw a registration."],
  ])("SCRUM27_AC7_a_rejection_for_%s_is_explained_and_offers_no_retry", async (_case, error, message) => {
    const user = userEvent.setup();
    vi.mocked(withdrawRegistration).mockRejectedValue(error);
    renderPage();
    await user.click(await openConfirmation(user));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expectRegistrationUnchanged();
    // Asking again would get the same answer, so nothing invites it.
    expect(screen.queryByRole("button", { name: /Withdraw|Try again|Confirm/ })).not.toBeInTheDocument();
  });

  it("SCRUM27_AC7_a_final_refusal_stays_after_the_page_reloads_on_return", async () => {
    const user = userEvent.setup();
    vi.mocked(withdrawRegistration).mockRejectedValue(
      httpError(409, { error: "x", code: "WITHDRAWAL_DEADLINE_PASSED" }));
    renderPage();
    await user.click(await openConfirmation(user));
    await screen.findByRole("alert");

    // Switching tabs and back re-reads the event and remounts the action.
    fireEvent.focus(window);
    await waitFor(() => expect(getAttendeeEvent).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Hall A")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/withdrawal deadline for this event has passed/);
    expect(screen.queryByRole("button", { name: /Withdraw|Try again|Confirm/ })).not.toBeInTheDocument();
    expect(withdrawRegistration).toHaveBeenCalledTimes(1);
  });

  it("SCRUM27_AC7_a_refusal_for_one_registration_does_not_hide_the_action_for_a_new_one", async () => {
    const user = userEvent.setup();
    vi.mocked(withdrawRegistration).mockRejectedValue(httpError(409, { error: "x", code: "EVENT_STARTED" }));
    vi.mocked(getAttendeeEvent).mockResolvedValueOnce(event).mockResolvedValueOnce({ ...event, registrationId: "r2" });
    renderPage();
    await user.click(await openConfirmation(user));
    await screen.findByRole("alert");

    fireEvent.focus(window);
    expect(await screen.findByRole("button", { name: "Withdraw registration" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    ["a network failure", Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" }),
      "Could not reach the server. Your registration has not changed; check your connection and try again."],
    ["an outage", httpError(503, { error: "x" }), "Registration withdrawal is temporarily unavailable. Please try again later."],
    ["a concurrent change", httpError(409, { error: "x", code: "REGISTRATION_CHANGED" }),
      "Your registration changed while it was being withdrawn. Please try again."],
    ["an unexpected server error", httpError(500, {}), "Your registration could not be withdrawn. It has not changed; please try again."],
  ])("SCRUM27_AC7_%s_is_not_a_rejection_and_can_be_retried", async (_case, error, message) => {
    const user = userEvent.setup();
    vi.mocked(withdrawRegistration).mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ id: REGISTRATION, status: "withdrawn" });
    vi.mocked(getAttendeeEvent).mockResolvedValueOnce(event).mockRejectedValueOnce(notFound);
    renderPage();
    await user.click(await openConfirmation(user));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expectRegistrationUnchanged();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Your registration has been withdrawn.")).toBeInTheDocument();
    expect(withdrawRegistration).toHaveBeenCalledTimes(2);
  });
});
