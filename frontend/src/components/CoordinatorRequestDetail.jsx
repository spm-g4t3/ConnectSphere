// CoordinatorRequestDetail.jsx
//
// SCRUM-45: one event request, read by the Event Coordinator who has to
// decide something about it, plus the single action this story gives them --
// jumping into venue search with the capacity already filtered.
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
// be rediscovered.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  getCoordinatorChangeRequests,
  processCoordinatorChangeRequest,
  requestEventClarification,
} from "../services/eventRequestService";
import {
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
 * Is this a capacity worth seeding the venue search with?
 *
 * expected_attendance is nullable, and the whole point of the guard is that
 * `/venue-search?minCapacity=null` would arrive at the backend's
 * parseSearchFilters as Number("null") -> NaN and silently filter out
 * everything. A request with no attendance figure produces a bare
 * /venue-search instead: no filter is honest, an impossible filter is not.
 */
function seedableCapacity(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

export default function CoordinatorRequestDetail({
  request,
  onReviewDecisionProcessed,
  onChangeRequestProcessed,
}) {
  const navigate = useNavigate();
  const display = readStatusDisplay(request);
  const capacity = seedableCapacity(request.expectedAttendance);
  const [reviewNote, setReviewNote] = useState("");
  const [processingReviewDecision, setProcessingReviewDecision] = useState(false);
  const [reviewDecisionError, setReviewDecisionError] = useState(null);
  const [changeRequests, setChangeRequests] = useState([]);
  const [changeRequestsLoading, setChangeRequestsLoading] = useState(true);
  const [changeRequestsError, setChangeRequestsError] = useState(null);
  const [processingChangeRequestId, setProcessingChangeRequestId] = useState(null);
  const [rejectingChangeRequestId, setRejectingChangeRequestId] = useState(null);
  const [rejectionNote, setRejectionNote] = useState("");
  const [changeRequestActionError, setChangeRequestActionError] = useState(null);

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

  /**
   * Hand off to venue search (workflow step 3).
   *
   * Filters travel in the query string and context travels in router state,
   * and the split is deliberate. The capacity filter must survive a reload
   * and the back button -- a Coordinator comparing venues will do both, and
   * silently losing the filter is the exact bug this handoff exists to
   * prevent -- so it belongs in the URL, which is also the vocabulary the
   * backend's parseSearchFilters already speaks.
   *
   * The event name and the requirements prose do NOT go in the URL. Putting a
   * request's title into an address bar leaks it into browser history and
   * into any link that gets pasted somewhere, for a string that is only
   * decoration. In router state it disappears on reload, which is correct:
   * the filters are the contract, the banner is the courtesy.
   */
  function handleFindVenue() {
    const query = capacity === null ? "" : `?minCapacity=${capacity}`;

    navigate(`/venue-search${query}`, {
      state: {
        eventRequestContext: {
          eventName: request.eventName,
          venueRequirements: request.venueRequirements ?? null,
        },
          returnToReview: { request },
      },
    });
  }

  async function handleReviewDecision(decision) {
    if (decision !== "returned_for_amendment") return;

    const note = reviewNote.trim();
    if (!note) {
      setReviewDecisionError("Add instructions before returning this request.");
      return;
    }

    setProcessingReviewDecision(true);
    setReviewDecisionError(null);
    try {
      await requestEventClarification(request.id, note);
      onReviewDecisionProcessed?.();
    } catch (error) {
      setReviewDecisionError(
        error.response?.data?.error || "Could not return the request for amendment.",
      );
    } finally {
      setProcessingReviewDecision(false);
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

  return (
    <div className="coordinator-request-detail">
      <h2>
        {request.eventName}
        <span className={`status-badge ${statusClassName(display.group)}`}>
          {display.label}
        </span>
      </h2>
      <p>{display.description}</p>

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
                  {isOpen && (
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
            {/* A bare uuid on purpose. The queue joins no profiles row, so no
                name exists to show -- that is the privacy floor of a queue
                every Coordinator can read, not a missing feature. Rendered as
                an identifier so it never reads as a label. */}
            <strong>Organiser</strong>
            <code title={request.organiserId ?? undefined}>
              {request.organiserId ?? "unknown"}
            </code>
          </li>
        </ul>
      </section>

      {request.status === "pending_clarification" ? (
        <section>
          <h3>Waiting for organiser amendment</h3>
          <p>{request.clarificationNote || "No clarification note was recorded."}</p>
        </section>
      ) : (
        <section>
          <h3>Coordinator decision</h3>
          <p>Approve and reject are not available yet. To request updates, return the event to the Organiser for amendment.</p>
          <div className="coordinator-clarification">
            <label>
              Amendment instructions
              <textarea
                value={reviewNote}
                onChange={(event) => setReviewNote(event.target.value)}
                rows={4}
                maxLength={2000}
                placeholder="Explain what the Organiser needs to clarify or amend."
              />
            </label>
            {reviewDecisionError && (
              <p className="coordinator-clarification__error" role="alert">
                {reviewDecisionError}
              </p>
            )}
            <div className="coordinator-review-actions">
              <button className="coordinator-review-actions__approve" type="button" disabled={processingReviewDecision} onClick={() => handleReviewDecision("approved")}>
                {processingReviewDecision ? "Saving..." : "Approve request"}
              </button>
              <button className="coordinator-review-actions__reject" type="button" disabled={processingReviewDecision} onClick={() => handleReviewDecision("rejected")}>
                Reject request
              </button>
              <button className="coordinator-review-actions__return" type="button" disabled={processingReviewDecision} onClick={() => handleReviewDecision("returned_for_amendment")}>
                Return for amendment
              </button>
            </div>
          </div>
        </section>
      )}

      <section>
        <h3>Find a venue</h3>
        <p>
          {capacity === null
            ? "This request gives no expected attendance, so venue search opens unfiltered."
            : `Venue search will open filtered to venues seating at least ${capacity}.`}
        </p>
        <button onClick={handleFindVenue}>Find a venue for this event</button>
      </section>
    </div>
  );
}
