// VenueStaffDashboard.jsx
//
// SCRUM-110, AC3: "A venue can be retired so it no longer appears in
// searches, while its past bookings remain viewable." The backend half has
// existed since 005_venue_retirement.sql; this is the seat it is finally
// driven from.
//
// The catalogue reads GET /venues rather than /venues/search on purpose:
// search cannot return a retired venue and does not even select the column,
// so it could never render the Active/Retired distinction this section
// exists to show. GET /venues is Venue Staff only for the matching reason.

import { useEffect, useState, useCallback } from "react";
import {
  getPendingBookingRequests,
  getVenueCatalogue,
  retireVenue,
} from "../services/venueService";

// Keyed by status, the same shape as AuthContext's LOGIN_ERROR_MESSAGES.
//
// The server's own message is deliberately not surfaced. EventRequestForm
// passes err.response.data.error straight through because those come from a
// validator, about a form the user just filled in. These do not: the 409 body
// is "venue <uuid> is already retired" — database prose carrying a raw uuid.
// But one hard-coded line would be worse than either, because "Could not
// retire this venue" is a lie when the truth is that it already is retired.
// The status code carries the meaning the body cannot be shown for.
const RETIRE_ERROR_MESSAGES = {
  400: "That venue id was not recognised. Please refresh and try again.",
  403: "Only Venue Staff can retire a venue.",
  404: "That venue no longer exists. The catalogue has been refreshed.",
  409: "That venue has already been retired.",
};

export default function VenueStaffDashboard({ user }) {
  const [pendingRequests, setPendingRequests] = useState([]);

  const [venues, setVenues] = useState([]);
  const [loadingVenues, setLoadingVenues] = useState(true);
  const [venuesError, setVenuesError] = useState(null);

  // Ids rather than booleans. The house pattern is one named flag per
  // in-flight action, but retiring is per row, and an id is that flag
  // generalised: a shared boolean would grey out every other row's button
  // while one row was mid-request. retireError carries its row's id for the
  // same reason — one state variable, rendered under the row it belongs to.
  const [confirmingId, setConfirmingId] = useState(null); // row awaiting confirmation
  const [retiringId, setRetiringId] = useState(null);     // row whose retire is in flight
  const [retireError, setRetireError] = useState(null);   // { id, message }

  const fetchVenues = useCallback(async () => {
    setLoadingVenues(true);
    try {
      const data = await getVenueCatalogue();
      setVenues(data);
      setVenuesError(null);
    } catch {
      setVenuesError("Could not load the venue catalogue. Please try again.");
    } finally {
      setLoadingVenues(false);
    }
  }, []);

  // No focus/visibilitychange refetch, unlike MyEventRequests. That pattern
  // exists there because a Coordinator can move an Organiser's request out
  // from under them. Venue Staff are the only people who can change this
  // list, so nobody is racing the person reading it.
  useEffect(() => {
    fetchVenues();
  }, [fetchVenues]);

  // Still a stub with no endpoint behind it, so it resolves to [] rather than
  // rejecting. The .catch is here so the day that stops being true shows up
  // as an empty section rather than an unhandled rejection.
  useEffect(() => {
    getPendingBookingRequests()
      .then(setPendingRequests)
      .catch(() => setPendingRequests([]));
  }, []);

  async function handleRetire(venue) {
    if (retiringId) return; // closes the double-click window before it opens

    // confirmingId is deliberately NOT cleared here. The "Retiring..." label
    // and the two disabled buttons live inside the confirm block, so clearing
    // it now -- batched with setRetiringId into one render -- would unmount
    // that block the instant the request started and put the plain, enabled
    // "Retire venue" button back in its place. The in-flight state would be
    // unreachable by construction. The row stays in confirm mode until the
    // finally below, which is the only thing that makes the disabled state
    // visible at all.
    setRetiringId(venue.id);
    setRetireError(null);

    try {
      await retireVenue(venue.id);
      // Refetch rather than splicing the response in. POST /:id/retire
      // answers with getVenueById's fat shape (layouts, hours, createdAt,
      // lastModifiedBy) while these rows are the flat five-field shape, so
      // splicing would leave the array holding two kinds of object; the
      // ordering is the server's ORDER BY name, not ours; and the 409/404
      // paths below need a refetch anyway, so one recovery path beats two.
      await fetchVenues();
    } catch (err) {
      const status = err.response?.status;
      setRetireError({
        id: venue.id,
        message:
          RETIRE_ERROR_MESSAGES[status] ||
          "Could not retire this venue. Please try again.",
      });
      // Either of these means our copy of the row is stale, whoever made it so.
      if (status === 409 || status === 404) await fetchVenues();
    } finally {
      // Both flags drop together, once there is something new to show. On the
      // success path the refetched row is retired, so !retired hides the
      // confirm block regardless; on the error path this returns the row to
      // the plain "Retire venue" button with the message beside it, which is
      // the state someone would want to retry from.
      setRetiringId(null);
      setConfirmingId(null);
    }
  }

  return (
    <div className="dashboard dashboard--venue-staff">
      {/* user.name does not exist: auth.js:44-51 returns { id, email, role }
          and never selects profiles.full_name, so this rendered "Welcome, "
          with nothing after it. The email is the honest fallback; the real
          fix is server-side and has its own ticket. */}
      <h1>Welcome, {user.name ?? user.email}</h1>

      <section>
        <h2>Pending booking requests</h2>
        <ul>
          {pendingRequests.map((req) => (
            <li key={req.id}>
              {req.venueName} — requested by {req.requesterName}
              <button>Approve</button>
              <button>Reject</button>
            </li>
          ))}
          {pendingRequests.length === 0 && <p>No pending requests.</p>}
        </ul>
      </section>

      <section>
        <h2>Venue catalogue</h2>

        {loadingVenues && <p>Loading...</p>}
        {venuesError && (
          <p className="venue-catalogue__error" role="alert">
            {venuesError}
          </p>
        )}
        {!loadingVenues && !venuesError && venues.length === 0 && (
          <p>No venues in the catalogue yet.</p>
        )}

        <ul>
          {venues.map((venue) => {
            // Boolean(), not !== null: a row that arrives without the key at
            // all — an older server, a stale cache — then reads as active
            // rather than being badged Retired on the strength of undefined.
            const retired = Boolean(venue.retiredAt);
            const confirming = confirmingId === venue.id;
            const retiring = retiringId === venue.id;

            return (
              <li key={venue.id}>
                <div className="venue-catalogue__item-main">
                  <strong>{venue.name}</strong> — {venue.location}
                  <span
                    className={`status-badge ${retired ? "status--retired" : "status--active"}`}
                  >
                    {retired ? "Retired" : "Active"}
                  </span>
                  {retireError?.id === venue.id && (
                    <p className="venue-catalogue__error" role="alert">
                      {retireError.message}
                    </p>
                  )}
                </div>

                <div className="venue-catalogue__item-actions">
                  {/* Disabled on a retired venue because update_venue has no
                      retirement check of its own: a PATCH would succeed
                      server-side and quietly edit a venue nobody can book.
                      The button does nothing yet either way, so this costs
                      nothing now and pre-empts the question later. */}
                  <button
                    disabled={retired}
                    title={retired ? "A retired venue cannot be edited." : undefined}
                  >
                    Edit details
                  </button>

                  {/* Two-step inline confirmation rather than a modal or
                      window.confirm. Retirement is the first irreversible
                      action in this app — 005_venue_retirement.sql defines no
                      un-retire — so it warrants confirming; but there is not
                      one modal, dialog element or window.confirm anywhere in
                      this frontend, and introducing the first of them for a
                      single button is a new primitive to maintain. A state
                      variable and two buttons are neither. */}
                  {!retired && !confirming && (
                    <button
                      onClick={() => setConfirmingId(venue.id)}
                      title="A retired venue stops appearing in searches. Its past bookings stay viewable. This cannot be undone."
                    >
                      Retire venue
                    </button>
                  )}

                  {!retired && confirming && (
                    <>
                      <span>Retire this venue? It cannot be undone.</span>
                      <button onClick={() => handleRetire(venue)} disabled={retiring}>
                        {retiring ? "Retiring..." : "Yes, retire"}
                      </button>
                      <button onClick={() => setConfirmingId(null)} disabled={retiring}>
                        Cancel
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        <button>+ Add new venue</button>
      </section>
    </div>
  );
}
