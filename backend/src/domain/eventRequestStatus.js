/**
 * Event request status vocabulary.
 *
 * SCRUM-44: Define and map event request status stages.
 *
 * The database (001_event_requests.sql) decides which statuses are *storable*.
 * This module decides what they *mean*: what an Event Organiser sees, and which
 * status changes are legal.
 *
 * Deliberately free of imports, database calls and framework code. It is pure
 * data and pure functions, so it can be tested in isolation and reasoned about
 * without running anything else.
 */


/**
 * The ten statuses, spelled exactly as the Postgres enum `event_request_status`.
 *
 * These two lists must stay identical. If they drift, the database rejects the
 * write at runtime -- so a test asserts the match rather than leaving it to
 * whoever edits one file to remember the other.
 */
export const STATUS = Object.freeze({
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  UNDER_REVIEW: 'under_review',
  PENDING_CLARIFICATION: 'pending_clarification',
  APPROVED: 'approved',
  PLANNING: 'planning',
  CONFIRMED: 'confirmed',
  COMPLETED: 'completed',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
});


/**
 * Organiser-facing groups.
 *
 * Why a second layer on top of STATUS: groups are the *stable* contract, while
 * statuses are internal detail that will grow. When the team later adds, say,
 * 'postponed', it maps into an existing group and the UI needs no change.
 * React also styles on the group, so colours and icons do not churn either.
 *
 * AWAITING_REVIEW and ACTION_REQUIRED are the two halves of what AC3 calls
 * "awaiting action". Splitting them is the most useful thing the status page
 * does: it tells the Organiser whether to wait or to go and do something.
 */
export const STATUS_GROUP = Object.freeze({
  DRAFT: 'DRAFT',
  AWAITING_REVIEW: 'AWAITING_REVIEW',   // waiting on ConnectSphere
  UNDER_REVIEW: 'UNDER_REVIEW',
  ACTION_REQUIRED: 'ACTION_REQUIRED',   // waiting on the Organiser
  APPROVED: 'APPROVED',
  CONFIRMED: 'CONFIRMED',
  COMPLETED: 'COMPLETED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',

  // SCRUM-47. Not stages of the planning process -- these say the status
  // itself could not be shown. They live here because React styles on the
  // group, and a fallback the UI cannot style is a fallback that renders
  // as an unstyled gap.
  UNAVAILABLE: 'UNAVAILABLE',   // nothing usable was supplied
  UNKNOWN: 'UNKNOWN',           // a value arrived, but not one we know
});


/**
 * What the Organiser sees for each status.
 *
 * Descriptions are written in the second person because they are shown to the
 * Organiser directly, and the customer brief asks that the system "not assume
 * that users understand ConnectSphere's internal processes".
 *
 * Object.freeze is shallow, so each entry is frozen too.
 */
export const STATUS_DISPLAY = Object.freeze({
  [STATUS.DRAFT]: Object.freeze({
    label: 'Draft',
    group: STATUS_GROUP.DRAFT,
    description: 'Not yet submitted to ConnectSphere. You can keep editing it.',
  }),
  [STATUS.SUBMITTED]: Object.freeze({
    label: 'Submitted',
    group: STATUS_GROUP.AWAITING_REVIEW,
    description: 'Received by ConnectSphere and waiting to be picked up by a Coordinator.',
  }),
  [STATUS.UNDER_REVIEW]: Object.freeze({
    label: 'Under Review',
    group: STATUS_GROUP.UNDER_REVIEW,
    description: 'A Coordinator is assessing your request.',
  }),
  [STATUS.PENDING_CLARIFICATION]: Object.freeze({
    label: 'Action Needed',
    group: STATUS_GROUP.ACTION_REQUIRED,
    description: 'A Coordinator needs more information from you before this can move forward.',
  }),
  [STATUS.APPROVED]: Object.freeze({
    label: 'Approved',
    group: STATUS_GROUP.APPROVED,
    description: 'Your request has been accepted. Arrangements will now begin.',
  }),
  [STATUS.PLANNING]: Object.freeze({
    label: 'In Planning',
    group: STATUS_GROUP.APPROVED,
    description: 'Venue and equipment arrangements are being made.',
  }),
  [STATUS.CONFIRMED]: Object.freeze({
    label: 'Confirmed',
    group: STATUS_GROUP.CONFIRMED,
    description: 'All arrangements are complete. Your event is going ahead.',
  }),
  [STATUS.COMPLETED]: Object.freeze({
    label: 'Completed',
    group: STATUS_GROUP.COMPLETED,
    description: 'This event has taken place.',
  }),
  [STATUS.REJECTED]: Object.freeze({
    label: 'Rejected',
    group: STATUS_GROUP.REJECTED,
    description: 'This request was not accepted. See the Coordinator notes for the reason.',
  }),
  [STATUS.CANCELLED]: Object.freeze({
    label: 'Cancelled',
    group: STATUS_GROUP.CANCELLED,
    description: 'This event was called off.',
  }),
});


/**
 * Which status changes are legal.
 *
 * Two rules worth spelling out:
 *
 *  - pending_clarification goes back to under_review, not to submitted. The
 *    Coordinator already holds the request; the Organiser is answering them,
 *    not re-joining the queue.
 *
 *  - cancelled is reachable from every live status including confirmed. The
 *    customer brief has Organisers postponing or cancelling "due to unforeseen
 *    circumstances" with no stage limit, and real events are cancelled late.
 *
 * completed, rejected and cancelled are terminal: nothing leads out of them, so
 * a rejected request can never quietly become confirmed.
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  [STATUS.DRAFT]: Object.freeze([
    STATUS.SUBMITTED,
    STATUS.CANCELLED,
  ]),
  [STATUS.SUBMITTED]: Object.freeze([
    STATUS.UNDER_REVIEW,
    STATUS.PENDING_CLARIFICATION,
    STATUS.CANCELLED,
  ]),
  [STATUS.UNDER_REVIEW]: Object.freeze([
    STATUS.PENDING_CLARIFICATION,
    STATUS.APPROVED,
    STATUS.REJECTED,
    STATUS.CANCELLED,
  ]),
  [STATUS.PENDING_CLARIFICATION]: Object.freeze([
    STATUS.UNDER_REVIEW,
    STATUS.CANCELLED,
  ]),
  [STATUS.APPROVED]: Object.freeze([
    STATUS.PLANNING,
    STATUS.CANCELLED,
  ]),
  [STATUS.PLANNING]: Object.freeze([
    STATUS.CONFIRMED,
    STATUS.CANCELLED,
  ]),
  [STATUS.CONFIRMED]: Object.freeze([
    STATUS.COMPLETED,
    STATUS.CANCELLED,
  ]),
  [STATUS.COMPLETED]: Object.freeze([]),
  [STATUS.REJECTED]: Object.freeze([]),
  [STATUS.CANCELLED]: Object.freeze([]),
});


/**
 * The statuses that put a request in the Event Coordinator's review queue.
 *
 * SCRUM-45. This lives in the domain and not in the service because *which
 * statuses constitute the queue* is a meaning, not a query detail: the service
 * hands this array to .in() and would otherwise be the only place the team's
 * definition of "waiting for a decision" was written down.
 *
 * Each of the three earns its place, and so does each omission:
 *
 *  - pending_clarification IS in the queue. It looks like the Organiser's turn,
 *    but ALLOWED_TRANSITIONS[PENDING_CLARIFICATION] leads back to under_review
 *    and nowhere else forward -- the Coordinator never let go of it, they asked
 *    a question. Dropping it out of the queue would mean the only way back to
 *    a request you yourself paused is to remember its id.
 *
 *  - draft is OUT, and that exclusion is not an oversight -- it is the privacy
 *    boundary of the whole shared-queue design. There is no coordinator_id on
 *    event_requests and no assignment model, so every Coordinator sees every
 *    row this list admits. A draft is an Organiser's private working copy that
 *    they have not chosen to show anyone, so the status filter IS the access
 *    control, and widening this array is what would breach it.
 *
 *  - approved, planning, confirmed, completed, rejected and cancelled are out
 *    because a decision has been made. What a Coordinator does with a request
 *    afterwards is a post-decision worklist, and whoever builds that screen
 *    owns its own list rather than inheriting a queue that would never empty.
 *
 * Order is load-bearing only in the weak sense that a test pins it; .in() does
 * not care. It reads submitted -> under_review -> pending_clarification because
 * that is the order a request travels through them.
 */
export const COORDINATOR_QUEUE_STATUSES = Object.freeze([
  STATUS.SUBMITTED,
  STATUS.UNDER_REVIEW,
  STATUS.PENDING_CLARIFICATION,
]);


/**
 * Is moving from one status to another allowed?
 *
 * SCRUM-45 enforces this before writing a status change.
 *
 * Object.hasOwn rather than a plain lookup: `ALLOWED_TRANSITIONS['constructor']`
 * would otherwise find an inherited property and blow up on .includes(). Reading
 * only the object's own keys makes any unrecognised input simply false.
 *
 * @param {string} from - current status
 * @param {string} to   - proposed status
 * @returns {boolean}
 */
export function canTransition(from, to) {
  if (!Object.hasOwn(ALLOWED_TRANSITIONS, from)) return false;
  return ALLOWED_TRANSITIONS[from].includes(to);
}


/**
 * What the Organiser sees when the status itself cannot be shown.
 *
 * SCRUM-47: handle unavailable or unknown request status states.
 *
 * Two cases, kept apart because they mean different things to the person
 * reading the page and call for different actions:
 *
 *   UNAVAILABLE -- nothing usable arrived. The request exists but its status
 *                  did not reach us, so the honest answer is "we cannot tell
 *                  you right now", and refreshing may fix it.
 *   UNKNOWN     -- a value arrived that this build does not recognise. Almost
 *                  always a deployed frontend older than the status list.
 *                  Refreshing will not help; a human will.
 *
 * Collapsing them into one message would tell an Organiser to retry something
 * that cannot succeed, or to give up on something that would have worked.
 */
export const STATUS_FALLBACK = Object.freeze({
  UNAVAILABLE: Object.freeze({
    label: 'Status Unavailable',
    group: STATUS_GROUP.UNAVAILABLE,
    description:
      'We could not read the status of this request. Please refresh the page, ' +
      'and contact your Event Coordinator if it keeps happening.',
  }),
  UNKNOWN: Object.freeze({
    label: 'Unknown Status',
    group: STATUS_GROUP.UNKNOWN,
    description:
      'This request is at a stage this page does not recognise. Your Event ' +
      'Coordinator can tell you where it stands.',
  }),
});


/**
 * The Organiser-facing view of a status.
 *
 * Returns the exact shape the API sends to React, so the frontend keeps no
 * copy of the status list and the two can never disagree.
 *
 * SCRUM-47: never returns undefined. AC1 says the Organiser can view the
 * status of their request, and a screen showing nothing at all meets that
 * worse than a screen saying the status could not be read. Every caller gets
 * the same four fields, so the UI has one code path rather than a rendering
 * path and a null-guarding path.
 *
 * A non-empty string that is not in the vocabulary is UNKNOWN; anything else
 * -- null, undefined, blank, or not a string at all -- is UNAVAILABLE, because
 * no value arrived that could have been a status in the first place.
 *
 * @param {string} status
 * @returns {{status: string|null, label: string, group: string, description: string}}
 */
export function getStatusDisplay(status) {
  if (Object.hasOwn(STATUS_DISPLAY, status)) {
    const { label, group, description } = STATUS_DISPLAY[status];
    return Object.freeze({ status, label, group, description });
  }

  const supplied = typeof status === 'string' && status.trim() !== '';
  const fallback = supplied ? STATUS_FALLBACK.UNKNOWN : STATUS_FALLBACK.UNAVAILABLE;

  // Echo the offending value only when it was a string. Putting an object or
  // a number in the payload under a field the frontend treats as a status
  // code would just move the problem downstream.
  return Object.freeze({
    status: supplied ? status : null,
    label: fallback.label,
    group: fallback.group,
    description: fallback.description,
  });
}


/**
 * Is this a status the system actually knows?
 *
 * SCRUM-47. getStatusDisplay always returns something renderable, which is
 * right for the UI but means a caller can no longer tell a real status from a
 * fallback by checking for undefined. This is how they ask that directly --
 * for deciding whether to offer an action, not for deciding what to render.
 *
 * @param {string} status
 * @returns {boolean}
 */
export function isKnownStatus(status) {
  return Object.hasOwn(STATUS_DISPLAY, status);
}
