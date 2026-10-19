import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import EventRegistrationSettings from "../../src/components/EventRegistrationSettings.jsx";
import {
  getRegistrationSettings,
  saveRegistrationSettings,
} from "../../src/services/eventRegistrationService";

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
