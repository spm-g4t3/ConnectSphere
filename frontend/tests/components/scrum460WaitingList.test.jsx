// The waiting list across the attendee, organiser and coordinator screens, with
// the services mocked; the backend's rules are tested in the backend.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";

import BrowseEventDetails from "../../src/components/BrowseEventDetails.jsx";
import WaitingListPlaces from "../../src/components/WaitingListPlaces.jsx";
import RegistrationCounts from "../../src/components/RegistrationCounts.jsx";
import EventRegistrationSettings from "../../src/components/EventRegistrationSettings.jsx";
import { getOpenEvent } from "../../src/services/openEventService";
import { deferred } from "../helpers/async.js";
import { getWaitlist, leaveWaitlist } from "../../src/services/attendeeEventService";
import {
  getRegistrationCounts,
  getRegistrationSettings,
  saveRegistrationSettings,
} from "../../src/services/eventRegistrationService";

vi.mock("../../src/services/openEventService", () => ({ getOpenEvent: vi.fn() }));
vi.mock("../../src/services/attendeeEventService", () => ({ getWaitlist: vi.fn(), leaveWaitlist: vi.fn() }));
vi.mock("../../src/services/eventRegistrationService", () => ({
  getRegistrationCounts: vi.fn(),
  getRegistrationSettings: vi.fn(),
  saveRegistrationSettings: vi.fn(),
}));

const fullEvent = (overrides = {}) => ({
  id: "e1",
  eventName: "Open Day",
  description: "Come along.",
  startsAt: "2026-10-25T01:00:00.000Z",
  endsAt: "2026-10-25T03:30:00.000Z",
  capacity: 1,
  placesLeft: 0,
  isFull: true,
  isRegistered: false,
  canRegister: false,
  canJoinWaitlist: true,
  waitlistPosition: null,
  ...overrides,
});

function renderDetails(onJoinWaitlist) {
  return render(
    <MemoryRouter initialEntries={["/open-events/e1"]}>
      <Routes>
        <Route
          path="/open-events/:eventId"
          element={(
            <>
              <BrowseEventDetails onRegister={vi.fn()} onJoinWaitlist={onJoinWaitlist} />
              <Link to="/open-events/e2">Another event</Link>
            </>
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SCRUM460 joining from the event page", () => {
  it("SCRUM460_AC1_a_full_event_offers_the_waiting_list_and_reports_the_position", async () => {
    vi.mocked(getOpenEvent).mockResolvedValueOnce(fullEvent())
      .mockResolvedValueOnce(fullEvent({ canJoinWaitlist: false, waitlistPosition: 2 }));
    const onJoinWaitlist = vi.fn().mockResolvedValue({ status: "waitlisted", waitlistPosition: 2 });
    renderDetails(onJoinWaitlist);

    fireEvent.click(await screen.findByRole("button", { name: "Join waiting list" }));

    await waitFor(() => expect(onJoinWaitlist).toHaveBeenCalledWith("e1"));
    expect(await screen.findByText("You are on the waiting list for Open Day at position 2.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "On the waiting list" })).toBeDisabled();
    expect(screen.getByText(/You are number 2 on the waiting list/)).toBeInTheDocument();
  });

  it("SCRUM460_AC1_a_full_event_without_a_waiting_list_stays_full", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(fullEvent({ canJoinWaitlist: false }));
    renderDetails(vi.fn());
    expect(await screen.findByText("This event is full.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Join waiting list" })).not.toBeInTheDocument();
  });

  it("SCRUM460_AC1_a_refusal_is_explained", async () => {
    vi.mocked(getOpenEvent).mockResolvedValueOnce(fullEvent())
      .mockResolvedValueOnce(fullEvent({ isFull: false, placesLeft: 1, canRegister: true, canJoinWaitlist: false }));
    const onJoinWaitlist = vi.fn().mockRejectedValue({ response: { status: 409, data: { code: "PLACES_AVAILABLE" } } });
    renderDetails(onJoinWaitlist);

    fireEvent.click(await screen.findByRole("button", { name: "Join waiting list" }));

    expect(await screen.findByText("A place is available, so you can register instead of joining the waiting list."))
      .toBeInTheDocument();
  });
});

describe("SCRUM460 joining: one attempt, for the event on screen", () => {
  it("SCRUM460_AC1_the_button_is_disabled_while_joining_and_an_unnamed_event_reads_naturally", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(fullEvent({ eventName: null }));
    const attempt = deferred();
    renderDetails(vi.fn(() => attempt.promise));

    fireEvent.click(await screen.findByRole("button", { name: "Join waiting list" }));
    expect(screen.getByRole("button", { name: "Joining..." })).toBeDisabled();
    attempt.resolve({ waitlistPosition: 1 });

    expect(await screen.findByText("You are on the waiting list for this event at position 1.")).toBeInTheDocument();
  });

  it("SCRUM460_AC1_joining_pauses_when_the_event_cannot_be_checked_again", async () => {
    vi.mocked(getOpenEvent).mockResolvedValueOnce(fullEvent())
      .mockRejectedValueOnce({ response: { status: 500 } });
    renderDetails(vi.fn().mockRejectedValue({ response: { status: 500, data: {} } }));

    fireEvent.click(await screen.findByRole("button", { name: "Join waiting list" }));

    expect(await screen.findByText("Joining is paused until this event can be checked again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Join waiting list" })).toBeDisabled();
  });

  it("SCRUM460_AC1_an_unexplained_failure_gets_the_generic_message", async () => {
    vi.mocked(getOpenEvent).mockResolvedValue(fullEvent());
    renderDetails(vi.fn().mockRejectedValue({ response: { status: 500, data: {} } }));

    fireEvent.click(await screen.findByRole("button", { name: "Join waiting list" }));

    expect(await screen.findByText("You could not be added to the waiting list. Please try again.")).toBeInTheDocument();
  });

  it("SCRUM460_AC1_an_answer_that_arrives_after_moving_to_another_event_is_not_shown_there", async () => {
    vi.mocked(getOpenEvent).mockResolvedValueOnce(fullEvent())
      .mockResolvedValue(fullEvent({ id: "e2", eventName: "Second event" }));
    const attempt = deferred();
    renderDetails(vi.fn(() => attempt.promise));

    fireEvent.click(await screen.findByRole("button", { name: "Join waiting list" }));
    fireEvent.click(screen.getByRole("link", { name: "Another event" }));
    expect(await screen.findByRole("heading", { name: "Second event" })).toBeInTheDocument();
    attempt.resolve({ waitlistPosition: 1 });

    expect(await screen.findByRole("button", { name: "Join waiting list" })).toBeEnabled();
    expect(screen.queryByText(/You are on the waiting list/)).not.toBeInTheDocument();
  });
});

describe("SCRUM460 waiting lists in My Registrations", () => {
  const place = { registrationId: "r1", eventRequestId: "e1", eventName: "Open Day", waitlistPosition: 3 };

  it("SCRUM460_AC2_shows_each_position_and_leaves_after_confirmation", async () => {
    vi.mocked(getWaitlist).mockResolvedValueOnce([place]).mockResolvedValueOnce([]);
    vi.mocked(leaveWaitlist).mockResolvedValue({ id: "r1", status: "withdrawn" });
    const onChanged = vi.fn();
    render(<WaitingListPlaces onChanged={onChanged} />);

    expect(await screen.findByText("Position 3 on the waiting list")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Leave waiting list" }));
    expect(leaveWaitlist).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm leaving" }));

    await waitFor(() => expect(leaveWaitlist).toHaveBeenCalledWith("r1"));
    expect(await screen.findByText("You are not on any waiting lists.")).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it("SCRUM460_AC2_a_promotion_in_flight_is_explained_and_refreshes_registrations", async () => {
    vi.mocked(getWaitlist).mockResolvedValue([place]);
    vi.mocked(leaveWaitlist).mockRejectedValue({ response: { status: 409, data: { code: "NOT_WAITLISTED" } } });
    const onChanged = vi.fn();
    render(<WaitingListPlaces onChanged={onChanged} />);

    fireEvent.click(await screen.findByRole("button", { name: "Leave waiting list" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm leaving" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("You have been given a place at this event");
    expect(onChanged).toHaveBeenCalled();
  });
});

describe("SCRUM460 waiting-list count for staff", () => {
  it("SCRUM460_AC6_the_coordinator_panel_shows_registered_and_waitlisted_totals", async () => {
    vi.mocked(getRegistrationCounts).mockResolvedValue({
      eventRequestId: "e1", capacity: 50, waitlistEnabled: true, registeredCount: 50, waitlistCount: 4,
    });
    render(<RegistrationCounts eventId="e1" />);

    const panel = await screen.findByRole("region", { name: "Registrations" });
    expect(within(panel).getByText("50 / 50")).toBeInTheDocument();
    expect(within(panel).getByText("4")).toBeInTheDocument();
    expect(getRegistrationCounts).toHaveBeenCalledWith("e1");
  });

  it("SCRUM460_AC6_the_organiser_sees_the_count_and_switches_the_list_on", async () => {
    const settings = {
      enabled: true, opensAt: "2030-01-01T09:00:00.000Z", closesAt: null, capacity: 80,
      withdrawalDeadline: null, waitlistEnabled: false, registeredCount: 80, waitlistCount: 0,
    };
    vi.mocked(getRegistrationSettings).mockResolvedValue({
      eventName: "Industry Night", status: "confirmed", proposedStart: "2030-01-01T12:00:00.000Z", settings,
    });
    vi.mocked(saveRegistrationSettings).mockResolvedValue({ ...settings, waitlistEnabled: true });
    render(
      <MemoryRouter>
        <EventRegistrationSettings eventId="e1" />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Configure registration" }));
    const form = await screen.findByRole("form");
    fireEvent.click(within(form).getByLabelText("Waiting list is on"));
    fireEvent.click(within(form).getByRole("button", { name: "Save registration settings" }));

    await waitFor(() => expect(saveRegistrationSettings).toHaveBeenCalledWith(
      "e1", expect.objectContaining({ waitlistEnabled: true }),
    ));
    const waitlisted = (await screen.findByText("Waitlisted")).closest("div");
    expect(within(waitlisted).getByText("0")).toBeInTheDocument();
  });
});
