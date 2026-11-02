// scrum583ExpiredSessionFlow.test.jsx
//
// SCRUM-583 AC1, AC4 and AC5 end to end: the REAL App with the real
// AuthProvider and apiClient, the network replaced. A signed-in user whose
// session is refused lands on the login page with the one message, whatever the
// role and whichever screen they were on, and signing in again works.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import App from "../../src/App.jsx";
import { apiClient } from "../../src/services/apiClient";
import { SESSION_EXPIRED_MESSAGE } from "../../src/auth/sessionExpiry";
import { ALL_ROLES } from "../helpers/authMock";
import { installFakeApi, makeSession, storeSignedIn, storedSession } from "../helpers/fakeApi";

let api;

function renderAppAt(path) {
  window.history.pushState({}, "", path);
  return render(<App />);
}

const here = () => window.location.pathname;
const notice = () => screen.queryByText(SESSION_EXPIRED_MESSAGE);

beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  api = installFakeApi({ "*": { status: 401, data: { error: "Your session is no longer valid" } } });
});

afterEach(() => {
  api.restore();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("SCRUM583_AC1_AC5 an expired session ends on the login page with one message, for every role", () => {
  it.each(ALL_ROLES)("SCRUM583_AC5_%s_is_sent_to_login_with_the_message", async (role) => {
    storeSignedIn({ role });

    renderAppAt("/dashboard");

    await waitFor(() => expect(here()).toBe("/login"));
    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
    expect(screen.getAllByText(SESSION_EXPIRED_MESSAGE)).toHaveLength(1);
    expect(storedSession()).toBeNull();
  });

  it("SCRUM583_AC1_no_screen_adds_its_own_expiry_wording", async () => {
    storeSignedIn({ role: "event_coordinator" });

    renderAppAt("/dashboard");

    await waitFor(() => expect(here()).toBe("/login"));
    expect(screen.queryByText(/session has expired/i)).toBeNull();
    expect(screen.queryByText(/sign in again to/i)).toBeNull();
    expect(document.body.textContent.match(/sign in again/gi)).toHaveLength(1);
  });

  it("SCRUM583_AC1_the_message_is_a_status_notice_not_an_error", async () => {
    storeSignedIn({ role: "attendee" });

    renderAppAt("/dashboard");

    const shown = await screen.findByText(SESSION_EXPIRED_MESSAGE);
    expect(shown).toHaveAttribute("role", "status");
  });

  it("SCRUM583_AC1_a_screen_that_is_not_protected_is_left_for_the_login_page_too", async () => {
    storeSignedIn({ role: "attendee" });
    api.set({ "*": { status: 200 } });
    renderAppAt("/unauthorized");
    expect(here()).toBe("/unauthorized");

    api.set({ "GET /anything": { status: 401 } });
    await act(async () => {
      await apiClient.get("/anything").catch(() => {});
    });

    await waitFor(() => expect(here()).toBe("/login"));
    expect(notice()).toBeInTheDocument();
  });

  it("SCRUM583_AC1_a_deep_link_to_a_protected_screen_also_ends_on_login", async () => {
    storeSignedIn({ role: "venue_staff" });

    renderAppAt("/venue-catalogue");

    await waitFor(() => expect(here()).toBe("/login"));
    expect(notice()).toBeInTheDocument();
  });

  it("SCRUM583_AC1_a_visitor_who_was_never_signed_in_sees_no_expiry_message", async () => {
    renderAppAt("/dashboard");

    await waitFor(() => expect(here()).toBe("/login"));
    expect(notice()).toBeNull();
  });

  it("SCRUM583_AC1_a_403_does_not_sign_the_user_out", async () => {
    storeSignedIn({ role: "attendee" });
    api.set({ "*": { status: 403, data: { error: "Forbidden" } } });

    renderAppAt("/dashboard");
    await screen.findByRole("navigation");

    expect(here()).toBe("/dashboard");
    expect(notice()).toBeNull();
    expect(storedSession()).not.toBeNull();
  });
});

describe("SCRUM583_AC1 the login page after an expiry", () => {
  async function expireThenShowLogin() {
    storeSignedIn({ role: "event_organiser" });
    renderAppAt("/dashboard");
    await waitFor(() => expect(here()).toBe("/login"));
    await screen.findByText(SESSION_EXPIRED_MESSAGE);
  }

  it("SCRUM583_AC1_a_wrong_password_shows_the_login_error_and_nothing_else_changes", async () => {
    await expireThenShowLogin();
    api.set({ "POST /auth/login": { status: 401, data: { error: "Invalid email or password" } } });

    await userEvent.type(screen.getByLabelText("Email"), "a@b.com");
    await userEvent.type(screen.getByLabelText("Password"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
    expect(here()).toBe("/login");
  });

  it("SCRUM583_AC1_a_wrong_password_on_a_fresh_visit_shows_only_the_login_error", async () => {
    renderAppAt("/login");
    api.set({ "POST /auth/login": { status: 401, data: { error: "Invalid email or password" } } });

    await userEvent.type(screen.getByLabelText("Email"), "a@b.com");
    await userEvent.type(screen.getByLabelText("Password"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
    expect(notice()).toBeNull();
  });

  it("SCRUM583_AC4_signing_in_again_works_and_the_message_is_gone", async () => {
    await expireThenShowLogin();
    api.set({
      "*": { status: 200, data: [] },
      "POST /auth/login": {
        status: 200,
        data: {
          user: { id: "u9", email: "again@connectsphere.com", role: "attendee" },
          session: makeSession({ access: "fresh", refresh: "fresh-r" }),
        },
      },
    });

    await userEvent.type(screen.getByLabelText("Email"), "again@connectsphere.com");
    await userEvent.type(screen.getByLabelText("Password"), "right");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));

    await waitFor(() => expect(here()).not.toBe("/login"));
    expect(notice()).toBeNull();
    expect(storedSession().session.access_token).toBe("fresh");
  });

  it("SCRUM583_AC4_the_signed_back_in_user_is_not_signed_out_by_a_straggling_request_from_before", async () => {
    storeSignedIn({ role: "event_organiser", session: makeSession({ access: "old-token" }) });
    let release;
    api.set({
      "*": { status: 200, data: [] },
      "GET /straggler": () => new Promise((resolve) => { release = () => resolve({ status: 401 }); }),
      "POST /auth/login": {
        status: 200,
        data: {
          user: { id: "u9", email: "again@connectsphere.com", role: "attendee" },
          session: makeSession({ access: "fresh", refresh: "fresh-r" }),
        },
      },
    });
    renderAppAt("/login");
    const straggler = apiClient.get("/straggler").catch(() => {});

    await userEvent.type(screen.getByLabelText("Email"), "again@connectsphere.com");
    await userEvent.type(screen.getByLabelText("Password"), "right");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => expect(storedSession()?.session.access_token).toBe("fresh"));
    await act(async () => {
      release();
      await straggler;
    });

    expect(storedSession().session.access_token).toBe("fresh");
    expect(notice()).toBeNull();
  });

  it("SCRUM583_AC1_the_message_stays_until_the_user_signs_in_not_just_for_a_moment", async () => {
    await expireThenShowLogin();

    await new Promise((resolve) => setTimeout(resolve, 4000));

    expect(notice()).toBeInTheDocument();
  }, 10000);

  it("SCRUM583_AC1_the_notice_sits_inside_the_login_form", async () => {
    await expireThenShowLogin();

    const form = screen.getByRole("heading", { name: "Log in" }).closest("form");

    expect(within(form).getByText(SESSION_EXPIRED_MESSAGE)).toBeInTheDocument();
  });
});
