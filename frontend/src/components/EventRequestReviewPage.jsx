// EventRequestReviewPage.jsx
//
// SCRUM-486 (SCRUM-521): one event's coordinator screen, opened by its URL,
// /event-requests/:eventRequestId.
//
// Why it exists. CoordinatorRequestDetail, the screen a handover is made
// from, was only ever opened as a panel inside a list (the review queue, My
// events), from a row that list had already loaded. The Event Coordinator
// Lead has neither list: the review queue is the coordinators', and the Lead's
// unassigned queue holds only requests nobody holds, which cannot be handed
// over. So the Lead had no way onto the screen at all. This page is that
// way: it loads the event by id through GET /:id/review, which since SCRUM-521
// admits the Lead, and renders the same screen.
//
// Deliberately not a list. The Lead chooses an event from AssignedEvents
// (/assigned-events, SCRUM-486 AC6), whose rows link here. This page said
// until then that the Lead reached an event only by its address; the AC1
// walkthrough on 12 October showed that was not "reassign events where
// necessary", so the list was built as the first slice of SCRUM-487's
// coordinator overview. SCRUM-487 extended it (the counts, the filters,
// finished events), and its rows still link here.
//
// Open to coordinators too, for the events they hold (SCRUM-444): it is the
// same read they already have, and gives an event a link of its own. The
// server decides what either may do on it.

import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { normaliseRole } from "../auth/normaliseRole";
import { canRetryRead } from "../services/apiErrors";
import { getEventRequestForReview } from "../services/eventRequestService";
import CoordinatorRequestDetail from "./CoordinatorRequestDetail";
import ErrorNotice from "./ui/ErrorNotice";
import LoadingText from "./ui/LoadingText";
import useFocusAfterRetry from "./useFocusAfterRetry";

// Keyed by status, as every load in this frontend is, never on the server's
// text. 404 covers a draft, a missing id and, since SCRUM-444, an event the
// caller does not hold: GET /:id/review answers all three the same. It is the
// page a previous holder lands on from an old link or a notice (AC4).
const LOAD_ERROR_MESSAGES = {
  403: "Only Event Coordinators and the Event Coordinator Lead can open an event here.",
  404: "This event isn't available to you. It may have been handed over to another coordinator, or it may no longer exist.",
  500: "This event request could not be loaded.",
};

// The Lead reads every event, so their 404 is only ever a draft or a missing id:
// no handover to mention. Keyed on the role from the auth context, not the text.
const LEAD_NOT_FOUND = "This event request doesn't exist or hasn't been submitted yet.";

export default function EventRequestReviewPage() {
  const { eventRequestId } = useParams();
  const { user } = useAuth();
  const isLead = normaliseRole(user?.role) === "EVENT_COORDINATOR_LEAD";
  const [request, setRequest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [retryable, setRetryable] = useState(false);

  const load = useCallback(async () => {
    try {
      setRequest(await getEventRequestForReview(eventRequestId));
      setError(null);
    } catch (err) {
      const status = err.response?.status;
      setError(
        (isLead && status === 404 ? LEAD_NOT_FOUND : LOAD_ERROR_MESSAGES[status]) ||
          "This event request could not be loaded.",
      );
      setRetryable(canRetryRead(err));
    } finally {
      setLoading(false);
    }
  }, [eventRequestId, isLead]);

  useEffect(() => {
    load();
  }, [load]);

  // Only Try again shows the loading text again: the refreshes after a
  // decision keep the screen mounted, so it keeps its own state.
  const retryLoad = useCallback(() => {
    setLoading(true);
    return load();
  }, [load]);
  // The page section stays mounted through a retry, so focus lands on it
  // whether the read then succeeds or fails again.
  const { headingRef, retry } = useFocusAfterRetry(retryLoad);

  // After a handover, a decision or a processed change request, read the
  // event again, so the screen shows where it stands now. The screen keeps
  // its own state (who it was handed to) across the refresh.
  return (
    <section ref={headingRef} tabIndex={-1}>
      {loading ? (
        <LoadingText />
      ) : error ? (
        <ErrorNotice message={error} onRetry={retryable ? retry : undefined} />
      ) : (
        <CoordinatorRequestDetail
          asPage
          request={request}
          onChangeRequestProcessed={load}
          onReviewDecisionProcessed={load}
        />
      )}
    </section>
  );
}
