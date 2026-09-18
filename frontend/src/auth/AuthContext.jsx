// AuthContext.jsx

// There is no GET /api/auth/me yet, so session restore on page reload
// trusts what's in sessionStorage rather than re-validating server-side.
// Ask your backend teammate to add a /me route that checks the Supabase
// session token — this is a stopgap, not the final version.
//
// IMPORTANT: confirm with your team what strings profiles.role actually
// contains (e.g. "EVENT_ORGANISER" vs "organiser" vs something else) and
// make sure Dashboard.jsx / Navigation.jsx key off the same values.

import { createContext, useContext, useState, useEffect } from "react";
import { apiClient } from "../services/apiClient"; // <-- replace with your actual API client

const AuthContext = createContext(null);

const STORAGE_KEY = "connectsphere_auth"; // stores { user, session }

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

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

  async function login(email, password) {
    try {
      const res = await apiClient.post("/auth/login", { email, password });
      const { user: loggedInUser, session: newSession } = res.data;

      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ user: loggedInUser, session: newSession }),
      );
      setUser(loggedInUser);
      setSession(newSession);

      return { success: true };
    } catch (err) {
      // Backend already returns a generic message for bad credentials
      // (SCRUM-92 AC: no leaking whether it was the email or password).
      const message =
        err.response?.data?.error || "Invalid email or password.";
      return { success: false, error: message };
    }
  }

  async function logout() {
    // POST /api/auth/logout now exists (SCRUM-105) — it takes the access
    // token as a Bearer header and invalidates the session server-side via
    // supabaseAuth.auth.admin.signOut(token).
    if (session?.access_token) {
      try {
        await apiClient.post(
          "/auth/logout",
          {},
          { headers: { Authorization: `Bearer ${session.access_token}` } },
        );
      } catch (err) {
        // Even if the server-side call fails (e.g. token already expired),
        // still clear local state below — a stuck "logged in" UI is worse
        // than a session that lingers server-side a little longer.
        console.error("Server-side logout failed:", err);
      }
    }

    sessionStorage.removeItem(STORAGE_KEY);
    setUser(null);
    setSession(null);
  }

  return (
    <AuthContext.Provider value={{ user, session, loading, login, logout }}>
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
