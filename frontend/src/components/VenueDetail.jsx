// VenueDetail.jsx
//
// One venue's bookings and its change history, side by side.
//
// SCRUM-110 AC3's second clause -- "while its past bookings remain viewable"
// -- has had a backend since 005 and no seat to be read from. This is it, and
// it is why the catalogue's "View bookings & history" button is NOT disabled
// on a retired venue: a retired venue whose bookings you cannot see is a
// delete wearing a different name.
//
// SCRUM-15 AC4 -- "every change records the editing user, a timestamp, and
// the previous values" -- is the history half.
//
// SCRUM-186: turnaround_minutes arrives through 003's diff trigger like any
// other venues column; HISTORY_VALUE_FORMATTERS renders it as a duration.
//
// SCRUM-137: setup_minutes (023) arrives the same way and is rendered with the
// same formatter -- formatTurnaround formats any number of minutes.
//
// SCRUM-493 adds a "Safety information" section -- emergency access and known
// restrictions -- above the bookings, and labels both columns in the history.
// The facts themselves render through VenueSafetyFacts, the same component the
// Safety Officer's review will use; the loading, error and retry states stay
// here.

import { useCallback, useEffect, useId, useState } from "react";
import {
  getVenueBookings,
  getVenueDetails,
  getVenueHistory,
} from "../services/venueService";
import { formatTimestamp, shortId } from "../services/displayFormat";
import { formatTurnaround } from "../services/turnaroundOptions";
import { safetyFactText } from "../services/venueSafetyFacts";
import VenueSafetyFacts from "./VenueSafetyFacts";

const BOOKINGS_ERROR_MESSAGES = {
  400: "That venue id was not recognised. Please go back and refresh.",
  401: "Your session has expired. Please sign in again.",
  // SCRUM-182 gated the route. Only Venue Staff reach this panel in practice,
  // but the map names every status the API can now return.
  403: "Only Venue Staff and Event Coordinators can see a venue's bookings.",
  // Not a lie, and not a shrug either. 009_bookings.sql is a hand-run
  // migration; in an environment where it was never run, the missing-table
  // error falls past every branch of venueService.translateError and arrives
  // as a bare 500. Rendering that as "something went wrong" would send
  // somebody debugging a system that is working exactly as built.
  500: "Bookings are not available yet. The booking feature is still being built.",
};

const SAFETY_ERROR_MESSAGES = {
  400: "That venue id was not recognised. Please go back and refresh.",
  401: "Your session has expired. Please sign in again.",
  404: "That venue no longer exists. Go back and refresh the catalogue.",
  500: "The safety information could not be loaded. Please try again.",
};

const HISTORY_ERROR_MESSAGES = {
  400: "That venue id was not recognised. Please go back and refresh.",
  401: "Your session has expired. Please sign in again.",
  403: "Only Venue Staff can see a venue's change history.",
  500: "The change history could not be loaded. Please try again.",
};

// Every key the three history triggers can emit. record_venue_change
// (003:65-97) diffs the columns of `venues` minus updated_at and
// last_modified_by; record_venue_creation (008:40-57) writes the same column
// set on insert; record_venue_attribute_change (008:104-136) writes the four
// keys venue_attribute_snapshot builds (008:75-97) -- note they are the JOIN
// TABLE names, not the camelCase the read API uses, so `room_layouts` here is
// `layouts` in getVenueDetails.
const HISTORY_FIELD_LABELS = {
  id: "Venue id",
  name: "Name",
  location: "Location",
  max_capacity: "Maximum capacity",
  turnaround_minutes: "Turnaround between events",
  setup_minutes: "Setup before events",
  emergency_access: "Emergency access",
  known_restrictions: "Known restrictions",
  retired_at: "Retired at",
  created_at: "Created at",
  room_layouts: "Room layouts",
  accessibility_features: "Accessibility features",
  facilities: "Facilities",
  operating_hours: "Opening hours",
};

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The raw key when the label table has not heard of it -- never blank. */
function fieldLabel(key) {
  return HISTORY_FIELD_LABELS[key] ?? key;
}

/**
 * One history value, rendered.
 *
 * This runs over raw jsonb written by three different database triggers, on
 * rows that may predate any given shape. IT MUST NOT THROW -- a single
 * unexpected value would otherwise blank the whole history panel, which is
 * the one place a Venue Staff member can find out what happened to a venue.
 * Hence the outermost try/catch and the String() of last resort.
 */
function fmt(value) {
  try {
    if (value === null || value === undefined) return "not set";

    if (Array.isArray(value)) {
      if (value.length === 0) return "none";

      // operating_hours: [{day_of_week, opens_at, closes_at}, ...]
      if (value.every((entry) => entry && typeof entry === "object")) {
        return value
          .map((entry) => {
            const { day_of_week: day, opens_at: opens, closes_at: closes } = entry;
            if (opens === undefined || closes === undefined) return JSON.stringify(entry);
            const name = SHORT_DAYS[day] ?? `Day ${day}`;
            return `${name} ${String(opens).slice(0, 5)}–${String(closes).slice(0, 5)}`;
          })
          .join("; ");
      }

      // The code arrays: layouts, accessibility features, facilities.
      return value.join(", ");
    }

    if (typeof value === "object") return JSON.stringify(value);

    return String(value);
  } catch {
    return String(value);
  }
}

// Per-field renderers, for a column whose raw value reads badly through fmt:
// "30 minutes -> 1 hour", not "30 -> 60". A key not listed here uses fmt.
//
// SCRUM-493: the safety facts use safetyFactText, so a cleared field reads
// "Not recorded" -- the words the details section uses -- not fmt's "not set".
const HISTORY_VALUE_FORMATTERS = {
  turnaround_minutes: formatTurnaround,
  setup_minutes: formatTurnaround,
  emergency_access: safetyFactText,
  known_restrictions: safetyFactText,
};

/**
 * One history value, rendered with its field's formatter when it has one.
 * Wrapped for the same reason fmt is: a formatter that throws must cost one
 * prettier string, not the panel.
 */
function fmtField(key, value) {
  const formatter = HISTORY_VALUE_FORMATTERS[key];
  if (!formatter) return fmt(value);
  try {
    return formatter(value);
  } catch {
    return fmt(value);
  }
}

export default function VenueDetail({ venue }) {
  // Names the "Safety information" section by its h3, so the page has exactly
  // one region of that name. VenueSafetyFacts inside it, given no venueName,
  // is a plain div and does not repeat it.
  const safetyHeadingId = useId();
  const venueId = venue.id;

  // Two fetchers, two error states, two loading flags -- on purpose. History
  // is Venue Staff only and bookings are open to Venue Staff and Event
  // Coordinators only (SCRUM-182), so a 403 on one must not blank the other.
  // One combined fetch with a single catch would throw away the half that
  // succeeded.
  const [bookings, setBookings] = useState([]);
  const [loadingBookings, setLoadingBookings] = useState(true);
  const [bookingsError, setBookingsError] = useState(null);

  // SCRUM-493: a third fetcher, for the safety facts. The `venue` prop is the
  // catalogue's list row, which does not select these columns, so the full
  // venue comes from GET /venues/:id. Separate from the other two for the
  // same reason they are separate from each other: a failure here must not
  // blank the bookings or the history.
  const [details, setDetails] = useState(null);
  const [loadingDetails, setLoadingDetails] = useState(true);
  const [detailsError, setDetailsError] = useState(null);

  const [history, setHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [historyError, setHistoryError] = useState(null);

  const fetchBookings = useCallback(async () => {
    try {
      setBookings(await getVenueBookings(venueId));
      setBookingsError(null);
    } catch (err) {
      setBookingsError(
        BOOKINGS_ERROR_MESSAGES[err.response?.status] ||
          "Could not load this venue's bookings. Please try again.",
      );
    } finally {
      setLoadingBookings(false);
    }
  }, [venueId]);

  const fetchDetails = useCallback(async () => {
    try {
      setDetails(await getVenueDetails(venueId));
      setDetailsError(null);
    } catch (err) {
      setDetailsError(
        SAFETY_ERROR_MESSAGES[err.response?.status] ||
          "Could not load this venue's safety information. Please try again.",
      );
    } finally {
      setLoadingDetails(false);
    }
  }, [venueId]);

  /** "Try again": back to Loading... so a second failure is visibly a new one. */
  function retryDetails() {
    setDetailsError(null);
    setLoadingDetails(true);
    fetchDetails();
  }

  const fetchHistory = useCallback(async () => {
    try {
      setHistory(await getVenueHistory(venueId));
      setHistoryError(null);
    } catch (err) {
      setHistoryError(
        HISTORY_ERROR_MESSAGES[err.response?.status] ||
          "Could not load this venue's change history. Please try again.",
      );
    } finally {
      setLoadingHistory(false);
    }
  }, [venueId]);

  useEffect(() => {
    fetchBookings();
  }, [fetchBookings]);

  useEffect(() => {
    fetchDetails();
  }, [fetchDetails]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  return (
    <div className="venue-detail">
      <h2>
        {venue.name} &mdash; {venue.location}
      </h2>

      <section aria-labelledby={safetyHeadingId}>
        <h3 id={safetyHeadingId}>Safety information</h3>
        {/* No filter on retirement: a retired venue keeps its safety facts
            (SCRUM-493 AC5), and this shows them like everything else here. */}

        {loadingDetails && <p>Loading...</p>}
        {detailsError && (
          <>
            <p className="venue-detail__error" role="alert">
              {detailsError}
            </p>
            <button type="button" onClick={retryDetails}>
              Try again
            </button>
          </>
        )}

        {!loadingDetails && !detailsError && details && (
          <VenueSafetyFacts
            emergencyAccess={details.emergencyAccess}
            knownRestrictions={details.knownRestrictions}
          />
        )}
      </section>

      <section>
        <h3>Bookings</h3>
        {/* No filter on retirement, here or server-side. A retired venue's
            bookings are exactly what this section exists to show. */}

        {loadingBookings && <p>Loading...</p>}
        {bookingsError && (
          <p className="venue-detail__error" role="alert">
            {bookingsError}
          </p>
        )}
        {!loadingBookings && !bookingsError && bookings.length === 0 && (
          <p>No bookings have been made against this venue.</p>
        )}

        {bookings.length > 0 && (
          <>
            {/* 009_bookings.sql joins nothing and the service selects six
                columns, none of them a name, so there is no event title to
                show. The id is rendered as an identifier rather than dressed
                up as a label it is not. */}
            <p className="venue-detail__help">
              Event names are not shown &mdash; the API records the event request's
              id only.
            </p>
            <ul>
              {bookings.map((booking) => (
                <li key={booking.id}>
                  <span>
                    {formatTimestamp(booking.startsAt)} &ndash;{" "}
                    {formatTimestamp(booking.endsAt)}
                  </span>
                  <code title={booking.eventRequestId ?? undefined}>
                    {booking.eventRequestId ? shortId(booking.eventRequestId) : "no event"}
                  </code>
                  {/* SCRUM-243: a booking request that is not (or no longer) a
                      hold -- pending, rejected, withdrawn -- must not read as
                      one. Absent from older responses, so shown only when sent. */}
                  {booking.statusDisplay?.label && (
                    <span className="venue-detail__booking-status">{booking.statusDisplay.label}</span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section>
        <h3>Change history</h3>

        {loadingHistory && <p>Loading...</p>}
        {historyError && (
          <p className="venue-detail__error" role="alert">
            {historyError}
          </p>
        )}
        {!loadingHistory && !historyError && history.length === 0 && (
          <p>No changes have been recorded for this venue.</p>
        )}

        {history.length > 0 && (
          <>
            <p className="venue-detail__help">
              Names are not shown &mdash; the API records the editing user's id only.
            </p>
            <ul>
              {history.map((entry) => {
                const oldValues = entry.oldValues;
                const newValues = entry.newValues;
                const valuesAreObjects =
                  oldValues && typeof oldValues === "object" && !Array.isArray(oldValues) &&
                  newValues && typeof newValues === "object" && !Array.isArray(newValues);

                // 008:34's convention: an empty old_values means "this did not
                // exist before". Rendering it field by field would produce ten
                // rows all reading "not set -> x", which says the same thing
                // ten times and buries it.
                const isCreation =
                  valuesAreObjects && Object.keys(oldValues).length === 0;

                const keys = valuesAreObjects
                  ? [...new Set([...Object.keys(newValues), ...Object.keys(oldValues)])]
                  : [];

                return (
                  <li key={entry.id}>
                    <div className="venue-history__meta">
                      <strong>{formatTimestamp(entry.changedAt)}</strong>
                      {entry.changedBy ? (
                        <span>
                          by{" "}
                          <code title={entry.changedBy}>{shortId(entry.changedBy)}</code>
                        </span>
                      ) : (
                        // 008:14-15: changed_by NULL means the row was written
                        // by something that was not this API -- a hand edit in
                        // the SQL editor. Saying "unknown user" would imply we
                        // lost the name; we never had one.
                        <span>Changed outside the app</span>
                      )}
                    </div>

                    {isCreation && <p className="venue-history__value">Venue created</p>}

                    {!isCreation && valuesAreObjects && (
                      <ul>
                        {keys.map((key) => (
                          <li key={key}>
                            <span>{fieldLabel(key)}</span>
                            <span className="venue-history__value">
                              {fmtField(key, oldValues[key])} &rarr; {fmtField(key, newValues[key])}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}

                    {/* Last resort. If a row's values are not objects at all
                        -- a shape no current trigger produces -- show them raw
                        rather than rendering nothing. An audit trail that
                        quietly omits an entry is worse than an ugly one. */}
                    {!valuesAreObjects && (
                      <pre className="venue-history__value">
                        {fmt(oldValues)} &rarr; {fmt(newValues)}
                      </pre>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
