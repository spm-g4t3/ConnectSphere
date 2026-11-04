// ProtectedRoute.jsx
// Wraps routes to require login, and optionally restrict to specific roles.
//
// Usage:
//   <ProtectedRoute><Dashboard /></ProtectedRoute>
//   <ProtectedRoute allowedRoles={["VENUE_STAFF"]}><VenueCatalogueAdmin /></ProtectedRoute>

import { Navigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { normaliseRole } from "./normaliseRole";

export default function ProtectedRoute({ children, allowedRoles }) {
  const { user, loading } = useAuth();

  if (loading) {
    return <p>Loading...</p>;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // Both sides are normalised, and that is a bug fix rather than tidying. The
  // token carries `venue_staff`; the usage this file's own docblock advertises
  // writes `allowedRoles={["VENUE_STAFF"]}`. A raw === between those two is
  // always false, so the first real allowedRoles usage would have bounced
  // every genuine Venue Staff member to /unauthorized. Comparing canonical
  // keys means a call site may spell the role however reads best.
  if (allowedRoles && !allowedRoles.map(normaliseRole).includes(normaliseRole(user.role))) {
    return <Navigate to="/unauthorized" replace />;
  }

  return children;
}
