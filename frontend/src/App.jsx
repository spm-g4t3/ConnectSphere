import { BrowserRouter, Navigate, Route, Routes, useParams, useSearchParams } from "react-router-dom";
import { useEffect } from "react";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import ProtectedRoute from "./auth/ProtectedRoute";
import Navigation from "./components/Navigation";
import { UnreadCountProvider } from "./notifications/UnreadCountContext";
import Dashboard from "./components/Dashboard";
import LoginForm from "./components/LoginForm";
import NotAvailablePage from "./components/NotAvailablePage";
import LoadingText from "./components/ui/LoadingText";
import MyEventRequests from "./components/MyEventRequests";
import VenueSearch from "./components/VenueSearch";
import VenueCatalogue from "./components/VenueCatalogue";
import ReviewQueue from "./components/ReviewQueue";
import MyAssignedEvents from "./components/MyAssignedEvents";
import UnassignedQueue from "./components/UnassignedQueue";
import AssignedEvents from "./components/AssignedEvents";
import EventRequestReviewPage from "./components/EventRequestReviewPage";
import MyBookingRequests from "./components/MyBookingRequests";
import PendingBookingRequests from "./components/PendingBookingRequests";
import FlaggedBookings from "./components/FlaggedBookings";
import EquipmentCatalogue from "./components/EquipmentCatalogue";
import VenueCalendar from "./components/VenueCalendar";
import { parseCalendarDate } from "./services/calendarRange";
import EquipmentAvailabilityCheck from "./components/EquipmentAvailabilityCheck";
import EquipmentReview from "./components/EquipmentReview";
import EventRegistrationSettings from "./components/EventRegistrationSettings";
import RegistrationEventsList from "./components/RegistrationEventsList";
import EventRegistrationList from "./components/EventRegistrationList";
import EquipmentRequestQueue from "./components/EquipmentRequestQueue";
import SafetyOfficerDashboard from "./components/SafetyOfficerDashboard";
import SafetyReviewHistory from "./components/SafetyReviewHistory";
import BrowseOpenEvents from "./components/BrowseOpenEvents";
import BrowseEventDetails from "./components/BrowseEventDetails";
import RegisteredEvents from "./components/RegisteredEvents";
import AttendeeEventInformation from "./components/AttendeeEventInformation";
import { REGISTERED_EVENTS_PATH, ATTENDEE_EVENT_ROUTE } from "./services/attendeeEventRoutes";
import { joinWaitlist, registerForEvent } from "./services/registrationService";
import { BROWSE_OPEN_EVENTS_PATH, OPEN_EVENT_DETAILS_ROUTE } from "./services/openEventRoutes";
import "./App.css";

function LoadingScreen() {
  return (
    <main className="loading-screen">
      <LoadingText />
    </main>
  );
}

// The calendar takes its venue from the URL, and optionally the day to open
// on from ?date=YYYY-MM-DD. SCRUM-181 links here from the venue catalogue and
// from venue search results; a search with a window sends that window's start
// date. A missing, malformed or impossible date passes undefined, so the
// component's own default of today applies.
//
// The key holds both, so following a new link remounts the calendar: one
// venue's view, dates and header never carry over onto another's, and a new
// ?date= is not ignored by a calendar that already read its initialDate.
function VenueCalendarRoute() {
  const { venueId } = useParams();
  const [searchParams] = useSearchParams();
  const date = searchParams.get("date");
  return (
    <main className="venue-calendar-page">
      <VenueCalendar
        key={`${venueId} ${date ?? ""}`}
        venueId={venueId}
        initialDate={parseCalendarDate(date) ?? undefined}
      />
    </main>
  );
}

function EventRegistrationSettingsRoute() {
  const { eventId } = useParams();
  return <EventRegistrationSettings key={eventId} eventId={eventId} />;
}

function EventRegistrationListRoute() {
  const { eventId } = useParams();
  return <EventRegistrationList key={eventId} eventId={eventId} />;
}

function AppRoutes() {
  const { user, loading, logoutMessage, clearLogoutMessage } = useAuth();

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
        <Route
          path="/safety-review"
          element={
            <ProtectedRoute allowedRoles={["safety_officer"]}>
              <SafetyOfficerDashboard user={user} />
            </ProtectedRoute>
          }
        />
        <Route
          path="/safety-review/history"
          element={
            <ProtectedRoute allowedRoles={["safety_officer"]}>
              <SafetyReviewHistory />
            </ProtectedRoute>
          }
        />
        <Route path="/events" element={<ProtectedRoute><MyEventRequests /></ProtectedRoute>} />
        <Route path={REGISTERED_EVENTS_PATH} element={
          <ProtectedRoute allowedRoles={["attendee"]}>
            <div className="dashboard dashboard--attendee"><RegisteredEvents /></div>
          </ProtectedRoute>
        } />
        <Route path={ATTENDEE_EVENT_ROUTE} element={
          <ProtectedRoute allowedRoles={["attendee"]}>
            <div className="dashboard dashboard--attendee"><AttendeeEventInformation /></div>
          </ProtectedRoute>
        } />
        <Route
          path="/registration"
          element={
            <ProtectedRoute allowedRoles={["event_organiser"]}>
              <RegistrationEventsList />
            </ProtectedRoute>
          }
        />
        <Route
          path="/events/:eventId/registration"
          element={
            <ProtectedRoute allowedRoles={["event_organiser"]}>
              <EventRegistrationSettingsRoute />
            </ProtectedRoute>
          }
        />
        <Route
          path="/events/:eventId/registrations"
          element={
            <ProtectedRoute allowedRoles={["event_organiser", "event_coordinator"]}>
              <EventRegistrationListRoute />
            </ProtectedRoute>
          }
        />
        {/* VenueSearch was written, correct, and imported by nothing — the route
            rendered a placeholder over a working component. Swapped for the real one. */}
        {/* Internal roles only. Venue search is the Coordinator's planning tool
            (SCRUM-20); an Organiser landing here found a list with nothing to do,
            which read as "pick your venue". Belt to the backend's braces, as with
            /review-queue: an old link now lands on /unauthorized. */}
        <Route
          path="/venue-search"
          element={
            <ProtectedRoute allowedRoles={["event_coordinator", "venue_staff"]}>
              <VenueSearch role={user?.role} userId={user?.id} />
            </ProtectedRoute>
          }
        />
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
        {/* SCRUM-486 (SCRUM-519): the Event Coordinator Lead's unassigned queue,
            also on the Lead's dashboard, given a route of its own as the review
            queue is, so the Lead's nav can link to it. Gated as /review-queue
            is, for the same reason: GET /event-requests/unassigned answers 403
            to anyone else regardless, and allowedRoles turns them away at
            /unauthorized instead of on a page of one error message. Wrapped in
            the Lead's dashboard class so the card styling matches the
            dashboard's. */}
        <Route
          path="/unassigned-queue"
          element={
            <ProtectedRoute allowedRoles={["event_coordinator_lead"]}>
              <div className="dashboard dashboard--coordinator-lead">
                <UnassignedQueue />
              </div>
            </ProtectedRoute>
          }
        />
        {/* SCRUM-486 AC6: every event someone holds in an active status, for
            the Event Coordinator Lead, each row opening the event's page below.
            Gated as /unassigned-queue is, for the same reason: GET
            /event-requests/assigned answers 403 to anyone else regardless.
            Wrapped in the coordinator class, not the Lead's, as the event page
            below is: App.css colours the status badge under
            .dashboard--coordinator only, and this list shows one per row. */}
        <Route
          path="/assigned-events"
          element={
            <ProtectedRoute allowedRoles={["event_coordinator_lead"]}>
              <div className="dashboard dashboard--coordinator">
                <AssignedEvents />
              </div>
            </ProtectedRoute>
          }
        />
        {/* SCRUM-486 (SCRUM-521): one event's coordinator screen by its address,
            so the Event Coordinator Lead can open an event they do not hold and
            hand it over (AC6). Coordinators may open it too. allowedRoles
            mirrors GET /event-requests/:id/review's gate; the API answers 403
            to anyone else regardless. The Lead reaches it from
            /assigned-events above, the list SCRUM-486 built and SCRUM-487
            extended into the coordinator overview (see the page's header).

            The coordinator wrapper for both roles, because App.css colours the
            status badge under .dashboard--coordinator only. */}
        <Route
          path="/event-requests/:eventRequestId"
          element={
            <ProtectedRoute allowedRoles={["event_coordinator", "event_coordinator_lead"]}>
              <div className="dashboard dashboard--coordinator">
                <EventRequestReviewPage />
              </div>
            </ProtectedRoute>
          }
        />
        {/* SCRUM-255: the coordinator's venue booking requests and their
            statuses. Gated and wrapped as /my-events is, for the same reasons:
            GET /booking-requests/mine is role-checked server-side, and the
            wrapper is what colours the status badges. */}
        <Route
          path="/my-venue-requests"
          element={
            <ProtectedRoute allowedRoles={["event_coordinator"]}>
              <div className="dashboard dashboard--coordinator">
                <MyBookingRequests />
              </div>
            </ProtectedRoute>
          }
        />
        {/* Attendees only, like the API, so a direct URL from another role lands
            on /unauthorized, not on a page that is only an error. The
            .dashboard wrapper gives the pages their card styling. */}
        <Route
          path={BROWSE_OPEN_EVENTS_PATH}
          element={
            <ProtectedRoute allowedRoles={["attendee"]}>
              <div className="dashboard dashboard--attendee">
                <BrowseOpenEvents />
              </div>
            </ProtectedRoute>
          }
        />
        <Route
          path={OPEN_EVENT_DETAILS_ROUTE}
          element={
            <ProtectedRoute allowedRoles={["attendee"]}>
              <div className="dashboard dashboard--attendee">
                <BrowseEventDetails onRegister={registerForEvent} onJoinWaitlist={joinWaitlist} />
              </div>
            </ProtectedRoute>
          }
        />
        <Route
          path="/equipment-catalogue"
          element={
            <ProtectedRoute allowedRoles={["technical_support_staff"]}>
              <EquipmentCatalogue />
            </ProtectedRoute>
          }
        />
        <Route
          path="/equipment-review/:eventId"
          element={
            <ProtectedRoute allowedRoles={["technical_support_staff"]}>
              <EquipmentReview />
            </ProtectedRoute>
          }
        />
        <Route
          path="/equipment-availability"
          element={
            <ProtectedRoute allowedRoles={["technical_support_staff"]}>
              <EquipmentAvailabilityCheck />
            </ProtectedRoute>
          }
        />
        {/* SCRUM-180 (part of SCRUM-178): one venue's calendar of bookings and
            blocks, linked from the catalogue and from venue search (SCRUM-181).
            Internal roles only (SCRUM-182, SCRUM-178 AC6): the same two roles
            the backend's GET /venues/:id/calendar admits. Belt to the backend's
            braces, as with /venue-search: the API answers 403 regardless, and
            what this buys is the failure mode -- an Organiser who follows a link
            here lands on /unauthorized instead of on a calendar frame whose
            only content is an error message. */}
        <Route
          path="/venues/:venueId/calendar"
          element={
            <ProtectedRoute allowedRoles={["event_coordinator", "venue_staff"]}>
              <VenueCalendarRoute />
            </ProtectedRoute>
          }
        />
        {/* Where ProtectedRoute sends a signed-in user whose role is not allowed.
            Deliberately unprotected: a signed-out user never reaches it, because
            ProtectedRoute's `!user` branch redirects to /login before the role
            check runs. Wrapping it would only risk a redirect loop. */}
        <Route path="/unauthorized" element={<NotAvailablePage />} />
        {/* SCRUM-258: Venue Staff's queue of open booking requests, the same
            component the Venue Staff dashboard shows, so the nav link and the
            dashboard are two ways into one screen. Gated and wrapped as
            /venue-catalogue is: GET /booking-requests/pending answers 403 to
            anyone else regardless, and the wrapper styles the cards and badges. */}
        <Route
          path="/booking-requests"
          element={
            <ProtectedRoute allowedRoles={["venue_staff"]}>
              <div className="dashboard dashboard--venue-staff">
                <PendingBookingRequests />
              </div>
            </ProtectedRoute>
          }
        />
        {/* Venue Staff's flagged bookings, the same component the dashboard
            shows, wrapped as /booking-requests is. GET /flagged-bookings
            answers 403 to anyone else regardless. */}
        <Route
          path="/flagged-bookings"
          element={
            <ProtectedRoute allowedRoles={["venue_staff"]}>
              <div className="dashboard dashboard--venue-staff">
                <FlaggedBookings />
              </div>
            </ProtectedRoute>
          }
        />
        {/* Technical support staff only. The queue renders <section>s and no dashboard
            wrapper, so the wrapper is supplied here, as /review-queue does. */}
        <Route
          path="/equipment"
          element={
            <ProtectedRoute allowedRoles={["technical_support_staff"]}>
              <div className="dashboard dashboard--tech-support">
                <h1>Equipment request queue</h1>
                <EquipmentRequestQueue />
              </div>
            </ProtectedRoute>
          }
        />
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
        <UnreadCountProvider>
          <div className="app-shell">
            <AppRoutes />
          </div>
        </UnreadCountProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
