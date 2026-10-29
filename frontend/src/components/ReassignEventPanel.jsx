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
// button only to the assigned coordinator or an Event Coordinator Lead, as a
// convenience; the server's reassign_event_request (052) is the gate, and
// checks it again under a lock. So every refusal the server can give is
// handled below, including the ones the parent's check should make rare.
//
// SCRUM-486 (SCRUM-521): two callers. Since 052 the Lead may hand over any
// event, not only the holder. Three things follow, each marked below: which
// list of coordinators is read, who is left out of it, and wording that was
// written for a caller who held the event.

import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { normaliseRole } from "../auth/normaliseRole";
import {
  listCoordinatorWorkload,
  listCoordinators,
  reassignEventRequest,
} from "../services/eventRequestService";
import { coordinatorOptionLabel } from "../services/coordinatorDisplay";

// 403 reworded in SCRUM-521. It said "Only Event Coordinators can hand an
// event over", which has been false since 052 let the Lead hand over too.
const LOAD_ERROR_MESSAGES = {
  403: "Only Event Coordinators and the Event Coordinator Lead can hand an event over.",
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
// someone else, so one message. Since SCRUM-521 the message names both: it
// used to name only the first, because the second could not be chosen when
// the caller was the holder and the list left the caller out. The list now
// leaves out whoever holds the event, so it is again rare, and only a stale
// list (someone else handed the event on while this one was open) reaches it.
//
// 403, since SCRUM-486 (SCRUM-519). It used to say "This event is no longer
// assigned to you", which was the only way a coordinator could be refused
// when only the holder could hand over. 052 lets the Event Coordinator Lead
// hand over any event too, so a 403 now means the caller is neither the
// holder nor a Lead, and "assigned to you" would be wrong said to a Lead.
// The message says who may hand an event over, which is true for any caller.
const REASSIGN_ERROR_MESSAGES = {
  400: "That person cannot take this event. They may no longer be an Event Coordinator, or they may already hold it. Choose someone else.",
  403: "You cannot hand this event over. Only the coordinator who holds it, or the Event Coordinator Lead, can do that, and it may have been handed to someone else. Go back and reopen it to see who holds it now.",
  404: "This event no longer exists.",
  409: "This event cannot be handed over right now. Its status may not allow a handover, or it changed while you were looking at it. Go back and reopen it to see where it stands.",
  500: "The event could not be handed over. Please try again.",
};

/**
 * @param {object} props
 * @param {object} props.request        the event being handed over
 * @param {string} [props.outgoingCoordinatorId]  who holds it now; the request's
 *                                      own assignedCoordinatorId unless the parent
 *                                      knows of a handover since it was loaded
 * @param {Function} props.onCancel     back to the event, nothing changed
 * @param {Function} props.onReassigned called with (updatedEvent, chosenCoordinator)
 *                                      once the server has accepted the handover
 */
export default function ReassignEventPanel({
  request,
  outgoingCoordinatorId = request.assignedCoordinatorId,
  onCancel,
  onReassigned,
}) {
  const { user } = useAuth();
  const isLead = normaliseRole(user?.role) === "EVENT_COORDINATOR_LEAD";
  const callerHoldsIt = Boolean(user?.id) && user.id === outgoingCoordinatorId;
  const [coordinators, setCoordinators] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [newCoordinatorId, setNewCoordinatorId] = useState("");
  const [handoverNote, setHandoverNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    // Which list, by role. GET /coordinators is the coordinators' (SCRUM-334)
    // and refuses a Lead, deliberately (SCRUM-485 AC5); the Lead's own list
    // of the same people is GET /coordinator-workload (SCRUM-519), which also
    // gives each one's active events. Widening /coordinators instead would
    // undo that pinned refusal for a need this already meets.
    const loadCoordinators = isLead ? listCoordinatorWorkload : listCoordinators;

    loadCoordinators()
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
  }, [isLead]);

  // Whoever holds the event is left out: handing an event to its current
  // holder is refused by the server (23514, a confusing 400). Done here and
  // not on the server, because "everyone but the holder" is this picker's
  // need, not the list's meaning.
  //
  // SCRUM-521. This used to leave out the signed-in user, which is the same
  // person when the holder hands over, and was right while only the holder
  // could. For a Lead it was wrong twice: the Lead is never in the list, so
  // the filter removed nobody, and the holder stayed in it, offered as a
  // choice the server would refuse. A coordinator who is not the holder is
  // never shown this panel (the parent shows the button to the holder or a
  // Lead), and if one were, they would be listed: they are a valid choice.
  const choices = coordinators.filter((coordinator) => coordinator.id !== outgoingCoordinatorId);

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
      {/* SCRUM-327 AC7, said before the caller commits: after this the
          coordinator handing it over can still read the event, and can no
          longer change it. Said to the holder as "you"; a Lead never could
          change it, so to a Lead it is said about the holder (SCRUM-521). */}
      <p>
        {callerHoldsIt
          ? "The coordinator you choose becomes responsible for this event. You will still be able to view it, but not change it."
          : "The coordinator you choose becomes responsible for this event. The coordinator who holds it now will still be able to view it, but not change it."}
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
                  {coordinatorOptionLabel(coordinator)}
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
