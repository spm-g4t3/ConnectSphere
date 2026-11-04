// DecisionOutcome.jsx
//
// SCRUM-129 and SCRUM-133, for SCRUM-19 AC9 and AC10: a decided request's
// outcome, read-only. The outcome, the reason or note, who decided and when.
//
// One component for both screens, as AssignmentHistory is: the coordinator's
// event panel and the Organiser's list both show the same record. The `view`
// prop names the audience the same way AssignmentHistory's does, because the
// name lookup below goes through the same two endpoints.
//
// Read-only on purpose. A decision cannot be edited (AC9): approved and
// rejected never return to under_review, and decide_event_request requires
// under_review, so nothing here offers to change it.
//
// Where the decider's name comes from. decidedBy is a bare user id, and
// neither the event nor the Organiser's list carries a name for it. The
// assignment history does: every coordinator who has held the event appears
// in it as a newCoordinatorId with a newCoordinatorName, and the person who
// decided must have held the event when they decided (029 refuses anyone
// else). So the name is looked up there, by matching decidedBy. That reuses
// an endpoint both audiences may already call, rather than adding one.
//
// It is the decider, not the current coordinator. An approved event can be
// handed over afterwards (018 allows it), so "the coordinator who decided"
// and "the coordinator now responsible" can be different people, and AC10
// asks for the first. The newest history entry would give the second.
//
// The status history (GET /:id/status-history) also names who made each
// change, but answers only the Organiser and the event's coordinator; the
// assignment history answers the Lead too.

import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import {
  getAssignmentHistory,
  getAssignmentHistoryForReview,
} from "../services/eventRequestService";
import { formatDateTime } from "../services/displayFormat";
import { canRetryRead } from "../services/apiErrors";
import ErrorNotice from "./ui/ErrorNotice";

const FETCH_BY_VIEW = {
  coordinator: getAssignmentHistoryForReview,
  organiser: getAssignmentHistory,
};

// The decision's own two values. Not a copy of the status vocabulary: a
// decision is 025's separate two-value enum, the status may have moved on
// since (an approved event is later confirmed), and the server sends no
// display text for it.
const DECISION_LABEL = {
  approved: "Approved",
  rejected: "Rejected",
};

/**
 * @param {object} props
 * @param {object} props.request                    a decided event request
 * @param {"coordinator"|"organiser"} props.view    which audience; anything
 *                                                   else gets the Organiser's
 */
export default function DecisionOutcome({ request, view }) {
  const { user } = useAuth();
  const [deciderName, setDeciderName] = useState(null);
  const [nameLoaded, setNameLoaded] = useState(false);
  const [nameError, setNameError] = useState(null); // { retryable }
  // Bumped by Try again to run the read below once more.
  const [attempt, setAttempt] = useState(0);

  const decidedBy = request.decidedBy;
  const decidedByYou = view === "coordinator" && Boolean(user?.id) && decidedBy === user.id;
  /* v8 ignore next -- @preserve Typo-safe default: every caller passes a known view. */
  const fetchHistory = FETCH_BY_VIEW[view] ?? FETCH_BY_VIEW.organiser;

  // Only when the name is needed: not for "you", and not when nobody is
  // recorded. Read once per mount; a list refetch keeps this row mounted, so
  // it does not read it again.
  useEffect(() => {
    if (decidedByYou || !decidedBy) return undefined;

    let cancelled = false;
    fetchHistory(request.id)
      .then((entries) => {
        if (cancelled) return;
        const held = entries.find((entry) => entry.newCoordinatorId === decidedBy);
        setDeciderName(held?.newCoordinatorName ?? null);
      })
      .catch((err) => {
        // Only the name's line says so: the outcome and the reason still show.
        if (!cancelled) setNameError({ retryable: canRetryRead(err) });
      })
      .finally(() => {
        if (!cancelled) setNameLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [request.id, decidedBy, decidedByYou, fetchHistory, attempt]);

  function retryName() {
    setNameLoaded(false);
    setNameError(null);
    setAttempt((count) => count + 1);
  }

  let decider;
  if (decidedByYou) decider = "You";
  else if (!decidedBy) decider = "Not recorded";
  // Plain text, not LoadingText: one value in a record, and a live region per
  // decided row would be announced once for every row in the list.
  else if (!nameLoaded) decider = "Loading...";
  else if (nameError) {
    decider = (
      <ErrorNotice
        message="The decider's name could not be loaded."
        onRetry={nameError.retryable ? retryName : undefined}
      />
    );
  } else decider = deciderName ?? "A coordinator with no name on record";

  const isRejection = request.decision === "rejected";

  return (
    <dl className="decision-outcome">
      <dt>Outcome</dt>
      <dd>{DECISION_LABEL[request.decision]}</dd>

      {/* "Reason" for a rejection, because the database requires one and it
          is what the Organiser needs to read. "Note" for an approval, which
          may have none. */}
      <dt>{isRejection ? "Reason" : "Note"}</dt>
      <dd>{request.decisionNote || "No note was left."}</dd>

      <dt>Decided by</dt>
      <dd>{decider}</dd>

      <dt>Decided</dt>
      <dd>{formatDateTime(request.decidedAt, "Not recorded")}</dd>
    </dl>
  );
}
