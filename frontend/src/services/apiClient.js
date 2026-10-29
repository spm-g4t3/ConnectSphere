// apiClient.js
//
// The one place the frontend's base API URL and shared request config live.
// Every service file (AuthContext, venueService, eventRequestService, etc.)
// imports this rather than constructing its own axios instance.
//
// Base URL comes from an env var so it's different in dev vs. production
// without editing code. Uses Vite's import.meta.env convention — if your
// project uses Create React App instead, swap this for
// process.env.REACT_APP_API_BASE_URL and adjust the .env key name to match.

import axios from "axios";
import { AUTH_STORAGE_KEY } from "../auth/authStorageKey";
import { AUTH_PATHS_EXEMPT_FROM_EXPIRY, reportSessionRefused } from "../auth/sessionExpiry";

const BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000/api";

export const apiClient = axios.create({
  baseURL: BASE_URL,
  headers: {
    "Content-Type": "application/json",
  },
});

// Attaches the current session's access token to every outgoing request,
// when one exists — so individual service calls don't each have to remember
// to pass an Authorization header themselves.
//
// Reads directly from sessionStorage (the key AuthContext.jsx writes to)
// rather than importing AuthContext here, which would create a circular
// import (AuthContext -> apiClient -> AuthContext).
apiClient.interceptors.request.use((config) => {
  try {
    const stored = sessionStorage.getItem(AUTH_STORAGE_KEY);
    if (stored) {
      const { session } = JSON.parse(stored);
      if (session?.access_token) {
        config.headers.Authorization = `Bearer ${session.access_token}`;
      }
    }
  } catch {
    // Malformed storage shouldn't block the request — it'll just go out
    // unauthenticated and the backend will reject it if auth is required.
  }
  return config;
});

// A 401 on a request that carried the signed-in user's token means the session
// is over: tell AuthContext, which clears it and sends the user to login. The
// token sent is compared with the stored one so a slow request from a previous
// session cannot sign out the new one. The error still reaches the caller.
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error?.response?.status === 401 && !isExemptFromExpiry(error.config?.url)) {
      const sent = bearerTokenOf(error.config);
      if (sent && sent === storedAccessToken()) reportSessionRefused(sent);
    }
    return Promise.reject(error);
  },
);

function isExemptFromExpiry(url) {
  if (typeof url !== "string") return false;
  const path = url.split("?")[0];
  return AUTH_PATHS_EXEMPT_FROM_EXPIRY.some((exempt) => path === exempt || path.endsWith(exempt));
}

function bearerTokenOf(config) {
  // The request interceptor always writes "Bearer <token>"; no header, no token.
  return String(config?.headers?.Authorization ?? "").replace(/^Bearer /, "");
}

function storedAccessToken() {
  try {
    const stored = sessionStorage.getItem(AUTH_STORAGE_KEY);
    return stored ? JSON.parse(stored).session?.access_token ?? null : null;
  } catch {
    return null;
  }
}

export default apiClient;
