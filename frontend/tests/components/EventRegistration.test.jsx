import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import AttendeeDashboard from "../../src/components/AttendeeDashboard.jsx";
import EventRegistrationSettings from "../../src/components/EventRegistrationSettings.jsx";
import {
  getOpenRegistrationEvents,
  getRegistrationSettings,
  registerForEvent,
  saveRegistrationSettings,
} from "../../src/services/eventRegistrationService";

vi.mock("../../src/services/eventRegistrationService", () => ({
  getOpenRegistrationEvents: vi.fn(),
  getRegistrationSettings: vi.fn(),
  registerForEvent: vi.fn(),
  saveRegistrationSettings: vi.fn(),
}));

vi.mock("../../src/components/NotificationInbox", () => ({
  default: () => null,
}));

const EVENT_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SCRUM-363 organiser registration controls", () => {
  it("SCRUM494_AC6_shows_current_configuration_and_saves_organiser_changes", async () => {
    vi.mocked(getRegistrationSettings).mockResolvedValue({
      eventName: "Industry Night",
      status: "approved",
      proposedStart: "2030-01-01T12:00:00.000Z",
      settings: {
        enabled: false,
        opensAt: "2030-01-01T09:00:00.000Z",
        closesAt: "2030-01-01T11:00:00.000Z",
        capacity: 80,
        withdrawalDeadline: null,
        registeredCount: 12,
      },
    });
    vi.mocked(saveRegistrationSettings).mockResolvedValue({
      enabled: true,
      opensAt: "2030-01-01T09:00:00.000Z",
      closesAt: "2030-01-01T11:00:00.000Z",
      capacity: 90,
      withdrawalDeadline: null,
      registeredCount: 12,
    });

    render(
      <MemoryRouter initialEntries={[`/events/${EVENT_ID}/registration`]}>
        <Routes>
          <Route path="/events/:eventId/registration" element={<EventRegistrationSettings eventId={EVENT_ID} />} />
        </Routes>
      </MemoryRouter>,
    );

    const configure = await screen.findByRole("button", { name: "Configure registration" });
    expect(screen.getByRole("heading", { name: "Industry Night" })).toBeInTheDocument();
    expect(screen.getByText("12 / 80")).toBeInTheDocument();
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    fireEvent.click(configure);
    const form = await screen.findByRole("form");
    expect(screen.queryByText("12 / 80")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Registration settings" })).not.toBeInTheDocument();
    fireEvent.click(within(form).getByLabelText("Registration is on"));
    fireEvent.change(within(form).getByRole("spinbutton"), {
      target: { value: "90" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Save registration settings" }));

    await waitFor(() => expect(saveRegistrationSettings).toHaveBeenCalledWith(
      EVENT_ID,
      expect.objectContaining({ enabled: true, capacity: 90 }),
    ));
    expect(await screen.findByText("Registration settings saved.")).toBeInTheDocument();
  });
});

describe("SCRUM-22 attendee registration", () => {
  it("SCRUM494_AC5_keeps_the_attendee_registered_when_registration_reaches_capacity", async () => {
    vi.stubEnv("VITE_OPEN_EVENTS_ENABLED", "false");
    const openEvent = {
      id: EVENT_ID,
      eventName: "Industry Night",
      description: "Meet employers.",
      startsAt: "2030-01-01T12:00:00.000Z",
      registrationClosesAt: "2030-01-01T12:00:00.000Z",
      capacity: 1,
      registeredCount: 0,
    };
    vi.mocked(getOpenRegistrationEvents)
      .mockResolvedValueOnce([openEvent])
      .mockResolvedValue([{ ...openEvent, registeredCount: 1, isRegistered: true, isFull: true }]);
    vi.mocked(registerForEvent).mockResolvedValue({ id: "registration-1" });

    render(<AttendeeDashboard user={{ name: "Ari" }} />);
    expect(await screen.findByRole("heading", { name: "Industry Night" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    expect(screen.getByText("Event starts")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm registration" }));

    await waitFor(() => expect(registerForEvent).toHaveBeenCalledWith(EVENT_ID));
    expect(await screen.findByText("Registered")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Industry Night" })).toBeInTheDocument();
  });

  it("SCRUM494_AC5_rereads_the_list_after_a_failed_registration", async () => {
    vi.stubEnv("VITE_OPEN_EVENTS_ENABLED", "false");
    const openEvent = {
      id: EVENT_ID,
      eventName: "Industry Night",
      description: "",
      startsAt: "2030-01-01T12:00:00.000Z",
      registrationClosesAt: null,
      capacity: 1,
      registeredCount: 0,
    };
    vi.mocked(getOpenRegistrationEvents)
      .mockResolvedValueOnce([openEvent])
      .mockResolvedValue([{ ...openEvent, registeredCount: 1, isFull: true }]);
    vi.mocked(registerForEvent).mockRejectedValue({ response: { data: { error: "This event is full." } } });

    render(<AttendeeDashboard user={{ name: "Ari" }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Register" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm registration" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This event is full.");
    expect(await screen.findByText("Full")).toBeInTheDocument();
    expect(getOpenRegistrationEvents).toHaveBeenCalledTimes(2);
  });

  it("SCRUM494_AC5_shows_a_full_event_to_an_attendee_who_already_registered", async () => {
    vi.stubEnv("VITE_OPEN_EVENTS_ENABLED", "false");
    vi.mocked(getOpenRegistrationEvents).mockResolvedValue([{
      id: EVENT_ID,
      eventName: "Industry Night",
      startsAt: "2030-01-01T12:00:00.000Z",
      registrationClosesAt: "2030-01-01T12:00:00.000Z",
      capacity: 1,
      registeredCount: 1,
      isRegistered: true,
      isFull: true,
    }]);

    render(<AttendeeDashboard user={{ name: "Ari" }} />);

    expect(await screen.findByRole("heading", { name: "Industry Night" })).toBeInTheDocument();
    expect(screen.getByText("Registered")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Register" })).not.toBeInTheDocument();
  });
});
