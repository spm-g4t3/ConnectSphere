import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { useEffect } from "react";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import ProtectedRoute from "./auth/ProtectedRoute";
import Navigation from "./components/Navigation";
import Dashboard from "./components/Dashboard";
import LoginForm from "./components/LoginForm";
import MyEventRequests from "./components/MyEventRequests";
import VenueSearch from "./components/VenueSearch";
import VenueCatalogue from "./components/VenueCatalogue";
import ReviewQueue from "./components/ReviewQueue";
import MyAssignedEvents from "./components/MyAssignedEvents";
import "./App.css";

function LoadingScreen() {
  return <main className="loading-screen">Loading ConnectSphere...</main>;
}

function PagePlaceholder({ title, description }) {
  return (
    <main className="placeholder-page">
      <span className="eyebrow">ConnectSphere workspace</span>
      <h1>{title}</h1>
      <p>{description}</p>
    </main>
  );
}

function AppRoutes() {
  const { loading, logoutMessage, clearLogoutMessage } = useAuth();

  useEffect(() => {
    if (!logoutMessage) return undefined;

    const timeout = setTimeout(clearLogoutMessage, 3500);
    return () => clearTimeout(timeout);
  }, [logoutMessage, clearLogoutMessage]);

  if (loading) return <LoadingScreen />;

  return (
    <>
      <Navigation />
      {logoutMessage && <p className="auth-success" role="status">{logoutMessage}</p>}
      <Routes>
        <Route path="/login" element={<LoginForm />} />
        <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/events" element={<ProtectedRoute><MyEventRequests /></ProtectedRoute>} />
        {/* VenueSearch was written, correct, and imported by nothing — the route
            rendered a placeholder over a working component. Swapped for the real one. */}
        <Route path="/venue-search" element={<ProtectedRoute><VenueSearch /></ProtectedRoute>} />
        {/* First real user of allowedRoles in the app, which is why ProtectedRoute had
            to start normalising both sides first: the token says `venue_staff`.
            The `dashboard dashboard--venue-staff` wrapper is not decoration — the
            catalogue's panels are styled entirely through that scope in App.css
            (e.g. `.dashboard--venue-staff .venue-form li`), so without it the
            standalone route renders visibly broken while the dashboard one does not. */}
        <Route
          path="/venue-catalogue"
          element={
            <ProtectedRoute allowedRoles={["venue_staff"]}>
              <div className="dashboard dashboard--venue-staff">
                <VenueCatalogue />
              </div>
            </ProtectedRoute>
          }
        />
        {/* SCRUM-45. The Coordinator's nav link points here rather than at /events,
            which renders MyEventRequests over the organiser-scoped endpoint and so
            told every Coordinator "You haven't created any event requests yet."

            allowedRoles is belt to the backend's braces, not the gate itself:
            GET /event-requests/queue is role-checked server-side and would answer
            403 regardless. What this buys is the failure mode — an Organiser who
            follows a link here lands on /unauthorized instead of on a page whose
            only content is an error message.

            The `dashboard dashboard--coordinator` wrapper is not decoration, for
            the same reason /venue-catalogue's is not: App.css scopes .status-badge
            and the .status--* colours to a dashboard class deliberately, so
            without the wrapper every badge in the queue renders as bare text. */}
        <Route
          path="/review-queue"
          element={
            <ProtectedRoute allowedRoles={["event_coordinator"]}>
              <div className="dashboard dashboard--coordinator">
                <ReviewQueue />
              </div>
            </ProtectedRoute>
          }
        />
        {/* SCRUM-333: the coordinator's own events, every status, grouped.
            /my-events and not /events, which is the Organiser's page
            (MyEventRequests over the organiser-scoped endpoint).

            Gated and wrapped exactly as /review-queue is, for the same two
            reasons: allowedRoles turns an Organiser who follows a link here
            into /unauthorized rather than a page of one error message (the
            backend's GET /mine answers 403 regardless), and the wrapper is what
            colours the badges, since App.css scopes them to a dashboard class. */}
        <Route
          path="/my-events"
          element={
            <ProtectedRoute allowedRoles={["event_coordinator"]}>
              <div className="dashboard dashboard--coordinator">
                <MyAssignedEvents />
              </div>
            </ProtectedRoute>
          }
        />
        {/* Where ProtectedRoute sends a signed-in user whose role is not allowed.
            Deliberately unprotected: a signed-out user never reaches it, because
            ProtectedRoute's `!user` branch redirects to /login before the role
            check runs. Wrapping it would only risk a redirect loop. */}
        <Route path="/unauthorized" element={<PagePlaceholder title="Not available to your role" description="Your account does not have access to that page. If you think it should, ask an administrator to check your role." />} />
        {/* The next three are placeholders on purpose, and the nav links that point
            at them are kept on purpose. A future sprint builds exactly these three
            features, so deleting the links now just means re-adding them then. What
            was wrong before was not the links — it was that they fell through to the
            catch-all below and silently bounced the user to /dashboard with no
            explanation. An honest "being built" page is truthful today and becomes
            the real page later. Do not "tidy" these away. */}
        <Route path="/booking-requests" element={<ProtectedRoute><PagePlaceholder title="Booking requests" description="Booking requests are still being built. Venue staff will review and respond to incoming booking requests here in a future release. Nothing is waiting for you behind this page yet." /></ProtectedRoute>} />
        <Route path="/tickets" element={<ProtectedRoute><PagePlaceholder title="Support tickets" description="Support tickets are still being built. Technical support staff will raise, triage and close event support tickets here in a future release. Nothing is waiting for you behind this page yet." /></ProtectedRoute>} />
        <Route path="/equipment" element={<ProtectedRoute><PagePlaceholder title="Equipment requests" description="Equipment requests are still being built. Technical support staff will track equipment allocated to each event here in a future release. Nothing is waiting for you behind this page yet." /></ProtectedRoute>} />
        {/* Catch-all stays last: React Router picks the best match rather than the
            first, but keeping `*` at the bottom is what a reader expects. */}
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <div className="app-shell">
          <AppRoutes />
        </div>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
