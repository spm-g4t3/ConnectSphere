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
// stub.

import { useEffect, useRef, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { getVenueCatalogue, retireVenue } from "../services/venueService";
import VenueForm from "./VenueForm";
import VenueDetail from "./VenueDetail";
import VenueBlocksPanel from "./VenueBlocksPanel";
import VenueHoldsPanel from "./VenueHoldsPanel";
import { formatOccupiedPeriod } from "../services/occupiedPeriodDisplay";
import Button from "./ui/Button";
import StatusBadge from "./ui/StatusBadge";
import LoadingText from "./ui/LoadingText";
import EmptyState from "./ui/EmptyState";
import ErrorNotice from "./ui/ErrorNotice";
import ConfirmDialog from "./ui/ConfirmDialog";
import { formatDateTimeRange } from "../services/displayFormat";
import { VENUE_TONES } from "../services/venueStatusTones";
import { flaggedBookingsHeading, venueSaveFlagReasons } from "../services/flaggedBookingDisplay";

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

// currentUserId (SCRUM-131) is only passed through, to VenueBlocksPanel, so
// a block's audit line and history can say "you" for the signed-in user's own
// changes. Optional: without it those show as a short id.
export default function VenueCatalogue({ currentUserId, asPage = false } = {}) {
  const [venues, setVenues] = useState([]);
  const [loadingVenues, setLoadingVenues] = useState(true);
  const [venuesError, setVenuesError] = useState(null);

  // Ids rather than booleans. The house pattern is one named flag per
  // in-flight action, but retiring is per row, and an id is that flag
  // generalised: a shared boolean would grey out every other row's button
  // while one row was mid-request. retireError carries its row's id for the
  // same reason — one state variable, rendered under the row it belongs to.
  const [confirmingId, setConfirmingId] = useState(null); // row whose dialog is open
  const [retiringId, setRetiringId] = useState(null);     // row whose retire is in flight
  const [retireError, setRetireError] = useState(null);   // { id, message }

  // Which panel is open, if any: { mode: "create" } | { mode: "edit", venue }
  // | { mode: "detail", venue } | { mode: "blocks", venue }
  // | { mode: "holds", venue } (SCRUM-491) | null. A full-page panel with a
  // Back button, as in MyEventRequests: each is a screen of its own, not a
  // question to answer.
  const [activePanel, setActivePanel] = useState(null);

  // The Retire button that opened the dialog, and each row's main text, so
  // focus can go back to the button, or to the row once it has no button.
  const retireOpener = useRef(null); // { id, button }
  const rowMains = useRef(new Map());

  // The button that opened the current panel, keyed "<venue id> <mode>" (or
  // "create"), so Back can return focus to it once the list is back.
  const panelOpener = useRef(null); // { key, id }
  const panelButtons = useRef(new Map());
  // Set when a panel opens; cleared once its heading has taken focus. A flag
  // rather than an effect because the edit form's heading only appears once
  // the venue has loaded.
  const headingFocusPending = useRef(false);
  const focusPanelHeading = useCallback((heading) => {
    if (!heading || !headingFocusPending.current) return;
    headingFocusPending.current = false;
    heading.focus();
  }, []);

  // SCRUM-484 (AC8). The bookings the last save flagged for review, because a
  // new setup or turnaround time made them overlap. Kept until dismissed or
  // replaced by the next save, so it survives the refetch and stays readable
  // after the form closes. Empty means no notice.
  const [flaggedBookings, setFlaggedBookings] = useState([]);
  // The name of the venue whose save flagged them, for the notice's heading.
  // Kept beside the list, not looked up from venues, so it stays the name
  // the save answered with even if the catalogue refetch has not landed.
  const [flaggedVenueName, setFlaggedVenueName] = useState(null);
  // Why they were flagged: new hours, a new setup or turnaround, or both.
  const [flaggedReasons, setFlaggedReasons] = useState([]);

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

  // The error clears first, so a second failure is visibly a new one.
  function retryVenues() {
    setVenuesError(null);
    fetchVenues();
  }

  // No focus/visibilitychange refetch, unlike MyEventRequests. That pattern
  // exists there because a Coordinator can move an Organiser's request out
  // from under them. Venue Staff are the only people who can change this
  // list, so nobody is racing the person reading it.
  useEffect(() => {
    fetchVenues();
  }, [fetchVenues]);

  // Runs once the dialog has closed: focus cannot move out of an open modal.
  // A retired row has no Retire button, so its name and Retired badge take it.
  useEffect(() => {
    if (confirmingId !== null || !retireOpener.current) return;
    const { id, button } = retireOpener.current;
    retireOpener.current = null;
    (button.isConnected ? button : rowMains.current.get(id))?.focus();
  }, [confirmingId]);

  // Runs once the list is back. A button that went away or was disabled
  // meanwhile (the venue was retired) hands focus to its row instead.
  useEffect(() => {
    if (activePanel !== null || !panelOpener.current) return;
    const { key, id } = panelOpener.current;
    panelOpener.current = null;
    headingFocusPending.current = false;
    const button = panelButtons.current.get(key);
    (button && !button.disabled ? button : rowMains.current.get(id))?.focus();
  }, [activePanel]);

  function openPanel(mode, venue = null) {
    panelOpener.current = { key: venue ? `${venue.id} ${mode}` : mode, id: venue?.id };
    headingFocusPending.current = true;
    setActivePanel(venue ? { mode, venue } : { mode });
  }

  /** Records one of the panel buttons for Back; called from its ref callback. */
  function trackPanelButton(key, element) {
    panelButtons.current.set(key, element);
    return () => panelButtons.current.delete(key);
  }

  function openRetire(venue, event) {
    retireOpener.current = { id: venue.id, button: event.currentTarget };
    setConfirmingId(venue.id);
  }

  // Close the panel, then refetch. Refetch rather than splice for the same
  // reason handleRetire does it: create and update both answer with
  // getVenueById's fat shape while these rows are the flat five-field one.
  //
  // An update also answers with flaggedBookings (AC8). A save that flagged
  // some replaces the notice; one that flagged none leaves the old notice as
  // it was, since it carries no news either way. Called with no argument by
  // the blocks panel's Back button, which leaves it alone as well.
  // confirmedHoursChange (from VenueForm) tells hours flags from setup ones.
  function handleSaved(saved, { confirmedHoursChange = [] } = {}) {
    setActivePanel(null);
    if (Array.isArray(saved?.flaggedBookings) && saved.flaggedBookings.length > 0) {
      setFlaggedBookings(saved.flaggedBookings);
      setFlaggedVenueName(saved.name ?? null);
      setFlaggedReasons(venueSaveFlagReasons(saved.flaggedBookings, confirmedHoursChange));
    }
    fetchVenues();
  }

  async function handleRetire(venue) {
    if (retiringId) return; // closes the double-click window before it opens

    // confirmingId is deliberately NOT cleared here: the dialog stays open,
    // busy and labelled "Retiring...", until the finally below, so the request
    // is visibly in flight and cannot be cancelled or sent twice.
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
      // Both flags drop together, once there is something new to show: the
      // refetched, retired row, or the row's error beside its Retire button,
      // which is the state someone would want to retry from.
      setRetiringId(null);
      setConfirmingId(null);
    }
  }

  // On its own route the catalogue is the page; on the dashboard it is a
  // section under the greeting's h1. The page keeps its h1 while a panel is
  // open, since the panel replaces the list.
  const Title = asPage ? "h1" : "h2";
  const confirmingVenue = venues.find((venue) => venue.id === confirmingId);
  const pageTitle = asPage && <h1>Venue catalogue</h1>;

  if (activePanel?.mode === "create") {
    return (
      <section>
        {pageTitle}
        <Button variant="link" onClick={() => setActivePanel(null)}>
          &larr; Back to the venue catalogue
        </Button>
        <VenueForm onSaved={handleSaved} headingRef={focusPanelHeading} />
      </section>
    );
  }

  if (activePanel?.mode === "edit") {
    return (
      <section>
        {pageTitle}
        <Button variant="link" onClick={() => setActivePanel(null)}>
          &larr; Back to the venue catalogue
        </Button>
        <VenueForm
          venueId={activePanel.venue.id}
          onSaved={handleSaved}
          headingRef={focusPanelHeading}
        />
      </section>
    );
  }

  if (activePanel?.mode === "detail") {
    return (
      <section>
        {pageTitle}
        <Button variant="link" onClick={() => setActivePanel(null)}>
          &larr; Back to the venue catalogue
        </Button>
        {/* No onSaved: this panel reads and changes nothing, so closing it
            needs no refetch. */}
        <VenueDetail venue={activePanel.venue} headingRef={focusPanelHeading} />
      </section>
    );
  }

  if (activePanel?.mode === "blocks") {
    return (
      <section>
        {pageTitle}
        {/* handleSaved, not a bare close: the panel can learn the venue was
            retired meanwhile (VENUE_RETIRED), and the catalogue row should
            say so when we come back to it. */}
        <Button variant="link" onClick={handleSaved}>&larr; Back to the venue catalogue</Button>
        <VenueBlocksPanel
          venue={activePanel.venue}
          currentUserId={currentUserId}
          headingRef={focusPanelHeading}
        />
      </section>
    );
  }

  // SCRUM-491. The same shape as the blocks panel, and handleSaved on Back
  // for the same reason: the hold panel can learn the venue was retired.
  if (activePanel?.mode === "holds") {
    return (
      <section>
        {pageTitle}
        <Button variant="link" onClick={handleSaved}>&larr; Back to the venue catalogue</Button>
        <VenueHoldsPanel
          venue={activePanel.venue}
          currentUserId={currentUserId}
          headingRef={focusPanelHeading}
        />
      </section>
    );
  }

  return (
    <section>
      <Title>Venue catalogue</Title>

      {/* A status region on the catalogue itself, not a modal or a page of
          its own: the coordinators have already been notified, so there is
          nothing to decide here, only something to know. */}
      {flaggedBookings.length > 0 && (
        <div className="venue-catalogue__flagged" role="status">
          <h3>{flaggedBookingsHeading(flaggedBookings.length, flaggedVenueName, flaggedReasons)}</h3>
          <ul className="venue-catalogue__flagged-list">
            {flaggedBookings.map((booking, i) => (
              <li key={booking.bookingId ?? i}>
                <strong>{booking.eventName || "Unnamed event"}</strong>
                <span>{formatOccupiedPeriod(booking, formatDateTimeRange)}</span>
              </li>
            ))}
          </ul>
          {/* Qualified, because an event can have no coordinator assigned
              yet, and then nobody was notified about it. */}
          <p>
            Where an event has an assigned coordinator, they have been notified.
          </p>
          <Button variant="secondary" onClick={() => setFlaggedBookings([])}>
            Dismiss
          </Button>
        </div>
      )}

      {loadingVenues && <LoadingText />}
      {venuesError && <ErrorNotice message={venuesError} onRetry={retryVenues} />}
      {!loadingVenues && !venuesError && venues.length === 0 && (
        <EmptyState
          message="No venues in the catalogue yet."
          nextStep="Add a venue with + Add new venue."
        />
      )}

      <ul>
        {venues.map((venue) => {
          // Boolean(), not !== null: a row that arrives without the key at
          // all — an older server, a stale cache — then reads as active
          // rather than being badged Retired on the strength of undefined.
          const retired = Boolean(venue.retiredAt);

          return (
            <li key={venue.id}>
              {/* tabIndex -1: focus lands here after the venue is retired. */}
              <div
                className="venue-catalogue__item-main"
                tabIndex={-1}
                ref={(element) => {
                  rowMains.current.set(venue.id, element);
                  return () => rowMains.current.delete(venue.id);
                }}
              >
                <strong>{venue.name}</strong> — {venue.location}
                <StatusBadge tone={retired ? VENUE_TONES.retired : VENUE_TONES.active}>
                  {retired ? "Retired" : "Active"}
                </StatusBadge>
                {/* No Try again: retiring cannot be undone, so it goes back
                    through Retire venue and its confirm. */}
                {retireError?.id === venue.id && <ErrorNotice message={retireError.message} />}
              </div>

              <div className="venue-catalogue__item-actions">
                {/* Disabled on a retired venue because update_venue has no
                    retirement check of its own: a PATCH would succeed
                    server-side and quietly edit a venue nobody can book.
                    Now that the button opens a real form, that is no longer
                    hypothetical. */}
                <Button
                  ref={(element) => trackPanelButton(`${venue.id} edit`, element)}
                  variant="secondary"
                  disabled={retired}
                  title={retired ? "A retired venue cannot be edited." : undefined}
                  onClick={() => openPanel("edit", venue)}
                >
                  Edit details
                </Button>

                {/* Pointedly NOT disabled when retired. AC3 is two clauses,
                    and this is the second one: a retired venue stops
                    appearing in searches *while its past bookings remain
                    viewable*. Greying this out on a retired row would make
                    retirement a delete after all. */}
                {/* The one primary action in a row: the read every row has,
                    retired or not. */}
                <Button
                  ref={(element) => trackPanelButton(`${venue.id} detail`, element)}
                  onClick={() => openPanel("detail", venue)}
                >
                  View bookings &amp; history
                </Button>

                {/* SCRUM-181. NOT disabled when retired either, for the same
                    clause: SCRUM-178 AC1 keeps a retired venue's past
                    bookings viewable on its calendar. A Link rather than a
                    panel because the calendar is a route of its own, so the
                    URL can be bookmarked and search can link to it too. */}
                <Link to={`/venues/${venue.id}/calendar`} className="venue-catalogue__calendar-link">
                  View calendar
                </Link>

                {/* Disabled on a retired venue for the reason Edit details is:
                    the server refuses a new block there with VENUE_RETIRED, so
                    the button would only open a form that cannot be saved. */}
                <Button
                  ref={(element) => trackPanelButton(`${venue.id} blocks`, element)}
                  variant="secondary"
                  disabled={retired}
                  title={retired ? "A retired venue cannot be blocked." : undefined}
                  onClick={() => openPanel("blocks", venue)}
                >
                  Manage blocks
                </Button>

                {/* SCRUM-491. Beside Manage blocks, because a tentative hold
                    is the other way Venue Staff keep a venue for a while.
                    Disabled on a retired venue for the same reason: the
                    server refuses a hold there with VENUE_RETIRED (AC4). */}
                <Button
                  ref={(element) => trackPanelButton(`${venue.id} holds`, element)}
                  variant="secondary"
                  disabled={retired}
                  title={retired ? "A retired venue cannot be held." : undefined}
                  onClick={() => openPanel("holds", venue)}
                >
                  Place hold
                </Button>

                {/* Retirement cannot be undone (005_venue_retirement.sql has
                    no un-retire), so the button only opens the dialog. */}
                {!retired && (
                  <Button
                    variant="danger"
                    className="venue-catalogue__retire"
                    onClick={(event) => openRetire(venue, event)}
                    title="A retired venue stops appearing in searches. Its past bookings stay viewable. This cannot be undone."
                  >
                    Retire venue
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <Button ref={(element) => trackPanelButton("create", element)} onClick={() => openPanel("create")}>
        + Add new venue
      </Button>

      {confirmingVenue && (
        <ConfirmDialog
          open
          title={`Retire ${confirmingVenue.name}?`}
          confirmLabel={retiringId ? "Retiring..." : "Retire venue"}
          cancelLabel="Keep venue"
          danger
          busy={Boolean(retiringId)}
          onConfirm={() => handleRetire(confirmingVenue)}
          onCancel={() => setConfirmingId(null)}
        >
          It stops appearing in searches. Its past bookings stay viewable. This cannot be
          undone.
        </ConfirmDialog>
      )}
    </section>
  );
}
