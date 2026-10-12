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
// coordinator overview, which extends it and keeps linking here.
//
// Open to coordinators too: it is the same read they already have, and gives
// an event a link of its own. The server decides what either may do on it.

import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getEventRequestForReview } from "../services/eventRequestService";
import CoordinatorRequestDetail from "./CoordinatorRequestDetail";

// Keyed by status, as every load in this frontend is. 404 covers a draft as
// well as a missing id: GET /:id/review answers both the same, so a draft is
// not revealed to exist.
const LOAD_ERROR_MESSAGES = {
  401: "Your session has expired. Please sign in again.",
  403: "Only Event Coordinators and the Event Coordinator Lead can open an event here.",
  404: "There is no submitted event request at this address.",
  500: "This event request could not be loaded. Please try again.",
};

export default function EventRequestReviewPage() {
  const { eventRequestId } = useParams();
  const [request, setRequest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setRequest(await getEventRequestForReview(eventRequestId));
      setError(null);
    } catch (err) {
      setError(
        LOAD_ERROR_MESSAGES[err.response?.status] ||
          "This event request could not be loaded. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }, [eventRequestId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <p>Loading...</p>;

  if (error) {
    return (
      <p className="coordinator-clarification__error" role="alert">
        {error}
      </p>
    );
  }

  // After a handover, a decision or a processed change request, read the
  // event again, so the screen shows where it stands now. The screen keeps
  // its own state (who it was handed to) across the refresh.
  return (
    <section>
      <CoordinatorRequestDetail
        request={request}
        onChangeRequestProcessed={load}
        onReviewDecisionProcessed={load}
      />
    </section>
  );
}
