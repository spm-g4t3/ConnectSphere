// EventVenueFinder.jsx
//
// SCRUM-141 (SCRUM-20 AC1/AC2): the coordinator's venue search, inside the
// event view. The form is pre-filled from the event and every field stays
// editable, so the coordinator can widen or narrow the search before running
// it, and again after.
//
// Rules worth keeping:
//
//   - Seeded ONCE, by a lazy useState. A different event is a different
//     component instance: the parent keys this on the event's id plus the
//     three values it seeds from (proposedStart, proposedEnd,
//     expectedAttendance). Opening another event re-seeds the form, and so
//     does a change request that moves this event's period or attendance;
//     a refresh that changes nothing else leaves the coordinator's edits
//     alone.
//   - Nothing is searched on open. The coordinator presses Search. A search
//     on open would run before anyone checked the pre-filled values, and its
//     results would read as an answer to a question nobody asked yet.
//   - The inputs keep their values after a search, so changing one thing and
//     searching again is one edit and one click.
//   - Client faults show beside their fields and send nothing. A 400's
//     details[] show beside the fields they name (mapServerDetails), and
//     anything else gets one message above the results.
//
// SCRUM-142: each result shows the six things the story asks for -- name,
// location, maximum capacity, room layouts, accessibility features and
// facilities -- and nothing else. Hours, setup and turnaround come back too
// but are left off: the search has already checked them against the event.
// The code lists show as labels from venueLookups, which is a known-stale
// copy, so a code it has not heard of shows as itself rather than vanishing,
// and an empty list says "None listed" rather than leaving a blank.
//
// SCRUM-143 (AC8): a search that matches nothing says so, in fixed text that
// names no criterion. The search applies every criterion together, so no one
// of them is "the reason", and naming one would steer the coordinator to
// loosen it when another edit might do. The form keeps its values, so
// adjusting and searching again is the retry. The message hides while a
// search runs and goes once a new search succeeds or fails.
//
// SCRUM-20 AC1/AC2: the date and times are Singapore wall clock, not the
// device's, because the backend checks them against venue hours in Singapore
// (eventVenueSearchForm.js explains). The hint under them says so.
//
// Two more hints answer what would otherwise look like a fault:
//
//   - Location matches part of the venue's location attribute (the backend's
//     matchesLocation), not its name, so "room" does not find "Meeting room"
//     in Singapore. The hint under the input says so, and the input's
//     aria-describedby names it alongside any errors.
//   - An event whose start and end fall on different Singapore dates seeds
//     with End blank (seedFromEvent's spansDays), because the search checks
//     one date at a time. A hint by the times says so and names the seeded
//     date, so the "is required" beside End has a reason. It is read from the
//     seed, stored once, and stays even if the coordinator changes the date:
//     it describes the event, not the form.
//
// The event's free-text requirements are already shown under "Requirements"
// in the same panel, so this section does not repeat them.
//
// SCRUM-254: each result offers "Request this venue", which opens
// BookingRequestPanel in place, under the search. The button lives here
// because this finder replaced the old navigate handoff to /venue-search,
// which was the only way into that panel; without it a coordinator could find
// a venue for the event and then have no way to ask for it. The panel has its
// own <form>, so it renders beside this one, never inside it, and the button
// is type="button" so it never runs the search.
// bookingRequestEligibility is a convenience, not the gate: it saves a
// coordinator a button that can only be refused, and when it says no, its
// reason shows once above the results. The server checks everything again
// under a lock (create_booking_request, migration 030).
//
// SCRUM-525 (AC1, R11, R13): an event may hold several venues, but only one
// live request (pending, approved or flagged for review) per venue. So the
// lock is per venue, never event-wide: a venue's Request button is disabled
// when the parent says the event already has a live request for it
// (`liveRequests`), or when this finder sent one for it, or when the server
// refused one for it as already requested (`sentVenues`). Every other venue
// stays requestable. A locked card says why, under the card, linked to its
// button with aria-describedby: the event already has a request for this
// venue, its status when known, and that it is listed under Venue suitability
// above, which is where the existing request is shown (R13). It is a plain
// hint, not a status: nothing changed at that moment that needs announcing.
// The status shown is the parent's when it has one, since that is the
// server's current word; this finder's own guess ("Pending" for a request it
// just sent, "Flagged for review" for that refusal, none for a request that
// already existed) only fills the gap. A new search closes an open panel but
// keeps the locks: they describe the event, not the results.
// A refusal carries the existing booking's id but no venue id, so the venue
// is the one the refused panel was opened for, captured when that panel's
// callbacks were made, not read from state when the answer lands.
//
// SCRUM-191 (SCRUM-188 AC1/AC2): "Check suitability" on each result, and a
// "Check another venue" control under the results for any active venue the
// search did not return, open VenueSuitabilityPanel in place, beside the
// search form like the request panel. There is no page or route for it: the
// check is a step in finding a venue for this event, so it lives here.
//
//   - Enabled only for the event's assigned coordinator (userId equal to
//     assignedCoordinatorId), the only caller the server answers. The parent
//     passes userId only while that holds.
//   - The requirements checked are a snapshot of the form's layout,
//     accessibility and facilities taken when the check is pressed, kept with
//     the open panel. Editing the form afterwards does not change the result
//     on screen; pressing Check again takes a new snapshot and a fresh panel.
//   - "Check another venue" loads searchActiveVenues() once, when first
//     opened, so a coordinator who never opens it costs no call. That search
//     leaves retired venues out, and any row still marked retired is dropped
//     here too, so a retired venue is never offered.
//   - One panel at a time: opening a check closes an open request panel, and
//     opening a request closes an open check. "Request this venue" from a
//     check opens BookingRequestPanel with the result as `suitability` and the
//     same snapshot as `requirements`, so the unsuitable warning shows up front
//     and the request carries the codes that were checked. A request straight
//     from a result card, with no check first, carries the form's current
//     codes, so the server's check on submit still judges them.
//   - A new search closes either panel, as it always closed the request one.
//
// SCRUM-188, reworked by SCRUM-525: `liveRequests` is the parent's word, from
// the event's Venue suitability section, on which venues already have a live
// request when the view loads, as a Map of venue id to status label. Those
// venues start locked, rather than only after a refused send.
// onVenueAlreadyRequested(code) tells the parent the server refused a venue
// as already requested, so it can reload that section and show the request
// the coordinator collided with.
//
// A venue locked this way and opened through "Check suitability" or "Check
// another venue" shows the same sentence in the suitability panel in place of
// its Request button (requestBlockedReason), so it is never offered there
// either.
//
// SCRUM-266: `replacing` is the flagged booking the coordinator chose to
// replace from Flagged bookings above. While set, a notice names it, focus
// moves there so the coordinator lands on the search, and the request panel
// sends its id as replacesBookingId. The parent owns it: "Stop replacing"
// calls onStopReplacing, and onReplacementRefused(code) reports a flagged
// booking the server says can no longer be replaced.

import { useEffect, useId, useRef, useState } from "react";
import { VENUE_TIME_ZONE, formatVenuePeriod } from "../services/datetimeFormat";
import { bookingRequestEligibility } from "../services/bookingRequestEligibility";
import {
  mapServerDetails,
  searchErrorMessage,
  seedFromEvent,
  toSearchCriteria,
  validateEventSearchForm,
} from "../services/eventVenueSearchForm";
import { findVenuesForEvent, searchActiveVenues } from "../services/venueService";
import {
  ACCESSIBILITY_FEATURES,
  FACILITIES,
  ROOM_LAYOUTS,
} from "../services/venueLookups";
import BookingRequestPanel from "./BookingRequestPanel";
import VenueSuitabilityPanel from "./VenueSuitabilityPanel";

/** The default for `liveRequests`: one shared empty Map, so it is stable. */
const NO_LIVE_REQUESTS = new Map();

/**
 * SCRUM-525 (R13): why a venue cannot be requested again, naming its live
 * request's status when known and where that request is listed.
 */
function alreadyRequestedText(status) {
  return status
    ? `This event already has a request for this venue (${status}). See it under Venue suitability above.`
    : "This event already has a request for this venue. See it under Venue suitability above.";
}

/** The three code lists on a result, in the order they are shown. */
const RESULT_CODE_LISTS = [
  { field: "layouts", term: "Room layouts", options: ROOM_LAYOUTS },
  { field: "accessibility", term: "Accessibility features", options: ACCESSIBILITY_FEATURES },
  { field: "facilities", term: "Facilities", options: FACILITIES },
];

/**
 * A code list as readable text. A code venueLookups does not know shows as
 * the raw code -- the same fallback VenueDetail's fieldLabel uses -- because
 * the lookup copy is stale by design and hiding a code would misreport the
 * venue.
 */
function codesText(codes, options) {
  if (!Array.isArray(codes) || codes.length === 0) return "None listed";
  return codes
    .map((code) => options.find((option) => option.code === code)?.label ?? code)
    .join(", ");
}

/**
 * One matching venue: its name as the heading, the rest as a <dl>, then the
 * SCRUM-191 check and SCRUM-254 request buttons.
 */
function VenueResult({ venue, headingId, checkDisabled, onCheck, requestDisabled, lockedReason, onRequest }) {
  // SCRUM-525: the hint that explains a locked Request button, by id.
  const lockedHintId = `${headingId}-locked`;
  const rows = [
    { term: "Location", value: venue.location },
    { term: "Maximum capacity", value: venue.maxCapacity },
    ...RESULT_CODE_LISTS.map(({ field, term, options }) => ({
      term,
      value: codesText(venue[field], options),
    })),
  ];
  return (
    <article className="event-venue-finder__result" aria-labelledby={headingId}>
      <h4 id={headingId}>{venue.name}</h4>
      <dl>
        {rows.map(({ term, value }) => (
          <div key={term} className="event-venue-finder__result-row">
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {/* type="button": these sit inside the search form and must not submit it. */}
      <button
        type="button"
        className="event-venue-finder__check"
        aria-label={`Check suitability: ${venue.name}`}
        disabled={checkDisabled}
        onClick={() => onCheck(venue)}
      >
        Check suitability
      </button>
      <button
        type="button"
        className="event-venue-finder__request"
        aria-label={`Request this venue: ${venue.name}`}
        disabled={requestDisabled}
        aria-describedby={lockedReason ? lockedHintId : undefined}
        onClick={() => onRequest(venue)}
      >
        Request this venue
      </button>
      {lockedReason && (
        <p className="event-venue-finder__hint" id={lockedHintId}>
          {lockedReason}
        </p>
      )}
    </article>
  );
}

/**
 * SCRUM-191 (AC1): check any active venue, not only the ones the search
 * returned. A disclosure, so the venue list is fetched only once someone
 * opens it, and only once. It sits outside the search form (see the header).
 */
function OtherVenueCheck({ disabled, onCheck }) {
  const idPrefix = useId();
  const [open, setOpen] = useState(false);
  // null until loaded, so "not loaded yet" and "no active venues" differ.
  const [venues, setVenues] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [selectedId, setSelectedId] = useState("");

  async function load() {
    setLoading(true);
    setLoadError(false);
    try {
      const rows = await searchActiveVenues();
      // The search already leaves retired venues out; this is belt and braces.
      setVenues((Array.isArray(rows) ? rows : []).filter((venue) => !venue?.retiredAt));
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && venues === null && !loading) load();
  }

  const selected = venues?.find((venue) => venue.id === selectedId) ?? null;
  const bodyId = `${idPrefix}-body`;
  const selectId = `${idPrefix}-venue`;

  return (
    <div className="event-venue-finder__other">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        disabled={disabled}
        onClick={toggle}
      >
        Check another venue
      </button>
      {open && (
        <div id={bodyId} className="event-venue-finder__other-body">
          {loading && <p className="event-venue-finder__hint">Loading venues...</p>}
          {loadError && (
            <>
              <p className="event-venue-finder__error" role="alert">
                Could not load the list of venues. Please try again.
              </p>
              <button type="button" onClick={load}>
                Try again
              </button>
            </>
          )}
          {venues !== null && venues.length === 0 && (
            <p className="event-venue-finder__hint">There are no active venues to check.</p>
          )}
          {venues !== null && venues.length > 0 && (
            <div className="event-venue-finder__other-row">
              <label htmlFor={selectId}>Active venue</label>
              <select
                id={selectId}
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
                disabled={disabled}
              >
                <option value="">Choose a venue</option>
                {venues.map((venue) => (
                  <option key={venue.id} value={venue.id}>
                    {venue.location ? `${venue.name} (${venue.location})` : venue.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={disabled || !selected}
                onClick={() => onCheck(selected)}
              >
                Check
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The two checkbox groups, in the order they are shown. */
const CODE_GROUPS = [
  { field: "accessibility", legend: "Accessibility features", options: ACCESSIBILITY_FEATURES },
  { field: "facilities", legend: "Facilities", options: FACILITIES },
];

export default function EventVenueFinder({
  request,
  userId,
  liveRequests = NO_LIVE_REQUESTS,
  onRequestSubmitted,
  onVenueAlreadyRequested,
  replacing,
  onStopReplacing,
  onReplacementRefused,
}) {
  // Lazy: the function runs on the first render only. See the header.
  const [seed] = useState(() => seedFromEvent(request));
  const [values, setValues] = useState(seed);
  const [fieldErrors, setFieldErrors] = useState([]);
  const [serverFieldErrors, setServerFieldErrors] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  // null until a search has succeeded, so "not searched yet" (no message) and
  // "searched, nothing matched" (the no-match message) stay distinguishable.
  const [results, setResults] = useState(null);

  // SCRUM-254. See the header: the venue whose panel is open.
  // `requesting` is { venue, suitability, requirements } for the open request
  // panel; suitability is set only when it was opened from a check (SCRUM-191).
  const eligibility = bookingRequestEligibility(request, userId);
  const [requesting, setRequesting] = useState(null);
  // SCRUM-525. The venues this finder has locked itself (see the header):
  // venue id -> the status it knows of, or null when it knows none.
  const [sentVenues, setSentVenues] = useState(() => new Map());

  const isLocked = (venueId) => liveRequests.has(venueId) || sentVenues.has(venueId);
  // The parent's status first: it is the server's (see the header).
  const lockedStatus = (venueId) => liveRequests.get(venueId) ?? sentVenues.get(venueId) ?? null;
  const lockedReason = (venueId) => (isLocked(venueId) ? alreadyRequestedText(lockedStatus(venueId)) : null);

  function lockVenue(venueId, status) {
    setSentVenues((prev) => new Map(prev).set(venueId, status));
  }

  // SCRUM-191. See the header: the venue whose suitability panel is open,
  // with the requirements snapshot it checks and a per-check key, so pressing
  // Check again on the same venue runs a fresh check.
  const canCheck = Boolean(request?.id) && Boolean(userId) && request.assignedCoordinatorId === userId;
  const [checkingVenue, setCheckingVenue] = useState(null);
  const checkCount = useRef(0);

  // SCRUM-266. Focus follows each new choice of booking to replace.
  const replacingNotice = useRef(null);
  const replacingId = replacing?.id ?? null;
  useEffect(() => {
    if (replacingId) replacingNotice.current?.focus();
  }, [replacingId]);

  const idPrefix = useId();
  const idFor = (field) => `${idPrefix}-${field}`;
  const errorId = (field) => `${idPrefix}-${field}-error`;
  const hintId = (field) => `${idPrefix}-${field}-hint`;

  /** Editing a field retires that field's errors, client and server alike. */
  function clearErrorsFor(field) {
    setFieldErrors((prev) => prev.filter((err) => err.field !== field));
    setServerFieldErrors((prev) => prev.filter((err) => err.field !== field));
  }

  function update(field, value) {
    setValues((prev) => ({ ...prev, [field]: value }));
    clearErrorsFor(field);
  }

  function toggleCode(field, code, checked) {
    setValues((prev) => {
      const current = prev[field];
      const next = checked
        ? [...current.filter((c) => c !== code), code]
        : current.filter((c) => c !== code);
      return { ...prev, [field]: next };
    });
    clearErrorsFor(field);
  }

  async function handleSearch(event) {
    event.preventDefault();

    const errors = validateEventSearchForm(values);
    if (errors.length > 0) {
      // Nothing is sent, and the last good results stay on screen.
      setFieldErrors(errors);
      setServerFieldErrors([]);
      setError(null);
      return;
    }

    setFieldErrors([]);
    setServerFieldErrors([]);
    setError(null);
    // The results are about to change, so a panel for one of them closes.
    setRequesting(null);
    setCheckingVenue(null);
    setLoading(true);
    try {
      // SCRUM-491 (AC5): this event's id, so a venue it holds is not hidden
      // from its own search.
      setResults(await findVenuesForEvent(toSearchCriteria(values, { eventRequestId: request?.id })));
    } catch (err) {
      // A failed search leaves no results behind: the ones from before would
      // sit under criteria that have since changed.
      setResults(null);
      if (err?.response?.status === 400) {
        const { fieldErrors: mapped, hasUnmapped } = mapServerDetails(
          err.response.data?.details,
        );
        setServerFieldErrors(mapped);
        if (hasUnmapped) setError(searchErrorMessage(err));
      } else {
        setError(searchErrorMessage(err));
      }
    } finally {
      setLoading(false);
    }
  }

  /** The form's requirement codes as they stand now, copied (see the header). */
  function currentRequirements() {
    return {
      layout: values.layout,
      accessibility: [...values.accessibility],
      facilities: [...values.facilities],
    };
  }

  function openCheck(venue) {
    checkCount.current += 1;
    setRequesting(null);
    setCheckingVenue({ venue, requirements: currentRequirements(), key: checkCount.current });
  }

  function openRequest(venue) {
    setCheckingVenue(null);
    setRequesting({ venue, suitability: undefined, requirements: currentRequirements() });
  }

  function requestFromCheck(venue, result) {
    const requirements = checkingVenue?.requirements;
    setCheckingVenue(null);
    setRequesting({ venue, suitability: result, requirements });
  }

  function messagesFor(field) {
    return [...fieldErrors, ...serverFieldErrors]
      .filter((err) => err.field === field)
      .map((err) => err.message);
  }

  /**
   * aria wiring for one control, the same way VenueSearch does it, plus the
   * ids of any hints that describe it. Errors come first, so they are read
   * before the standing hint.
   */
  function ariaFor(field, hintIds = []) {
    const hasErrors = messagesFor(field).length > 0;
    const describedBy = [...(hasErrors ? [errorId(field)] : []), ...hintIds];
    return {
      "aria-invalid": hasErrors ? "true" : undefined,
      "aria-describedby": describedBy.length > 0 ? describedBy.join(" ") : undefined,
    };
  }

  function renderFieldErrors(field) {
    const messages = messagesFor(field);
    if (messages.length === 0) return null;
    return (
      <ul className="event-venue-finder__field-error" id={errorId(field)}>
        {messages.map((message, i) => (
          <li key={i}>{message}</li>
        ))}
      </ul>
    );
  }

  const hasResults = results !== null && results.length > 0;

  return (
    <>
      {replacing && (
        <div className="event-venue-finder__replacing" role="status" tabIndex={-1} ref={replacingNotice}>
          <p>
            Requesting a replacement for {replacing.venueName},{" "}
            {formatVenuePeriod(replacing.startsAt, replacing.endsAt)}
          </p>
          <button type="button" onClick={onStopReplacing}>
            Stop replacing
          </button>
        </div>
      )}
      <form className="event-venue-finder" onSubmit={handleSearch} noValidate>
        <div className="event-venue-finder__row">
          <div className="event-venue-finder__field">
            <label htmlFor={idFor("date")}>Date</label>
            <input
              id={idFor("date")}
              type="date"
              value={values.date}
              onChange={(e) => update("date", e.target.value)}
              disabled={loading}
              {...ariaFor("date")}
            />
            {renderFieldErrors("date")}
          </div>
          <div className="event-venue-finder__field">
            <label htmlFor={idFor("startTime")}>Start</label>
            <input
              id={idFor("startTime")}
              type="time"
              value={values.startTime}
              onChange={(e) => update("startTime", e.target.value)}
              disabled={loading}
              {...ariaFor("startTime")}
            />
            {renderFieldErrors("startTime")}
          </div>
          <div className="event-venue-finder__field">
            <label htmlFor={idFor("endTime")}>End</label>
            <input
              id={idFor("endTime")}
              type="time"
              value={values.endTime}
              onChange={(e) => update("endTime", e.target.value)}
              disabled={loading}
              {...ariaFor("endTime", seed.spansDays ? [hintId("spansDays")] : [])}
            />
            {renderFieldErrors("endTime")}
          </div>
        </div>

        {/* Disclosure, not a picker: venue time on every device (see the header). */}
        <p className="event-venue-finder__hint">
          Times are Singapore time ({VENUE_TIME_ZONE}), the venues' local time.
        </p>
        {/* A plain hint, not a status: it describes the event (see the header). */}
        {seed.spansDays && (
          <p className="event-venue-finder__hint" id={hintId("spansDays")}>
            This event runs over more than one day. Venue search checks one day at a
            time — set the end time for {seed.date}.
          </p>
        )}

        <div className="event-venue-finder__row">
          <div className="event-venue-finder__field">
            <label htmlFor={idFor("expectedAttendance")}>Expected attendance</label>
            <input
              id={idFor("expectedAttendance")}
              type="number"
              min="1"
              step="1"
              value={values.expectedAttendance}
              onChange={(e) => update("expectedAttendance", e.target.value)}
              disabled={loading}
              {...ariaFor("expectedAttendance")}
            />
            {renderFieldErrors("expectedAttendance")}
          </div>
          <div className="event-venue-finder__field">
            <label htmlFor={idFor("location")}>Location</label>
            <input
              id={idFor("location")}
              type="text"
              value={values.location}
              onChange={(e) => update("location", e.target.value)}
              disabled={loading}
              {...ariaFor("location", [hintId("location")])}
            />
            <p className="event-venue-finder__hint" id={hintId("location")}>
              Matches part of the venue's location (building or area), not its name.
            </p>
            {renderFieldErrors("location")}
          </div>
          <div className="event-venue-finder__field">
            <label htmlFor={idFor("layout")}>Layout</label>
            <select
              id={idFor("layout")}
              value={values.layout}
              onChange={(e) => update("layout", e.target.value)}
              disabled={loading}
              {...ariaFor("layout")}
            >
              <option value="">Any layout</option>
              {ROOM_LAYOUTS.map((layout) => (
                <option key={layout.code} value={layout.code}>
                  {layout.label}
                </option>
              ))}
            </select>
            {renderFieldErrors("layout")}
          </div>
        </div>

        {CODE_GROUPS.map(({ field, legend, options }) => (
          <fieldset key={field} className="event-venue-finder__group" {...ariaFor(field)}>
            <legend>{legend}</legend>
            <div className="event-venue-finder__options">
              {options.map((option) => (
                <label key={option.code} className="event-venue-finder__option">
                  <input
                    type="checkbox"
                    checked={values[field].includes(option.code)}
                    onChange={(e) => toggleCode(field, option.code, e.target.checked)}
                    disabled={loading}
                  />
                  {option.label}
                </label>
              ))}
            </div>
            {renderFieldErrors(field)}
          </fieldset>
        ))}

        <div className="event-venue-finder__actions">
          <button type="submit" disabled={loading}>
            {loading ? "Searching..." : "Search venues"}
          </button>
        </div>

        {error && (
          <p className="event-venue-finder__error" role="alert">
            {error}
          </p>
        )}

        {hasResults && !eligibility.eligible && (
          <p className="event-venue-finder__hint" role="status">
            {eligibility.reason}
          </p>
        )}

        {hasResults && (
          <ul className="event-venue-finder__results" aria-label="Matching venues">
            {results.map((venue) => (
              <li key={venue.id}>
                <VenueResult
                  venue={venue}
                  headingId={`${idPrefix}-venue-${venue.id}`}
                  checkDisabled={!canCheck}
                  onCheck={openCheck}
                  requestDisabled={!eligibility.eligible || isLocked(venue.id)}
                  lockedReason={lockedReason(venue.id)}
                  onRequest={openRequest}
                />
              </li>
            ))}
          </ul>
        )}

        {/* status, not alert: an empty result is an answer, not a failure. */}
        {results !== null && results.length === 0 && !loading && (
          <p className="event-venue-finder__no-match" role="status">
            No venue matched your criteria. Adjust the criteria above and search again.
          </p>
        )}
      </form>

      {/* Outside the search form: it has controls of its own (see the header). */}
      <OtherVenueCheck disabled={!canCheck} onCheck={openCheck} />

      {/* Beside the search form, not in it, like the request panel below. */}
      {checkingVenue && (
        <VenueSuitabilityPanel
          key={checkingVenue.key}
          event={request}
          venue={checkingVenue.venue}
          requirements={checkingVenue.requirements}
          canRequest={eligibility.eligible && !isLocked(checkingVenue.venue.id)}
          requestBlockedReason={lockedReason(checkingVenue.venue.id) ?? undefined}
          onRequest={requestFromCheck}
          onClose={() => setCheckingVenue(null)}
        />
      )}

      {/* Beside the search form, not in it: the panel has a <form> of its own. */}
      {requesting && (
        <BookingRequestPanel
          key={requesting.venue.id}
          event={request}
          venue={requesting.venue}
          suitability={requesting.suitability}
          requirements={requesting.requirements}
          // The venue is captured here, with the panel (see the header).
          onSubmitted={(created) => {
            lockVenue(requesting.venue.id, "Pending");
            onRequestSubmitted?.(created);
          }}
          onVenueAlreadyRequested={(code) => {
            lockVenue(requesting.venue.id, code === "BOOKING_FLAGGED_FOR_REVIEW" ? "Flagged for review" : null);
            onVenueAlreadyRequested?.(code);
          }}
          replacesBookingId={replacing?.id}
          onReplacementRefused={onReplacementRefused}
          onClose={() => setRequesting(null)}
        />
      )}
    </>
  );
}
