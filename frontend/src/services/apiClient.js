// apiClient.js
//
// The one place the frontend's base API URL and shared request config live.
// Every service file (AuthContext, venueService, eventRequestService, etc.)
// imports this rather than constructing its own axios instance.
//
// Requires axios: npm install axios
//
// Base URL comes from an env var so it's different in dev vs. production
// without editing code. Uses Vite's import.meta.env convention — if your
// project uses Create React App instead, swap this for
// process.env.REACT_APP_API_BASE_URL and adjust the .env key name to match.

import axios from "axios";

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
// Reads directly from sessionStorage (the same key AuthContext.jsx writes
// to) rather than importing AuthContext here, which would create a circular
// import (AuthContext -> apiClient -> AuthContext).
apiClient.interceptors.request.use((config) => {
  try {
    const stored = sessionStorage.getItem("connectsphere_auth");
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

apiClient.interceptors.response.use(
  (response) => response,
  (error) => Promise.reject(error),
);

export default apiClient;
