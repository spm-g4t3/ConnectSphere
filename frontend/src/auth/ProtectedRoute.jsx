// ProtectedRoute.jsx
// Wraps routes to require login, and optionally restrict to specific roles.
//
// Usage:
//   <ProtectedRoute><Dashboard /></ProtectedRoute>
//   <ProtectedRoute allowedRoles={["VENUE_STAFF"]}><VenueCatalogueAdmin /></ProtectedRoute>

import { Navigate } from "react-router-dom";
import { useAuth } from "./AuthContext";

export default function ProtectedRoute({ children, allowedRoles }) {
  const { user, loading } = useAuth();

  if (loading) {
    return <p>Loading...</p>;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return <Navigate to="/unauthorized" replace />;
  }

  return children;
}
