import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";

import { useAuth } from "../../src/auth/AuthContext";
import { renderAppAt } from "../helpers/renderApp.js";

vi.mock("../../src/auth/AuthContext", async () => (await import("../helpers/authMock.js")).authContextMock());

vi.mock("../../src/components/EventRegistrationSettings", () => ({
  default: ({ eventId }) => <p data-testid="registration-settings">Settings for {eventId}</p>,
}));

const renderRegistrationPage = (role) =>
  renderAppAt("/events/22222222-2222-4222-8222-222222222222/registration", role);

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
});

describe("SCRUM494 event registration settings route", () => {
  it("SCRUM494_AC1_allows_an_event_organiser_to_open_the_event_settings_page", () => {
    renderRegistrationPage("event_organiser");

    expect(screen.getByTestId("registration-settings"))
      .toHaveTextContent("Settings for 22222222-2222-4222-8222-222222222222");
    expect(window.location.pathname).toBe("/events/22222222-2222-4222-8222-222222222222/registration");
  });

  it.each(["event_coordinator", "attendee", "venue_staff"])(
    "SCRUM494_AC1_refuses_%s_from_the_settings_page",
    (role) => {
      renderRegistrationPage(role);

      expect(screen.queryByTestId("registration-settings")).not.toBeInTheDocument();
      expect(window.location.pathname).toBe("/unauthorized");
      expect(screen.getByRole("heading", { name: "Not available to your role" })).toBeInTheDocument();
    },
  );

  it("SCRUM494_AC1_sends_a_signed_out_visitor_to_login", () => {
    renderRegistrationPage(null);

    expect(screen.queryByTestId("registration-settings")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/login");
  });
});
