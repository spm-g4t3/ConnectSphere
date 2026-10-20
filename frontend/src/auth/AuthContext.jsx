// AuthContext.jsx
//
// Matches the CURRENT backend: only POST /api/auth/login exists.
// There is no GET /api/auth/me yet, so session restore on page reload
// trusts what's in sessionStorage rather than re-validating server-side.
// Ask your backend teammate to add a /me route that checks the Supabase
// session token — this is a stopgap, not the final version.
//
// IMPORTANT: confirm with your team what strings profiles.role actually
// contains (e.g. "EVENT_ORGANISER" vs "organiser" vs something else) and
// make sure Dashboard.jsx / Navigation.jsx key off the same values.

import { createContext, useContext, useState, useEffect } from "react";
import { apiClient } from "../services/apiClient";

const AuthContext = createContext(null);

const STORAGE_KEY = "connectsphere_auth"; // stores { user, session }
const LOGIN_ERROR_MESSAGES = {
  400: "Email and password are required",
  401: "Invalid email or password",
  500: "Unable to retrieve user role",
};

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [logoutMessage, setLogoutMessage] = useState(null);

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
      const message = err.response?.status === 401
        ? "No active session"
        : err.response?.status === 500
          ? "Failed to log out"
          : "We could not log you out. Please try again.";
      return { success: false, error: message };
    }

    sessionStorage.removeItem(STORAGE_KEY);
    setUser(null);
    setSession(null);
    const message = "Logged out successfully";
    setLogoutMessage(message);
    return { success: true, message };
  }

  function clearLogoutMessage() {
    setLogoutMessage(null);
  }

  return (
    <AuthContext.Provider value={{ user, session, loading, login, logout, logoutMessage, clearLogoutMessage }}>
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
