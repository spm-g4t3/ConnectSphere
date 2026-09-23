// VenueCatalogue.jsx
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
//
// Lifted out of VenueStaffDashboard unchanged. The dashboard was 237 lines
// with three panels about to hang off it, and the catalogue is the only part
// of it with its own route in Phase 3 -- without the split, /venue-catalogue
// would have to render a second copy of the greeting and the pending-requests
// stub. The retire flow below is a move, not a rewrite: same two-step
// confirm, same error map, same refetch-rather-than-splice, same finally.

import { useEffect, useState, useCallback } from "react";
import { getVenueCatalogue, retireVenue } from "../services/venueService";
import VenueForm from "./VenueForm";
import VenueDetail from "./VenueDetail";

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

export default function VenueCatalogue() {
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

  // Which panel is open, if any: { mode: "create" } | { mode: "edit", venue }
  // | { mode: "detail", venue } | null. Copied from MyEventRequests, which is
  // where this app decided that a full-page panel with a Back button is what
  // it does instead of a modal — there is not one modal, <dialog> or
  // window.confirm anywhere in this frontend and this is not the place to
  // introduce the first.
  const [activePanel, setActivePanel] = useState(null);

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

  // Close the panel, then refetch. Refetch rather than splice for the same
  // reason handleRetire does it: create and update both answer with
  // getVenueById's fat shape while these rows are the flat five-field one.
  function handleSaved() {
    setActivePanel(null);
    fetchVenues();
  }

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

  if (activePanel?.mode === "create") {
    return (
      <section>
        <button onClick={() => setActivePanel(null)}>
          &larr; Back to the venue catalogue
        </button>
        <VenueForm onSaved={handleSaved} />
      </section>
    );
  }

  if (activePanel?.mode === "edit") {
    return (
      <section>
        <button onClick={() => setActivePanel(null)}>
          &larr; Back to the venue catalogue
        </button>
        <VenueForm venueId={activePanel.venue.id} onSaved={handleSaved} />
      </section>
    );
  }

  if (activePanel?.mode === "detail") {
    return (
      <section>
        <button onClick={() => setActivePanel(null)}>
          &larr; Back to the venue catalogue
        </button>
        {/* No onSaved: this panel reads and changes nothing, so closing it
            needs no refetch. */}
        <VenueDetail venue={activePanel.venue} />
      </section>
    );
  }

  return (
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
                    Now that the button opens a real form, that is no longer
                    hypothetical. */}
                <button
                  disabled={retired}
                  title={retired ? "A retired venue cannot be edited." : undefined}
                  onClick={() => setActivePanel({ mode: "edit", venue })}
                >
                  Edit details
                </button>

                {/* Pointedly NOT disabled when retired. AC3 is two clauses,
                    and this is the second one: a retired venue stops
                    appearing in searches *while its past bookings remain
                    viewable*. Greying this out on a retired row would make
                    retirement a delete after all. */}
                <button onClick={() => setActivePanel({ mode: "detail", venue })}>
                  View bookings &amp; history
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

      <button onClick={() => setActivePanel({ mode: "create" })}>+ Add new venue</button>
    </section>
  );
}
