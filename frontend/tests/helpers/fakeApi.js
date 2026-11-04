// fakeApi.js
//
// Replaces the network under the REAL apiClient, so a test exercises its
// interceptors (the bearer token going out, the 401 handler coming back) and
// not just a mocked service. Plain .js, shared by the SCRUM-583 tests.
//
// A route is "METHOD /path" -> a response, or a function of the request that
// returns one or throws. A response is { status, data }; status >= 400 rejects
// the way axios does, with err.response set. Throwing { network: true } rejects
// with no response at all, as a dropped connection does.

import { AxiosError } from "axios";
import { apiClient } from "../../src/services/apiClient";

export function installFakeApi(routes = {}) {
  const original = apiClient.defaults.adapter;
  const calls = [];
  const table = { ...routes };

  apiClient.defaults.adapter = async (config) => {
    const key = `${String(config.method).toUpperCase()} ${config.url}`;
    const headers = { ...(config.headers?.toJSON?.() ?? config.headers) };
    const call = {
      key,
      url: config.url,
      method: String(config.method).toUpperCase(),
      body: config.data ? JSON.parse(config.data) : undefined,
      authorization: headers.Authorization ?? headers.authorization,
    };
    calls.push(call);

    const handler = table[key] ?? table[`* ${config.url}`] ?? table["*"];
    let answer = typeof handler === "function" ? await handler(call) : handler;
    if (answer === undefined) answer = { status: 404, data: { error: "no route in fakeApi" } };

    if (answer.network) {
      throw new AxiosError("Network Error", "ERR_NETWORK", config, null, undefined);
    }

    const response = { status: answer.status ?? 200, data: answer.data ?? {}, statusText: "", headers: {}, config };
    if (response.status >= 400) {
      throw new AxiosError(
        `Request failed with status code ${response.status}`,
        "ERR_BAD_REQUEST",
        config,
        null,
        response,
      );
    }
    return response;
  };

  return {
    calls,
    /** Add or replace routes mid-test. */
    set(more) {
      Object.assign(table, more);
    },
    callsTo(key) {
      return calls.filter((c) => c.key === key);
    },
    restore() {
      apiClient.defaults.adapter = original;
    },
  };
}

/** A Supabase-shaped session. expires_at is in seconds, as Supabase sends it. */
export function makeSession({ access = "access-1", refresh = "refresh-1", lifetimeSeconds = 3600, now = Date.now() } = {}) {
  return {
    access_token: access,
    refresh_token: refresh,
    expires_in: lifetimeSeconds,
    expires_at: Math.floor(now / 1000) + lifetimeSeconds,
    token_type: "bearer",
  };
}

export const STORAGE_KEY = "connectsphere_auth";

export function storeSignedIn({ role = "event_organiser", id = "u1", session = makeSession() } = {}) {
  const user = { id, email: `${role}@connectsphere.com`, role };
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ user, session }));
  return { user, session };
}

export function storedSession() {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
}
