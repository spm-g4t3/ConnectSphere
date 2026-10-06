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
// The event's free-text requirements are already shown under "Requirements"
// in the same panel, so this section does not repeat them.

import { useId, useState } from "react";
import { VENUE_TIME_ZONE } from "../services/datetimeFormat";
import {
  mapServerDetails,
  searchErrorMessage,
  seedFromEvent,
  toSearchCriteria,
  validateEventSearchForm,
} from "../services/eventVenueSearchForm";
import { findVenuesForEvent } from "../services/venueService";
import {
  ACCESSIBILITY_FEATURES,
  FACILITIES,
  ROOM_LAYOUTS,
} from "../services/venueLookups";

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

/** One matching venue: its name as the heading, the rest as a <dl>. */
function VenueResult({ venue, headingId }) {
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
    </article>
  );
}

/** The two checkbox groups, in the order they are shown. */
const CODE_GROUPS = [
  { field: "accessibility", legend: "Accessibility features", options: ACCESSIBILITY_FEATURES },
  { field: "facilities", legend: "Facilities", options: FACILITIES },
];

export default function EventVenueFinder({ request }) {
  // Lazy: the function runs on the first render only. See the header.
  const [values, setValues] = useState(() => seedFromEvent(request));
  const [fieldErrors, setFieldErrors] = useState([]);
  const [serverFieldErrors, setServerFieldErrors] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  // null until a search has succeeded, so "not searched yet" (no message) and
  // "searched, nothing matched" (the no-match message) stay distinguishable.
  const [results, setResults] = useState(null);

  const idPrefix = useId();
  const idFor = (field) => `${idPrefix}-${field}`;
  const errorId = (field) => `${idPrefix}-${field}-error`;

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
    setLoading(true);
    try {
      setResults(await findVenuesForEvent(toSearchCriteria(values)));
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

  function messagesFor(field) {
    return [...fieldErrors, ...serverFieldErrors]
      .filter((err) => err.field === field)
      .map((err) => err.message);
  }

  /** aria wiring for one control, the same way VenueSearch does it. */
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
      <ul className="event-venue-finder__field-error" id={errorId(field)}>
        {messages.map((message, i) => (
          <li key={i}>{message}</li>
        ))}
      </ul>
    );
  }

  return (
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
            {...ariaFor("endTime")}
          />
          {renderFieldErrors("endTime")}
        </div>
      </div>

      {/* Disclosure, not a picker: venue time on every device (see the header). */}
      <p className="event-venue-finder__hint">
        Times are Singapore time ({VENUE_TIME_ZONE}), the venues' local time.
      </p>

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
            {...ariaFor("location")}
          />
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

      {results !== null && results.length > 0 && (
        <ul className="event-venue-finder__results" aria-label="Matching venues">
          {results.map((venue) => (
            <li key={venue.id}>
              <VenueResult venue={venue} headingId={`${idPrefix}-venue-${venue.id}`} />
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
  );
}
