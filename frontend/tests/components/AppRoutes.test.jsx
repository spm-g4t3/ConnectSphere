// AppRoutes.test.jsx
//
// The real App's own behaviour, outside any one screen: the registration list
// route remounting per event, and the "Logged out" message clearing itself.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import App from "../../src/App.jsx";
import { useAuth } from "../../src/auth/AuthContext";
import { authValue } from "../helpers/authMock.js";
import { renderAppAt } from "../helpers/renderApp.js";

vi.mock("../../src/auth/AuthContext", async () => (await import("../helpers/authMock.js")).authContextMock());

// Remembers the event it was first mounted for, so a list reused across
// events (instead of remounted) shows the old id beside the new one.
vi.mock("../../src/components/EventRegistrationList", async () => {
  const { useState } = await import("react");
  const { Link } = await import("react-router-dom");
  return {
    default: function EventRegistrationListStub({ eventId }) {
      const [mountedFor] = useState(eventId);
      return (
        <div>
          <p data-testid="registration-list">List for {eventId}, mounted for {mountedFor}</p>
          <Link to="/events/33333333-3333-4333-8333-333333333333/registrations">Next event</Link>
        </div>
      );
    },
  };
});

const FIRST = "22222222-2222-4222-8222-222222222222";
const SECOND = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.mocked(useAuth).mockReset();
});

describe("SCRUM478 the registration list route", () => {
  it.each(["event_organiser", "event_coordinator"])(
    "SCRUM478_AC1_%s_opens_the_list_for_the_event_in_the_url",
    (role) => {
      renderAppAt(`/events/${FIRST}/registrations`, role);

      expect(screen.getByTestId("registration-list")).toHaveTextContent(
        `List for ${FIRST}, mounted for ${FIRST}`,
      );
      expect(window.location.pathname).toBe(`/events/${FIRST}/registrations`);
    },
  );

  it("SCRUM478_AC1_following_a_link_to_another_event_starts_a_fresh_list", async () => {
    const user = userEvent.setup();
    renderAppAt(`/events/${FIRST}/registrations`, "event_organiser");

    await user.click(screen.getByRole("link", { name: "Next event" }));

    expect(screen.getByTestId("registration-list")).toHaveTextContent(
      `List for ${SECOND}, mounted for ${SECOND}`,
    );
  });

  it("SCRUM478_AC1_refuses_an_attendee", () => {
    renderAppAt(`/events/${FIRST}/registrations`, "attendee");

    expect(screen.queryByTestId("registration-list")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/unauthorized");
  });
});

describe("SCRUM583 the logged-out message", () => {
  // renderAppAt signs in through authValue, which never carries a message.
  function renderLoggedOut() {
    const auth = { ...authValue(null), logoutMessage: "Logged out successfully" };
    vi.mocked(useAuth).mockReturnValue(auth);
    window.history.pushState({}, "", "/login");
    return { auth, view: render(<App />) };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("SCRUM583_AC4_the_message_shows_then_clears_after_three_and_a_half_seconds", () => {
    const { auth } = renderLoggedOut();

    expect(screen.getByText("Logged out successfully")).toHaveAttribute("role", "status");

    act(() => vi.advanceTimersByTime(3499));
    expect(auth.clearLogoutMessage).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(auth.clearLogoutMessage).toHaveBeenCalledTimes(1);
  });

  it("SCRUM583_AC4_leaving_before_it_clears_cancels_the_timer", () => {
    const { auth, view } = renderLoggedOut();

    view.unmount();
    act(() => vi.advanceTimersByTime(5000));

    expect(auth.clearLogoutMessage).not.toHaveBeenCalled();
  });
});
