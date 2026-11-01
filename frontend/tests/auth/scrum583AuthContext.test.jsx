// scrum583AuthContext.test.jsx
//
// SCRUM-583 AC1, AC2, AC4 against the REAL AuthProvider and the REAL apiClient,
// with only the network replaced: what a refused request, a renewal, a logout and
// a login each do to the stored session, to React state, and to the message the
// login page shows.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useEffect } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";

import { AuthProvider, useAuth } from "../../src/auth/AuthContext";
import { apiClient } from "../../src/services/apiClient";
import { SESSION_EXPIRED_MESSAGE } from "../../src/auth/sessionExpiry";
import { deferred } from "../helpers/async";
import { installFakeApi, makeSession, storeSignedIn, storedSession, STORAGE_KEY } from "../helpers/fakeApi";

let api;
// The latest context value, written by Probe on every render.
const latestAuth = { current: null };
const auth = new Proxy({}, { get: (_target, key) => latestAuth.current[key] });

function Probe() {
  const ctx = useAuth();
  // Published after render: the tests read the latest context through `auth`.
  useEffect(() => {
    latestAuth.current = ctx;
  });
  return (
    <div>
      <p data-testid="user">{ctx.user ? ctx.user.email : "nobody"}</p>
      <p data-testid="token">{ctx.session?.access_token ?? "none"}</p>
      <p data-testid="expired">{ctx.sessionExpiredMessage ?? "none"}</p>
      <p data-testid="logout">{ctx.logoutMessage ?? "none"}</p>
    </div>
  );
}

function renderProvider() {
  return render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
}

const text = (id) => screen.getByTestId(id).textContent;

const LOGIN_OK = (role = "event_organiser", session = makeSession({ access: "login-token", refresh: "login-refresh" })) => ({
  status: 200,
  data: { user: { id: "u1", email: `${role}@connectsphere.com`, role }, session },
});

beforeEach(() => {
  sessionStorage.clear();
  api = installFakeApi();
});

afterEach(() => {
  api.restore();
  sessionStorage.clear();
});

describe("SCRUM583_AC1 any request refused for an expired session ends the session once", () => {
  it("SCRUM583_AC1_a_refused_request_clears_storage_and_state_and_sets_the_message", async () => {
    storeSignedIn({ session: makeSession({ access: "tok" }) });
    api.set({ "GET /venues": { status: 401, data: { error: "Your session is no longer valid" } } });
    renderProvider();
    await waitFor(() => expect(text("user")).not.toBe("nobody"));

    await act(async () => {
      await apiClient.get("/venues").catch(() => {});
    });

    expect(storedSession()).toBeNull();
    expect(text("user")).toBe("nobody");
    expect(text("token")).toBe("none");
    expect(text("expired")).toBe(SESSION_EXPIRED_MESSAGE);
  });

  it("SCRUM583_AC1_the_message_is_exactly_the_one_in_the_story", () => {
    expect(SESSION_EXPIRED_MESSAGE).toBe("Your session expired. Please sign in again.");
  });

  it("SCRUM583_AC1_five_requests_refused_together_end_the_session_once_not_five_times", async () => {
    storeSignedIn();
    api.set({ "*": { status: 401 } });
    renderProvider();
    await waitFor(() => expect(text("user")).not.toBe("nobody"));

    await act(async () => {
      await Promise.all(["/a", "/b", "/c", "/d", "/e"].map((u) => apiClient.get(u).catch(() => {})));
    });

    expect(text("expired")).toBe(SESSION_EXPIRED_MESSAGE);
    expect(storedSession()).toBeNull();
  });

  it("SCRUM583_AC1_a_refusal_for_a_non_expiry_status_leaves_the_user_signed_in", async () => {
    storeSignedIn();
    api.set({ "GET /venues": { status: 403 } });
    renderProvider();
    await waitFor(() => expect(text("user")).not.toBe("nobody"));

    await act(async () => {
      await apiClient.get("/venues").catch(() => {});
    });

    expect(text("user")).not.toBe("nobody");
    expect(text("expired")).toBe("none");
    expect(storedSession()).not.toBeNull();
  });

  it("SCRUM583_AC1_expireSession_called_with_nobody_signed_in_does_nothing", async () => {
    renderProvider();
    await waitFor(() => expect(auth.loading).toBe(false));

    act(() => auth.expireSession());

    expect(text("expired")).toBe("none");
  });

  it("SCRUM583_AC1_a_refusal_from_a_session_that_is_no_longer_current_is_ignored", async () => {
    storeSignedIn({ session: makeSession({ access: "old" }) });
    api.set({
      "GET /slow": async () => {
        storeSignedIn({ session: makeSession({ access: "new" }) });
        return { status: 401 };
      },
    });
    renderProvider();
    await waitFor(() => expect(text("user")).not.toBe("nobody"));

    await act(async () => {
      await apiClient.get("/slow").catch(() => {});
    });

    expect(storedSession().session.access_token).toBe("new");
    expect(text("expired")).toBe("none");
  });

  it("SCRUM583_AC1_a_stale_report_that_slips_past_the_interceptor_is_still_ignored", async () => {
    storeSignedIn({ session: makeSession({ access: "current" }) });
    renderProvider();
    await waitFor(() => expect(text("user")).not.toBe("nobody"));

    const { reportSessionRefused } = await import("../../src/auth/sessionExpiry");
    act(() => reportSessionRefused("some-other-token"));

    expect(text("expired")).toBe("none");
    expect(storedSession()).not.toBeNull();
  });

  it("SCRUM583_AC1_the_provider_stops_listening_when_it_unmounts", async () => {
    storeSignedIn({ session: makeSession({ access: "tok" }) });
    api.set({ "GET /venues": { status: 401 } });
    const view = renderProvider();
    await waitFor(() => expect(text("user")).not.toBe("nobody"));
    view.unmount();

    await apiClient.get("/venues").catch(() => {});

    // Nothing mounted to clear it: storage is untouched, and nothing threw.
    expect(storedSession()).not.toBeNull();
  });
});

describe("SCRUM583_AC1 a wrong password on the login page is unaffected", () => {
  it("SCRUM583_AC1_a_wrong_password_returns_the_login_error_and_sets_no_expiry_message", async () => {
    api.set({ "POST /auth/login": { status: 401, data: { error: "Invalid email or password" } } });
    renderProvider();
    await waitFor(() => expect(auth.loading).toBe(false));

    let result;
    await act(async () => {
      result = await auth.login("a@b.com", "wrong");
    });

    expect(result).toEqual({ success: false, error: "Invalid email or password" });
    expect(text("expired")).toBe("none");
    expect(storedSession()).toBeNull();
  });

  it("SCRUM583_AC1_a_wrong_password_while_an_expiry_message_is_showing_keeps_that_message", async () => {
    storeSignedIn();
    api.set({ "GET /venues": { status: 401 }, "POST /auth/login": { status: 401 } });
    renderProvider();
    await waitFor(() => expect(text("user")).not.toBe("nobody"));
    await act(async () => {
      await apiClient.get("/venues").catch(() => {});
    });

    await act(async () => {
      await auth.login("a@b.com", "wrong");
    });

    expect(text("expired")).toBe(SESSION_EXPIRED_MESSAGE);
  });

  it.each([
    [400, "Email and password are required"],
    [500, "Unable to retrieve user role"],
    [503, "Unable to log in right now. Please try again."],
  ])("SCRUM583_AC1_login_%i_is_worded_as_before", async (status, message) => {
    api.set({ "POST /auth/login": { status } });
    renderProvider();
    await waitFor(() => expect(auth.loading).toBe(false));

    let result;
    await act(async () => {
      result = await auth.login("a@b.com", "x");
    });

    expect(result.error).toBe(message);
  });
});

describe("SCRUM583_AC4 signing in and out", () => {
  it("SCRUM583_AC4_signing_in_after_an_expiry_works_and_clears_the_message", async () => {
    storeSignedIn();
    api.set({ "GET /venues": { status: 401 }, "POST /auth/login": LOGIN_OK("venue_staff") });
    renderProvider();
    await waitFor(() => expect(text("user")).not.toBe("nobody"));
    await act(async () => {
      await apiClient.get("/venues").catch(() => {});
    });
    expect(text("expired")).toBe(SESSION_EXPIRED_MESSAGE);

    let result;
    await act(async () => {
      result = await auth.login("venue_staff@connectsphere.com", "pw");
    });

    expect(result.success).toBe(true);
    expect(text("expired")).toBe("none");
    expect(text("user")).toBe("venue_staff@connectsphere.com");
    expect(storedSession().session.access_token).toBe("login-token");
  });

  it("SCRUM583_AC4_a_session_signed_in_after_an_expiry_is_not_signed_out_by_the_old_one", async () => {
    storeSignedIn({ session: makeSession({ access: "old" }) });
    api.set({ "POST /auth/login": LOGIN_OK(), "GET /venues": { status: 200 } });
    renderProvider();
    await waitFor(() => expect(text("user")).not.toBe("nobody"));
    await act(async () => {
      await auth.login("a@b.com", "pw");
    });

    await act(async () => {
      await apiClient.get("/venues");
    });

    expect(text("user")).not.toBe("nobody");
    expect(api.callsTo("GET /venues")[0].authorization).toBe("Bearer login-token");
  });

  it("SCRUM583_AC4_logout_clears_the_stored_session_and_says_so", async () => {
    storeSignedIn({ session: makeSession({ access: "tok" }) });
    api.set({ "POST /auth/logout": { status: 200, data: { message: "Logged out successfully" } } });
    renderProvider();
    await waitFor(() => expect(text("user")).not.toBe("nobody"));

    let result;
    await act(async () => {
      result = await auth.logout();
    });

    expect(result).toEqual({ success: true, message: "Logged out successfully" });
    expect(storedSession()).toBeNull();
    expect(text("user")).toBe("nobody");
    expect(text("logout")).toBe("Logged out successfully");
    expect(text("expired")).toBe("none");
    expect(api.callsTo("POST /auth/logout")[0].authorization).toBe("Bearer tok");
  });

  it("SCRUM583_AC4_logging_out_a_session_the_server_already_dropped_still_signs_out", async () => {
    storeSignedIn();
    api.set({ "POST /auth/logout": { status: 401, data: { error: "No active session" } } });
    renderProvider();
    await waitFor(() => expect(text("user")).not.toBe("nobody"));

    let result;
    await act(async () => {
      result = await auth.logout();
    });

    expect(result.success).toBe(true);
    expect(storedSession()).toBeNull();
    expect(text("user")).toBe("nobody");
    // A deliberate log out is not an expiry: no expiry message.
    expect(text("expired")).toBe("none");
  });

  it.each([
    [500, "Failed to log out"],
    [502, "We could not log you out. Please try again."],
  ])("SCRUM583_AC4_a_logout_the_server_failed_%i_keeps_the_user_signed_in", async (status, message) => {
    storeSignedIn();
    api.set({ "POST /auth/logout": { status } });
    renderProvider();
    await waitFor(() => expect(text("user")).not.toBe("nobody"));

    let result;
    await act(async () => {
      result = await auth.logout();
    });

    expect(result).toEqual({ success: false, error: message });
    expect(storedSession()).not.toBeNull();
    expect(text("user")).not.toBe("nobody");
  });

  it("SCRUM583_AC4_logging_out_clears_a_leftover_expiry_message", async () => {
    storeSignedIn();
    api.set({ "GET /venues": { status: 401 }, "POST /auth/login": LOGIN_OK(), "POST /auth/logout": { status: 200 } });
    renderProvider();
    await waitFor(() => expect(text("user")).not.toBe("nobody"));
    await act(async () => {
      await apiClient.get("/venues").catch(() => {});
    });
    await act(async () => {
      await auth.login("a@b.com", "pw");
    });
    await act(async () => {
      await auth.logout();
    });

    expect(text("expired")).toBe("none");
  });

  it("SCRUM583_AC4_an_expiry_clears_a_leftover_logged_out_message", async () => {
    storeSignedIn();
    api.set({ "POST /auth/logout": { status: 200 }, "POST /auth/login": LOGIN_OK(), "GET /venues": { status: 401 } });
    renderProvider();
    await waitFor(() => expect(text("user")).not.toBe("nobody"));
    await act(async () => {
      await auth.logout();
    });
    await act(async () => {
      await auth.login("a@b.com", "pw");
    });
    expect(text("logout")).toBe("none");

    await act(async () => {
      await apiClient.get("/venues").catch(() => {});
    });

    expect(text("logout")).toBe("none");
    expect(text("expired")).toBe(SESSION_EXPIRED_MESSAGE);
  });

  it("SCRUM583_AC4_logging_out_with_nobody_signed_in_still_finishes_cleanly", async () => {
    api.set({ "POST /auth/logout": { status: 401 } });
    renderProvider();
    await waitFor(() => expect(auth.loading).toBe(false));

    let result;
    await act(async () => {
      result = await auth.logout();
    });

    expect(result.success).toBe(true);
    expect(api.callsTo("POST /auth/logout")[0].authorization).toBeUndefined();
  });

  it("SCRUM583_AC4_a_page_reload_restores_a_stored_session", async () => {
    storeSignedIn({ role: "attendee" });

    renderProvider();

    await waitFor(() => expect(text("user")).toBe("attendee@connectsphere.com"));
  });

  it("SCRUM583_AC4_a_corrupt_stored_session_is_discarded_on_load", async () => {
    sessionStorage.setItem(STORAGE_KEY, "{broken");

    renderProvider();

    await waitFor(() => expect(auth.loading).toBe(false));
    expect(text("user")).toBe("nobody");
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("SCRUM583_AC4_clearLogoutMessage_clears_it", async () => {
    storeSignedIn();
    api.set({ "POST /auth/logout": { status: 200 } });
    renderProvider();
    await waitFor(() => expect(text("user")).not.toBe("nobody"));
    await act(async () => {
      await auth.logout();
    });
    expect(text("logout")).toBe("Logged out successfully");

    act(() => auth.clearLogoutMessage());

    expect(text("logout")).toBe("none");
  });

  it("SCRUM583_useAuth_outside_a_provider_throws", () => {
    function Bare() {
      useAuth();
      return null;
    }
    const spy = console.error;
    console.error = () => {};
    try {
      expect(() => render(<Bare />)).toThrow("useAuth must be used within an AuthProvider");
    } finally {
      console.error = spy;
    }
  });
});

describe("SCRUM583_AC2 renewing the session", () => {
  async function signedInProvider(session = makeSession({ access: "a1", refresh: "r1" }), role = "event_organiser") {
    storeSignedIn({ session, role });
    renderProvider();
    await waitFor(() => expect(text("user")).not.toBe("nobody"));
  }

  it("SCRUM583_AC2_a_renewal_stores_the_new_session_and_keeps_the_user_and_role", async () => {
    await signedInProvider(undefined, "safety_officer");
    const next = makeSession({ access: "a2", refresh: "r2" });
    api.set({ "POST /auth/refresh": { status: 200, data: { session: next } } });

    let outcome;
    await act(async () => {
      outcome = await auth.renewSession();
    });

    expect(outcome).toBe("renewed");
    expect(storedSession().session).toEqual(next);
    expect(storedSession().user.role).toBe("safety_officer");
    expect(text("token")).toBe("a2");
    expect(api.callsTo("POST /auth/refresh")[0].body).toEqual({ refresh_token: "r1" });
  });

  it("SCRUM583_AC2_after_a_renewal_requests_go_out_with_the_new_token", async () => {
    await signedInProvider();
    api.set({
      "POST /auth/refresh": { status: 200, data: { session: makeSession({ access: "a2", refresh: "r2" }) } },
      "GET /venues": { status: 200 },
    });
    await act(async () => {
      await auth.renewSession();
    });

    await apiClient.get("/venues");

    expect(api.callsTo("GET /venues")[0].authorization).toBe("Bearer a2");
  });

  it("SCRUM583_AC2_renewals_arriving_together_share_one_request", async () => {
    await signedInProvider();
    const gate = deferred();
    api.set({ "POST /auth/refresh": () => gate.promise });

    let first;
    let second;
    act(() => {
      first = auth.renewSession();
      second = auth.renewSession();
    });
    expect(first).toBe(second);
    gate.resolve({ status: 200, data: { session: makeSession({ access: "a2", refresh: "r2" }) } });
    await act(async () => {
      await first;
    });

    expect(api.callsTo("POST /auth/refresh")).toHaveLength(1);
  });

  it("SCRUM583_AC2_a_renewal_after_the_first_has_finished_makes_a_new_request", async () => {
    await signedInProvider();
    api.set({
      "POST /auth/refresh": (call) => ({
        status: 200,
        data: { session: makeSession({ access: `a-${call.body.refresh_token}`, refresh: `${call.body.refresh_token}+` }) },
      }),
    });

    await act(async () => {
      await auth.renewSession();
    });
    await act(async () => {
      await auth.renewSession();
    });

    expect(api.callsTo("POST /auth/refresh").map((c) => c.body.refresh_token)).toEqual(["r1", "r1+"]);
  });

  it.each([400, 401])("SCRUM583_AC2_a_%i_from_refresh_ends_the_session_with_the_expiry_message", async (status) => {
    await signedInProvider();
    api.set({ "POST /auth/refresh": { status, data: { error: "Your session is no longer valid" } } });

    let outcome;
    await act(async () => {
      outcome = await auth.renewSession();
    });

    expect(outcome).toBe("expired");
    expect(storedSession()).toBeNull();
    expect(text("expired")).toBe(SESSION_EXPIRED_MESSAGE);
  });

  it.each([
    ["503", { status: 503 }],
    ["500", { status: 500 }],
    ["429", { status: 429 }],
    ["a dropped connection", { network: true }],
  ])("SCRUM583_AC2_%s_from_refresh_keeps_the_session_and_says_unavailable", async (_label, answer) => {
    await signedInProvider();
    api.set({ "POST /auth/refresh": answer });

    let outcome;
    await act(async () => {
      outcome = await auth.renewSession();
    });

    expect(outcome).toBe("unavailable");
    expect(storedSession().session.access_token).toBe("a1");
    expect(text("user")).not.toBe("nobody");
    expect(text("expired")).toBe("none");
  });

  it("SCRUM583_AC2_with_no_refresh_token_stored_the_session_is_over", async () => {
    await signedInProvider({ access_token: "a1", expires_at: 9_999_999_999 });

    let outcome;
    await act(async () => {
      outcome = await auth.renewSession();
    });

    expect(outcome).toBe("expired");
    expect(text("expired")).toBe(SESSION_EXPIRED_MESSAGE);
    expect(api.callsTo("POST /auth/refresh")).toHaveLength(0);
  });

  it.each([
    ["no session", {}],
    ["a session with no access token", { session: { refresh_token: "r2" } }],
    ["a session with no refresh token", { session: { access_token: "a2" } }],
  ])("SCRUM583_AC2_a_refresh_answer_with_%s_ends_the_session", async (_label, data) => {
    await signedInProvider();
    api.set({ "POST /auth/refresh": { status: 200, data } });

    let outcome;
    await act(async () => {
      outcome = await auth.renewSession();
    });

    expect(outcome).toBe("expired");
    expect(storedSession()).toBeNull();
  });

  it("SCRUM583_AC2_an_unreadable_stored_session_cannot_be_renewed_and_ends_the_session", async () => {
    await signedInProvider();
    sessionStorage.setItem(STORAGE_KEY, "{broken");

    let outcome;
    await act(async () => {
      outcome = await auth.renewSession();
    });

    expect(outcome).toBe("expired");
    expect(text("user")).toBe("nobody");
    expect(text("expired")).toBe(SESSION_EXPIRED_MESSAGE);
    expect(api.callsTo("POST /auth/refresh")).toHaveLength(0);
  });

  it("SCRUM583_AC2_a_user_who_logs_out_while_a_renewal_is_out_is_not_signed_back_in", async () => {
    await signedInProvider();
    const gate = deferred();
    api.set({ "POST /auth/refresh": () => gate.promise, "POST /auth/logout": { status: 200 } });

    let pending;
    act(() => {
      pending = auth.renewSession();
    });
    await act(async () => {
      await auth.logout();
    });
    gate.resolve({ status: 200, data: { session: makeSession({ access: "a2", refresh: "r2" }) } });
    let outcome;
    await act(async () => {
      outcome = await pending;
    });

    expect(outcome).toBe("ended");
    expect(storedSession()).toBeNull();
    expect(text("user")).toBe("nobody");
  });

  it("SCRUM583_AC2_a_different_user_signing_in_while_a_renewal_is_out_keeps_their_own_session", async () => {
    await signedInProvider();
    const gate = deferred();
    api.set({ "POST /auth/refresh": () => gate.promise, "POST /auth/login": LOGIN_OK("venue_staff") });

    let pending;
    act(() => {
      pending = auth.renewSession();
    });
    await act(async () => {
      await auth.login("v@b.com", "pw");
    });
    gate.resolve({ status: 200, data: { session: makeSession({ access: "a2", refresh: "r2" }) } });
    let outcome;
    await act(async () => {
      outcome = await pending;
    });

    expect(outcome).toBe("ended");
    expect(storedSession().session.access_token).toBe("login-token");
    expect(text("user")).toBe("venue_staff@connectsphere.com");
  });

  it("SCRUM583_AC2_a_refused_renewal_for_a_session_already_replaced_does_not_sign_out_the_new_one", async () => {
    await signedInProvider();
    const gate = deferred();
    api.set({ "POST /auth/refresh": () => gate.promise, "POST /auth/login": LOGIN_OK("venue_staff") });

    let pending;
    act(() => {
      pending = auth.renewSession();
    });
    await act(async () => {
      await auth.login("v@b.com", "pw");
    });
    gate.resolve({ status: 401 });
    let outcome;
    await act(async () => {
      outcome = await pending;
    });

    expect(outcome).toBe("ended");
    expect(text("user")).toBe("venue_staff@connectsphere.com");
    expect(text("expired")).toBe("none");
  });
});

describe("SCRUM583_AC3 ending an idle session", () => {
  it("SCRUM583_AC3_endIdleSession_signs_out_with_the_expiry_message_and_tells_the_server", async () => {
    storeSignedIn({ session: makeSession({ access: "tok-idle" }) });
    api.set({ "POST /auth/logout": { status: 200 } });
    renderProvider();
    await waitFor(() => expect(text("user")).not.toBe("nobody"));

    act(() => auth.endIdleSession());

    expect(storedSession()).toBeNull();
    expect(text("user")).toBe("nobody");
    expect(text("expired")).toBe(SESSION_EXPIRED_MESSAGE);
    await waitFor(() => expect(api.callsTo("POST /auth/logout")).toHaveLength(1));
    expect(api.callsTo("POST /auth/logout")[0].authorization).toBe("Bearer tok-idle");
  });

  it("SCRUM583_AC3_the_user_is_signed_out_even_if_the_server_cannot_be_told", async () => {
    storeSignedIn();
    api.set({ "POST /auth/logout": { network: true } });
    renderProvider();
    await waitFor(() => expect(text("user")).not.toBe("nobody"));

    act(() => auth.endIdleSession());

    expect(text("expired")).toBe(SESSION_EXPIRED_MESSAGE);
    await waitFor(() => expect(api.callsTo("POST /auth/logout")).toHaveLength(1));
    expect(storedSession()).toBeNull();
  });

  it("SCRUM583_AC3_with_nothing_stored_it_makes_no_request_and_shows_no_message", async () => {
    renderProvider();
    await waitFor(() => expect(auth.loading).toBe(false));

    act(() => auth.endIdleSession());

    expect(api.calls).toHaveLength(0);
    expect(text("expired")).toBe("none");
  });
});
