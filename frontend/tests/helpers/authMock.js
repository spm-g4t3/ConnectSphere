// authMock.js
//
// The mocked auth context the route tests share. It imports nothing from src,
// so a vi.mock factory can load it without importing the module it replaces.

import { vi } from "vitest";

/** Every role, in the order the route tests list them. */
export const ALL_ROLES = [
  "event_organiser",
  "event_coordinator",
  "venue_staff",
  "technical_support_staff",
  "attendee",
  "event_coordinator_lead",
  "safety_officer",
];

/**
 * The AuthContext module as the route tests replace it. Use it as
 * `vi.mock(path, async () => (await import("../helpers/authMock.js")).authContextMock())`,
 * since vi.mock is hoisted above any static import of this file.
 */
export function authContextMock() {
  return {
    AuthProvider: ({ children }) => children,
    useAuth: vi.fn(),
  };
}

/** What useAuth returns for a signed-in role, or for a visitor when role is empty. */
export function authValue(role, user = { id: "u1", name: "Test User" }) {
  return {
    user: role ? { ...user, role } : null,
    loading: false,
    logout: vi.fn().mockResolvedValue({ success: true }),
    logoutMessage: null,
    clearLogoutMessage: vi.fn(),
  };
}
