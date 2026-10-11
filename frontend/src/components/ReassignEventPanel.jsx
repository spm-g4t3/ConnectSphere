// ReassignEventPanel.jsx
//
// SCRUM-334, for SCRUM-327 AC6 and AC9: the assigned coordinator hands an
// event to a colleague, with an optional note for them.
//
// A full-page panel with a back button, opened from CoordinatorRequestDetail,
// like every other panel in this frontend. There is no modal anywhere in the
// codebase, and a handover is not the place to introduce the first.
//
// This screen decides nothing about who may hand over. The parent shows the
// button only to the assigned coordinator, as a convenience; the server's
// reassign_event_request (018) is the gate, and checks it again under a lock.
// So every refusal the server can give is handled below, including the ones
// the parent's check should make rare.

import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { listCoordinators, reassignEventRequest } from "../services/eventRequestService";

const LOAD_ERROR_MESSAGES = {
  401: "Your session has expired. Please sign in again.",
  403: "Only Event Coordinators can hand an event over.",
  500: "The list of coordinators could not be loaded. Please try again.",
};

// Keyed by status, as ReviewQueue's table is, and for a stronger reason: the
// server's messages here are written by the database and name ids, for
// example "only the coordinator assigned to event request 2f1c... can hand it
// over", or "A value was rejected by the database: ...". Neither is fit to
// show, so this screen says what happened in its own words.
//
// 409 means one of two things: the event's status does not allow a handover,
// or the event changed hands while this screen was open. They are not told
// apart, on purpose. Both share a status code, so telling them apart would
// mean matching the database's message text, which is exactly what the
// backend avoided by giving each refusal its own SQLSTATE, and which would
// break silently the day a message is reworded. Both also have the same
// remedy: go back, reopen the event, see where it stands. 018 records that
// the second can only happen if the row lock has failed, so in practice a 409
// is the status case. The message names both so it is true either way.
//
// 400 likewise covers two: the person chosen is no longer an Event
// Coordinator, or they already hold the event. The remedy is the same, choose
// someone else, so one message.
//
// 403, since SCRUM-486 (SCRUM-519). It used to say "This event is no longer
// assigned to you", which was the only way a coordinator could be refused
// when only the holder could hand over. 041 lets the Event Coordinator Lead
// hand over any event too, so a 403 now means the caller is neither the
// holder nor a Lead, and "assigned to you" would be wrong said to a Lead.
// The message says who may hand an event over, which is true for any caller.
const REASSIGN_ERROR_MESSAGES = {
  400: "That person cannot take this event. They may no longer be an Event Coordinator. Choose someone else.",
  401: "Your session has expired. Please sign in again.",
  403: "You cannot hand this event over. Only the coordinator who holds it, or the Event Coordinator Lead, can do that, and it may have been handed to someone else. Go back and reopen it to see who holds it now.",
  404: "This event no longer exists.",
  409: "This event cannot be handed over right now. Its status may not allow a handover, or it changed while you were looking at it. Go back and reopen it to see where it stands.",
  500: "The event could not be handed over. Please try again.",
};

/** A coordinator as a picker option, never "null". */
function optionLabel(coordinator) {
  return coordinator.fullName ?? `No name on record (${coordinator.id})`;
}

/**
 * @param {object} props
 * @param {object} props.request        the event being handed over
 * @param {Function} props.onCancel     back to the event, nothing changed
 * @param {Function} props.onReassigned called with (updatedEvent, chosenCoordinator)
 *                                      once the server has accepted the handover
 */
export default function ReassignEventPanel({ request, onCancel, onReassigned }) {
  const { user } = useAuth();
  const [coordinators, setCoordinators] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [newCoordinatorId, setNewCoordinatorId] = useState("");
  const [handoverNote, setHandoverNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    listCoordinators()
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

  // The signed-in user is left out. listCoordinators returns everyone,
  // including the caller, and handing an event to yourself is refused by the
  // server with a database message. Matched on id because AuthContext's user
  // has no name to match on. Done here and not on the server, because "every
  // coordinator except me" is this picker's need, not the list's meaning.
  const choices = coordinators.filter((coordinator) => coordinator.id !== user?.id);

  async function handleSubmit(event) {
    event.preventDefault();

    if (!newCoordinatorId) {
      setSubmitError("Choose who to hand this event to.");
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    try {
      // The note is sent as typed. The server stores a blank one as no note,
      // so there is nothing to tidy here.
      const updated = await reassignEventRequest(request.id, { newCoordinatorId, handoverNote });
      const chosen = choices.find((coordinator) => coordinator.id === newCoordinatorId) ?? null;
      onReassigned?.(updated, chosen);
    } catch (err) {
      setSubmitError(
        REASSIGN_ERROR_MESSAGES[err.response?.status] ||
          "The event could not be handed over. Please try again.",
      );
      setSubmitting(false);
    }
  }

  return (
    <div className="reassign-event">
      {/* No back button of its own. The parent that mounts this panel already
          renders one directly above it, as the parent does for every panel in
          this codebase, and two stacked back buttons read as a bug. Going
          back to the event, rather than out to the list, is the form's Cancel
          button, and the Cancel below the messages when there is no form. */}
      <h2>Hand over {request.eventName}</h2>
      {/* SCRUM-327 AC7, said before the coordinator commits: after this they
          can still read the event, and can no longer change it. */}
      <p>
        The coordinator you choose becomes responsible for this event. You will
        still be able to view it, but not change it.
      </p>

      {loading && <p>Loading coordinators...</p>}
      {loadError && (
        <p className="coordinator-clarification__error" role="alert">{loadError}</p>
      )}
      {!loading && !loadError && choices.length === 0 && (
        <p>There is no other Event Coordinator to hand this event to.</p>
      )}

      {/* When the list failed to load, or there is nobody to choose, there is
          no form and so no form Cancel. Without this the only way out would
          be the parent's back button, which leaves the event for the list
          instead of returning to it. */}
      {!loading && (loadError || choices.length === 0) && (
        <div className="reassign-event__actions">
          <button type="button" onClick={onCancel}>
            Back to the event
          </button>
        </div>
      )}

      {!loading && !loadError && choices.length > 0 && (
        <form className="reassign-event__form" onSubmit={handleSubmit}>
          <label>
            Hand over to
            <select
              value={newCoordinatorId}
              onChange={(event) => {
                setNewCoordinatorId(event.target.value);
                setSubmitError(null);
              }}
              required
            >
              <option value="">Choose a coordinator</option>
              {/* In the server's order, by name, with anyone unnamed last. */}
              {choices.map((coordinator) => (
                <option key={coordinator.id} value={coordinator.id}>
                  {optionLabel(coordinator)}
                </option>
              ))}
            </select>
          </label>

          <label>
            Note for the new coordinator (optional)
            <textarea
              value={handoverNote}
              onChange={(event) => setHandoverNote(event.target.value)}
              rows={4}
              placeholder="Anything they should know: what is done, what is waiting, where your notes are."
            />
          </label>
          {/* Said here because it decides what gets written: the note is for
              the coordinator team and is never shown to the Organiser. */}
          <p className="reassign-event__hint">
            Other coordinators can read this note. The Organiser cannot.
          </p>

          {submitError && (
            <p className="coordinator-clarification__error" role="alert">{submitError}</p>
          )}

          <div className="reassign-event__actions">
            <button type="submit" disabled={submitting || !newCoordinatorId}>
              {submitting ? "Handing over..." : "Confirm handover"}
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
