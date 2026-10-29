// AuthContext.jsx
//
// Matches the CURRENT backend: POST /api/auth/login, /logout and /refresh
// (SCRUM-583) exist. There is no GET /api/auth/me yet, so session restore on page reload
// trusts what's in sessionStorage rather than re-validating server-side.
// Ask your backend teammate to add a /me route that checks the Supabase
// session token — this is a stopgap, not the final version.
//
// IMPORTANT: confirm with your team what strings profiles.role actually
// contains (e.g. "EVENT_ORGANISER" vs "organiser" vs something else) and
// make sure Dashboard.jsx / Navigation.jsx key off the same values.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { apiClient } from "../services/apiClient";
import { AUTH_STORAGE_KEY as STORAGE_KEY } from "./authStorageKey";
import { SESSION_EXPIRED_MESSAGE, onSessionRefused } from "./sessionExpiry";

const AuthContext = createContext(null);

const LOGIN_ERROR_MESSAGES = {
  400: "Email and password are required",
  401: "Invalid email or password",
  500: "Unable to retrieve user role",
};

/** What is stored, or null when nothing usable is. Never throws. */
function readStored() {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [logoutMessage, setLogoutMessage] = useState(null);
  // Why the user was sent to the login page, until they sign in again.
  const [sessionExpiredMessage, setSessionExpiredMessage] = useState(null);
  const renewal = useRef(null);

  // Restore from sessionStorage on load. This is a stopgap: it trusts
  // client-side storage rather than asking the server to re-validate the
  // token, because there's no /me endpoint yet.
  useEffect(() => {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const { user: storedUser, session: storedSession } = JSON.parse(stored);
        setUser(storedUser);
        setSession(storedSession);
      } catch {
        sessionStorage.removeItem(STORAGE_KEY);
      }
    }
    setLoading(false);
  }, []);

  // Ends the session and leaves the message for the login page. A no-op when
  // nothing is stored, so requests refused together sign the user out once.
  const expireSession = useCallback(() => {
    if (!sessionStorage.getItem(STORAGE_KEY)) return;
    sessionStorage.removeItem(STORAGE_KEY);
    setUser(null);
    setSession(null);
    setLogoutMessage(null);
    setSessionExpiredMessage(SESSION_EXPIRED_MESSAGE);
  }, []);

  useEffect(
    () => onSessionRefused((token) => {
      // Only the session that was refused (apiClient checked too; this closes the gap).
      if (readStored()?.session?.access_token === token) expireSession();
    }),
    [expireSession],
  );

  // Swaps the refresh token for a new session. Resolves to "renewed",
  // "expired" (session over, message set), "unavailable" (server not reached,
  // try later) or "ended" (user signed out or in again meanwhile, nothing
  // changed). One at a time: Supabase rotates refresh tokens, so a second call
  // with the same token would be refused and read as a dead session.
  const renewSession = useCallback(() => {
    if (!renewal.current) {
      renewal.current = (async () => {
        const before = readStored();
        const refreshToken = before?.session?.refresh_token;
        if (!refreshToken) {
          expireSession();
          return "expired";
        }

        let next;
        try {
          const res = await apiClient.post("/auth/refresh", { refresh_token: refreshToken });
          next = res.data?.session;
        } catch (err) {
          const status = err.response?.status;
          if (status === 400 || status === 401) {
            // Only if this is still the session we asked about.
            if (readStored()?.session?.refresh_token !== refreshToken) return "ended";
            expireSession();
            return "expired";
          }
          return "unavailable";
        }

        const now = readStored();
        // Re-read: the user may have signed out or in while the request was out.
        if (!now || now.session?.refresh_token !== refreshToken) return "ended";

        if (!next?.access_token || !next?.refresh_token) {
          expireSession();
          return "expired";
        }

        sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ user: now.user, session: next }));
        setSession(next);
        return "renewed";
      })().finally(() => {
        renewal.current = null;
      });
    }
    return renewal.current;
  }, [expireSession]);

  // The user did not answer "Are you still there?": sign out as an expiry, and
  // tell the server (best effort) so the token cannot be used afterwards.
  const endIdleSession = useCallback(() => {
    const token = readStored()?.session?.access_token;
    expireSession();
    if (token) {
      apiClient
        .post("/auth/logout", {}, { headers: { Authorization: `Bearer ${token}` } })
        .catch(() => {});
    }
  }, [expireSession]);

  async function login(email, password) {
    setLogoutMessage(null);
    try {
      const res = await apiClient.post("/auth/login", { email, password });
      const { user: loggedInUser, session: newSession } = res.data;

      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ user: loggedInUser, session: newSession }),
      );
      setUser(loggedInUser);
      setSession(newSession);
      setSessionExpiredMessage(null);

      return { success: true, user: loggedInUser };
    } catch (err) {
      const message = LOGIN_ERROR_MESSAGES[err.response?.status]
        || "Unable to log in right now. Please try again.";
      return { success: false, error: message };
    }
  }

  async function logout() {
    // POST /api/auth/logout now exists (SCRUM-105) — it takes the access
    // token as a Bearer header and invalidates the session server-side via
    // supabaseAuth.auth.admin.signOut(token).
    try {
      await apiClient.post(
        "/auth/logout",
        {},
        session?.access_token
          ? { headers: { Authorization: `Bearer ${session.access_token}` } }
          : undefined,
      );
    } catch (err) {
      // A 401 means the session was already gone, which is what logging out
      // wanted, so it finishes like a success instead of leaving the user stuck.
      if (err.response?.status !== 401) {
        const message = err.response?.status === 500
          ? "Failed to log out"
          : "We could not log you out. Please try again.";
        return { success: false, error: message };
      }
    }

    sessionStorage.removeItem(STORAGE_KEY);
    setUser(null);
    setSession(null);
    setSessionExpiredMessage(null);
    const message = "Logged out successfully";
    setLogoutMessage(message);
    return { success: true, message };
  }

  function clearLogoutMessage() {
    setLogoutMessage(null);
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        loading,
        login,
        logout,
        logoutMessage,
        clearLogoutMessage,
        sessionExpiredMessage,
        expireSession,
        renewSession,
        endIdleSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
