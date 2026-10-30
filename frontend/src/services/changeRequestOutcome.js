// changeRequestOutcome.js
//
// The words for how a change request ended, shared by the Organiser's list of their change
// requests and the coordinator's panel, so the two cannot disagree.
//
// A coordinator decides a request as approved or rejected. The three "event_*" outcomes are not
// decisions: the system closed the request because the whole event was rejected, cancelled or
// completed (SCRUM-347, SCRUM-379 AC4), and they must not read as a rejection.

const OUTCOME_LABELS = {
  approved: "Approved",
  rejected: "Rejected",
  event_rejected: "Closed, event rejected",
  event_cancelled: "Closed, event cancelled",
  event_completed: "Closed, event completed",
};

/**
 * @param {string|null|undefined} decision  the change request's decision as the API gives it
 * @returns {string|null}  the label, or null when it has no decision yet; an outcome this
 *   screen does not know is shown as a plain "Closed" rather than guessed to be a rejection
 */
export function changeRequestOutcomeLabel(decision) {
  if (!decision) return null;
  return OUTCOME_LABELS[decision] ?? "Closed";
}
