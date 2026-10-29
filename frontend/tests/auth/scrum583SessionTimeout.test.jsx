// scrum583SessionTimeout.test.jsx
//
// SCRUM-583 AC2 and AC3 against the real AuthProvider, the real apiClient and a
// fake clock: an active user's session is renewed before it ends, an idle user
// is asked "Are you still there?" after 30 minutes, and a user who does not
// answer within 15 minutes is signed out with the expiry message.
//
// The clock is Vitest's fake one (Date included), so "29 minutes 59 seconds" and
// "30 minutes" are the real boundaries, not approximations.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { AuthProvider, useAuth } from "../../src/auth/AuthContext";
import SessionTimeout from "../../src/auth/SessionTimeout";
import {
  ANSWER_LIMIT_MS,
  IDLE_LIMIT_MS,
  RENEW_BEFORE_MS,
  RENEW_RETRY_MS,
  SESSION_EXPIRED_MESSAGE,
  formatRemaining,
  renewalMargin,
} from "../../src/auth/sessionExpiry";
import { deferred } from "../helpers/async";
import { installFakeApi, makeSession, storeSignedIn, storedSession } from "../helpers/fakeApi";

const SEC = 1000;
const MIN = 60 * SEC;

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
      <p data-testid="expired">{ctx.sessionExpiredMessage ?? "none"}</p>
      <p data-testid="logout">{ctx.logoutMessage ?? "none"}</p>
      <button type="button">page button</button>
    </div>
  );
}

async function mount({ session, role, id } = {}) {
  storeSignedIn({ session: session ?? makeSession({ now: Date.now() }), role, id });
  render(
    <AuthProvider>
      <Probe />
      <SessionTimeout />
    </AuthProvider>,
  );
  await advance(0);
}

/**
 * Moves the fake clock, letting React and the promises it starts settle.
 *
 * In small steps, each in its own act(): React holds back renders until an
 * act() scope ends, so one long act would let the clock run a whole hour on a
 * session that React had not yet been told was renewed. In a browser a render
 * follows its state change at once; the steps make the test do the same.
 */
async function advance(ms) {
  let left = ms;
  do {
    const step = Math.min(left, 5 * SEC);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(step);
    });
    left -= step;
  } while (left > 0);
}

const popup = () => screen.queryByRole("alertdialog");
const text = (id) => screen.getByTestId(id).textContent;
const refreshCalls = () => api.callsTo("POST /auth/refresh");

/** A refresh that hands back a fresh session each time, with its own tokens. */
function refreshIssuesNewSessions(lifetimeSeconds = 3600) {
  let n = 1;
  return () => {
    n += 1;
    return {
      status: 200,
      data: { session: makeSession({ access: `a${n}`, refresh: `r${n}`, lifetimeSeconds, now: Date.now() }) },
    };
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-02T09:00:00Z"));
  sessionStorage.clear();
  api = installFakeApi({
    "POST /auth/refresh": refreshIssuesNewSessions(),
    "POST /auth/logout": { status: 200, data: { message: "Logged out successfully" } },
  });
});

afterEach(() => {
  api.restore();
  sessionStorage.clear();
  vi.useRealTimers();
});

describe("SCRUM583_AC3 the numbers", () => {
  it("SCRUM583_AC3_idle_is_30_minutes_and_the_answer_window_is_15", () => {
    expect(IDLE_LIMIT_MS).toBe(30 * MIN);
    expect(ANSWER_LIMIT_MS).toBe(15 * MIN);
  });
});

describe("SCRUM583_AC3 after 30 minutes without activity a popup asks 'Are you still there?'", () => {
  it("SCRUM583_AC3_nothing_is_shown_to_a_signed_out_visitor_however_long_they_wait", async () => {
    render(
      <AuthProvider>
        <Probe />
        <SessionTimeout />
      </AuthProvider>,
    );

    await advance(3 * 60 * MIN);

    expect(popup()).toBeNull();
    expect(api.calls).toHaveLength(0);
  });

  it("SCRUM583_AC3_no_popup_one_second_before_30_minutes", async () => {
    await mount();

    await advance(IDLE_LIMIT_MS - SEC);

    expect(popup()).toBeNull();
  });

  it("SCRUM583_AC3_the_popup_appears_at_exactly_30_minutes", async () => {
    await mount();

    await advance(IDLE_LIMIT_MS);

    expect(popup()).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Are you still there?" })).toBeInTheDocument();
  });

  it("SCRUM583_AC3_the_popup_offers_Yes_and_Log_out", async () => {
    await mount();
    await advance(IDLE_LIMIT_MS);

    expect(screen.getByRole("button", { name: /yes/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Log out" })).toBeEnabled();
  });

  it("SCRUM583_AC3_the_popup_is_a_modal_dialog_named_by_its_question", async () => {
    await mount();
    await advance(IDLE_LIMIT_MS);

    const dialog = screen.getByRole("alertdialog", { name: "Are you still there?" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription(/signed out in 15:00/);
  });

  it.each([
    ["a mouse press", () => fireEvent.pointerDown(document.body)],
    ["a mouse move", () => fireEvent.mouseMove(document.body)],
    ["a key press", () => fireEvent.keyDown(document.body, { key: "a" })],
    ["a scroll", () => fireEvent.scroll(window)],
    ["a touch", () => fireEvent.touchStart(document.body)],
    ["a wheel turn", () => fireEvent.wheel(document.body)],
  ])("SCRUM583_AC3_%s_restarts_the_30_minutes", async (_label, act_) => {
    await mount();
    await advance(29 * MIN);

    act_();
    await advance(29 * MIN);

    expect(popup()).toBeNull();
    await advance(MIN);
    expect(popup()).toBeInTheDocument();
  });

  it("SCRUM583_AC3_activity_reaches_the_clock_even_when_a_handler_stops_propagation", async () => {
    await mount();
    await advance(29 * MIN);
    const stopper = (e) => e.stopPropagation();
    document.body.addEventListener("keydown", stopper);

    fireEvent.keyDown(document.body, { key: "a" });
    document.body.removeEventListener("keydown", stopper);
    await advance(29 * MIN);

    expect(popup()).toBeNull();
  });

  it("SCRUM583_AC3_steady_activity_means_no_popup_ever", async () => {
    await mount({ session: makeSession({ lifetimeSeconds: 24 * 3600, now: Date.now() }) });

    for (let i = 0; i < 20; i += 1) {
      await advance(10 * MIN);
      fireEvent.mouseMove(document.body);
    }

    expect(popup()).toBeNull();
  });

  it("SCRUM583_AC3_the_popup_counts_down_from_15_minutes", async () => {
    await mount();
    await advance(IDLE_LIMIT_MS);
    expect(screen.getByText("15:00")).toBeInTheDocument();

    await advance(90 * SEC);

    expect(screen.getByText("13:30")).toBeInTheDocument();
  });

  it("SCRUM583_AC3_moving_the_mouse_to_reach_a_button_does_not_answer_for_the_user", async () => {
    await mount();
    await advance(IDLE_LIMIT_MS);

    fireEvent.mouseMove(document.body);
    fireEvent.keyDown(document.body, { key: "a" });
    fireEvent.pointerDown(document.body);
    await advance(5 * MIN);

    expect(popup()).toBeInTheDocument();
    expect(screen.getByText("10:00")).toBeInTheDocument();
  });

  it("SCRUM583_AC3_Escape_does_not_dismiss_the_popup", async () => {
    await mount();
    await advance(IDLE_LIMIT_MS);

    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });

    expect(popup()).toBeInTheDocument();
  });

  it("SCRUM583_AC3_background_activity_requests_do_not_count_as_the_user_being_active", async () => {
    await mount({ session: makeSession({ lifetimeSeconds: 24 * 3600, now: Date.now() }) });
    api.set({ "GET /poll": { status: 200 } });

    for (let i = 0; i < 6; i += 1) {
      await advance(5 * MIN);
      await act(async () => {
        const { apiClient } = await import("../../src/services/apiClient");
        await apiClient.get("/poll");
      });
    }

    expect(popup()).toBeInTheDocument();
  });

  it("SCRUM583_AC3_a_tab_that_slept_past_30_minutes_asks_the_moment_it_wakes", async () => {
    await mount({ session: makeSession({ lifetimeSeconds: 24 * 3600, now: Date.now() }) });

    // The laptop sleeps: the clock jumps and no interval fires.
    vi.setSystemTime(Date.now() + 40 * MIN);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(popup()).toBeInTheDocument();
    // 10 of the 15 minutes were already used up while it slept.
    expect(screen.getByText("5:00")).toBeInTheDocument();
  });
});

describe("SCRUM583_AC3 Yes extends the session", () => {
  it("SCRUM583_AC3_Yes_renews_the_session_and_closes_the_popup", async () => {
    await mount();
    await advance(IDLE_LIMIT_MS);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes/i }));
    });
    await advance(0);

    expect(popup()).toBeNull();
    expect(refreshCalls()).toHaveLength(1);
    expect(storedSession().session.access_token).toBe("a2");
    expect(text("user")).not.toBe("nobody");
  });

  it("SCRUM583_AC3_after_Yes_the_30_minutes_start_again", async () => {
    await mount({ session: makeSession({ lifetimeSeconds: 24 * 3600, now: Date.now() }) });
    await advance(IDLE_LIMIT_MS + 5 * MIN);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes/i }));
    });
    await advance(0);

    await advance(IDLE_LIMIT_MS - SEC);
    expect(popup()).toBeNull();

    await advance(SEC);
    expect(popup()).toBeInTheDocument();
    expect(screen.getByText("15:00")).toBeInTheDocument();
  });

  it("SCRUM583_AC3_Yes_just_before_the_15_minutes_run_out_still_keeps_the_user_signed_in", async () => {
    await mount();
    await advance(IDLE_LIMIT_MS + ANSWER_LIMIT_MS - SEC);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes/i }));
    });
    await advance(5 * SEC);

    expect(text("user")).not.toBe("nobody");
    expect(popup()).toBeNull();
  });

  it("SCRUM583_AC3_both_buttons_are_disabled_while_the_renewal_is_out", async () => {
    await mount();
    await advance(IDLE_LIMIT_MS);
    const gate = deferred();
    api.set({ "POST /auth/refresh": () => gate.promise });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes/i }));
    });

    expect(screen.getByRole("button", { name: /yes/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Log out" })).toBeDisabled();
    gate.resolve({ status: 200, data: { session: makeSession({ access: "a2", refresh: "r2", now: Date.now() }) } });
    await advance(0);
    expect(popup()).toBeNull();
  });

  it("SCRUM583_AC3_Yes_when_the_server_cannot_be_reached_still_counts_as_an_answer", async () => {
    await mount({ session: makeSession({ lifetimeSeconds: 24 * 3600, now: Date.now() }) });
    await advance(IDLE_LIMIT_MS);
    api.set({ "POST /auth/refresh": { status: 503 } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes/i }));
    });
    await advance(0);

    expect(popup()).toBeNull();
    expect(text("user")).not.toBe("nobody");
    expect(text("expired")).toBe("none");
  });

  it("SCRUM583_AC3_Yes_when_the_session_was_already_revoked_signs_out_with_the_expiry_message", async () => {
    await mount();
    await advance(IDLE_LIMIT_MS);
    api.set({ "POST /auth/refresh": { status: 401 } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes/i }));
    });
    await advance(0);

    expect(popup()).toBeNull();
    expect(text("user")).toBe("nobody");
    expect(text("expired")).toBe(SESSION_EXPIRED_MESSAGE);
  });
});

describe("SCRUM583_AC3 no answer for 15 minutes signs the user out", () => {
  it("SCRUM583_AC3_still_signed_in_one_second_before_the_15_minutes_are_up", async () => {
    await mount();

    await advance(IDLE_LIMIT_MS + ANSWER_LIMIT_MS - SEC);

    expect(popup()).toBeInTheDocument();
    expect(text("user")).not.toBe("nobody");
  });

  it("SCRUM583_AC3_signed_out_when_the_15_minutes_are_up_with_the_same_message", async () => {
    await mount();

    await advance(IDLE_LIMIT_MS + ANSWER_LIMIT_MS);

    expect(popup()).toBeNull();
    expect(text("user")).toBe("nobody");
    expect(text("expired")).toBe(SESSION_EXPIRED_MESSAGE);
    expect(storedSession()).toBeNull();
  });

  it("SCRUM583_AC3_the_server_is_told_to_end_the_session_with_the_token_that_was_in_use", async () => {
    await mount({ session: makeSession({ access: "idle-token", lifetimeSeconds: 24 * 3600, now: Date.now() }) });

    await advance(IDLE_LIMIT_MS + ANSWER_LIMIT_MS);

    expect(api.callsTo("POST /auth/logout")).toHaveLength(1);
    expect(api.callsTo("POST /auth/logout")[0].authorization).toBe("Bearer idle-token");
  });

  it("SCRUM583_AC3_the_user_is_signed_out_even_if_the_server_cannot_be_told", async () => {
    api.set({ "POST /auth/logout": { network: true } });
    await mount();

    await advance(IDLE_LIMIT_MS + ANSWER_LIMIT_MS);

    expect(text("user")).toBe("nobody");
    expect(text("expired")).toBe(SESSION_EXPIRED_MESSAGE);
  });

  it("SCRUM583_AC3_a_tab_that_slept_through_the_whole_45_minutes_signs_out_on_waking", async () => {
    await mount({ session: makeSession({ lifetimeSeconds: 24 * 3600, now: Date.now() }) });

    vi.setSystemTime(Date.now() + 50 * MIN);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(text("user")).toBe("nobody");
    expect(text("expired")).toBe(SESSION_EXPIRED_MESSAGE);
  });

  it("SCRUM583_AC3_the_next_person_to_sign_in_gets_a_fresh_30_minutes", async () => {
    await mount({ session: makeSession({ lifetimeSeconds: 24 * 3600, now: Date.now() }) });
    await advance(IDLE_LIMIT_MS + ANSWER_LIMIT_MS);
    expect(text("user")).toBe("nobody");
    api.set({
      "POST /auth/login": {
        status: 200,
        data: {
          user: { id: "u2", email: "second@connectsphere.com", role: "attendee" },
          session: makeSession({ access: "second", refresh: "second-r", lifetimeSeconds: 24 * 3600, now: Date.now() }),
        },
      },
    });
    await act(async () => {
      await auth.login("second@connectsphere.com", "pw");
    });

    await advance(IDLE_LIMIT_MS - SEC);
    expect(popup()).toBeNull();
    await advance(SEC);
    expect(popup()).toBeInTheDocument();
  });
});

describe("SCRUM583_AC3 a different person signing in over a session", () => {
  it("SCRUM583_AC3_gets_their_own_fresh_30_minutes_not_what_was_left_of_the_previous_ones", async () => {
    await mount({ session: makeSession({ lifetimeSeconds: 24 * 3600, now: Date.now() }) });
    await advance(20 * MIN);
    api.set({
      "POST /auth/login": {
        status: 200,
        data: {
          user: { id: "u2", email: "second@connectsphere.com", role: "attendee" },
          session: makeSession({ access: "second", refresh: "second-r", lifetimeSeconds: 24 * 3600, now: Date.now() }),
        },
      },
    });
    await act(async () => {
      await auth.login("second@connectsphere.com", "pw");
    });

    await advance(11 * MIN);

    // 31 minutes after the first person's last activity, 11 after the second's.
    expect(popup()).toBeNull();
    expect(text("user")).toBe("second@connectsphere.com");
  });
});

describe("SCRUM583_AC3 the popup's Log out button", () => {
  it("SCRUM583_AC3_Log_out_signs_out_through_the_normal_logout", async () => {
    await mount({ session: makeSession({ access: "tok", now: Date.now() }) });
    await advance(IDLE_LIMIT_MS);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    });
    await advance(0);

    expect(api.callsTo("POST /auth/logout")).toHaveLength(1);
    expect(api.callsTo("POST /auth/logout")[0].authorization).toBe("Bearer tok");
    expect(popup()).toBeNull();
    expect(text("user")).toBe("nobody");
    expect(storedSession()).toBeNull();
    // A choice, not an expiry: the logged-out message, not the expired one.
    expect(text("logout")).toBe("Logged out successfully");
    expect(text("expired")).toBe("none");
  });

  it("SCRUM583_AC3_a_failed_log_out_keeps_the_popup_and_says_why", async () => {
    await mount();
    await advance(IDLE_LIMIT_MS);
    api.set({ "POST /auth/logout": { status: 500 } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    });
    await advance(0);

    expect(screen.getByRole("alert")).toHaveTextContent("Failed to log out");
    expect(popup()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log out" })).toBeEnabled();
    expect(text("user")).not.toBe("nobody");
  });

  it("SCRUM583_AC3_the_error_goes_away_when_Log_out_is_tried_again", async () => {
    await mount();
    await advance(IDLE_LIMIT_MS);
    api.set({ "POST /auth/logout": { status: 500 } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    });
    await advance(0);
    expect(screen.getByRole("alert")).toBeInTheDocument();

    api.set({ "POST /auth/logout": { status: 200 } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    });
    await advance(0);

    expect(popup()).toBeNull();
    expect(text("user")).toBe("nobody");
  });

  it("SCRUM583_AC3_the_countdown_keeps_running_after_a_failed_log_out", async () => {
    await mount();
    await advance(IDLE_LIMIT_MS);
    api.set({ "POST /auth/logout": { status: 500 } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    });

    await advance(ANSWER_LIMIT_MS);

    expect(text("user")).toBe("nobody");
    expect(text("expired")).toBe(SESSION_EXPIRED_MESSAGE);
  });
});

describe("SCRUM583_AC3 keyboard and focus", () => {
  it("SCRUM583_AC3_focus_moves_to_Yes_when_the_popup_opens", async () => {
    await mount();

    await advance(IDLE_LIMIT_MS);

    expect(screen.getByRole("button", { name: /yes/i })).toHaveFocus();
  });

  it("SCRUM583_AC3_focus_returns_to_where_it_was_when_the_popup_closes", async () => {
    await mount({ session: makeSession({ lifetimeSeconds: 24 * 3600, now: Date.now() }) });
    const pageButton = screen.getByRole("button", { name: "page button" });
    pageButton.focus();
    await advance(IDLE_LIMIT_MS);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes/i }));
    });
    await advance(0);

    expect(pageButton).toHaveFocus();
  });

  it("SCRUM583_AC3_focus_does_not_throw_if_the_element_it_came_from_is_gone", async () => {
    await mount({ session: makeSession({ lifetimeSeconds: 24 * 3600, now: Date.now() }) });
    const gone = document.createElement("button");
    document.body.appendChild(gone);
    gone.focus();
    await advance(IDLE_LIMIT_MS);
    gone.remove();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes/i }));
    });
    await advance(0);

    expect(popup()).toBeNull();
  });

  it("SCRUM583_AC3_Tab_from_the_last_button_wraps_to_the_first", async () => {
    await mount();
    await advance(IDLE_LIMIT_MS);
    const logOut = screen.getByRole("button", { name: "Log out" });
    logOut.focus();

    fireEvent.keyDown(logOut, { key: "Tab" });

    expect(screen.getByRole("button", { name: /yes/i })).toHaveFocus();
  });

  it("SCRUM583_AC3_Shift_Tab_from_the_first_button_wraps_to_the_last", async () => {
    await mount();
    await advance(IDLE_LIMIT_MS);
    const yes = screen.getByRole("button", { name: /yes/i });
    yes.focus();

    fireEvent.keyDown(yes, { key: "Tab", shiftKey: true });

    expect(screen.getByRole("button", { name: "Log out" })).toHaveFocus();
  });

  it("SCRUM583_AC3_Tab_between_the_buttons_is_left_to_the_browser", async () => {
    await mount();
    await advance(IDLE_LIMIT_MS);
    const yes = screen.getByRole("button", { name: /yes/i });
    yes.focus();

    const notPrevented = fireEvent.keyDown(yes, { key: "Tab" });
    const logOut = screen.getByRole("button", { name: "Log out" });
    logOut.focus();
    const backNotPrevented = fireEvent.keyDown(logOut, { key: "Tab", shiftKey: true });

    expect(notPrevented).toBe(true);
    expect(backNotPrevented).toBe(true);
  });

  it("SCRUM583_AC3_Tab_with_focus_outside_the_dialog_pulls_it_back_in", async () => {
    await mount();
    await advance(IDLE_LIMIT_MS);
    screen.getByRole("button", { name: "page button" }).focus();

    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Tab" });

    expect(screen.getByRole("button", { name: /yes/i })).toHaveFocus();
  });

  it("SCRUM583_AC3_Tab_while_both_buttons_are_disabled_stays_put", async () => {
    await mount();
    await advance(IDLE_LIMIT_MS);
    const gate = deferred();
    api.set({ "POST /auth/refresh": () => gate.promise });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /yes/i }));
    });

    const notPrevented = fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Tab" });

    expect(notPrevented).toBe(false);
    gate.resolve({ status: 200, data: { session: makeSession({ access: "a2", refresh: "r2", now: Date.now() }) } });
    await advance(0);
  });

  it("SCRUM583_AC3_other_keys_inside_the_dialog_are_not_interfered_with", async () => {
    await mount();
    await advance(IDLE_LIMIT_MS);

    const notPrevented = fireEvent.keyDown(screen.getByRole("button", { name: /yes/i }), { key: "Enter" });

    expect(notPrevented).toBe(true);
  });
});

describe("SCRUM583_AC2 an active user's session is renewed before it ends", () => {
  it("SCRUM583_AC2_the_margin_is_5_minutes_for_a_normal_token_and_half_the_life_for_a_short_one", () => {
    expect(RENEW_BEFORE_MS).toBe(5 * MIN);
    expect(renewalMargin(3600 * SEC)).toBe(5 * MIN);
    expect(renewalMargin(8 * MIN)).toBe(4 * MIN);
    expect(renewalMargin(2 * MIN)).toBe(1 * MIN);
  });

  it("SCRUM583_AC2_nothing_is_renewed_early", async () => {
    await mount({ session: makeSession({ lifetimeSeconds: 3600, now: Date.now() }) });

    for (let t = 0; t < 54; t += 9) {
      await advance(9 * MIN);
      fireEvent.mouseMove(document.body);
    }
    await advance(MIN - SEC);

    expect(refreshCalls()).toHaveLength(0);
  });

  it("SCRUM583_AC2_it_is_renewed_5_minutes_before_the_token_ends", async () => {
    await mount({ session: makeSession({ lifetimeSeconds: 3600, now: Date.now() }) });

    for (let i = 0; i < 5; i += 1) {
      await advance(10 * MIN);
      fireEvent.mouseMove(document.body);
    }
    await advance(5 * MIN);

    expect(refreshCalls()).toHaveLength(1);
    expect(storedSession().session.access_token).toBe("a2");
    expect(text("user")).not.toBe("nobody");
  });

  it("SCRUM583_AC2_the_renewed_session_is_renewed_again_before_its_own_end", async () => {
    await mount({ session: makeSession({ lifetimeSeconds: 3600, now: Date.now() }) });

    for (let i = 0; i < 22; i += 1) {
      await advance(10 * MIN);
      fireEvent.mouseMove(document.body);
    }

    // Renewals at 55, 110, 165 and 220 minutes into the 220 simulated.
    expect(refreshCalls().length).toBe(4);
    expect(text("user")).not.toBe("nobody");
    expect(popup()).toBeNull();
  });

  it("SCRUM583_AC2_each_renewal_sends_the_refresh_token_of_the_session_before_it", async () => {
    await mount({ session: makeSession({ lifetimeSeconds: 600, refresh: "r1", now: Date.now() }) });
    api.set({ "POST /auth/refresh": refreshIssuesNewSessions(600) });

    for (let i = 0; i < 12; i += 1) {
      await advance(2 * MIN);
      fireEvent.mouseMove(document.body);
    }

    const sent = refreshCalls().map((c) => c.body.refresh_token);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(sent[0]).toBe("r1");
    expect(sent[1]).toBe("r2");
    expect(sent[2]).toBe("r3");
  });

  it("SCRUM583_AC2_a_short_lived_token_is_renewed_once_per_cycle_not_in_a_loop", async () => {
    // 2-minute tokens: margin is 1 minute, so one renewal per minute at most.
    await mount({ session: makeSession({ lifetimeSeconds: 120, now: Date.now() }) });
    api.set({ "POST /auth/refresh": refreshIssuesNewSessions(120) });

    for (let i = 0; i < 10; i += 1) {
      await advance(MIN);
      fireEvent.mouseMove(document.body);
    }

    expect(refreshCalls().length).toBeLessThanOrEqual(10);
    expect(refreshCalls().length).toBeGreaterThanOrEqual(8);
  });

  it("SCRUM583_AC2_while_the_popup_is_up_the_idle_user_is_not_renewed", async () => {
    // 35-minute token: due for renewal at 30 minutes, exactly when the popup opens.
    await mount({ session: makeSession({ lifetimeSeconds: 35 * 60, now: Date.now() }) });

    await advance(IDLE_LIMIT_MS + 3 * MIN);

    expect(popup()).toBeInTheDocument();
    expect(refreshCalls()).toHaveLength(0);
  });

  it("SCRUM583_AC2_a_renewal_does_not_count_as_activity", async () => {
    // 20-minute token: renewed in the 15th minute and every 15 after, with no
    // user activity at all. The popup must still come at 30.
    await mount({ session: makeSession({ lifetimeSeconds: 20 * 60, now: Date.now() }) });

    await advance(IDLE_LIMIT_MS - SEC);
    expect(popup()).toBeNull();
    expect(refreshCalls().length).toBeGreaterThanOrEqual(1);

    await advance(SEC);
    expect(popup()).toBeInTheDocument();
  });

  it("SCRUM583_AC2_a_refused_renewal_signs_the_user_out_with_the_expiry_message", async () => {
    await mount({ session: makeSession({ lifetimeSeconds: 600, now: Date.now() }) });
    api.set({ "POST /auth/refresh": { status: 401, data: { error: "Your session is no longer valid" } } });

    await advance(6 * MIN);

    expect(text("user")).toBe("nobody");
    expect(text("expired")).toBe(SESSION_EXPIRED_MESSAGE);
    expect(storedSession()).toBeNull();
  });

  it("SCRUM583_AC2_a_renewal_the_server_cannot_answer_is_retried_30_seconds_later", async () => {
    await mount({ session: makeSession({ lifetimeSeconds: 600, now: Date.now() }) });
    api.set({ "POST /auth/refresh": { status: 503 } });

    await advance(5 * MIN);
    expect(refreshCalls()).toHaveLength(1);
    await advance(RENEW_RETRY_MS - SEC);
    expect(refreshCalls()).toHaveLength(1);
    await advance(SEC);
    expect(refreshCalls()).toHaveLength(2);
    expect(text("user")).not.toBe("nobody");
  });

  it("SCRUM583_AC2_a_retry_that_gets_through_keeps_the_user_signed_in", async () => {
    await mount({ session: makeSession({ lifetimeSeconds: 600, now: Date.now() }) });
    api.set({ "POST /auth/refresh": { status: 503 } });
    await advance(5 * MIN);
    api.set({ "POST /auth/refresh": refreshIssuesNewSessions() });

    await advance(RENEW_RETRY_MS);

    expect(storedSession().session.access_token).toBe("a2");
    expect(text("user")).not.toBe("nobody");
    expect(text("expired")).toBe("none");
  });

  it("SCRUM583_AC2_if_the_server_stays_unreachable_until_the_token_ends_the_user_is_signed_out", async () => {
    await mount({ session: makeSession({ lifetimeSeconds: 600, now: Date.now() }) });
    api.set({ "POST /auth/refresh": { network: true } });

    await advance(10 * MIN - SEC);
    fireEvent.mouseMove(document.body);
    expect(text("user")).not.toBe("nobody");

    await advance(35 * SEC);

    expect(text("user")).toBe("nobody");
    expect(text("expired")).toBe(SESSION_EXPIRED_MESSAGE);
  });

  it("SCRUM583_AC2_only_one_renewal_is_ever_in_flight", async () => {
    await mount({ session: makeSession({ lifetimeSeconds: 600, now: Date.now() }) });
    const gate = deferred();
    api.set({ "POST /auth/refresh": () => gate.promise });

    await advance(5 * MIN);
    await advance(20 * SEC);

    expect(refreshCalls()).toHaveLength(1);
    gate.resolve({ status: 200, data: { session: makeSession({ access: "a2", refresh: "r2", lifetimeSeconds: 600, now: Date.now() }) } });
    await advance(0);
  });

  it("SCRUM583_AC2_a_session_whose_token_ended_while_the_tab_was_closed_is_renewed_on_load", async () => {
    // Stored an hour and a half ago; the refresh token is still good.
    const stale = makeSession({ lifetimeSeconds: 3600, now: Date.now() - 90 * MIN });

    await mount({ session: stale });
    await advance(2 * SEC);

    expect(refreshCalls()).toHaveLength(1);
    expect(storedSession().session.access_token).toBe("a2");
    expect(text("user")).not.toBe("nobody");
  });

  it("SCRUM583_AC2_a_session_with_no_expiry_time_is_never_renewed_proactively", async () => {
    const odd = { access_token: "a1", refresh_token: "r1" };
    await mount({ session: odd });

    await advance(25 * MIN);
    fireEvent.mouseMove(document.body);
    await advance(25 * MIN);

    expect(refreshCalls()).toHaveLength(0);
    expect(text("user")).not.toBe("nobody");
  });

  it("SCRUM583_AC2_a_session_with_no_lifetime_falls_back_to_an_hour_for_the_margin", async () => {
    // expires_at present, expires_in missing: the margin assumes a 1-hour token.
    const noLifetime = { access_token: "a1", refresh_token: "r1", expires_at: Math.floor((Date.now() + 3600 * SEC) / 1000) };
    await mount({ session: noLifetime });

    for (let i = 0; i < 5; i += 1) {
      await advance(10 * MIN);
      fireEvent.mouseMove(document.body);
    }
    expect(refreshCalls()).toHaveLength(0);
    await advance(5 * MIN);

    expect(refreshCalls()).toHaveLength(1);
  });

  it("SCRUM583_AC2_a_renewal_that_returns_after_the_user_was_signed_out_by_a_401_changes_nothing", async () => {
    await mount({ session: makeSession({ lifetimeSeconds: 600, now: Date.now() }) });
    const gate = deferred();
    api.set({ "POST /auth/refresh": () => gate.promise, "GET /venues": { status: 401 } });
    await advance(5 * MIN);

    await act(async () => {
      const { apiClient } = await import("../../src/services/apiClient");
      await apiClient.get("/venues").catch(() => {});
    });
    gate.resolve({ status: 200, data: { session: makeSession({ access: "late", refresh: "late-r", now: Date.now() }) } });
    await advance(0);

    expect(text("user")).toBe("nobody");
    expect(storedSession()).toBeNull();
  });
});

describe("SCRUM583_AC5 every role", () => {
  it.each([
    "event_organiser",
    "event_coordinator",
    "event_coordinator_lead",
    "venue_staff",
    "technical_support_staff",
    "safety_officer",
    "attendee",
  ])("SCRUM583_AC5_%s_is_asked_and_signed_out_like_anyone_else", async (role) => {
    await mount({ role, session: makeSession({ lifetimeSeconds: 24 * 3600, now: Date.now() }) });

    await advance(IDLE_LIMIT_MS);
    expect(popup()).toBeInTheDocument();
    await advance(ANSWER_LIMIT_MS);

    expect(text("user")).toBe("nobody");
    expect(text("expired")).toBe(SESSION_EXPIRED_MESSAGE);
  });
});

describe("SCRUM583 formatRemaining", () => {
  it.each([
    [15 * MIN, "15:00"],
    [14 * MIN + 59 * SEC + 1, "15:00"],
    [90 * SEC, "1:30"],
    [61 * SEC, "1:01"],
    [9 * SEC, "0:09"],
    [1, "0:01"],
    [0, "0:00"],
    [-5000, "0:00"],
  ])("SCRUM583_AC3_formats_%i_ms_as_%s", (ms, expected) => {
    expect(formatRemaining(ms)).toBe(expected);
  });
});
