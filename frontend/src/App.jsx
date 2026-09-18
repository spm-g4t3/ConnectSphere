// App.jsx
// Top-level routing. Adapt further as you add more pages.

import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import ProtectedRoute from "./auth/ProtectedRoute";
import LoginForm from "./components/LoginForm";
import Dashboard from "./components/Dashboard";
import VenueSearch from "./components/VenueSearch";

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
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

          {/* Add more routes here as you build more pages, e.g.:
          <Route
            path="/venue-catalogue"
            element={
              <ProtectedRoute allowedRoles={["VENUE_STAFF"]}>
                <VenueCatalogueAdmin />
              </ProtectedRoute>
            }
          />
          */}

          <Route path="/unauthorized" element={<p>You don't have access to this page.</p>} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
