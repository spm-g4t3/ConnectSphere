// ReassignEventPanel.jsx
//
// SCRUM-334, for SCRUM-327 AC9: an event handed to another coordinator, with
// an optional note for them.
//
// A full-page panel with a back button, opened from CoordinatorRequestDetail,
// like every other panel in this frontend. There is no modal anywhere in the
// codebase, and a handover is not the place to introduce the first.
//
// This screen decides nothing about who may hand over. Since SCRUM-444 (AC3)
// the parent shows the button to the Event Coordinator Lead alone, as a
// convenience; the server's reassign_event_request (055) is the gate, and
// checks it again under a lock. So every refusal the server can give is
// handled below, including the ones the parent's check should make rare.

import { useCallback, useEffect, useState } from "react";
import {
  listCoordinatorWorkload,
  reassignEventRequest,
} from "../services/eventRequestService";
import { coordinatorOptionLabel } from "../services/coordinatorDisplay";
import { canRetryRead } from "../services/apiErrors";
import Button from "./ui/Button";
import EmptyState from "./ui/EmptyState";
import ErrorNotice from "./ui/ErrorNotice";
import LoadingText from "./ui/LoadingText";
import useFocusAfterRetry from "./useFocusAfterRetry";

// The list is the Lead's (GET /coordinator-workload, leadOnly), so a 403 means
// the caller is not the Lead.
const LOAD_ERROR_MESSAGES = {
  403: "Only the Event Coordinator Lead can hand an event over.",
  500: "The list of coordinators could not be loaded.",
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
// someone else, so one message, naming both. The list leaves out whoever holds
// the event, so the second is rare: only a stale list (the event handed on
// while this one was open) reaches it.
//
// 403: the caller is not the Lead (SCRUM-444, 055). The message says who may
// hand an event over, which is true for any caller.
const REASSIGN_ERROR_MESSAGES = {
  400: "That person cannot take this event. They may no longer be an Event Coordinator, or they may already hold it. Choose someone else.",
  403: "You cannot hand this event over. Only the Event Coordinator Lead can do that.",
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
  const [coordinators, setCoordinators] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null); // { message, retryable }
  const [newCoordinatorId, setNewCoordinatorId] = useState("");
  const [handoverNote, setHandoverNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  // State is set only in the callbacks, and only while isActive() holds, so an
  // answer arriving after the panel has closed is dropped.
  const loadCoordinators = useCallback((isActive = () => true) => {
    // The Lead's list (SCRUM-519), the only list of coordinators since SCRUM-444.
    return listCoordinatorWorkload()
      .then((data) => {
        if (isActive()) setCoordinators(data);
      })
      .catch((err) => {
        if (isActive()) {
          setLoadError({
            message: LOAD_ERROR_MESSAGES[err.response?.status] || "The list of coordinators could not be loaded.",
            retryable: canRetryRead(err),
          });
        }
      })
      .finally(() => {
        if (isActive()) setLoading(false);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadCoordinators(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadCoordinators]);

  // Loading starts true, so only a retry needs to raise it.
  function reloadCoordinators() {
    setLoading(true);
    setLoadError(null);
    return loadCoordinators();
  }
  const { headingRef, retry: retryLoad } = useFocusAfterRetry(reloadCoordinators);

  // Whoever holds the event is left out: handing an event to its current
  // holder is refused by the server (23514, a confusing 400). Done here and
  // not on the server, because "everyone but the holder" is this picker's
  // need, not the list's meaning.
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
      <h2 ref={headingRef} tabIndex={-1}>Hand over {request.eventName}</h2>
      {/* SCRUM-444 AC4, said before the Lead commits: the coordinator who
          holds it now loses it, view and all. */}
      <p>
        The coordinator you choose becomes responsible for this event. The coordinator who holds it now will no longer be able to view or change it.
      </p>

      {loading && <LoadingText />}
      {loadError && (
        <ErrorNotice
          message={loadError.message}
          onRetry={loadError.retryable ? retryLoad : undefined}
        />
      )}
      {!loading && !loadError && choices.length === 0 && (
        <EmptyState
          message="There is no other Event Coordinator to hand this event to."
          nextStep="Another Event Coordinator account must be set up outside ConnectSphere before this event can be handed over."
        />
      )}

      {/* When the list failed to load, or there is nobody to choose, there is
          no form and so no form Cancel. Without this the only way out would
          be the parent's back button, which leaves the event for the list
          instead of returning to it. */}
      {!loading && (loadError || choices.length === 0) && (
        <div className="reassign-event__actions">
          <Button variant="secondary" onClick={onCancel}>
            Back to the event
          </Button>
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

          {/* Form errors have no Try again: submitting again is the retry. */}
          {submitError && <ErrorNotice message={submitError} />}

          <div className="reassign-event__actions">
            <Button type="submit" disabled={submitting || !newCoordinatorId}>
              {submitting ? "Handing over..." : "Confirm handover"}
            </Button>
            <Button variant="secondary" onClick={onCancel} disabled={submitting}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
