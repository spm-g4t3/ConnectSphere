// AssignCoordinatorPanel.jsx
//
// SCRUM-486 (SCRUM-519), AC3 and AC4: the Event Coordinator Lead chooses the
// Event Coordinator for one unassigned request, with an optional note.
//
// A full-page panel opened from UnassignedQueue, like ReassignEventPanel is
// from the event screen. There is no modal anywhere in this frontend.
//
// What AC3 rules out, and how this screen keeps to it:
//
//   * No default. Nothing is checked when the list arrives, and Confirm stays
//     disabled until the Lead picks someone. A preselected first row would be
//     the system's suggestion, made silently.
//   * No ordering by workload, no "recommended" mark. The list is shown in
//     the server's order, by name, and never re-sorted here. Each name carries
//     its active-event count as a fact to weigh, not a ranking.
//   * Only Event Coordinators. The server's list has no Lead in it; this
//     screen adds nobody and filters nobody.
//
// Radio buttons rather than ReassignEventPanel's <select>: a select shows one
// name until opened, so the counts the Lead is meant to compare would be
// hidden behind a click. A list of radios shows every name and count at once.
//
// This screen decides nothing about who may assign. The server's
// assign_event_request (041) checks the caller is a Lead, the request is still
// unassigned, and the person chosen is an Event Coordinator, under a lock.

import { useEffect, useState } from "react";
import { assignEventRequest, listCoordinatorWorkload } from "../services/eventRequestService";

const LOAD_ERROR_MESSAGES = {
  401: "Your session has expired. Please sign in again.",
  403: "Only the Event Coordinator Lead can assign event requests.",
  500: "The list of coordinators could not be loaded. Please try again.",
};

// Keyed by status, as ReassignEventPanel's table is, and for the same reason:
// the server's messages name ids and are written by the database. 409 is the
// one with two meanings, and unlike ReassignEventPanel's they are told apart,
// by the response's code, never by its text (see assignErrorMessage).
const ASSIGN_ERROR_MESSAGES = {
  400: "That person cannot be assigned this request. They may no longer be an Event Coordinator. Choose someone else.",
  401: "Your session has expired. Please sign in again.",
  403: "Only the Event Coordinator Lead can assign event requests.",
  404: "This request no longer exists.",
  409: "This request can no longer be assigned. It may have been withdrawn or cancelled. Go back to the queue to see what is still waiting.",
  500: "The request could not be assigned. Please try again.",
};

/**
 * AC4: a lost race names who won it. The name comes from the response's
 * conflicts, which the backend reads for this purpose (code ALREADY_ASSIGNED),
 * so nothing here parses a message that could be reworded.
 */
function assignErrorMessage(err) {
  const status = err.response?.status;
  const data = err.response?.data;

  if (status === 409 && data?.code === "ALREADY_ASSIGNED") {
    const name = data.conflicts?.[0]?.assignedCoordinatorName ?? "another coordinator";
    return `This request has already been assigned to ${name}, by another Event Coordinator Lead. Go back to the queue; it is no longer waiting.`;
  }

  return ASSIGN_ERROR_MESSAGES[status] || "The request could not be assigned. Please try again.";
}

/** A coordinator as a choice, never "null". */
function nameOf(coordinator) {
  return coordinator.fullName ?? `No name on record (${coordinator.id})`;
}

/** "1 active event", "3 active events". The server always sends a count, 0 included. */
function workloadOf({ activeEvents }) {
  return `${activeEvents} active event${activeEvents === 1 ? "" : "s"}`;
}

/**
 * @param {object} props
 * @param {object} props.request        the unassigned request
 * @param {Function} props.onCancel     back to the queue, nothing changed
 * @param {Function} props.onAssigned   called with (updatedRequest, chosenCoordinator)
 */
export default function AssignCoordinatorPanel({ request, onCancel, onAssigned }) {
  const [coordinators, setCoordinators] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [coordinatorId, setCoordinatorId] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  // After a 404 or 409 nothing on this form can succeed: the request is gone,
  // taken, or no longer waiting. The form gives way to a way back.
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    let cancelled = false;

    listCoordinatorWorkload()
      .then((data) => {
        if (!cancelled) setCoordinators(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(
            LOAD_ERROR_MESSAGES[err.response?.status] ||
              "The list of coordinators could not be loaded. Please try again.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event) {
    event.preventDefault();

    setSubmitting(true);
    setSubmitError(null);

    try {
      // The note is sent as typed; the server stores a blank one as no note.
      const updated = await assignEventRequest(request.id, { coordinatorId, note });
      // Always found: the only ids that can be chosen are this list's.
      const chosen = coordinators.find((coordinator) => coordinator.id === coordinatorId);
      onAssigned?.(updated, chosen);
    } catch (err) {
      const status = err.response?.status;
      setSubmitError(assignErrorMessage(err));
      if (status === 404 || status === 409) setFinished(true);
      setSubmitting(false);
    }
  }

  const showForm = !loading && !loadError && coordinators.length > 0 && !finished;

  return (
    <div className="assign-coordinator">
      <h2>Assign {request.eventName}</h2>
      <p>
        The coordinator you choose becomes responsible for this request and is
        told it is theirs. The Organiser is told who their coordinator is.
      </p>

      {loading && <p>Loading coordinators...</p>}
      {loadError && (
        <p className="coordinator-clarification__error" role="alert">{loadError}</p>
      )}
      {!loading && !loadError && coordinators.length === 0 && (
        <p>There is no Event Coordinator to assign this request to.</p>
      )}

      {finished && submitError && (
        <p className="coordinator-clarification__error" role="alert">{submitError}</p>
      )}

      {/* With no form there is no form Cancel, so the way back is offered on
          its own: after a failed load, an empty list, or a refusal nothing
          on the form can fix. */}
      {!loading && !showForm && (
        <div className="assign-coordinator__actions">
          <button type="button" onClick={onCancel}>
            Back to the queue
          </button>
        </div>
      )}

      {showForm && (
        <form className="assign-coordinator__form" onSubmit={handleSubmit}>
          <fieldset>
            <legend>Assign to</legend>
            {/* In the server's order, by name. Not re-sorted, and nothing
                checked until the Lead chooses (AC3). */}
            {coordinators.map((coordinator) => (
              <label key={coordinator.id} className="assign-coordinator__choice">
                <input
                  type="radio"
                  name="coordinator"
                  value={coordinator.id}
                  checked={coordinatorId === coordinator.id}
                  onChange={() => {
                    setCoordinatorId(coordinator.id);
                    setSubmitError(null);
                  }}
                />
                {nameOf(coordinator)}, {workloadOf(coordinator)}
              </label>
            ))}
          </fieldset>

          <label>
            Note for the coordinator (optional)
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={4}
              placeholder="Anything they should know before they start."
            />
          </label>
          {/* AC9: the note is the assignment history's handover note. The
              Organiser's notice and history leave it out. */}
          <p className="assign-coordinator__hint">
            Coordinators can read this note. The Organiser cannot.
          </p>

          {submitError && (
            <p className="coordinator-clarification__error" role="alert">{submitError}</p>
          )}

          <div className="assign-coordinator__actions">
            <button type="submit" disabled={submitting || !coordinatorId}>
              {submitting ? "Assigning..." : "Confirm assignment"}
            </button>
            <button type="button" onClick={onCancel} disabled={submitting}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
