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
// Opened from a list it lives in `activePanel` state, so a reload returns to
// the list. /event-requests/:id (EventRequestReviewPage) is its own URL: it
// reads GET /:id/review and mounts this with `asPage`.
//
// SCRUM-334 added the event's coordinator and assignment history, and the
// Reassign action (the Lead's since SCRUM-444), which opens ReassignEventPanel
// as a panel in place of this one.
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
//
// SCRUM-384 (SCRUM-379 AC1, AC2) added "Mark as completed" for the assigned coordinator of a
// Confirmed event that has ended (EventCompletionPanel), and "Closing notes" on a completed
// event, shown to coordinators only.

import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { normaliseRole } from "../auth/normaliseRole";
import { mayHaveRegistrationList } from "../services/registrationStatuses";
import AssignmentHistory from "./AssignmentHistory";
import EventVenueFinder from "./EventVenueFinder";
import EventVenueSuitability from "./EventVenueSuitability";
import EventFlaggedBookings from "./EventFlaggedBookings";
import EventVenueBookings from "./EventVenueBookings";
import NeedsAttentionBadge from "./NeedsAttentionBadge";
import NeedsAttentionReasons from "./NeedsAttentionReasons";
import DecisionOutcome from "./DecisionOutcome";
import DecisionHistory from "./DecisionHistory";
import ReassignEventPanel from "./ReassignEventPanel";
import ClarificationHistoryDialog from "./ClarificationHistoryDialog";
import EventEquipmentSection from "./EventEquipmentSection";
import EventCancellationPanel from "./EventCancellationPanel";
import ChangeRequestReviewPanel from "./ChangeRequestReviewPanel";
import EventRejectionPanel from "./EventRejectionPanel";
import SignificantEventChangePanel from "./SignificantEventChangePanel";
import EventDetailsEditPanel from "./EventDetailsEditPanel";
import EventChangeHistory from "./EventChangeHistory";
import SafetyCheckSubmissionPanel from "./SafetyCheckSubmissionPanel";
import SafetyApprovalNotice from "./SafetyApprovalNotice";
import EventConfirmationPanel from "./EventConfirmationPanel";
import EventCompletionPanel from "./EventCompletionPanel";
import RegistrationCounts from "./RegistrationCounts";
import Button from "./ui/Button";
import StatusBadge from "./ui/StatusBadge";
import Tabs from "./ui/Tabs";
import useReturnFocus from "./useReturnFocus";
import { isRegistrationConfigurable } from "../services/registrationStatuses";
import {
  decideEventRequest,
  requestEventClarification,
  startEventReview,
  closeEventClarification,
} from "../services/eventRequestService";
import {
  CANCELLABLE_STATUSES,
  readStatusDisplay,
  statusTone,
} from "../services/eventRequestStatusDisplay";
import {
  formatDateTime,
  formatDateTimeRangeOrFallback,
  formatDay,
  orNotSpecified,
  pluralise,
} from "../services/displayFormat";
import { STATUSES_ALLOWING_ORDINARY_EDITS, detailFieldList } from "../services/eventDetailFields";
import { isReplyOverdue, venueTomorrow } from "../services/datetimeFormat";
import { canMarkCompleted, closingNotesOf, eventHasEnded } from "../services/eventCompletion";
import { attentionReasonsOf } from "../services/equipmentFlagDisplay";

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

const PROGRESS_STEPS = [
  ["submitted", "Submitted"],
  ["under_review", "Under review"],
  ["approved", "Approved"],
  ["safety", "Safety check"],
  ["confirmed", "Confirmed"],
  ["completed", "Completed"],
];

// Where each status sits on PROGRESS_STEPS. A status missing here (a draft, or
// one this build does not know) marks no step, rather than guessing one.
const STEP_BY_STATUS = {
  submitted: 0,
  under_review: 1,
  pending_clarification: 1,
  approved: 2,
  safety_review: 3,
  safety_approved: 3,
  confirmed: 4,
  completed: 5,
};

// The status alone cannot say how far a closed event got, so these show only
// the steps it must have passed: a rejection always follows a review, and a
// cancellation can come straight after submission.
const TERMINAL_STATUSES = {
  rejected: { reached: 2, label: "Rejected" },
  cancelled: { reached: 1, label: "Cancelled" },
};

/** The progress stepper's items for a status, each "done", "current" or "upcoming". */
function progressSteps(status) {
  const terminal = TERMINAL_STATUSES[status];
  if (terminal) {
    return [
      ...PROGRESS_STEPS.slice(0, terminal.reached).map(([key, label]) => ({ key, label, state: "done" })),
      { key: status, label: terminal.label, state: "current" },
    ];
  }
  const index = STEP_BY_STATUS[status] ?? -1;
  return PROGRESS_STEPS.map(([key, label], i) => ({
    key,
    label: status === "pending_clarification" && i === index ? `${label}: waiting for the organiser` : label,
    state: i < index ? "done" : i === index ? "current" : "upcoming",
  }));
}

// The three outcomes of a review, each sent by the handler its old button called.
const DECISION_CHOICES = [
  {
    value: "approve",
    label: "Approve",
    hint: "Accept the request. The note is optional.",
    submitLabel: "Approve request",
    variant: "primary",
  },
  {
    value: "reject",
    label: "Reject",
    hint: "Turn the request down. The note is the reason, and is required.",
    submitLabel: "Reject request",
    variant: "danger",
  },
  {
    value: "return",
    label: "Return for amendment",
    hint: "Send it back to the Organiser to change. The note is the instructions, and is required.",
    submitLabel: "Return for amendment",
    variant: "primary",
  },
];

// While a request is being reviewed the reviewer reads it; after that the work is venues.
const DETAILS_FIRST_STATUSES = new Set(["submitted", "under_review", "pending_clarification"]);

function defaultEventTab(status) {
  return DETAILS_FIRST_STATUSES.has(status) ? "details" : "venues";
}

/**
 * @param {object} props
 * @param {boolean} [props.asPage]  true at /event-requests/:id, where the event's
 *                                  name is the page's h1; inside a list it is h2
 * @param {boolean} [props.focusOnOpen]  true when opened from a list row, whose
 *                                  button has gone, so focus starts on the title
 */
export default function CoordinatorRequestDetail({
  request,
  onReviewDecisionProcessed,
  onChangeRequestProcessed,
  asPage = false,
  focusOnOpen = false,
}) {
  // A mutation response belongs to the parent record it started from.
  const [localUpdate, setLocalUpdate] = useState(null);
  const [confirmationFeedback, setConfirmationFeedback] = useState(null);
  const current = localUpdate?.source === request ? localUpdate.record : request;

  function setUpdatedRequest(record) {
    setLocalUpdate(record ? { source: request, record } : null);
  }

  const display = readStatusDisplay(current);
  const capacity = seedableCapacity(current.expectedAttendance);
  // The reply-by date is a Singapore calendar day, so tomorrow is Singapore's.
  const minReplyByDate = venueTomorrow();
  const [reviewNote, setReviewNote] = useState("");
  const [replyByDate, setReplyByDate] = useState("");
  const [requestedFields, setRequestedFields] = useState([]);
  const [processingReviewDecision, setProcessingReviewDecision] = useState(false);
  const [reviewDecisionError, setReviewDecisionError] = useState(null);
  const [closureNote, setClosureNote] = useState("");
  const [closingClarification, setClosingClarification] = useState(false);
  const [closureError, setClosureError] = useState(null);
  // SCRUM-402 AC8: the Organiser's text for an accepted equipment change, shown
  // above the equipment section the screen then moves to.
  const [equipmentHandOff, setEquipmentHandOff] = useState(null);
  const equipmentSectionRef = useRef(null);

  // SCRUM-334. reassigning swaps this panel for ReassignEventPanel.
  // handedOverTo is who the event went to, if the Lead handed it over
  // while the panel was open: the `request` prop is the row the parent loaded
  // and may not be replaced (see handleReassigned). historyVersion is the
  // AssignmentHistory key, bumped to make it read the history again.
  const { user } = useAuth();
  const [reassigning, setReassigning] = useState(false);
  const [cancellationPage, setCancellationPage] = useState(false);
  const [rejectionPage, setRejectionPage] = useState(false);
  const [significantChangePage, setSignificantChangePage] = useState(false);
  // SCRUM-387. The success line belongs to the event it was saved on.
  const [detailsEditPage, setDetailsEditPage] = useState(false);
  const [detailsSaved, setDetailsSaved] = useState(null);
  // SCRUM-384. The completion panel, and the line saying the event was completed, which belongs
  // to the event it was done on.
  const [completionPage, setCompletionPage] = useState(false);
  const [completedNotice, setCompletedNotice] = useState(null);
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
  // The open tab belongs to the event shown: a re-read after an action keeps
  // it, and another event opens on its own status's default.
  const [tabChoice, setTabChoice] = useState(() => ({ eventId: current.id, tab: defaultEventTab(current.status) }));
  if (tabChoice.eventId !== current.id) {
    setTabChoice({ eventId: current.id, tab: defaultEventTab(current.status) });
  }
  const eventTab = tabChoice.tab;
  function setEventTab(tab) {
    setTabChoice({ eventId: current.id, tab });
  }

  const assignedCoordinatorId = handedOverTo?.id ?? request.assignedCoordinatorId;

  const isAssignedCoordinator = Boolean(user?.id) && assignedCoordinatorId === user.id;
  // SCRUM-444 AC3 reverses SCRUM-486 AC6: only the Lead hands over (055, behind
  // leadOnly). A convenience, not the gate. Only while someone holds it (a
  // request with no coordinator is assigned, not handed over), and never on a
  // cancelled event (SCRUM-370). The Lead is never isAssignedCoordinator, so
  // every other action on this screen stays the holder's.
  const isLead = normaliseRole(user?.role) === "EVENT_COORDINATOR_LEAD";
  const canConfirm = normaliseRole(user?.role) === "EVENT_COORDINATOR"
    && isAssignedCoordinator && current.status === "safety_approved";
  const canReassign = assignedCoordinatorId != null
    && current.status !== "cancelled"
    && isLead;
  // SCRUM-384 AC1: the holder, on a Confirmed event whose end has passed. A convenience;
  // complete_event_request (034) checks the caller, the status and the end time under the lock.
  const isCoordinatorRole = normaliseRole(user?.role) === "EVENT_COORDINATOR";
  const canComplete = isCoordinatorRole && canMarkCompleted(current, { isAssignedCoordinator });
  const awaitingEnd = isCoordinatorRole && isAssignedCoordinator
    && current.status === "confirmed" && !eventHasEnded(current.proposedEnd);
  // SCRUM-384 AC2, SCRUM-444 AC5: only the holder writes closing notes (on completion, 034); the holder and the Lead read them; never an Organiser.
  const closingNotes = (isCoordinatorRole || isLead) && current.status === "completed"
    ? closingNotesOf(current)
    : null;
  // SCRUM-387 AC1-AC5: the holder, in the five statuses that allow an edit,
  // read from the latest event. A convenience; 022 checks both under the lock.
  const canEditDetails = normaliseRole(user?.role) === "EVENT_COORDINATOR"
    && isAssignedCoordinator && STATUSES_ALLOWING_ORDINARY_EDITS.includes(current.status);

  // SCRUM-19. isAssignedCoordinator also decides who sees the review and
  // decision actions, and for the same reason: a convenience, not the gate.
  // 029's start_event_review and decide_event_request refuse anyone but the
  // assigned coordinator (and, for a decision, the recorded reviewer) under
  // the row lock, whatever this screen shows. docs/SCRUM-327.md makes the
  // same argument for the hand-over button.

  // Nothing is chosen at first, so no outcome is sent by accident.
  const [decisionChoice, setDecisionChoice] = useState(null);
  const decisionIds = useId();
  const [startingReview, setStartingReview] = useState(false);
  const [startReviewError, setStartReviewError] = useState(null);
  const [decisionError, setDecisionError] = useState(null);

  // Each swap-in page hides the opener that opened it. Leaving it puts focus
  // back on that opener, or on the title if the event's new status removed it.
  const openPanel = reassigning ? "reassign"
    : cancellationPage ? "cancel"
      : rejectionPage ? "reject"
        : completionPage ? "complete"
          : significantChangePage ? "revise"
            : detailsEditPage ? "edit" : null;
  const { listHeadingRef: titleRef, rowRef: openerRef, returnFocusTo } = useReturnFocus(openPanel, false);
  function closePanel(key, close) {
    returnFocusTo(key);
    close(false);
  }

  useEffect(() => {
    if (focusOnOpen) titleRef.current?.focus();
  }, [focusOnOpen, titleRef]);

  // A step that succeeds replaces the button that took it, so focus moves to
  // the Next step heading and the event's new state is read from there.
  const nextStepRef = useRef(null);
  const [nextStepFocus, setNextStepFocus] = useState(0);
  useEffect(() => {
    if (nextStepFocus) (nextStepRef.current ?? titleRef.current)?.focus();
  }, [nextStepFocus, titleRef]);
  function focusNextStep() {
    setNextStepFocus((count) => count + 1);
  }

  useEffect(() => {
    if (!equipmentHandOff) return;
    equipmentSectionRef.current?.scrollIntoView?.({ block: "start" });
    equipmentSectionRef.current?.focus();
  }, [equipmentHandOff]);

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
      focusNextStep();
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
      focusNextStep();
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
      focusNextStep();
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

  function handleSubmitDecision() {
    if (decisionChoice === "approve") return handleDecision("approved");
    if (decisionChoice === "reject") return handleDecision("rejected");
    if (decisionChoice === "return") return handleReturnForAmendment();
    return undefined;
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
      focusNextStep();
    } catch (error) {
      setClosureError(
        error.response?.data?.error || "Could not close the clarification request.",
      );
    } finally {
      setClosingClarification(false);
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
    closePanel("reassign", setReassigning);
    setHistoryVersion((version) => version + 1);
    onChangeRequestProcessed?.();
  }

  // A page swapped in takes the event title's level, so the screen keeps one h1.
  const panelTitleLevel = asPage ? 1 : 2;

  if (reassigning) {
    return (
      <ReassignEventPanel
        request={request}
        outgoingCoordinatorId={assignedCoordinatorId}
        headingLevel={panelTitleLevel}
        onCancel={() => closePanel("reassign", setReassigning)}
        onReassigned={handleReassigned}
      />
    );
  }

  if (cancellationPage) {
    return (
      <EventCancellationPanel
        eventRequest={current}
        headingLevel={panelTitleLevel}
        onBack={() => closePanel("cancel", setCancellationPage)}
        onCancelled={(updated) => {
          setUpdatedRequest(updated);
          onChangeRequestProcessed?.();
        }}
      />
    );
  }

  if (rejectionPage) {
    return (
      <EventRejectionPanel
        eventRequest={current}
        headingLevel={panelTitleLevel}
        onBack={() => closePanel("reject", setRejectionPage)}
        onRejected={(updated) => {
          setUpdatedRequest(updated);
          onChangeRequestProcessed?.();
        }}
        onCancelInstead={() => {
          setRejectionPage(false);
          setCancellationPage(true);
        }}
      />
    );
  }

  if (completionPage) {
    return (
      <EventCompletionPanel
        eventRequest={current}
        headingLevel={panelTitleLevel}
        onBack={() => closePanel("complete", setCompletionPage)}
        onCompleted={(updated) => {
          setUpdatedRequest(updated);
          closePanel("complete", setCompletionPage);
          setCompletedNotice({ eventId: updated.id });
          onChangeRequestProcessed?.();
        }}
      />
    );
  }

  if (significantChangePage) {
    return (
      <SignificantEventChangePanel
        eventRequest={current}
        headingLevel={panelTitleLevel}
        onBack={() => closePanel("revise", setSignificantChangePage)}
        onApplied={(updated) => {
          setUpdatedRequest(updated);
          closePanel("revise", setSignificantChangePage);
          setFlaggedVersion((version) => version + 1);
          setVenueVersion((version) => version + 1);
          onChangeRequestProcessed?.();
        }}
      />
    );
  }

  if (detailsEditPage) {
    return (
      <EventDetailsEditPanel
        eventRequest={current}
        headingLevel={panelTitleLevel}
        onBack={() => closePanel("edit", setDetailsEditPage)}
        onSaved={({ changedFields, ...updated }) => {
          setUpdatedRequest(updated);
          closePanel("edit", setDetailsEditPage);
          setDetailsSaved({ eventId: updated.id, message: `Saved. Changed: ${detailFieldList(changedFields)}.` });
          onChangeRequestProcessed?.();
        }}
      />
    );
  }

  // One level under the title wherever the screen is mounted, so none is skipped.
  const Title = asPage ? "h1" : "h2";
  const sectionLevel = asPage ? 2 : 3;
  const SectionHeading = `h${sectionLevel}`;
  const SubHeading = `h${sectionLevel + 1}`;
  // A queue row has no organiser name (see Provenance), so the line leaves it out.
  const facts = [
    formatDateTimeRangeOrFallback(current.proposedStart, current.proposedEnd, "Date not set"),
    capacity === null ? null : pluralise(capacity, "attendee"),
    request.organiserName || null,
  ].filter(Boolean).join(" · ");

  const canRevise = isAssignedCoordinator && [
    "approved",
    "confirmed",
    "safety_review",
    "safety_approved",
  ].includes(current.status);
  const canCancel = isAssignedCoordinator && CANCELLABLE_STATUSES.has(current.status);
  // Only an Approved event is rejected (Confirmed ones are cancelled), and only
  // an Approved one goes for its safety check.
  const isHolderOfApproved = isAssignedCoordinator && current.status === "approved";
  const hasOpeners = canRevise || canEditDetails || canComplete || canCancel || isHolderOfApproved;

  // The panel shows a refusal only for the revision it refused; once a
  // refetch moves the event on, or unmounts the panel, show it here.
  const showConfirmationFeedback = confirmationFeedback?.eventId === current.id && (confirmationFeedback.success
    ? current.status === "confirmed"
    : !canConfirm || confirmationFeedback.updatedAt !== current.updatedAt);
  const showDetailsSaved = detailsSaved?.eventId === current.id;
  const showCompletedNotice = completedNotice?.eventId === current.id && current.status === "completed";
  // A recorded decision is shown under Decision whatever the status now is, so
  // the review steps apply only while there is none.
  const reviewStep = !current.decision
    && ["submitted", "under_review", "pending_clarification"].includes(current.status)
    ? current.status
    : null;
  const hasNextStep = Boolean(display.description)
    || attentionReasonsOf(current).length > 0
    || current.status === "safety_approved"
    || showConfirmationFeedback || canConfirm || showDetailsSaved || awaitingEnd
    || showCompletedNotice || isHolderOfApproved || reviewStep !== null;
  const chosenDecision = DECISION_CHOICES.find((choice) => choice.value === decisionChoice);
  const hasActivity = Boolean(current.decision) || isAssignedCoordinator || isLead
    || request.status !== "pending_clarification";

  return (
    <div className="coordinator-request-detail">
      <header className="coordinator-request-detail__header">
        <Title ref={titleRef} tabIndex={-1} className="coordinator-request-detail__title">{current.eventName}</Title>
        <p className="coordinator-request-detail__badges">
          <StatusBadge tone={statusTone(display.group)}>{display.label}</StatusBadge>
          <NeedsAttentionBadge event={current} />
        </p>
        <p className="coordinator-request-detail__facts">{facts}</p>
        {/* Reject and Cancel only open their pages, where the final step is the danger one. */}
        {hasOpeners && (
          <div className="coordinator-request-detail__actions">
            {canRevise && (
              <Button
                variant="secondary"
                className="coordinator-request-detail__significant-change"
                ref={openerRef("revise")}
                onClick={() => setSignificantChangePage(true)}
              >
                Revise event details
              </Button>
            )}
            {canEditDetails && (
              <Button
                variant="secondary"
                className="coordinator-request-detail__edit-details"
                ref={openerRef("edit")}
                onClick={() => setDetailsEditPage(true)}
              >
                Edit event information
              </Button>
            )}
            {canComplete && (
              <Button ref={openerRef("complete")} className="coordinator-request-detail__complete" onClick={() => setCompletionPage(true)}>
                Mark as completed
              </Button>
            )}
            {canCancel && (
              <Button
                variant="secondary"
                className="coordinator-request-detail__cancel"
                ref={openerRef("cancel")}
                onClick={() => setCancellationPage(true)}
              >
                Cancel event
              </Button>
            )}
            {isHolderOfApproved && (
              <Button
                variant="secondary"
                className="coordinator-request-detail__reject"
                ref={openerRef("reject")}
                onClick={() => setRejectionPage(true)}
              >
                Reject event
              </Button>
            )}
          </div>
        )}
      </header>

      {/* Main column, then the rail: one column until the screen itself is wide. */}
      <div className="coordinator-request-detail__body">
        <div className="coordinator-request-detail__main">
          {/* What happens now for this status. Read-only viewers see the waiting
              texts; the status and ownership checks are a convenience, not the
              gate, and the error tables above say in words why the server refused. */}
          {hasNextStep && (
            <section className="coordinator-request-detail__next-step" aria-labelledby={`${decisionIds}-next`}>
              <SectionHeading id={`${decisionIds}-next`} ref={nextStepRef} tabIndex={-1}>Next step</SectionHeading>
              {display.description && <p>{display.description}</p>}
              <NeedsAttentionReasons event={current} />
              <SafetyApprovalNotice status={current.status} />
              {showConfirmationFeedback && (
                <p role={confirmationFeedback.success ? "status" : "alert"}>{confirmationFeedback.message}</p>
              )}
              {canConfirm && (
                <EventConfirmationPanel
                  key={current.id}
                  eventRequest={current}
                  headingLevel={sectionLevel + 1}
                  onConfirmed={(updated) => {
                    setUpdatedRequest(updated);
                    setConfirmationFeedback({ eventId: updated.id, success: true, message: "Event confirmed successfully." });
                    focusNextStep();
                    onChangeRequestProcessed?.();
                  }}
                  onStale={(message) => {
                    setUpdatedRequest(null);
                    setConfirmationFeedback({ eventId: current.id, updatedAt: current.updatedAt, success: false, message });
                    return onChangeRequestProcessed?.();
                  }}
                />
              )}
              {showDetailsSaved && (
                <p className="coordinator-request-detail__edit-saved" role="status">{detailsSaved.message}</p>
              )}
              {awaitingEnd && (
                <p className="coordinator-request-detail__complete-hint">
                  You can mark this event as completed once it has ended
                  {current.proposedEnd ? ` (${formatDateTime(current.proposedEnd)})` : ""}.
                </p>
              )}
              {showCompletedNotice && (
                <p className="coordinator-request-detail__completed-notice" role="status">
                  Marked as completed.
                </p>
              )}
              {/* The holder, while Approved. The server checks both again. */}
              {isHolderOfApproved && (
                <SafetyCheckSubmissionPanel
                  key={current.id}
                  eventRequest={current}
                  headingLevel={sectionLevel + 1}
                  onSubmitted={(updated) => {
                    setUpdatedRequest(updated);
                    focusNextStep();
                    onChangeRequestProcessed?.();
                  }}
                  onStale={() => onChangeRequestProcessed?.()}
                />
              )}

              {reviewStep === "pending_clarification" && (
                <div className="coordinator-request-detail__waiting">
                  <SubHeading>Waiting for organiser reply</SubHeading>
                  <div className="clarification-current">
                    <strong>Current question</strong>
                    <p>{current.clarificationNote || "No clarification question was recorded."}</p>
                    {current.clarificationReplyByDate && (
                      <span>
                        Reply by {formatDay(current.clarificationReplyByDate, "Not recorded")}
                        {isReplyOverdue(current.clarificationReplyByDate) && (
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
                      <Button type="submit" disabled={closingClarification || !closureNote.trim()}>
                        {closingClarification ? "Closing..." : "Close clarification"}
                      </Button>
                    </form>
                  )}
                </div>
              )}

              {reviewStep === "submitted" && (isAssignedCoordinator ? (
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
                  <Button disabled={startingReview} onClick={handleStartReview}>
                    {startingReview ? "Starting..." : "Start review"}
                  </Button>
                </div>
              ) : current.assignedCoordinatorId == null ? (
                // Since 052 a submitted request can have no coordinator: it is in
                // the Lead's unassigned queue, and "waiting for the assigned
                // coordinator" would name someone who does not exist.
                <p>Waiting for the Event Coordinator Lead to assign this request to a coordinator.</p>
              ) : (
                <p>Waiting for the assigned coordinator to start the review.</p>
              ))}

              {reviewStep === "under_review" && (isAssignedCoordinator ? (
                <div className="coordinator-clarification">
                  <fieldset className="coordinator-decision" disabled={processingReviewDecision}>
                    <legend>Your decision</legend>
                    {DECISION_CHOICES.map((choice) => {
                      const id = `${decisionIds}-${choice.value}`;
                      return (
                        <label
                          key={choice.value}
                          className={`coordinator-decision__option${decisionChoice === choice.value ? " coordinator-decision__option--selected" : ""}`}
                        >
                          <input
                            type="radio"
                            name={`${decisionIds}-decision`}
                            value={choice.value}
                            checked={decisionChoice === choice.value}
                            onChange={() => setDecisionChoice(choice.value)}
                            aria-labelledby={`${id}-label`}
                            aria-describedby={`${id}-hint`}
                          />
                          <span className="coordinator-decision__text">
                            <span id={`${id}-label`} className="coordinator-decision__label">{choice.label}</span>
                            <span id={`${id}-hint`} className="coordinator-decision__hint">{choice.hint}</span>
                          </span>
                        </label>
                      );
                    })}
                  </fieldset>
                  {/* One note for all three outcomes. Whichever is chosen, the note
                      is read by the Organiser: as the rejection reason, the
                      approval note, or the amendment instructions. */}
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
                  {/* Only a return for amendment sends the fields and the reply-by date. */}
                  {decisionChoice === "return" && (
                    <>
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
                    </>
                  )}
                  {(decisionError || reviewDecisionError) && (
                    <p className="coordinator-clarification__error" role="alert">
                      {decisionError || reviewDecisionError}
                    </p>
                  )}
                  <div className="coordinator-review-actions">
                    <Button
                      variant={chosenDecision?.variant ?? "primary"}
                      disabled={processingReviewDecision || !chosenDecision}
                      onClick={handleSubmitDecision}
                    >
                      {processingReviewDecision ? "Saving..." : chosenDecision?.submitLabel ?? "Submit decision"}
                    </Button>
                  </div>
                </div>
              ) : (
                <p>Only the assigned coordinator can decide this request.</p>
              ))}
            </section>
          )}

          {/* SCRUM-402: the Organiser's change requests, a submission at a time.
              Above the tabs because they wait on the coordinator. An accepted
              equipment change opens the Equipment tab, where its lines are made. */}
          <ChangeRequestReviewPanel
            eventRequest={current}
            canProcess={isAssignedCoordinator}
            onProcessed={() => onChangeRequestProcessed?.()}
            onEquipmentAccepted={(text) => {
              setEquipmentHandOff(text);
              setEventTab("equipment");
            }}
            headingLevel={sectionLevel}
          />

          {/* The assigned Coordinator sees the waiting-list count. */}
          {isAssignedCoordinator && isRegistrationConfigurable(current.status) && (
            <RegistrationCounts eventId={current.id} headingLevel={sectionLevel} />
          )}

          {/* Only the assigned coordinator may read the list; the server checks again. */}
          {isAssignedCoordinator && mayHaveRegistrationList(current.status) && (
            <p>
              <Link to={`/events/${current.id}/registrations`}>View registrations</Link>
            </p>
          )}

          <Tabs
            label="Event sections"
            selected={eventTab}
            onSelect={setEventTab}
            tabs={[
              {
                id: "venues",
                label: "Venues",
                content: (
                  <>
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
                        headingLevel={sectionLevel}
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
                    {/* SCRUM-492: the holder releases one approved venue while the event is
                        Approved. Not keyed on venueVersion, which a release bumps, so the
                        section keeps its own "was released" notice. */}
                    {isAssignedCoordinator && current.status === "approved" && (
                      <EventVenueBookings
                        key={`${current.id}|${current.proposedStart}|${current.proposedEnd}`}
                        eventRequestId={current.id}
                        headingLevel={sectionLevel}
                        onReleased={() => {
                          setVenueVersion((n) => n + 1);
                          onChangeRequestProcessed?.();
                        }}
                        onStale={() => onChangeRequestProcessed?.()}
                      />
                    )}
                    {isAssignedCoordinator && (
                      <section className="event-venue-suitability-section">
                        <SectionHeading>Venue suitability</SectionHeading>
                        <EventVenueSuitability
                          key={`${current.id}|${current.proposedStart}|${current.proposedEnd}|${current.expectedAttendance}|${venueVersion}`}
                          eventRequestId={current.id}
                          onLoaded={(items) => setLiveVenueRequests({ eventId: current.id, venues: liveRequestsFrom(items) })}
                          headingLevel={sectionLevel + 1}
                        />
                      </section>
                    )}

                    <section>
                      <SectionHeading>Find a venue</SectionHeading>
                      <EventVenueFinder
                        key={`${current.id}|${current.proposedStart}|${current.proposedEnd}|${current.expectedAttendance}`}
                        request={current}
                        headingLevel={sectionLevel + 1}
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
                  </>
                ),
              },
              {
                id: "equipment",
                label: "Equipment",
                content: (
                  // SCRUM-402 AC8: an accepted equipment change moves the screen here, with
                  // what the Organiser asked for above the lines it is to be made on.
                  <div className="change-request-review__equipment" ref={equipmentSectionRef} tabIndex={-1} aria-label="Equipment">
                    {equipmentHandOff && (
                      <p className="change-request-review__notice" role="status">
                        The organiser asked for this equipment change: {equipmentHandOff}
                      </p>
                    )}
                    <EventEquipmentSection
                      requestId={request.id}
                      status={current.status}
                      headingLevel={sectionLevel}
                      canEdit={isAssignedCoordinator && current.status !== "cancelled"}
                    />
                  </div>
                ),
              },
              {
                id: "details",
                label: "Details",
                content: (
                  <>
                    <section>
                      <SectionHeading>The request</SectionHeading>
                      <ul>
                        <li>
                          <strong>Purpose</strong>
                          <span>{orNotSpecified(current.purpose)}</span>
                        </li>
                        <li>
                          <strong>Description</strong>
                          <span>{orNotSpecified(current.description)}</span>
                        </li>
                        <li>
                          <strong>Proposed period</strong>
                          <span>{formatDateTimeRangeOrFallback(current.proposedStart, current.proposedEnd, "Not recorded")}</span>
                        </li>
                        <li>
                          <strong>Expected attendance</strong>
                          <span>{capacity === null ? "Not specified" : `${capacity} people`}</span>
                        </li>
                      </ul>
                    </section>

                    <section>
                      <SectionHeading>Requirements</SectionHeading>
                      {/* All three verbatim, and none of them parsed. They are free prose --
                          "a large room, ideally tiered seating" -- and guessing a search
                          term out of that would return no venues and read as "no venues
                          exist". Show, don't parse. */}
                      <ul>
                        <li>
                          <strong>Venue</strong>
                          <span>{orNotSpecified(current.venueRequirements)}</span>
                        </li>
                        <li>
                          <strong>Accessibility</strong>
                          <span>{orNotSpecified(current.accessibilityRequirements)}</span>
                        </li>
                        <li>
                          <strong>Equipment</strong>
                          <span>{orNotSpecified(current.equipmentRequirements)}</span>
                        </li>
                      </ul>
                    </section>

                    {closingNotes && (
                      <section className="coordinator-request-detail__closing-notes">
                        <SectionHeading>Closing notes</SectionHeading>
                        <p>{closingNotes.recorded ? closingNotes.text : "No closing notes were recorded."}</p>
                        <p className="coordinator-request-detail__closing-notes-audience">
                          Only coordinators can see these notes. The organiser cannot.
                        </p>
                      </section>
                    )}
                  </>
                ),
              },
              // Read-only viewers of a request waiting on the organiser have nothing here.
              hasActivity && {
                id: "activity",
                label: "Activity",
                content: (
                  <>
                    {/* A recorded decision, read-only, whatever the status now is: an
                        approved event later confirmed or cancelled still carries it, and
                        it is not edited. Checked on the decision itself, so no list of
                        "decided" statuses is copied here. */}
                    {current.decision && (
                      <section>
                        <SectionHeading>Decision</SectionHeading>
                        <DecisionOutcome request={current} view="coordinator" />
                      </section>
                    )}

                    {/* SCRUM-355 AC5: a resubmission says so, with the decisions before this
                        one. Only its coordinator and the Lead may read them, as the server rules. */}
                    {(isAssignedCoordinator || isLead) && (
                      <DecisionHistory eventRequestId={request.id} view="coordinator" headingLevel={sectionLevel} />
                    )}

                    {/* SCRUM-387 AC7: who may read it, as the server rules. Keyed on the
                        event's updatedAt, so an edit or a significant change re-reads it. */}
                    {(isAssignedCoordinator || isLead) && (
                      <section className="event-change-history" aria-label="Change history">
                        <SectionHeading>Change history</SectionHeading>
                        <EventChangeHistory key={current.updatedAt ?? ""} eventRequestId={current.id} />
                      </section>
                    )}

                    {request.status !== "pending_clarification" && (
                      <section className="coordinator-clarification-history">
                        <SectionHeading>Clarification history</SectionHeading>
                        <ClarificationHistoryDialog
                          eventRequestId={request.id}
                          eventName={request.eventName}
                        />
                      </section>
                    )}
                  </>
                ),
              },
            ].filter(Boolean)}
          />
        </div>

        <aside className="coordinator-request-detail__rail" aria-label="Event facts">
          <ol className="coordinator-request-detail__stepper" aria-label="Progress">
            {progressSteps(current.status).map((step) => (
              <li
                key={step.key}
                className={`coordinator-request-detail__step coordinator-request-detail__step--${step.state}`}
                aria-current={step.state === "current" ? "step" : undefined}
              >
                {step.label}
                {step.state === "done" && <span className="visually-hidden"> (done)</span>}
              </li>
            ))}
          </ol>

          <section>
            <SectionHeading>Provenance</SectionHeading>
            <ul>
              <li>
                <strong>Submitted</strong>
                <span>{formatDateTime(request.submittedAt, "Not recorded")}</span>
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
            <SectionHeading>Coordinator</SectionHeading>
            <AssignmentHistory
              key={historyVersion}
              eventRequestId={request.id}
              view="coordinator"
              currentCoordinatorId={assignedCoordinatorId}
              headingLevel={sectionLevel + 1}
            />

            {handedOverTo && (
              <p className="coordinator-reassign__notice" role="status">
                Handed over to {handedOverTo.fullName ?? "the coordinator you chose"}.
              </p>
            )}

            {canReassign && (
              <div className="coordinator-reassign">
                <Button variant="secondary" ref={openerRef("reassign")} onClick={() => setReassigning(true)}>
                  Hand over to another coordinator
                </Button>
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
