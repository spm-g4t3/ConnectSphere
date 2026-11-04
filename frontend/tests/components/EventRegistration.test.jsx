/* global process -- the time zone tests set TZ for the Node process the tests run in */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import EventRegistrationSettings from "../../src/components/EventRegistrationSettings.jsx";
import {
  getRegistrationSettings,
  saveRegistrationSettings,
} from "../../src/services/eventRegistrationService";
import { deferred } from "../helpers/async.js";

vi.mock("../../src/services/eventRegistrationService", () => ({
  getRegistrationSettings: vi.fn(),
  saveRegistrationSettings: vi.fn(),
}));

const EVENT_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SCRUM494 organiser registration controls", () => {
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

  it("SCRUM494_AC1_shows_field_names_not_api_keys_in_validation_errors", async () => {
    vi.mocked(getRegistrationSettings).mockResolvedValue({
      eventName: "Industry Night",
      status: "approved",
      proposedStart: "2030-01-01T12:00:00.000Z",
      settings: {
        enabled: false,
        opensAt: null,
        closesAt: null,
        capacity: null,
        withdrawalDeadline: null,
        registeredCount: 0,
      },
    });
    vi.mocked(saveRegistrationSettings).mockRejectedValue({
      response: {
        data: {
          error: "Registration settings are invalid.",
          details: [
            { field: "registrationClosesAt", message: "Must be before the event starts." },
            { field: "registrationCapacity", message: "Must be a whole number above zero." },
            { field: "somethingNew", message: "Check this value." },
          ],
        },
      },
    });

    render(
      <MemoryRouter>
        <EventRegistrationSettings eventId={EVENT_ID} />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Configure registration" }));
    fireEvent.click(within(await screen.findByRole("form")).getByRole("button", { name: "Save registration settings" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Closing time: Must be before the event starts. Capacity: Must be a whole number above zero. Check this value.",
    );
    expect(alert).not.toHaveTextContent(/registrationClosesAt|registrationCapacity|somethingNew/);
  });
});

const loadedEvent = (overrides = {}) => ({
  eventName: "Industry Night",
  status: "approved",
  proposedStart: "2030-01-01T12:00:00.000Z",
  settings: {
    enabled: false, opensAt: null, closesAt: null, capacity: 80, withdrawalDeadline: null, registeredCount: 12,
  },
  ...overrides,
});

describe("SCRUM494 registration settings page states", () => {
  it("SCRUM494_AC2_an_event_outside_the_configurable_statuses_explains_why_it_cannot_be_changed", async () => {
    vi.mocked(getRegistrationSettings).mockResolvedValue(loadedEvent({
      status: "completed", statusDisplay: { status: "completed", label: "Completed", group: "COMPLETED" },
    }));
    render(
      <MemoryRouter>
        <EventRegistrationSettings eventId={EVENT_ID} />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/Settings can only be changed while the event is Approved/))
      .toHaveTextContent("Current status: Completed.");
    expect(screen.getByText("12 / 80")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Configure registration" })).not.toBeInTheDocument();
  });

  it("SCRUM494_AC6_an_unexpected_server_error_on_load_says_what_to_check", async () => {
    vi.mocked(getRegistrationSettings).mockRejectedValue({
      response: { status: 500, data: { error: "Unexpected server error" } },
    });
    render(
      <MemoryRouter>
        <EventRegistrationSettings eventId={EVENT_ID} />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unexpected server error Check that the registration migrations are applied to the API database, then try again.",
    );
    expect(screen.queryByRole("button", { name: "Configure registration" })).not.toBeInTheDocument();
  });

  // Moving to another event while the first is still loading: its late answer
  // must not show the first event's settings or error on the second's page.
  async function switchEventWhileLoading() {
    const first = deferred();
    vi.mocked(getRegistrationSettings)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(loadedEvent({ eventName: "Career Fair" }));
    const { rerender } = render(
      <MemoryRouter>
        <EventRegistrationSettings eventId="event-1" />
      </MemoryRouter>,
    );
    rerender(
      <MemoryRouter>
        <EventRegistrationSettings eventId="event-2" />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "Career Fair" })).toBeInTheDocument();
    expect(getRegistrationSettings).toHaveBeenLastCalledWith("event-2");
    return first;
  }

  it("SCRUM494_AC6_settings_that_arrive_for_the_previous_event_are_not_shown", async () => {
    const first = await switchEventWhileLoading();

    await act(async () => first.resolve(loadedEvent({ eventName: "Old Event" })));

    expect(screen.getByRole("heading", { name: "Career Fair" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Old Event" })).not.toBeInTheDocument();
  });

  it("SCRUM494_AC6_a_load_failure_for_the_previous_event_is_not_shown", async () => {
    const first = await switchEventWhileLoading();

    await act(async () => first.reject({ response: { status: 500, data: { error: "Unexpected server error" } } }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Configure registration" })).toBeInTheDocument();
  });
});

// Times are typed in the device's zone, like the other forms, but the summary
// reads Singapore time like every event time. Pinned on a New York device.
describe("SCRUM494 registration times on a device outside Singapore", () => {
  const ORIGINAL_TZ = process.env.TZ;

  beforeEach(() => {
    process.env.TZ = "America/New_York";
    vi.mocked(getRegistrationSettings).mockResolvedValue({
      eventName: "Industry Night",
      status: "approved",
      proposedStart: "2026-11-20T02:00:00.000Z",
      settings: {
        enabled: true,
        // 02:00Z is 10:00 in Singapore and 22:00 the evening before in New York.
        opensAt: "2026-11-01T02:00:00.000Z",
        closesAt: "2026-11-10T02:00:00.000Z",
        capacity: null,
        withdrawalDeadline: null,
        registeredCount: 0,
      },
    });
  });

  afterEach(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  function renderSettings() {
    render(
      <MemoryRouter>
        <EventRegistrationSettings eventId={EVENT_ID} />
      </MemoryRouter>,
    );
  }

  async function openForm() {
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Configure registration" }));
    return screen.findByRole("form");
  }

  it("SCRUM494_AC6_summary_shows_saved_times_in_singapore_time", async () => {
    renderSettings();
    await screen.findByRole("button", { name: "Configure registration" });

    expect(screen.getByText("1 Nov 2026, 10:00 am")).toBeInTheDocument();
    expect(screen.getByText("10 Nov 2026, 10:00 am")).toBeInTheDocument();
  });

  it("SCRUM494_AC6_labels_the_inputs_with_the_device_time_zone", async () => {
    const form = await openForm();

    expect(within(form).getByText("Times are in your device's time zone (America/New_York)."))
      .toBeInTheDocument();
  });

  it("SCRUM494_AC6_prefills_saved_times_as_device_wall_clock", async () => {
    const form = await openForm();

    expect(within(form).getByLabelText("Opens at")).toHaveValue("2026-10-31T22:00");
    expect(within(form).getByLabelText(/Closes at/)).toHaveValue("2026-11-09T21:00");
  });

  it("SCRUM494_AC1_sends_entered_times_with_the_device_offset_and_blank_as_null", async () => {
    vi.mocked(saveRegistrationSettings).mockResolvedValue({
      enabled: true,
      opensAt: "2026-11-02T15:00:00.000Z",
      closesAt: null,
      capacity: null,
      withdrawalDeadline: null,
      registeredCount: 0,
    });
    const form = await openForm();

    // New York is on standard time (-05:00) by 2 November 2026.
    fireEvent.change(within(form).getByLabelText("Opens at"), { target: { value: "2026-11-02T10:00" } });
    fireEvent.change(within(form).getByLabelText(/Closes at/), { target: { value: "" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save registration settings" }));

    await waitFor(() => expect(saveRegistrationSettings).toHaveBeenCalledWith(
      EVENT_ID,
      expect.objectContaining({
        opensAt: "2026-11-02T10:00:00-05:00",
        closesAt: null,
        withdrawalDeadline: null,
      }),
    ));
  });

  it("SCRUM494_AC1_sends_the_withdrawal_deadline_entered_with_the_device_offset", async () => {
    vi.mocked(saveRegistrationSettings).mockResolvedValue({
      enabled: true,
      opensAt: "2026-11-01T02:00:00.000Z",
      closesAt: "2026-11-10T02:00:00.000Z",
      capacity: null,
      withdrawalDeadline: "2026-11-05T14:00:00.000Z",
      registeredCount: 0,
    });
    const form = await openForm();

    fireEvent.change(within(form).getByLabelText(/Withdrawal deadline/), { target: { value: "2026-11-05T09:00" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save registration settings" }));

    await waitFor(() => expect(saveRegistrationSettings).toHaveBeenCalledWith(
      EVENT_ID,
      expect.objectContaining({ withdrawalDeadline: "2026-11-05T09:00:00-05:00" }),
    ));
    // 14:00Z is 22:00 in Singapore.
    expect(await screen.findByText("5 Nov 2026, 10:00 pm")).toBeInTheDocument();
  });
});
