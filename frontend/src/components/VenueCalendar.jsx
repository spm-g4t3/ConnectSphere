// VenueCalendar.jsx
//
// SCRUM-180 (part of SCRUM-178): one venue's availability over a day, a
// week or a month -- approved bookings as "Booked", flagged ones as "Booked –
// under review", blocks as "Blocked" with their reason, and (SCRUM-491)
// active tentative holds as "Tentatively held" -- with Previous, Today
// and Next to move through time. It reads GET /venues/:id/calendar
// (SCRUM-179), which merges bookings and blocks into one sorted array.
//
// Hand-built on purpose. The frontend has no date or calendar library, and an
// agenda-style day and week plus a whole-weeks month table is little enough
// that a dependency would cost more than it saves. All the date arithmetic is
// in calendarRange.js and all the wording in calendarEntryDisplay.js, so this
// file only wires state to markup.
//
// Two fetches, deliberately unequal:
//   - The venue header (name, Retired badge) is decoration. If it fails the
//     page falls back to a generic heading and the calendar carries on.
//   - The calendar itself is the page. Its failures are mapped by status to
//     words, as VenueDetail does, and shown in an alert.
//
// Role-gated by the route (SCRUM-182's ProtectedRoute in App.jsx); the 403
// message below is only a fallback if the backend refuses anyway.

import { useEffect, useId, useState } from "react";
import { getVenueCalendar, getVenueDetails } from "../services/venueService";
import {
  CALENDAR_VIEWS,
  daysIn,
  entriesOnDay,
  rangeFor,
  rangeTitle,
  shiftAnchor,
  startOfDay,
  toWireWindow,
} from "../services/calendarRange";
import { calendarEntryDisplay } from "../services/calendarEntryDisplay";
import {
  formatDateTimeRange,
  formatDayMonth,
  formatLongDay,
  formatWeekdayShort,
} from "../services/displayFormat";
import { formatOccupiedPeriod } from "../services/occupiedPeriodDisplay";
import { SESSION_EXPIRED } from "../services/apiErrors";
import Button from "./ui/Button";
import StatusBadge from "./ui/StatusBadge";
import LoadingText from "./ui/LoadingText";
import EmptyState from "./ui/EmptyState";
import ErrorNotice from "./ui/ErrorNotice";
import { VENUE_TONES } from "../services/venueStatusTones";

// Keyed by status, the same shape as VenueDetail's BOOKINGS_ERROR_MESSAGES.
// The server's `error` string is not surfaced: on the venue routes it is
// database prose carrying raw uuids.
const ERROR_MESSAGES = {
  400: "That venue id was not recognised. Please go back and refresh.",
  401: SESSION_EXPIRED,
  403: "Only Venue Staff and Event Coordinators can see a venue's calendar.",
  404: "That venue does not exist. It may have been removed.",
  500: "The calendar could not be loaded. Please try again.",
};

// Any other status, or no response at all (a network error).
const FALLBACK_ERROR = "Could not load this venue's calendar. Please try again.";

const VIEW_LABELS = { day: "Day", week: "Week", month: "Month" };

const EMPTY_TEXT = "Nothing booked or blocked in this period.";

/**
 * One entry. `compact` (the month view) drops the visible time range to keep
 * a cell small; the range stays in the title either way.
 *
 * A booking's time is its whole occupied period -- setup, event, turnaround
 * (SCRUM-484, AC7) -- because that is how long the venue is unavailable. So
 * is a tentative hold's (SCRUM-491). A block has no setup or turnaround, so
 * it keeps its own range.
 */
function CalendarEntry({ entry, compact }) {
  const { label, detail, tone } = entry.display;
  const when =
    entry.kind === "booking" || entry.kind === "hold"
      ? formatOccupiedPeriod(entry, formatDateTimeRange)
      : formatDateTimeRange(entry.startsAt, entry.endsAt);
  return (
    <li className={`venue-calendar__entry venue-calendar__entry--${tone}`} title={when}>
      {!compact && <span className="venue-calendar__entry-time">{when}</span>}
      <span className="venue-calendar__entry-label">{label}</span>
      {detail && <span className="venue-calendar__entry-detail">{detail}</span>}
    </li>
  );
}

function EntryList({ entries, compact = false }) {
  return (
    <ul className="venue-calendar__entries">
      {entries.map((entry) => (
        // A booking and a block live in different tables, so their ids are
        // only unique together with their kind.
        <CalendarEntry key={`${entry.kind}-${entry.id}`} entry={entry} compact={compact} />
      ))}
    </ul>
  );
}

/**
 * The venue calendar.
 *
 * @param {Object} props
 * @param {string} props.venueId
 * @param {Date} [props.initialDate]  the day the calendar opens on; today by default
 */
export default function VenueCalendar({ venueId, initialDate = new Date() }) {
  const [view, setView] = useState("week");
  const [anchor, setAnchor] = useState(initialDate);
  const [venue, setVenue] = useState(null);

  // The last answer, tagged with the request it answers. "Loading" is then
  // simply "the answer on hand is for some other window", so there is no
  // loading flag to set and reset, and an answer for a window the user has
  // already moved past can never be shown as this one's.
  const [result, setResult] = useState({ key: null, entries: [], error: null });
  // Bumped by Try again. Part of the request key, so a retry shows Loading...
  // and an answer to an earlier attempt can never stand in for it.
  const [attempt, setAttempt] = useState(0);

  const titleId = useId();

  const range = rangeFor(view, anchor);
  const { from, to } = toWireWindow(range);
  const requestKey = `${venueId} ${from} ${to} ${attempt}`;

  useEffect(() => {
    let cancelled = false;

    // A failed header is the same as no header: null, and a generic heading.
    getVenueDetails(venueId)
      .catch(() => null)
      .then((data) => {
        if (!cancelled) setVenue(data);
      });

    return () => {
      cancelled = true;
    };
  }, [venueId]);

  // Keyed on the wire strings, not on `anchor`: Today pressed while already
  // on today's week is a new Date but the same window, and refetching it
  // would only flash the loading line.
  useEffect(() => {
    let cancelled = false;

    getVenueCalendar(venueId, { from, to })
      .then(
        (entries) => ({ entries, error: null }),
        (err) => ({
          entries: [],
          error: ERROR_MESSAGES[err.response?.status] || FALLBACK_ERROR,
        }),
      )
      .then((outcome) => {
        // The stale guard: quick clicks start several requests, and only the
        // one for the window still on screen may land.
        if (!cancelled) setResult({ key: `${venueId} ${from} ${to} ${attempt}`, ...outcome });
      });

    return () => {
      cancelled = true;
    };
  }, [venueId, from, to, attempt]);

  const loading = result.key !== requestKey;

  // Resolved once here so an entry the display rules do not recognise is
  // dropped everywhere, the empty state included.
  const visible = result.entries.flatMap((entry) => {
    const display = calendarEntryDisplay(entry);
    return display ? [{ ...entry, display }] : [];
  });

  const todayTime = startOfDay(new Date()).getTime();
  const days = daysIn(range);

  function showDay(day) {
    setView("day");
    setAnchor(day);
  }

  function cellProps(day, extraClass) {
    const isToday = day.getTime() === todayTime;
    return {
      className: `venue-calendar__cell${extraClass}${isToday ? " venue-calendar__cell--today" : ""}`,
      "aria-current": isToday ? "date" : undefined,
    };
  }

  return (
    <div className="venue-calendar">
      <header className="venue-calendar__header">
        <span className="eyebrow">Venue calendar</span>
        <h1>{venue ? venue.name : "Venue calendar"}</h1>
        {venue?.retiredAt && <StatusBadge tone={VENUE_TONES.retired}>Retired</StatusBadge>}
      </header>

      <div className="venue-calendar__toolbar">
        <div className="venue-calendar__nav" role="group" aria-label="Move through the calendar">
          <Button
            variant="secondary"
            aria-label={`Previous ${view}`}
            onClick={() => setAnchor((current) => shiftAnchor(view, current, -1))}
          >
            Previous
          </Button>
          <Button variant="secondary" aria-label="Go to today" onClick={() => setAnchor(new Date())}>
            Today
          </Button>
          <Button
            variant="secondary"
            aria-label={`Next ${view}`}
            onClick={() => setAnchor((current) => shiftAnchor(view, current, 1))}
          >
            Next
          </Button>
        </div>

        <div className="venue-calendar__views" role="group" aria-label="Calendar view">
          {CALENDAR_VIEWS.map((option) => (
            // The chosen view is the filled variant; aria-pressed says the same in words.
            <Button
              key={option}
              variant={option === view ? "primary" : "secondary"}
              aria-pressed={option === view}
              onClick={() => setView(option)}
            >
              {VIEW_LABELS[option]}
            </Button>
          ))}
        </div>
      </div>

      <h2 id={titleId} className="venue-calendar__title" aria-live="polite">
        {rangeTitle(view, range)}
      </h2>

      {loading && <LoadingText />}

      {!loading && result.error && (
        <ErrorNotice
          message={result.error}
          onRetry={result.error === SESSION_EXPIRED ? undefined : () => setAttempt((n) => n + 1)}
        />
      )}

      {!loading && !result.error && (
        <>
          {visible.length === 0 && (
            <EmptyState
              message={EMPTY_TEXT}
              nextStep="Use Previous or Next to look at another period."
            />
          )}

          {view === "day" && visible.length > 0 && <EntryList entries={visible} />}

          {view === "week" && (
            <div className="venue-calendar__scroll">
              <table className="venue-calendar__grid venue-calendar__grid--week" aria-labelledby={titleId}>
                <thead>
                  <tr>
                    {days.map((day) => (
                      <th key={day.getTime()} scope="col">
                        <span className="venue-calendar__weekday">{formatWeekdayShort(day)}</span>{" "}
                        <span className="venue-calendar__date">{formatDayMonth(day)}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    {days.map((day) => {
                      const dayEntries = entriesOnDay(visible, day);
                      return (
                        <td key={day.getTime()} {...cellProps(day, "")}>
                          {dayEntries.length > 0 && <EntryList entries={dayEntries} />}
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {view === "month" && (
            <div className="venue-calendar__scroll">
              <table className="venue-calendar__grid venue-calendar__grid--month" aria-labelledby={titleId}>
                <thead>
                  <tr>
                    {days.slice(0, 7).map((day) => (
                      <th key={day.getTime()} scope="col">
                        {formatWeekdayShort(day)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {days
                    .filter((_, index) => index % 7 === 0)
                    .map((weekStart, week) => (
                      <tr key={weekStart.getTime()}>
                        {days.slice(week * 7, week * 7 + 7).map((day) => {
                          const dayEntries = entriesOnDay(visible, day);
                          const outside = day.getMonth() !== anchor.getMonth();
                          return (
                            <td
                              key={day.getTime()}
                              {...cellProps(day, outside ? " venue-calendar__cell--muted" : "")}
                            >
                              <Button
                                variant="link"
                                className="venue-calendar__day-number"
                                aria-label={`Show ${formatLongDay(day)}`}
                                onClick={() => showDay(day)}
                              >
                                {day.getDate()}
                              </Button>
                              {dayEntries.length > 0 && <EntryList entries={dayEntries} compact />}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
