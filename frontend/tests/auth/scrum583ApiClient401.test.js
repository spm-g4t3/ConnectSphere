// scrum583ApiClient401.test.js
//
// SCRUM-583 AC1: one place hears "your session is no longer valid". The
// response interceptor on apiClient reports a 401 on a request that carried the
// signed-in user's token, and leaves every other failure alone.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../../src/services/apiClient";
import { onSessionRefused } from "../../src/auth/sessionExpiry";
import { installFakeApi, makeSession, storeSignedIn, STORAGE_KEY } from "../helpers/fakeApi";

let api;
let refused;
let unsubscribe;

beforeEach(() => {
  sessionStorage.clear();
  refused = vi.fn();
  unsubscribe = onSessionRefused(refused);
  api = installFakeApi();
});

afterEach(() => {
  unsubscribe();
  api.restore();
  sessionStorage.clear();
});

describe("SCRUM583_AC1 a 401 on a signed-in request is reported once, with the token that was refused", () => {
  it("SCRUM583_AC1_reports_a_401_that_carried_the_stored_token", async () => {
    storeSignedIn({ session: makeSession({ access: "tok-A" }) });
    api.set({ "GET /venues": { status: 401, data: { error: "Your session is no longer valid" } } });

    await expect(apiClient.get("/venues")).rejects.toMatchObject({ response: { status: 401 } });

    expect(refused).toHaveBeenCalledTimes(1);
    expect(refused).toHaveBeenCalledWith("tok-A");
  });

  it.each(["GET", "POST", "PUT", "PATCH", "DELETE"])(
    "SCRUM583_AC1_reports_a_401_on_a_%s",
    async (method) => {
      storeSignedIn();
      api.set({ [`${method} /things`]: { status: 401 } });

      await expect(apiClient.request({ method, url: "/things" })).rejects.toBeDefined();

      expect(refused).toHaveBeenCalledTimes(1);
    },
  );

  it("SCRUM583_AC1_still_rejects_with_the_original_error_so_callers_can_clean_up", async () => {
    storeSignedIn();
    api.set({ "GET /venues": { status: 401, data: { error: "x" } } });

    const err = await apiClient.get("/venues").catch((e) => e);

    expect(err.response.status).toBe(401);
    expect(err.response.data).toEqual({ error: "x" });
  });

  it("SCRUM583_AC1_reports_when_the_url_carries_a_query_string", async () => {
    storeSignedIn();
    api.set({ "GET /venues?page=2": { status: 401 } });

    await apiClient.get("/venues?page=2").catch(() => {});

    expect(refused).toHaveBeenCalledTimes(1);
  });
});

describe("SCRUM583_AC1 the requests whose 401 does not mean an expired session", () => {
  it("SCRUM583_AC1_a_wrong_password_on_login_is_not_an_expiry", async () => {
    storeSignedIn();
    api.set({ "POST /auth/login": { status: 401, data: { error: "Invalid email or password" } } });

    await apiClient.post("/auth/login", { email: "a@b.c", password: "x" }).catch(() => {});

    expect(refused).not.toHaveBeenCalled();
  });

  it("SCRUM583_AC1_a_wrong_password_with_no_session_stored_is_not_an_expiry", async () => {
    api.set({ "POST /auth/login": { status: 401 } });

    await apiClient.post("/auth/login", {}).catch(() => {});

    expect(refused).not.toHaveBeenCalled();
  });

  it("SCRUM583_AC2_a_refused_refresh_is_left_to_the_code_that_asked", async () => {
    storeSignedIn();
    api.set({ "POST /auth/refresh": { status: 401 } });

    await apiClient.post("/auth/refresh", { refresh_token: "r" }).catch(() => {});

    expect(refused).not.toHaveBeenCalled();
  });

  it("SCRUM583_AC4_a_logout_with_no_live_session_is_not_an_expiry", async () => {
    storeSignedIn();
    api.set({ "POST /auth/logout": { status: 401 } });

    await apiClient.post("/auth/logout").catch(() => {});

    expect(refused).not.toHaveBeenCalled();
  });

  it("SCRUM583_AC1_exempts_the_auth_paths_when_the_url_is_absolute_or_has_a_query", async () => {
    storeSignedIn();
    api.set({
      "POST http://localhost:5000/api/auth/login": { status: 401 },
      "POST /auth/login?x=1": { status: 401 },
    });

    await apiClient.post("http://localhost:5000/api/auth/login").catch(() => {});
    await apiClient.post("/auth/login?x=1").catch(() => {});

    expect(refused).not.toHaveBeenCalled();
  });

  it("SCRUM583_AC1_a_path_that_only_contains_an_auth_word_is_not_exempt", async () => {
    storeSignedIn();
    api.set({ "GET /auth/login-history": { status: 401 } });

    await apiClient.get("/auth/login-history").catch(() => {});

    expect(refused).toHaveBeenCalledTimes(1);
  });
});

describe("SCRUM583_AC1 only the session that was refused is reported", () => {
  it("SCRUM583_AC1_ignores_a_401_when_nobody_is_signed_in", async () => {
    api.set({ "GET /venues": { status: 401 } });

    await apiClient.get("/venues").catch(() => {});

    expect(refused).not.toHaveBeenCalled();
  });

  it("SCRUM583_AC1_ignores_a_401_for_a_request_sent_with_the_previous_sessions_token", async () => {
    storeSignedIn({ session: makeSession({ access: "old-token" }) });
    api.set({
      "GET /slow": async () => {
        // The user signs in again while the request is out; then it is refused.
        storeSignedIn({ session: makeSession({ access: "new-token" }) });
        return { status: 401 };
      },
    });

    await apiClient.get("/slow").catch(() => {});

    expect(refused).not.toHaveBeenCalled();
  });

  it("SCRUM583_AC1_ignores_a_401_for_a_request_that_finished_after_the_user_signed_out", async () => {
    storeSignedIn();
    api.set({
      "GET /slow": async () => {
        sessionStorage.removeItem(STORAGE_KEY);
        return { status: 401 };
      },
    });

    await apiClient.get("/slow").catch(() => {});

    expect(refused).not.toHaveBeenCalled();
  });

  it("SCRUM583_AC1_ignores_a_401_when_the_stored_value_is_not_json", async () => {
    sessionStorage.setItem(STORAGE_KEY, "{not json");
    api.set({ "GET /venues": { status: 401 } });

    await apiClient.get("/venues").catch(() => {});

    expect(refused).not.toHaveBeenCalled();
  });

  it("SCRUM583_AC1_ignores_a_401_when_the_stored_value_became_unreadable_while_the_request_was_out", async () => {
    storeSignedIn();
    api.set({
      "GET /slow": async () => {
        sessionStorage.setItem(STORAGE_KEY, "{not json");
        return { status: 401 };
      },
    });

    await apiClient.get("/slow").catch(() => {});

    expect(refused).not.toHaveBeenCalled();
  });

  it("SCRUM583_AC1_ignores_a_401_when_the_stored_session_lost_its_token_while_the_request_was_out", async () => {
    storeSignedIn();
    api.set({
      "GET /slow": async () => {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ user: { id: "u1" }, session: {} }));
        return { status: 401 };
      },
    });

    await apiClient.get("/slow").catch(() => {});

    expect(refused).not.toHaveBeenCalled();
  });

  it("SCRUM583_AC1_a_request_with_no_url_is_judged_like_any_other", async () => {
    storeSignedIn();
    api.set({ "GET undefined": { status: 401 } });

    await apiClient.request({ method: "get" }).catch(() => {});

    expect(refused).toHaveBeenCalledTimes(1);
  });

  it("SCRUM583_AC1_ignores_a_401_when_the_stored_value_has_no_session", async () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ user: { id: "u1" } }));
    api.set({ "GET /venues": { status: 401 } });

    await apiClient.get("/venues").catch(() => {});

    expect(refused).not.toHaveBeenCalled();
  });
});

describe("SCRUM583_AC1 other failures and successes pass straight through", () => {
  it.each([400, 403, 404, 409, 422, 429, 500, 502, 503])(
    "SCRUM583_AC1_does_not_treat_a_%i_as_an_expiry",
    async (status) => {
      storeSignedIn();
      api.set({ "GET /venues": { status } });

      await expect(apiClient.get("/venues")).rejects.toMatchObject({ response: { status } });

      expect(refused).not.toHaveBeenCalled();
    },
  );

  it("SCRUM583_AC1_does_not_treat_a_network_failure_as_an_expiry", async () => {
    storeSignedIn();
    api.set({ "GET /venues": { network: true } });

    const err = await apiClient.get("/venues").catch((e) => e);

    expect(err.response).toBeUndefined();
    expect(refused).not.toHaveBeenCalled();
  });

  it("SCRUM583_AC1_a_successful_response_is_returned_untouched", async () => {
    storeSignedIn();
    api.set({ "GET /venues": { status: 200, data: [{ id: 1 }] } });

    const res = await apiClient.get("/venues");

    expect(res.data).toEqual([{ id: 1 }]);
    expect(refused).not.toHaveBeenCalled();
  });
});

describe("SCRUM583 the bearer token still goes out on every request", () => {
  it("SCRUM583_AC2_sends_the_token_currently_stored_not_the_one_from_page_load", async () => {
    storeSignedIn({ session: makeSession({ access: "first" }) });
    api.set({ "GET /a": { status: 200 } });
    await apiClient.get("/a");

    storeSignedIn({ session: makeSession({ access: "second" }) });
    await apiClient.get("/a");

    expect(api.calls.map((c) => c.authorization)).toEqual(["Bearer first", "Bearer second"]);
  });
});
