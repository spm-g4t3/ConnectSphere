// MyAssignedEvents.jsx
//
// SCRUM-333, for SCRUM-327 AC11: each coordinator has a "My events" list
// showing the events assigned to them, grouped by status, earliest event
// first, each showing the event name, the organiser, the date and the status.
//
// Beside the review queue, not instead of it. The queue is every event
// awaiting a decision across the whole team, whoever holds it; this is the
// work one coordinator holds, every status. Both are on the dashboard (see
// EventCoordinatorDashboard for why).
//
// Built the way ReviewQueue is, on purpose, so the two sections on one screen
// behave alike: a useCallback fetch, a refetch when the tab regains focus, a
// status-keyed error table, readStatusDisplay and statusClassName for badges,
// an activePanel for the detail view, and a <section> root that takes its card
// styling and badge colours from whichever .dashboard--coordinator wrapper
// mounted it. That is why App.jsx's /my-events route supplies the wrapper
// itself, as /review-queue does.

import { useCallback, useEffect, useState } from "react";
import { getMyAssignedEvents } from "../services/eventRequestService";
import {
  readStatusDisplay,
  statusClassName,
} from "../services/eventRequestStatusDisplay";
import SafetyApprovalNotice from "./SafetyApprovalNotice";
import NeedsAttentionBadge from "./NeedsAttentionBadge";
import CoordinatorRequestDetail from "./CoordinatorRequestDetail";

// Keyed by status, the same shape as ReviewQueue's QUEUE_ERROR_MESSAGES.
// GET /mine is gated on the coordinator role, so a 403 means the account's
// role is wrong, an administration problem rather than a breakage, and the
// message says so instead of "could not load".
const MY_EVENTS_ERROR_MESSAGES = {
  401: "Your session has expired. Please sign in again.",
  403: "Only Event Coordinators have a My events list.",
  500: "Your events could not be loaded. Please try again.",
};

// The order the groups appear in, and what each is called on this screen.
//
// Ordered by what needs the coordinator, not alphabetically. Alphabetical
// would put Approved first and New in the middle, an order that means nothing
// to the person reading it. Instead:
//
//   1. New, not yet reviewed (submitted): nobody has touched these, and the
//      coordinator is the one person who now can.
//   2. Under review: the coordinator's move, already started.
//   3. Waiting on the organiser (pending clarification): the coordinator asked
//      a question and is waiting for the answer, so it needs watching more
//      than acting on.
//   4. Approved (approved and in planning): decided; the arrangements are
//      still to make.
//   5. Confirmed: going ahead. Nothing to do but be ready on the day.
//   6. Then the three finished groups, collapsed (see below).
//
// Keyed on statusDisplay.group, not the raw status, because the group is the
// stable half of the contract (eventRequestStatusDisplay.js says why): a
// status added later lands in an existing group and this table needs no edit.
//
// The headings are this screen's, not a copy of the status vocabulary. The
// server's labels are written for the Organiser, so pending clarification is
// "Action Needed", meaning the Organiser's action. Read by a coordinator, that
// heading would say the opposite of the truth. Each row's badge still shows
// the server's label, so the status itself is never re-worded here.
const OPEN_GROUPS = [
  { group: "AWAITING_REVIEW", heading: "New, not yet reviewed" },
  { group: "UNDER_REVIEW", heading: "Under review" },
  { group: "ACTION_REQUIRED", heading: "Waiting on the organiser" },
  { group: "APPROVED", heading: "Approved" },
  { group: "CONFIRMED", heading: "Confirmed" },
];

// Collapsed by default. The list never shrinks: the backend returns every
// status, so that a coordinator can still find the event they rejected when
// its Organiser asks why. Over a semester, finished events become most of the
// list. Collapsed, they stay one click away and the screen stays about the
// work that is still open. <details> rather than state and a toggle button:
// it is the browser's own disclosure control, works from the keyboard and to
// a screen reader with nothing added, and EventOrganiserDashboard already uses
// it for the same job.
const FINISHED_GROUPS = [
  { group: "COMPLETED", heading: "Completed" },
  { group: "REJECTED", heading: "Rejected" },
  { group: "CANCELLED", heading: "Cancelled" },
];

/**
 * Group the server's list for display, keeping the server's order.
 *
 * The backend already orders the whole list, earliest event first with
 * undated events last. Splitting it into groups keeps that order within each
 * group, because each event is appended in the order it arrived. Nothing is
 * re-sorted here, for the reason ReviewQueue gives: "what is coming up
 * soonest" is a fact the server answered, and a second answer in the client is
 * how two screens start disagreeing.
 *
 * A group in neither table above (a fallback such as UNKNOWN, or a group added
 * to the backend later) is still shown, after the open groups and before the
 * finished ones: it is not known to be finished, so it must not be collapsed
 * out of sight. Its heading is the server's label for its first event.
 *
 * @param {Array} events  the response of GET /event-requests/mine
 * @returns {Array<{group, heading, finished, events}>} only non-empty groups
 */
function groupByStatus(events) {
  const byGroup = new Map();
  for (const event of events) {
    const { group } = readStatusDisplay(event);
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(event);
  }

  const named = new Set([...OPEN_GROUPS, ...FINISHED_GROUPS].map((entry) => entry.group));
  const unnamed = [...byGroup.keys()]
    .filter((group) => !named.has(group))
    .map((group) => ({ group, heading: readStatusDisplay(byGroup.get(group)[0]).label }));

  return [
    ...[...OPEN_GROUPS, ...unnamed].map((entry) => ({ ...entry, finished: false })),
    ...FINISHED_GROUPS.map((entry) => ({ ...entry, finished: true })),
  ]
    .filter((entry) => byGroup.has(entry.group))
    .map((entry) => ({ ...entry, events: byGroup.get(entry.group) }));
}

/**
 * The event's date, or an honest statement that it has none.
 *
 * services/datetimeFormat.js has no read-only formatter: it converts to and
 * from the datetime-local input format, for forms. So this follows
 * EventOrganiserDashboard's formatEventDate, word for word, so the two lists
 * show a date the same way.
 */
function formatEventDate(value) {
  if (!value) return "Date not set";

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/**
 * Who organised the event, never the word "null".
 *
 * organiserName is null when the Organiser has no name on record. The id is
 * then the only thing that identifies them, so it is shown as an identifier,
 * and the label says why a name is missing rather than leaving a blank.
 */
function OrganiserName({ event }) {
  if (event.organiserName) return <span>{event.organiserName}</span>;

  return (
    <span>
      No name on record <code title={event.organiserId ?? undefined}>{event.organiserId ?? "unknown"}</code>
    </span>
  );
}

function EventRow({ event, onOpen }) {
  // Labels come from the API, so this component never interprets a status.
  const display = readStatusDisplay(event);
  const overdue = event.status === "pending_clarification" &&
    event.clarificationReplyByDate &&
    event.clarificationReplyByDate < new Date().toISOString().slice(0, 10);

  return (
    <li className="my-assigned-events__row">
      <div className="my-assigned-events__summary">
        <span className="my-assigned-events__title">
          <strong>{event.eventName}</strong>
          <span className={`status-badge ${statusClassName(display.group)}`}>
            {display.label}
          </span>
          <NeedsAttentionBadge event={event} />
        </span>
        <span className="my-assigned-events__meta">
          <span>{formatEventDate(event.proposedStart)}</span>
          {overdue && <strong className="clarification-overdue">Overdue</strong>}
          <span>
            Organiser: <OrganiserName event={event} />
          </span>
        </span>
        <SafetyApprovalNotice status={event.status} />
      </div>
      <button onClick={() => onOpen(event)}>Open</button>
    </li>
  );
}

export default function MyAssignedEvents() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Which panel is open, if any: { mode: "detail", request } | null. The same
  // full-page-panel-with-a-back-button pattern ReviewQueue uses; there is no
  // modal anywhere in this frontend.
  const [activePanel, setActivePanel] = useState(null);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getMyAssignedEvents();
      setEvents(data);
      // An event handed over leaves this list; keep its panel open (SCRUM-334)
      // so the coordinator sees the handover rather than losing the page.
      setActivePanel((current) => {
        if (!current) return current;
        const refreshed = data.find((event) => event.id === current.request.id);
        return refreshed ? { ...current, request: refreshed } : current;
      });
      setError(null);
      return data;
    } catch (err) {
      setError(
        MY_EVENTS_ERROR_MESSAGES[err.response?.status] ||
          "Your events could not be loaded. Please try again.",
      );
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  // Refetch when the coordinator comes back to the tab, for ReviewQueue's
  // reason: these events change while the coordinator is not looking. An
  // Organiser answers a clarification, a colleague hands an event over, and
  // the list should show it the moment the coordinator looks again. One
  // request per visit, not one every few seconds per open tab.
  useEffect(() => {
    function refetchIfVisible() {
      if (document.visibilityState === "visible") fetchEvents();
    }

    window.addEventListener("focus", refetchIfVisible);
    document.addEventListener("visibilitychange", refetchIfVisible);

    return () => {
      window.removeEventListener("focus", refetchIfVisible);
      document.removeEventListener("visibilitychange", refetchIfVisible);
    };
  }, [fetchEvents]);

  // The row from this list is a complete event request (the backend selects
  // the same columns as every other read), so the detail panel renders from it
  // with no second fetch, as it does from a queue row.
  if (activePanel?.mode === "detail") {
    return (
      <section>
        <button className="review-queue__back" onClick={() => setActivePanel(null)}>
          &larr; Back to my events
        </button>
        <CoordinatorRequestDetail
          request={activePanel.request}
          onReviewDecisionProcessed={() => {
            setActivePanel(null);
            fetchEvents();
          }}
          onChangeRequestProcessed={fetchEvents}
        />
      </section>
    );
  }

  const groups = groupByStatus(events);
  const openEvent = (request) => setActivePanel({ mode: "detail", request });
  const today = new Date().toISOString().slice(0, 10);
  const overdueClarifications = events
    .filter((event) =>
      event.status === "pending_clarification" &&
      event.clarificationReplyByDate &&
      event.clarificationReplyByDate < today)
    .sort((first, second) =>
      first.clarificationReplyByDate.localeCompare(second.clarificationReplyByDate));

  return (
    <section className="my-assigned-events">
      <h2>My events</h2>

      {loading && <p>Loading...</p>}
      {error && (
        <p className="review-queue__error" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && overdueClarifications.length > 0 && (
        <div className="my-assigned-events__needs-attention" role="region" aria-label="Needs attention">
          <h3>Needs attention</h3>
          <p>Clarification reply dates have passed. No status change has been made.</p>
          <ul>
            {overdueClarifications.map((event) => (
              <EventRow key={event.id} event={event} onOpen={openEvent} />
            ))}
          </ul>
        </div>
      )}
      {/* Nothing assigned is the good state, not a missing resource. */}
      {!loading && !error && events.length === 0 && (
        <p>No events are assigned to you right now.</p>
      )}

      {groups.map(({ group, heading, finished, events: groupEvents }) => {
        const rows = (
          <ul>
            {groupEvents.map((event) => (
              <EventRow key={event.id} event={event} onOpen={openEvent} />
            ))}
          </ul>
        );

        return finished ? (
          <details key={group} className="my-assigned-events__group my-assigned-events__group--finished">
            <summary>
              {heading} <span className="my-assigned-events__count">({groupEvents.length})</span>
            </summary>
            {rows}
          </details>
        ) : (
          <div key={group} className="my-assigned-events__group">
            <h3>
              {heading} <span className="my-assigned-events__count">({groupEvents.length})</span>
            </h3>
            {rows}
          </div>
        );
      })}
    </section>
  );
}
