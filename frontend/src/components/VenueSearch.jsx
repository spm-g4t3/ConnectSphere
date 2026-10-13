// VenueSearch.jsx
// Matches the backend's real supported filters (location, minCapacity, and an
// optional startsAt/endsAt window) and response shape ({ id, name, location,
// maxCapacity }).
//
// SCRUM-130 (part of SCRUM-17, AC2) added the window: with both dates set,
// venues blocked at any point in [From, To) are left out. It is optional and
// both-or-neither, so blank dates send exactly the search this page always
// sent. Venues booked in the window are left out too, and both checks count
// each venue's setup and turnaround (SCRUM-484); the note under the form says
// so, though search gives no reason per venue. The dates are not read from
// the URL: prefilling them from an event request belongs to SCRUM-141.
//
// SCRUM-45 added the seeded arrival: a Coordinator reaching this page from an
// event request lands with ?minCapacity=<expected attendance> already applied
// and a banner naming the event. Two rules govern that, and both are load-
// bearing rather than stylistic:
//
//   - The URL seeds the form ONCE, on first render. It is not two-way bound.
//     Writing every keystroke back into the address bar would fight the input
//     and fill the history stack; reading it on every render would clobber
//     what the Coordinator is typing.
//   - Filters live in the query string, context lives in router state. The
//     filter must survive a reload — losing it silently is the exact bug the
//     handoff exists to prevent — while the event name must not, because a
//     request's title in a URL leaks into history and into any shared link.
//     So on reload the banner disappears and the search still behaves
//     correctly. The filters are the contract; the banner is decoration.
//
// SCRUM-185 (for SCRUM-178 AC1) added "Include retired venues", so a retired
// venue's past bookings can still be reached through its calendar:
//
//   - Shown only to Venue Staff and Event Coordinators, the roles the backend
//     allows the flag for (anyone else gets a 403). The role is a prop, read
//     from useAuth() by App.jsx: useAuth throws without an AuthProvider, and
//     this page's tests render without one -- the same reason BlockHistory
//     takes currentUserId as a prop.
//   - It and the date window exclude each other. A retired venue can't be
//     booked, so a dated search over it means nothing, and the backend answers
//     that combination with a 400. Each control is disabled while the other is
//     set, with a hint saying why; neither is ever cleared behind the user's
//     back.
//   - It is a filter, so it seeds from the query string (?includeRetired=true,
//     the same spelling the API takes) exactly like location and minCapacity:
//     once, on first render, and its presence alone triggers the auto-search.
//   - A retired row's "View calendar" opens on the week the venue retired,
//     which is where its past bookings end.
//
// SCRUM-254 (part of SCRUM-243) adds "Request this venue". It exists only when
// the search was opened from an event (the eventRequestContext above, which now
// carries the event's id and details), and never on a retired row. Both are
// router state, so a reload drops the buttons along with the banner; the search
// itself is untouched. A click opens BookingRequestPanel for that row, the same
// flow the suitability panel (SCRUM-191) mounts; that panel lives in
// EventVenueFinder, inside the event view, not on this page. The buttons are
// disabled, with the reason shown once, when the signed-in coordinator cannot
// request for this event. userId is a prop for the reason role is: useAuth
// throws without an AuthProvider, and this page's tests render without one.
//
// SCRUM-525 (AC1, R11): an event may hold several venues, one live request
// per venue, so only the venue a request was sent for from this page, or the
// venue the server refused as already requested, is locked; every other
// venue stays requestable. This page does not read the event's existing
// requests on load (that list lives in the event view), so the server's
// refusal stays the gate for those. A locked row says why, linked to its
// button with aria-describedby; it does not point at Venue suitability,
// which is not on this page.

import { useState, useCallback, useEffect, useId, useRef } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { deviceTimeZoneLabel } from "../services/datetimeFormat";
import { toCalendarDateParam } from "../services/calendarRange";
import { formatRange } from "../services/displayFormat";
import { normaliseRole } from "../auth/normaliseRole";
import { searchActiveVenues } from "../services/venueService";
import { toSearchWindow, validateSearchWindow } from "../services/venueSearchValidation";
import { bookingRequestEligibility } from "../services/bookingRequestEligibility";
import BookingRequestPanel from "./BookingRequestPanel";

/** The window's fields. A 400 naming anything else gets the generic message. */
const DATE_FIELDS = ["startsAt", "endsAt"];

/** Fields a 400's details[] may name that get shown beside their control. */
const SERVER_FIELDS = [...DATE_FIELDS, "includeRetired"];

/** The roles the backend lets search retired venues (SCRUM-185). */
const RETIRED_SEARCH_ROLES = ["event_coordinator", "venue_staff"].map(normaliseRole);

/** The query-string value that seeds the checkbox. */
const INCLUDE_RETIRED_PARAM = "true";

export default function VenueSearch({ role, userId, onRequestSubmitted } = {}) {
  const [searchParams] = useSearchParams();
  const canIncludeRetired = RETIRED_SEARCH_ROLES.includes(normaliseRole(role));
  const location = useLocation();
  const navigate = useNavigate();

  // The banner's copy, or undefined on an ordinary visit. Router state, so it
  // is gone after a reload by design — see the header.
  const context = location.state?.eventRequestContext;

  // SCRUM-254. The event a request would be for: the context, when it carries
  // an id. Older context (a name and requirements only) has none, and then no
  // request button is offered.
  const requestEvent = context?.id ? context : null;
  const eligibility = bookingRequestEligibility(requestEvent, userId);
  // The venue whose panel is open, and (SCRUM-525) the venues this event now
  // has a live request for, as far as this page knows: sent from here, or
  // refused by the server as already requested. See the header.
  const [requestingVenue, setRequestingVenue] = useState(null);
  const [requestedVenueIds, setRequestedVenueIds] = useState(() => new Set());

  function lockVenue(venueId) {
    setRequestedVenueIds((prev) => new Set(prev).add(venueId));
  }

  // A lazy initialiser, not a plain object. useState's argument is evaluated
  // on every render even though only the first result is kept, so building
  // the seed inline would re-read the URL on every keystroke — cheap, but it
  // invites the next reader to "simplify" it into a value that does get
  // reapplied. The function form says once and means it.
  const [filters, setFilters] = useState(() => ({
    location: searchParams.get("location") ?? "",
    minCapacity: searchParams.get("minCapacity") ?? "",
    startsAt: "",
    endsAt: "",
    // Never seeded for a role that can't send it: a shared link must not
    // turn into a 403 for an Organiser.
    includeRetired:
      canIncludeRetired && searchParams.get("includeRetired") === INCLUDE_RETIRED_PARAM,
  }));
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searched, setSearched] = useState(false);
  // { field, message } lists: the browser's check, and a 400's date details[].
  const [fieldErrors, setFieldErrors] = useState([]);
  const [serverFieldErrors, setServerFieldErrors] = useState([]);
  // The window behind the results on screen, not the one in the inputs, so
  // the note never describes a search that has not run.
  const [appliedWindow, setAppliedWindow] = useState(null);
  // Likewise whether the results on screen include retired venues.
  const [appliedIncludeRetired, setAppliedIncludeRetired] = useState(false);

  const idPrefix = useId();

  // SCRUM-181. With a window applied, the calendar opens on the day it starts,
  // so the link lands on the week that was searched. appliedWindow, not the
  // inputs: it is the window behind the results the link sits in.
  //
  // SCRUM-185. A retired venue opens on the week it retired instead: its
  // bookings end there, and a retired row never sits under a window anyway.
  const calendarHref = (venue) => {
    const base = `/venues/${venue.id}/calendar`;
    if (venue.retiredAt) return `${base}?date=${toCalendarDateParam(new Date(venue.retiredAt))}`;
    return appliedWindow
      ? `${base}?date=${toCalendarDateParam(new Date(appliedWindow.startsAt))}`
      : base;
  };

  const handleSearch = useCallback(async () => {
    const errors = validateSearchWindow(filters);
    if (errors.length > 0) {
      // No request, and the results from the last good search stay put.
      setFieldErrors(errors);
      setServerFieldErrors([]);
      setError(null);
      return;
    }

    const searchWindow = toSearchWindow(filters);
    // The controls keep the two apart; this guards a state they can't reach.
    const includeRetired = canIncludeRetired && filters.includeRetired && !searchWindow.startsAt;
    setFieldErrors([]);
    setServerFieldErrors([]);
    setLoading(true);
    setError(null);
    try {
      const venues = await searchActiveVenues({
        location: filters.location || undefined,
        minCapacity: filters.minCapacity ? Number(filters.minCapacity) : undefined,
        ...searchWindow,
        // Spread in only when set, so a default search's filters keep exactly
        // the keys they always had.
        ...(includeRetired ? { includeRetired: true } : {}),
      });
      setResults(venues);
      setSearched(true);
      setAppliedWindow(searchWindow.startsAt ? searchWindow : null);
      setAppliedIncludeRetired(includeRetired);
    } catch (err) {
      const details = err?.response?.status === 400 ? err.response.data?.details : null;
      const dateDetails = Array.isArray(details)
        ? details.filter((d) => SERVER_FIELDS.includes(d?.field))
        : [];
      if (dateDetails.length > 0) {
        setServerFieldErrors(dateDetails);
      } else {
        setError("Could not load venues. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }, [filters, canIncludeRetired]);

  function updateDate(field, value) {
    setFilters({ ...filters, [field]: value });
    // Editing a date retires that field's errors, client and server alike.
    setFieldErrors((prev) => prev.filter((err) => err.field !== field));
    setServerFieldErrors((prev) => prev.filter((err) => err.field !== field));
  }

  function updateIncludeRetired(checked) {
    setFilters({ ...filters, includeRetired: checked });
    setServerFieldErrors((prev) => prev.filter((err) => err.field !== "includeRetired"));
  }

  function clearDates() {
    setFilters({ ...filters, startsAt: "", endsAt: "" });
    setFieldErrors([]);
    setServerFieldErrors([]);
  }

  function messagesFor(field) {
    return [...fieldErrors, ...serverFieldErrors]
      .filter((err) => err.field === field)
      .map((err) => err.message);
  }

  function errorId(field) {
    return `${idPrefix}-${field}-error`;
  }

  /** aria wiring for one control, the same way VenueBlockForm does it. */
  function ariaFor(field) {
    const hasErrors = messagesFor(field).length > 0;
    return {
      "aria-invalid": hasErrors ? "true" : undefined,
      "aria-describedby": hasErrors ? errorId(field) : undefined,
    };
  }

  function renderFieldErrors(field) {
    const messages = messagesFor(field);
    if (messages.length === 0) return null;
    return (
      <ul className="venue-search__field-error" id={errorId(field)}>
        {messages.map((message, i) => (
          <li key={i}>{message}</li>
        ))}
      </ul>
    );
  }

  const hasDates = filters.startsAt !== "" || filters.endsAt !== "";
  const retiredChecked = canIncludeRetired && filters.includeRetired;

  // Arriving with a filter in the URL means somebody already asked the
  // question; making them press Search to repeat it is a wasted click. Fired
  // once and only once.
  //
  // The guard is a ref rather than an empty dependency array, and that is not
  // belt-and-braces. handleSearch is useCallback([filters]), so its identity
  // changes on every keystroke — listing it as a dependency would re-run this
  // effect mid-typing, and omitting it is the stale-closure bug lint warns
  // about. A ref sidesteps the question: the effect may run as often as React
  // likes, and the body runs at most once.
  const autoSearched = useRef(false);

  useEffect(() => {
    if (autoSearched.current) return;
    if (
      !searchParams.get("location") &&
      !searchParams.get("minCapacity") &&
      // The URL, not the live checkbox: ticking the box must not search.
      !(canIncludeRetired && searchParams.get("includeRetired") === INCLUDE_RETIRED_PARAM)
    ) {
      return;
    }

    autoSearched.current = true;
    handleSearch();
  }, [searchParams, handleSearch, canIncludeRetired]);

  return (
    <div className="venue-search">
      {context && (
        <div className="venue-search__context">
          {location.state?.returnToReview && (
            <button
              type="button"
              className="venue-search__back"
              onClick={() => navigate("/review-queue", { state: location.state.returnToReview })}
            >
              Back to event review
            </button>
          )}
          <p>
            Finding a venue for <strong>{context.eventName}</strong>.
          </p>
          {/* Verbatim, never parsed into a filter. This is free prose — "a
              large room, ideally tiered seating" — and an ilike on a token
              guessed out of it would return zero rows and read as "no venues
              exist". Show it beside the search box and let a person do the
              matching. */}
          {context.venueRequirements && (
            <p>
              Their venue requirements: <em>{context.venueRequirements}</em>
            </p>
          )}
        </div>
      )}

      <div className="venue-search__filters">
        <input
          type="text"
          placeholder="Location"
          value={filters.location}
          onChange={(e) => setFilters({ ...filters, location: e.target.value })}
        />
        <input
          type="number"
          min="1"
          placeholder="Min capacity"
          value={filters.minCapacity}
          onChange={(e) => setFilters({ ...filters, minCapacity: e.target.value })}
        />
        <button onClick={handleSearch} disabled={loading}>
          {loading ? "Searching..." : "Search venues"}
        </button>
      </div>

      <div className="venue-search__window">
        <div>
          <label>
            From
            <input
              type="datetime-local"
              value={filters.startsAt}
              onChange={(e) => updateDate("startsAt", e.target.value)}
              disabled={loading || retiredChecked}
              {...ariaFor("startsAt")}
            />
          </label>
          {renderFieldErrors("startsAt")}
        </div>
        <div>
          <label>
            To
            <input
              type="datetime-local"
              value={filters.endsAt}
              onChange={(e) => updateDate("endsAt", e.target.value)}
              disabled={loading || retiredChecked}
              {...ariaFor("endsAt")}
            />
          </label>
          {renderFieldErrors("endsAt")}
        </div>
        {hasDates && (
          <button type="button" onClick={clearDates} disabled={loading}>
            Clear dates
          </button>
        )}
      </div>

      {canIncludeRetired && (
        <div className="venue-search__retired">
          <label>
            <input
              type="checkbox"
              checked={filters.includeRetired}
              onChange={(e) => updateIncludeRetired(e.target.checked)}
              disabled={loading || hasDates}
              {...ariaFor("includeRetired")}
            />
            Include retired venues
          </label>
          {renderFieldErrors("includeRetired")}
          {hasDates && (
            <p className="venue-search__hint">
              Retired venues can't be booked, so they can only be searched without dates.
            </p>
          )}
          {retiredChecked && (
            <p className="venue-search__hint">
              Dates are off while retired venues are included: a retired venue can't be booked.
            </p>
          )}
        </div>
      )}

      {/* Disclosure, not a picker -- the same wording VenueBlockForm uses. */}
      <p className="venue-search__hint">
        Times are in your device's time zone ({deviceTimeZoneLabel()}).
      </p>

      {error && <p className="venue-search__error">{error}</p>}

      {requestEvent && !eligibility.eligible && (
        <p className="venue-search__hint" role="status">
          {eligibility.reason}
        </p>
      )}

      {requestEvent && requestingVenue && (
        <BookingRequestPanel
          key={requestingVenue.id}
          event={requestEvent}
          venue={requestingVenue}
          // The venue the panel was opened for: a refusal names no venue.
          onSubmitted={(request) => {
            lockVenue(requestingVenue.id);
            onRequestSubmitted?.(request);
          }}
          onVenueAlreadyRequested={() => lockVenue(requestingVenue.id)}
          onClose={() => setRequestingVenue(null)}
        />
      )}

      {appliedWindow && (
        <p className="venue-search__window-note" role="status">
          {`Venues booked or blocked between ${formatRange(appliedWindow.startsAt, appliedWindow.endsAt)} are not shown, including each venue's setup and turnaround.`}
        </p>
      )}

      <ul className="venue-search__results">
        {results.map((venue) => (
          <li key={venue.id}>
            <strong>{venue.name}</strong>
            {venue.retiredAt && <span className="venue-search__badge">Retired</span>}
            {" "}— {venue.location}, seats up to {venue.maxCapacity}
            <Link to={calendarHref(venue)} className="venue-search__calendar-link">
              View calendar
            </Link>
            {requestEvent && !venue.retiredAt && (
              <button
                type="button"
                className="venue-search__request"
                aria-label={`Request this venue: ${venue.name}`}
                disabled={!eligibility.eligible || requestedVenueIds.has(venue.id)}
                aria-describedby={requestedVenueIds.has(venue.id) ? `${idPrefix}-requested-${venue.id}` : undefined}
                onClick={() => setRequestingVenue(venue)}
              >
                Request this venue
              </button>
            )}
            {requestEvent && !venue.retiredAt && requestedVenueIds.has(venue.id) && (
              <p className="venue-search__hint" id={`${idPrefix}-requested-${venue.id}`}>
                This event already has a request for this venue.
              </p>
            )}
          </li>
        ))}
        {searched && !loading && results.length === 0 && (
          <p>
            {appliedIncludeRetired
              ? "No venues match your search."
              : "No active venues match your search."}
          </p>
        )}
      </ul>
    </div>
  );
}
