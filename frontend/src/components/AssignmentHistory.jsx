// AssignmentHistory.jsx
//
// SCRUM-334, for SCRUM-327 AC9 and AC10: who is responsible for an event now,
// and every assignment and handover before that, oldest first.
//
// One component for both audiences, because both see the same thing: the
// current coordinator and the chain of who held the event. The one difference
// is the handover note, which the coordinator team sees and the Organiser
// does not. That difference is decided on the server, by two endpoints, not
// here: the Organiser's endpoint never sends the note at all.
//
// The `view` prop names the audience, "coordinator" or "organiser", rather
// than being a boolean such as includeNotes. The two views are two different
// endpoints with two different checks, ownership for the Organiser and the
// role for a coordinator, so the prop chooses which question is asked of the
// server, not whether to hide a field. A boolean would read as "the same data
// with the note switched off", which is not what happens. Any value other
// than "coordinator" gets the Organiser's view: a typo or a missing prop then
// fails towards showing less, never towards showing the note to an
// Organiser, which is the same default the backend's includeNotes has.
//
// The current coordinator is the newest entry's new coordinator. The history
// is read fresh when this mounts, so it is at least as current as the event
// row the parent is holding, and it is the one source that already carries a
// name and works for both audiences. listCoordinators would also give a name,
// but it is coordinator-only and an Organiser would get a 403.
//
// The root is a <div>, so each parent decides what wraps it: a <section> in
// the coordinator's event panel, a <details> on the Organiser's list.
//
// To read the history again after a handover, the parent changes this
// component's `key`, which remounts it. No refresh prop and no polling.

import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import {
  getAssignmentHistory,
  getAssignmentHistoryForReview,
} from "../services/eventRequestService";

const FETCH_BY_VIEW = {
  coordinator: getAssignmentHistoryForReview,
  organiser: getAssignmentHistory,
};

// Keyed by status, as ReviewQueue's table is. The 404 covers both a missing
// event and, for an Organiser, someone else's event; the server answers the
// two identically on purpose, so this does too.
const HISTORY_ERROR_MESSAGES = {
  401: "Your session has expired. Please sign in again.",
  403: "Only Event Coordinators can see this event's full history.",
  404: "This event's coordinator history is not available.",
  500: "The coordinator history could not be loaded. Please try again.",
};

/**
 * A timestamp in the reader's locale, or the raw string if it will not parse.
 * The same four lines as CoordinatorRequestDetail's formatTimestamp.
 */
function formatTimestamp(value) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

/**
 * A coordinator, never "null".
 *
 * Every name in the history can be null for a person with no name on record,
 * while their id is real. They are shown by id, labelled so it is clear why,
 * the same treatment MyAssignedEvents gives an Organiser with no name. "(you)"
 * marks the signed-in user, so a coordinator can find themselves in the chain.
 */
function PersonName({ id, name, currentUserId }) {
  const you = currentUserId && id === currentUserId ? " (you)" : "";

  if (name) return <span className="assignment-history__name">{name}{you}</span>;

  return (
    <span className="assignment-history__name">
      No name on record <code title={id ?? undefined}>{id ?? "unknown"}</code>{you}
    </span>
  );
}

function HistoryEntry({ entry, currentUserId }) {
  const to = (
    <PersonName id={entry.newCoordinatorId} name={entry.newCoordinatorName} currentUserId={currentUserId} />
  );

  // previousCoordinatorId is null on the first entry, because nobody held the
  // event before it was assigned. So the first line says "assigned to", not
  // "handed from nobody to".
  const movement = entry.previousCoordinatorId === null
    ? <>Assigned to {to}</>
    : (
      <>
        Handed from{" "}
        <PersonName id={entry.previousCoordinatorId} name={entry.previousCoordinatorName} currentUserId={currentUserId} />
        {" "}to {to}
      </>
    );

  // automatic: true means the system assigned the event when it was
  // submitted. There is no person behind it, so assignedByName is null by
  // design, not missing. It is tested here rather than assignedByName, because
  // a name is also null for a person who has none on record, and the two must
  // not read the same.
  const madeBy = entry.automatic
    ? "ConnectSphere, automatically on submission"
    : <PersonName id={entry.assignedById} name={entry.assignedByName} currentUserId={currentUserId} />;

  // The key is checked, not the value. In the coordinator's view handoverNote
  // is always present: a string, or null when nobody wrote one. In the
  // Organiser's view the key is absent, because the server never sent the
  // note. Testing for null would treat "not sent to you" as "none was
  // written", and would tell an Organiser that a coordinator left no note when
  // in fact one may exist and is simply not theirs to read.
  const noteWasSent = "handoverNote" in entry;

  return (
    <li className="assignment-history__entry">
      <div className="assignment-history__movement">{movement}</div>
      <div className="assignment-history__meta">
        {formatTimestamp(entry.createdAt)} &middot; by {madeBy}
      </div>
      {noteWasSent && entry.handoverNote && (
        <blockquote className="assignment-history__note">{entry.handoverNote}</blockquote>
      )}
      {/* "No note" only on a person's handover. An automatic assignment never
          has one, so saying so there would be noise. */}
      {noteWasSent && !entry.handoverNote && !entry.automatic && (
        <div className="assignment-history__no-note">No handover note was left.</div>
      )}
    </li>
  );
}

/**
 * @param {object} props
 * @param {string} props.eventRequestId
 * @param {"coordinator"|"organiser"} props.view  which audience; anything else
 *                                                 gets the Organiser's view
 */
export default function AssignmentHistory({ eventRequestId, view }) {
  const { user } = useAuth();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchHistory = FETCH_BY_VIEW[view] ?? FETCH_BY_VIEW.organiser;

  // State is set only in the promise's callbacks, the way
  // CoordinatorRequestDetail loads its change requests, so a response for an
  // event the user has already left is dropped rather than shown.
  useEffect(() => {
    let cancelled = false;

    fetchHistory(eventRequestId)
      .then((data) => {
        if (!cancelled) setEntries(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            HISTORY_ERROR_MESSAGES[err.response?.status] ||
              "The coordinator history could not be loaded. Please try again.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [eventRequestId, fetchHistory]);

  if (loading) return <div className="assignment-history"><p>Loading coordinator history...</p></div>;

  if (error) {
    return (
      <div className="assignment-history">
        <p className="assignment-history__error" role="alert">{error}</p>
      </div>
    );
  }

  // Oldest first is the server's order and is not re-sorted, so the newest
  // entry, and with it the current coordinator, is the last.
  const newest = entries[entries.length - 1];

  return (
    <div className="assignment-history">
      <p className="assignment-history__current">
        <span className="assignment-history__label">Current coordinator</span>{" "}
        {newest
          ? <PersonName id={newest.newCoordinatorId} name={newest.newCoordinatorName} currentUserId={user?.id} />
          : "Not assigned yet"}
      </p>

      <h4>Assignment history</h4>
      {entries.length === 0 ? (
        // Not "one is assigned on submission": a request cancelled while still
        // a draft also has no history, and will never be submitted.
        <p>No coordinator has been assigned to this request.</p>
      ) : (
        <ol className="assignment-history__list">
          {entries.map((entry) => (
            <HistoryEntry key={entry.id} entry={entry} currentUserId={user?.id} />
          ))}
        </ol>
      )}
    </div>
  );
}
