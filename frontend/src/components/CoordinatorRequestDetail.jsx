// CoordinatorRequestDetail.jsx
//
// SCRUM-45: one event request, read by the Event Coordinator who has to
// decide something about it. SCRUM-45 also gave it a "Find a venue" button
// that jumped to /venue-search with the capacity filtered; SCRUM-141 (SCRUM-20)
// replaced that with EventVenueFinder, a search pre-filled from this event
// that runs in place, so finding a venue stays part of handling the event.
// SCRUM-254's "Request this venue" used to be reached through that old
// handoff; it is now offered on each of the finder's results instead, so the
// coordinator finds and requests a venue without leaving the event.
//
// Takes the request as a prop and fetches nothing. That is a decision, not a
// shortcut: GET /event-requests/queue selects exactly the columns GET /:id
// does and applies the same statusDisplay, so the row the queue already holds
// IS the detail response. A second round trip would re-download bytes the
// caller is passing in.
//
// The cost is that this panel has no URL, so a reload returns the Coordinator
// to the queue. That matches every other entity view in this app -- the
// catalogue, the organiser's requests and the change-request panels all live
// in `activePanel` state -- so it is the house behaviour rather than a
// regression. If a shareable link is ever wanted, the backend plan records
// what to add (a coordinatorOnly GET /:id/review) rather than leaving it to
// be rediscovered. (SCRUM-332 has since built that route; nothing here uses
// it yet.)
//
// SCRUM-334 added the event's coordinator and assignment history, and the
// assigned coordinator's Reassign action, which opens ReassignEventPanel as a
// panel in place of this one.
//
// SCRUM-129 (SCRUM-19) replaced the dead decision section. The assigned
// coordinator now starts the review of a submitted request, then approves,
// rejects or returns it for amendment; a decided request shows its decision
// read-only (DecisionOutcome). See the comment above the decision section.
//
// SCRUM-192 (SCRUM-188 AC6, Week 7) added "Venue suitability" above "Find a
// venue": the event's requested and booked venues, rechecked live each time
// this view opens or the event's period or attendance changes. See the
// comment above that section.
//
// SCRUM-266 added "Flagged bookings" above it: the event's flagged bookings,
// each cancelled there or replaced through Find a venue.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { normaliseRole } from "../auth/normaliseRole";
import AssignmentHistory from "./AssignmentHistory";
import EventVenueFinder from "./EventVenueFinder";
import EventVenueSuitability from "./EventVenueSuitability";
import EventFlaggedBookings from "./EventFlaggedBookings";
import NeedsAttentionBadge from "./NeedsAttentionBadge";
import DecisionOutcome from "./DecisionOutcome";
import ReassignEventPanel from "./ReassignEventPanel";
import ClarificationHistoryDialog from "./ClarificationHistoryDialog";
import EventEquipmentSection from "./EventEquipmentSection";
import EventCancellationPanel from "./EventCancellationPanel";
import SafetyCheckSubmissionPanel from "./SafetyCheckSubmissionPanel";
import SafetyApprovalNotice from "./SafetyApprovalNotice";
import {
  decideEventRequest,
  getCoordinatorChangeRequests,
  processCoordinatorChangeRequest,
  requestEventClarification,
  startEventReview,
  closeEventClarification,
} from "../services/eventRequestService";
import {
  CANCELLABLE_STATUSES,
  readStatusDisplay,
  statusClassName,
} from "../services/eventRequestStatusDisplay";

/**
 * A timestamp in the reader's locale, or the raw string if it will not parse.
 *
 * Copied from VenueDetail rather than imported from services/datetimeFormat,
 * which sounds like the right home but is not: that module converts to and
 * from the `datetime-local` input format and has no read-only formatter. Two
 * copies of four lines is cheaper than a shared module nobody agreed the
 * shape of; when a third appears, lift it.
 */
function formatTimestamp(value) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

const CLARIFICATION_FIELDS = [
  ["eventName", "Event name"],
  ["purpose", "Purpose"],
  ["description", "Description"],
  ["proposedStart", "Proposed start"],
  ["proposedEnd", "Proposed end"],
  ["expectedAttendance", "Expected attendance"],
  ["venueRequirements", "Venue requirements"],
  ["accessibilityRequirements", "Accessibility requirements"],
  ["equipmentRequirements", "Equipment requirements"],
];

/**
 * A free-text requirement, or an explicit statement that there is none.
 *
 * "Not specified" and not an empty cell. Three of the fields below are
 * nullable prose, and a blank space reads as "the page failed to load this"
 * to the one person whose job is to act on what it says. Saying the Organiser
 * left it empty is information; showing nothing is an unanswered question.
 */
function orNotSpecified(value) {
  const text = typeof value === "string" ? value.trim() : value;
  return text ? text : "Not specified";
}

/**
 * Is this an attendance figure worth showing as one?
 *
 * expected_attendance is nullable. A missing or non-positive figure reads as
 * "Not specified" under Requirements rather than as "null people".
 *
 * Until SCRUM-141 it also guarded the /venue-search?minCapacity= link, where
 * Number("null") -> NaN would have filtered out everything. EventVenueFinder
 * now seeds its own attendance field (eventVenueSearchForm.seedFromEvent).
 */
function seedableCapacity(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

// SCRUM-19. Keyed by status, as ReviewQueue's table is, because the server's
// messages are written by the database and name ids.
// SCRUM-486 (SCRUM-517): 409 now has two causes. The request has moved on and
// is no longer waiting to be reviewed, or it has no coordinator and is waiting
// for the Event Coordinator Lead to assign it (migration 052 refuses that with
// 55000, a 409, rather than 029's 403, which told the coordinator it was
// someone else's when it was nobody's). One message names both: they share a
// remedy, and telling them apart would mean reading the server's message text,
// which this screen never does. The return-for-amendment table below does the
// same with its 409.
const START_REVIEW_ERROR_MESSAGES = {
  403: "This request is no longer assigned to you, so you cannot start its review. Go back and reopen it to see who holds it now.",
  404: "This request no longer exists.",
  409: "This request cannot be reviewed yet: it may be waiting for the Event Coordinator Lead to assign it a coordinator, or it may no longer be waiting to be reviewed. Go back and reopen it to see where it stands.",
};

const DECISION_ERROR_MESSAGES = {
  400: "A reason is required to reject this request.",
  403: "This request is no longer assigned to you, or someone else is reviewing it. Go back and reopen it to see who holds it now.",
  404: "This request no longer exists.",
  409: "This request has changed since you opened it: it may already be decided, or waiting on a clarification. Go back and reopen it to see where it stands.",
};

// Return for amendment (POST /:id/clarification), keyed by status for the
// same reason: requestEventClarification's refusals name the event's id. 400
// is a blank or overlong note, which this screen already prevents (the
// handler checks for a blank one, the textarea caps the length), so it can
// only arrive from a note the server counts differently. 404 is a missing
// event. 409 covers both of its causes, a status that moved and a handover
// mid-flight, because both have the same remedy.
const RETURN_FOR_AMENDMENT_ERROR_MESSAGES = {
  400: "The instructions could not be sent as written. Check they are not empty and are 2,000 characters or fewer, then try again.",
  403: "This request is no longer assigned to you, so you cannot return it for amendment. Go back and reopen it to see who holds it now.",
  404: "This request no longer exists.",
  409: "This request has changed since you opened it: it may already be decided, waiting on a clarification, or handed to another coordinator. Go back and reopen it to see where it stands.",
};

// AC6, said in this screen's words. The server's own refusal says the same:
// agree a new date or reject.
const START_DATE_PASSED_MESSAGE =
  "This request cannot be approved because its proposed start date has passed or is missing. Agree a new date with the organiser, or reject the request.";


/**
 * Has this event's proposed start passed, by this browser's clock?
 *
 * Used only to choose which 409 message to show after an approval is refused
 * (see handleDecision), never to decide whether to allow the approval: the
 * server decides that, against its own clock. A missing or unreadable date
 * counts as passed, as the server treats a missing one.
 */
function startDateHasPassed(value) {
  if (!value) return true;
  const time = new Date(value).getTime();
  return Number.isNaN(time) || time <= Date.now();
}

/**
 * SCRUM-525 (AC1, R13): Venue suitability's items as the venues Find a venue
 * must not offer again, each with the status label its hint names. An item
 * whose recheck failed still counts: it is a live booking all the same, and
 * the server would refuse a second request for its venue.
 */
function liveRequestsFrom(items) {
  const venues = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.venueId) venues.set(item.venueId, item.statusDisplay?.label ?? item.status ?? null);
  }
  return venues;
}

export default function CoordinatorRequestDetail({
  request,
  onReviewDecisionProcessed,
  onChangeRequestProcessed,
}) {
  // SCRUM-19. The request as this panel last saw it change. Starting a review
  // or deciding returns the updated request, and the panel stays open on it,
  // showing the next step or the recorded decision, rather than closing and
  // leaving the coordinator to find the request again. The `request` prop is
  // the row the parent loaded; this overrides it once this panel has changed
  // the request itself.
  const [updatedRequest, setUpdatedRequest] = useState(null);
  const current = updatedRequest ?? request;

  const display = readStatusDisplay(current);
  const capacity = seedableCapacity(request.expectedAttendance);
  const earliestReplyDate = new Date();
  earliestReplyDate.setUTCDate(earliestReplyDate.getUTCDate() + 1);
  const minReplyByDate = earliestReplyDate.toISOString().slice(0, 10);
  const [reviewNote, setReviewNote] = useState("");
  const [replyByDate, setReplyByDate] = useState("");
  const [requestedFields, setRequestedFields] = useState([]);
  const [processingReviewDecision, setProcessingReviewDecision] = useState(false);
  const [reviewDecisionError, setReviewDecisionError] = useState(null);
  const [closureNote, setClosureNote] = useState("");
  const [closingClarification, setClosingClarification] = useState(false);
  const [closureError, setClosureError] = useState(null);
  const [changeRequests, setChangeRequests] = useState([]);
  const [changeRequestsLoading, setChangeRequestsLoading] = useState(true);
  const [changeRequestsError, setChangeRequestsError] = useState(null);
  const [processingChangeRequestId, setProcessingChangeRequestId] = useState(null);
  const [rejectingChangeRequestId, setRejectingChangeRequestId] = useState(null);
  const [rejectionNote, setRejectionNote] = useState("");
  const [changeRequestActionError, setChangeRequestActionError] = useState(null);

  // SCRUM-334. reassigning swaps this panel for ReassignEventPanel.
  // handedOverTo is who the event went to, if this coordinator handed it over
  // while the panel was open: the `request` prop is the row the parent loaded
  // and may not be replaced (see handleReassigned). historyVersion is the
  // AssignmentHistory key, bumped to make it read the history again.
  const { user } = useAuth();
  const [reassigning, setReassigning] = useState(false);
  const [cancellationPage, setCancellationPage] = useState(false);
  const [handedOverTo, setHandedOverTo] = useState(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  // SCRUM-192. Bumped when a booking request is sent from "Find a venue", so
  // "Venue suitability" remounts and shows the new booking. The parent's
  // refresh alone would not: a booking changes none of the event fields the
  // section is keyed by, and `current` can be this panel's own copy.
  const [venueVersion, setVenueVersion] = useState(0);
  // SCRUM-188, per venue since SCRUM-525: the venues the Venue suitability
  // section found a live request for when it loaded, with each one's status,
  // so Find a venue starts with those venues' request buttons off instead of
  // offering one the server would refuse. Every other venue stays on.
  // Kept with the event it was loaded for, so another event never inherits it.
  const [liveVenueRequests, setLiveVenueRequests] = useState({ eventId: null, venues: new Map() });
  // SCRUM-266. The flagged booking Find a venue is requesting a replacement
  // for, or null. flaggedVersion remounts Flagged bookings after a request,
  // so a replacement just sent is listed under the booking it replaces.
  const [replacing, setReplacing] = useState(null);
  const [flaggedVersion, setFlaggedVersion] = useState(0);

  const assignedCoordinatorId = handedOverTo?.id ?? request.assignedCoordinatorId;

  // Reassign shows only to the event's assigned coordinator. This mirrors the
  // server's AC6 check in reassign_event_request (018) and is a convenience,
  // not the gate: it saves everyone else from a button that can only be
  // refused. The server checks again, under a lock, and if the row this panel
  // holds is stale, ReassignEventPanel turns the 403 into a message.
  const isAssignedCoordinator = Boolean(user?.id) && assignedCoordinatorId === user.id;
  // SCRUM-486 (SCRUM-521), AC6: the Event Coordinator Lead may hand over any
  // event, as 052's reassign_event_request allows, so the button shows for
  // the holder or a Lead. Only while someone holds it: a request with no
  // coordinator is assigned from the Lead's queue, not handed over (052
  // refuses that, AC5-05). The Lead is never isAssignedCoordinator (only
  // event_coordinator can be assigned), so every other action on this screen
  // stays the holder's.
  //
  // SCRUM-370: and never on a cancelled event, which nobody can hand over
  // (052's status list leaves cancelled out). Both conditions kept from the
  // merge of dev, neither dropped.
  const isLead = normaliseRole(user?.role) === "EVENT_COORDINATOR_LEAD";
  const canReassign = assignedCoordinatorId != null
    && current.status !== "cancelled"
    && (isAssignedCoordinator || isLead);

  // SCRUM-19. isAssignedCoordinator also decides who sees the review and
  // decision actions, and for the same reason: a convenience, not the gate.
  // 029's start_event_review and decide_event_request refuse anyone but the
  // assigned coordinator (and, for a decision, the recorded reviewer) under
  // the row lock, whatever this screen shows. docs/SCRUM-327.md makes the
  // same argument for the hand-over button.

  const [startingReview, setStartingReview] = useState(false);
  const [startReviewError, setStartReviewError] = useState(null);
  const [decisionError, setDecisionError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getCoordinatorChangeRequests(request.id)
      .then((items) => {
        if (!cancelled) setChangeRequests(items);
      })
      .catch(() => {
        if (!cancelled) setChangeRequestsError("Could not load organiser change requests.");
      })
      .finally(() => {
        if (!cancelled) setChangeRequestsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [request.id]);

  async function handleReturnForAmendment() {
    const note = reviewNote.trim();
    if (!note) {
      setReviewDecisionError("Add instructions before returning this request.");
      return;
    }

    setProcessingReviewDecision(true);
    setReviewDecisionError(null);
    setDecisionError(null);
    try {
      await requestEventClarification(
        request.id,
        note,
        replyByDate || null,
        requestedFields,
      );
      onReviewDecisionProcessed?.();
    } catch (error) {
      setReviewDecisionError(
        RETURN_FOR_AMENDMENT_ERROR_MESSAGES[error.response?.status] ||
          "The request could not be returned for amendment. Please try again.",
      );
    } finally {
      setProcessingReviewDecision(false);
    }
  }

  /**
   * SCRUM-19 AC1: start reviewing a submitted request.
   *
   * On success the panel stays open on the updated request, which is now
   * under review with this coordinator as its reviewer, so the decision
   * actions appear in place. The parent's list is refreshed through
   * onChangeRequestProcessed, for the reason handleReassigned gives below.
   */
  async function handleStartReview() {
    setStartingReview(true);
    setStartReviewError(null);
    try {
      const updated = await startEventReview(request.id);
      setUpdatedRequest(updated);
      onChangeRequestProcessed?.();
    } catch (error) {
      setStartReviewError(
        START_REVIEW_ERROR_MESSAGES[error.response?.status] ||
          "The review could not be started. Please try again.",
      );
    } finally {
      setStartingReview(false);
    }
  }

  /**
   * SCRUM-19: approve or reject the request under review.
   *
   * A rejection with no reason is refused here, before the call, as the
   * service and the database refuse it too: the coordinator is told what to
   * fill in without a round trip. An approval's note is optional.
   *
   * On success the panel stays open and shows the recorded decision
   * read-only, which is the coordinator's confirmation that it was recorded.
   *
   * 409 means one of two things, and the two are told apart. The server
   * shares the code (029's header: the event is not in a state that allows
   * this, either way), but the remedies differ: a request that changed needs
   * reopening; an event whose start date has passed needs a new date agreed
   * with the organiser, or a rejection (AC6). Showing the first message for
   * the second would send the coordinator to reopen a request that will be
   * refused again. So for a refused approval the event's own proposed start,
   * already on this screen, chooses: passed or missing means AC6's message.
   * A rejection is never refused for its date, so its 409 is always the
   * status case. Not by matching the server's message text, which is free to
   * change; the date is data. The one imprecision is clock skew between this
   * browser and the server within moments of the start time, where the other
   * message could show; both still say what to do next.
   */
  async function handleDecision(decision) {
    const note = reviewNote.trim();
    if (decision === "rejected" && !note) {
      setDecisionError("Add a reason before rejecting this request.");
      return;
    }

    setProcessingReviewDecision(true);
    setDecisionError(null);
    setReviewDecisionError(null);
    try {
      const updated = await decideEventRequest(request.id, {
        decision,
        decisionNote: note || undefined,
      });
      setUpdatedRequest(updated);
      setReviewNote("");
      onChangeRequestProcessed?.();
    } catch (error) {
      const status = error.response?.status;
      if (status === 409 && decision === "approved" && startDateHasPassed(current.proposedStart)) {
        setDecisionError(START_DATE_PASSED_MESSAGE);
      } else {
        setDecisionError(
          DECISION_ERROR_MESSAGES[status] || "The decision could not be recorded. Please try again.",
        );
      }
    } finally {
      setProcessingReviewDecision(false);
    }
  }

  async function handleCloseClarification(event) {
    event.preventDefault();
    const note = closureNote.trim();
    if (!note) {
      setClosureError("A note is required to close the clarification request.");
      return;
    }
    setClosingClarification(true);
    setClosureError(null);
    try {
      await closeEventClarification(request.id, note);
      onReviewDecisionProcessed?.();
    } catch (error) {
      setClosureError(
        error.response?.data?.error || "Could not close the clarification request.",
      );
    } finally {
      setClosingClarification(false);
    }
  }

  async function handleChangeRequestDecision(changeRequest, decision, decisionNotes) {
    setProcessingChangeRequestId(changeRequest.id);
    setChangeRequestActionError(null);
    try {
      const processed = await processCoordinatorChangeRequest(changeRequest.id, {
        decision,
        decisionNotes,
      });
      setChangeRequests((current) =>
        current.map((item) => item.id === processed.id ? { ...item, ...processed } : item),
      );
      setRejectingChangeRequestId(null);
      setRejectionNote("");
      onChangeRequestProcessed?.();
    } catch (error) {
      setChangeRequestActionError(
        error.response?.data?.error || "Could not process this change request.",
      );
    } finally {
      setProcessingChangeRequestId(null);
    }
  }

  /**
   * The server accepted the handover (SCRUM-334).
   *
   * Closes the handover panel, records who the event went to so the Reassign
   * button disappears at once, and remounts AssignmentHistory so it reads the
   * new entry. The panel stays open on this event, now read-only for this
   * coordinator, so they can see the handover in the history before leaving.
   *
   * Then the parent's list is refreshed through onChangeRequestProcessed. That
   * prop's name is narrower than what it does: both parents implement it as
   * "refetch the list and keep this panel open on the refreshed row", which
   * is exactly what a handover needs. In My events the event leaves the list;
   * in the queue its row is refreshed with the new coordinator. A new prop,
   * say onEventChanged, would be the cleaner name, but adding one means
   * editing ReviewQueue and MyAssignedEvents, which this ticket does not
   * touch. The rename is a follow-up.
   */
  function handleReassigned(updated, chosen) {
    setHandedOverTo({
      id: updated?.assignedCoordinatorId ?? chosen?.id ?? null,
      fullName: chosen?.fullName ?? null,
    });
    setReassigning(false);
    setHistoryVersion((version) => version + 1);
    onChangeRequestProcessed?.();
  }

  if (reassigning) {
    return (
      <ReassignEventPanel
        request={request}
        outgoingCoordinatorId={assignedCoordinatorId}
        onCancel={() => setReassigning(false)}
        onReassigned={handleReassigned}
      />
    );
  }

  if (cancellationPage) {
    return (
      <EventCancellationPanel
        eventRequest={current}
        onBack={() => setCancellationPage(false)}
        onCancelled={(updated) => {
          setUpdatedRequest(updated);
          onChangeRequestProcessed?.();
        }}
      />
    );
  }

  return (
    <div className="coordinator-request-detail">
      <h2>
        {request.eventName}
        <span className={`status-badge ${statusClassName(display.group)}`}>
          {display.label}
        </span>
        <NeedsAttentionBadge event={current} />
      </h2>
      <p>{display.description}</p>
      <SafetyApprovalNotice status={current.status} />
      {isAssignedCoordinator && CANCELLABLE_STATUSES.has(current.status) && (
        <button
          className="coordinator-request-detail__cancel"
          type="button"
          onClick={() => setCancellationPage(true)}
        >
          Cancel event
        </button>
      )}
      {/* SCRUM-489 AC1: the holder, while Approved. The server checks both again. */}
      {isAssignedCoordinator && current.status === "approved" && (
        <SafetyCheckSubmissionPanel
          key={current.id}
          eventRequest={current}
          onSubmitted={(updated) => {
            setUpdatedRequest(updated);
            onChangeRequestProcessed?.();
          }}
          onStale={() => onChangeRequestProcessed?.()}
        />
      )}

      <section>
        <h3>The request</h3>
        <ul>
          <li>
            <strong>Purpose</strong>
            <span>{orNotSpecified(request.purpose)}</span>
          </li>
          <li>
            <strong>Description</strong>
            <span>{orNotSpecified(request.description)}</span>
          </li>
          <li>
            <strong>Proposed period</strong>
            <span>
              {formatTimestamp(request.proposedStart)} &ndash;{" "}
              {formatTimestamp(request.proposedEnd)}
            </span>
          </li>
          <li>
            <strong>Expected attendance</strong>
            <span>{capacity === null ? "Not specified" : `${capacity} people`}</span>
          </li>
        </ul>
      </section>

      <section>
        <h3>Requirements</h3>
        {/* All three verbatim, and none of them parsed. They are free prose --
            "a large room, ideally tiered seating" -- and guessing a search
            term out of that would return no venues and read as "no venues
            exist". Show, don't parse. */}
        <ul>
          <li>
            <strong>Venue</strong>
            <span>{orNotSpecified(request.venueRequirements)}</span>
          </li>
          <li>
            <strong>Accessibility</strong>
            <span>{orNotSpecified(request.accessibilityRequirements)}</span>
          </li>
          <li>
            <strong>Equipment</strong>
            <span>{orNotSpecified(request.equipmentRequirements)}</span>
          </li>
        </ul>
      </section>

      <EventEquipmentSection
        requestId={request.id}
        status={current.status}
        canEdit={isAssignedCoordinator && current.status !== "cancelled"}
      />

      <section>
        <h3>Organiser change requests</h3>
        {changeRequestsLoading && <p>Loading change requests...</p>}
        {changeRequestsError && (
          <p className="coordinator-clarification__error" role="alert">
            {changeRequestsError}
          </p>
        )}
        {!changeRequestsLoading && !changeRequestsError && changeRequests.length === 0 && (
          <p>No change requests have been submitted for this event.</p>
        )}
        {!changeRequestsLoading && !changeRequestsError && changeRequests.length > 0 && (
          <ul className="coordinator-change-requests">
            {changeRequests.map((changeRequest) => {
              const isOpen = !changeRequest.decision;
              const isRejecting = rejectingChangeRequestId === changeRequest.id;

              return (
                <li key={changeRequest.id}>
                  <strong>{changeRequest.fieldLabel}</strong>
                  <p>{changeRequest.details}</p>
                  <small>
                    {changeRequest.status.replaceAll("_", " ")} | Requested{" "}
                    {formatTimestamp(changeRequest.createdAt)}
                  </small>
                  {changeRequest.decision && (
                    <p className="coordinator-change-requests__outcome">
                      Outcome: {changeRequest.decision === "approved" ? "Approved" : "Rejected"}
                      {changeRequest.decisionNotes && (
                        <span> | Reason: {changeRequest.decisionNotes}</span>
                      )}
                    </p>
                  )}
                  {isOpen && current.status !== "cancelled" && isAssignedCoordinator && (
                    <div className="coordinator-change-requests__actions">
                      <button
                        type="button"
                        disabled={processingChangeRequestId === changeRequest.id}
                        onClick={() => handleChangeRequestDecision(changeRequest, "approved")}
                      >
                        {processingChangeRequestId === changeRequest.id ? "Processing..." : "Approve"}
                      </button>
                      {!isRejecting && (
                        <button
                          type="button"
                          disabled={processingChangeRequestId === changeRequest.id}
                          onClick={() => {
                            setRejectingChangeRequestId(changeRequest.id);
                            setRejectionNote("");
                            setChangeRequestActionError(null);
                          }}
                        >
                          Reject
                        </button>
                      )}
                      {isRejecting && (
                        <form
                          className="coordinator-change-requests__reject-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            handleChangeRequestDecision(
                              changeRequest,
                              "rejected",
                              rejectionNote.trim(),
                            );
                          }}
                        >
                          <label>
                            Reason for rejection
                            <textarea
                              value={rejectionNote}
                              onChange={(event) => setRejectionNote(event.target.value)}
                              rows={3}
                              maxLength={2000}
                              required
                            />
                          </label>
                          <button
                            type="submit"
                            disabled={processingChangeRequestId === changeRequest.id || !rejectionNote.trim()}
                          >
                            {processingChangeRequestId === changeRequest.id ? "Processing..." : "Confirm rejection"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setRejectingChangeRequestId(null)}
                          >
                            Cancel
                          </button>
                        </form>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {changeRequestActionError && (
          <p className="coordinator-clarification__error" role="alert">
            {changeRequestActionError}
          </p>
        )}
      </section>

      <section>
        <h3>Provenance</h3>
        <ul>
          <li>
            <strong>Submitted</strong>
            <span>{formatTimestamp(request.submittedAt)}</span>
          </li>
          <li>
            {/* The name when the row has one, the bare uuid when it does not.
                A queue row never has one: the queue joins no profiles row,
                which is the privacy floor of a queue every Coordinator can
                read. A "My events" row does (SCRUM-333), because those are
                events this coordinator is responsible for, where contacting
                the Organiser is the job. The uuid is rendered as an
                identifier so it never reads as a label. */}
            <strong>Organiser</strong>
            {request.organiserName ? (
              <span>{request.organiserName}</span>
            ) : (
              <code title={request.organiserId ?? undefined}>
                {request.organiserId ?? "unknown"}
              </code>
            )}
          </li>
        </ul>
      </section>

      {/* SCRUM-334: who holds the event now, and how it got there, with the
          handover notes, which every coordinator may read. Read fresh when this
          panel opens, so it is the current coordinator even if the row this
          panel was opened from is a little out of date. */}
      <section>
        <h3>Coordinator</h3>
        <AssignmentHistory
          key={historyVersion}
          eventRequestId={request.id}
          view="coordinator"
          currentCoordinatorId={assignedCoordinatorId}
        />

        {handedOverTo && (
          <p className="coordinator-reassign__notice" role="status">
            Handed over to {handedOverTo.fullName ?? "the coordinator you chose"}.
            {/* Said to the coordinator who handed it over. A Lead never could
                change it, and can hand it over again (SCRUM-521). */}
            {isLead ? "" : " You can still view this event, but not change it."}
          </p>
        )}

        {canReassign && (
          <div className="coordinator-reassign">
            <button type="button" onClick={() => setReassigning(true)}>
              Hand over to another coordinator
            </button>
          </div>
        )}
      </section>

      {/* SCRUM-19. What the decision section shows, in order:

            1. A recorded decision, read-only, whatever the status now is. An
               approved event later confirmed or cancelled still carries its
               decision, and AC9 says it is not edited. Checked on the decision
               itself rather than a list of "decided" statuses, so no status
               vocabulary is copied here for it.
            2. Pending clarification: the existing waiting panel.
            3. Submitted: Start review, for the assigned coordinator.
            4. Under review: Approve, Reject and Return for amendment, for the
               assigned coordinator.
            Anyone else sees what is happening but nothing to press.

            The status and ownership checks here are a convenience, not the
            gate: the server refuses regardless, and the error tables above say
            why in words. */}
      {current.decision ? (
        <section>
          <h3>Decision</h3>
          <DecisionOutcome request={current} view="coordinator" />
        </section>
      ) : current.status === "pending_clarification" ? (
        <section>
          <h3>Waiting for organiser reply</h3>
          <div className="clarification-current">
            <strong>Current question</strong>
            <p>{current.clarificationNote || "No clarification question was recorded."}</p>
            {current.clarificationReplyByDate && (
              <span>
                Reply by {formatTimestamp(current.clarificationReplyByDate)}
                {current.clarificationReplyByDate < new Date().toISOString().slice(0, 10) && (
                  <strong className="clarification-overdue"> · Overdue</strong>
                )}
              </span>
            )}
          </div>
          <ClarificationHistoryDialog
            eventRequestId={request.id}
            eventName={request.eventName}
            isOpenQuestion
            latestQuestion={current.clarificationNote}
          />
          {isAssignedCoordinator && (
            <form className="coordinator-clarification" onSubmit={handleCloseClarification}>
              <label>
                Note explaining why you are closing this request
                <textarea
                  value={closureNote}
                  onChange={(event) => setClosureNote(event.target.value)}
                  rows={3}
                  maxLength={2000}
                  required
                />
              </label>
              {closureError && <p role="alert">{closureError}</p>}
              <button type="submit" disabled={closingClarification || !closureNote.trim()}>
                {closingClarification ? "Closing..." : "Close clarification"}
              </button>
            </form>
          )}
        </section>
      ) : current.status === "submitted" ? (
        <section>
          <h3>Review</h3>
          {isAssignedCoordinator ? (
            <div className="coordinator-start-review">
              <p>
                Start the review to approve, reject, or return this request for
                amendment. You will be recorded as its reviewer.
              </p>
              {startReviewError && (
                <p className="coordinator-clarification__error" role="alert">
                  {startReviewError}
                </p>
              )}
              <button type="button" disabled={startingReview} onClick={handleStartReview}>
                {startingReview ? "Starting..." : "Start review"}
              </button>
            </div>
          ) : current.assignedCoordinatorId == null ? (
            // SCRUM-486 AC8-04 (SCRUM-519). Since 052 a submitted request can
            // have no coordinator: it is in the Lead's unassigned queue. Every
            // coordinator can still open it (SCRUM-332), and "waiting for the
            // assigned coordinator" would name someone who does not exist.
            // isAssignedCoordinator is false for everyone here, so nobody is
            // offered Start review, which 052 would refuse anyway.
            <p>Waiting for the Event Coordinator Lead to assign this request to a coordinator.</p>
          ) : (
            <p>Waiting for the assigned coordinator to start the review.</p>
          )}
        </section>
      ) : current.status === "under_review" ? (
        <section>
          <h3>Coordinator decision</h3>
          {isAssignedCoordinator ? (
            <div className="coordinator-clarification">
              {/* One note for all three actions. Whichever is chosen, the note
                  is read by the Organiser: as the rejection reason, the
                  approval note, or the amendment instructions. One box means
                  the note cannot be typed into the wrong one. */}
              <label>
                Note for the Organiser
                <textarea
                  value={reviewNote}
                  onChange={(event) => setReviewNote(event.target.value)}
                  rows={4}
                  maxLength={2000}
                  placeholder="Required to reject or to return for amendment; optional when approving."
                />
              </label>
              <details className="coordinator-clarification__amendments" open>
                <summary>Let the Organiser amend specific fields (optional)</summary>
                <fieldset className="coordinator-clarification__fields">
                  <legend>Fields that need changing</legend>
                  <p>Leave all fields unchecked for a question-only clarification.</p>
                  {CLARIFICATION_FIELDS.map(([field, label]) => (
                    <label key={field}>
                      <input
                        type="checkbox"
                        checked={requestedFields.includes(field)}
                        onChange={(event) => {
                          setRequestedFields((previous) => event.target.checked
                            ? [...previous, field]
                            : previous.filter((item) => item !== field));
                        }}
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
              </details>
              <label>
                Optional reply-by date
                <input
                  type="date"
                  min={minReplyByDate}
                  value={replyByDate}
                  onChange={(event) => setReplyByDate(event.target.value)}
                />
              </label>
              {(decisionError || reviewDecisionError) && (
                <p className="coordinator-clarification__error" role="alert">
                  {decisionError || reviewDecisionError}
                </p>
              )}
              <div className="coordinator-review-actions">
                <button className="coordinator-review-actions__approve" type="button" disabled={processingReviewDecision} onClick={() => handleDecision("approved")}>
                  {processingReviewDecision ? "Saving..." : "Approve request"}
                </button>
                <button className="coordinator-review-actions__reject" type="button" disabled={processingReviewDecision} onClick={() => handleDecision("rejected")}>
                  Reject request
                </button>
                <button className="coordinator-review-actions__return" type="button" disabled={processingReviewDecision} onClick={handleReturnForAmendment}>
                  Return for amendment
                </button>
              </div>
            </div>
          ) : (
            <p>Only the assigned coordinator can decide this request.</p>
          )}
        </section>
      ) : null}

      {request.status !== "pending_clarification" && (
        <section className="coordinator-clarification-history">
          <h3>Clarification history</h3>
          <ClarificationHistoryDialog
            eventRequestId={request.id}
            eventName={request.eventName}
          />
        </section>
      )}

      {/* SCRUM-141: the search runs here, pre-filled from this event. Keyed
          by the id AND the three fields it seeds from, so opening a
          different event re-seeds the form, and so does an approved change
          request that moves this event's period or attendance -- the form
          must never offer stale event values as if they were current. A
          refresh that changes nothing else keeps the coordinator's edits.
          It gets `current`, not `request`, so an event approved in this
          panel can have a venue requested for it straight away (SCRUM-254:
          each result's "Request this venue"). userId is passed only while
          this user is the assigned coordinator, so a handover made here
          (handedOverTo) turns the request buttons off even though `current`
          still names this user. A sent request refreshes the parent's list
          and the Venue suitability section above. */}
      {/* SCRUM-192 (SCRUM-188 AC6, Week 7): the event's requested and booked
          venues, rechecked live against the event as it is now. Keyed like
          EventVenueFinder, so an approved change request that moves the
          period or attendance remounts it and the recheck happens as the
          change lands; venueVersion adds a booking just sent below. Shown
          only to the assigned coordinator, the one the server answers.
          SCRUM-188: what it loads tells Find a venue which venues already
          have a live request (onLoaded -> liveRequests; per venue since
          SCRUM-525). */}
      {/* SCRUM-266: the assigned coordinator's flagged bookings, hidden when
          there are none. Cancelling one reloads Venue suitability below. */}
      {isAssignedCoordinator && (
        <EventFlaggedBookings
          key={`${current.id}|${flaggedVersion}`}
          eventRequestId={current.id}
          replacingId={replacing?.id ?? null}
          // Find a venue moves focus to its notice, which brings it into view.
          onReplace={(item) => {
            setReplacing({
              id: item.id,
              venueName: item.venueName || "Unknown venue",
              startsAt: item.startsAt,
              endsAt: item.endsAt,
            });
          }}
          onCancelled={(item) => {
            setReplacing((cur) => (cur?.id === item.id ? null : cur));
            setVenueVersion((n) => n + 1);
            onChangeRequestProcessed?.();
          }}
          // A booking resolved elsewhere is no longer one to replace.
          onLoaded={(items) => setReplacing((cur) => (cur && !items.some((i) => i.id === cur.id) ? null : cur))}
        />
      )}
      {isAssignedCoordinator && (
        <section className="event-venue-suitability-section">
          <h3>Venue suitability</h3>
          <EventVenueSuitability
            key={`${current.id}|${current.proposedStart}|${current.proposedEnd}|${current.expectedAttendance}|${venueVersion}`}
            eventRequestId={current.id}
            onLoaded={(items) => setLiveVenueRequests({ eventId: current.id, venues: liveRequestsFrom(items) })}
          />
        </section>
      )}

      <section>
        <h3>Find a venue</h3>
        <EventVenueFinder
          key={`${current.id}|${current.proposedStart}|${current.proposedEnd}|${current.expectedAttendance}`}
          request={current}
          userId={isAssignedCoordinator && current.status !== "cancelled" ? user.id : undefined}
          // Only while the Venue suitability section is shown: the lock hint
          // says "See it under Venue suitability above", and after a handover
          // made here that section is gone while this state remains. The
          // buttons stay off anyway, for eligibility's reason, shown once.
          liveRequests={
            isAssignedCoordinator && liveVenueRequests.eventId === current.id ? liveVenueRequests.venues : undefined
          }
          onRequestSubmitted={() => {
            setVenueVersion((n) => n + 1);
            // SCRUM-266: a replacement sent is listed under its flagged booking.
            if (replacing) {
              setReplacing(null);
              setFlaggedVersion((n) => n + 1);
            }
            onChangeRequestProcessed?.();
          }}
          // SCRUM-525 (R13): a venue refused as already requested reloads
          // Venue suitability, so the request it collided with is listed.
          onVenueAlreadyRequested={() => setVenueVersion((n) => n + 1)}
          replacing={isAssignedCoordinator ? replacing : null}
          onStopReplacing={() => setReplacing(null)}
          onReplacementRefused={() => {
            setReplacing(null);
            setFlaggedVersion((n) => n + 1);
          }}
        />
        <p className="event-venue-finder__browse">
          <Link to="/venue-search">Browse all venues</Link>
        </p>
      </section>
    </div>
  );
}
