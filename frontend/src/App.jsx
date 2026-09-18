// App.jsx
// Top-level routing. Adapt further as you add more pages.

import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import ProtectedRoute from "./auth/ProtectedRoute";
import LoginForm from "./components/LoginForm";
import Dashboard from "./components/Dashboard";
import VenueSearch from "./components/VenueSearch";

/** Sends "/" to /dashboard if logged in, otherwise to /login. */
function RootRedirect() {
  const { user, loading } = useAuth();

  if (loading) return <p>Loading...</p>;

  return <Navigate to={user ? "/dashboard" : "/login"} replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<RootRedirect />} />

          <Route path="/login" element={<LoginForm />} />

          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            }
          />

          <Route
            path="/venue-search"
            element={
              <ProtectedRoute>
                <VenueSearch />
              </ProtectedRoute>
            }
          />

          <Route path="/unauthorized" element={<p>You don't have access to this page.</p>} />

          {/* Catch-all: any unrecognised path goes back to the root, which
              then redirects based on auth state. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}