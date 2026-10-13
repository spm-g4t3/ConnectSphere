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
 * The lifecycle statuses, including additions after the original enum
 * migration. PostgreSQL enum values are added by append-only migrations.
 *
 * There is no PLANNING status. The customer treats planning as approval, so
 * that stage is APPROVED. The enum still carries 'planning', because Postgres
 * cannot drop an enum value; migration 020 refuses it with a constraint
 * instead. Nothing here may write it, and a test asserts this list stays
 * inside the enum rather than leaving it to whoever edits one file to
 * remember the other.
 */
export const STATUS = Object.freeze({
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  UNDER_REVIEW: 'under_review',
  PENDING_CLARIFICATION: 'pending_clarification',
  APPROVED: 'approved',
  SAFETY_REVIEW: 'safety_review',
  SAFETY_APPROVED: 'safety_approved',
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
 * The label the Event Organiser sees for each status (SCRUM-318 AC7).
 *
 * The one definition of these words. STATUS_DISPLAY below takes its labels
 * from here, and so does everything that shows a status to an Organiser, so no
 * screen or response needs a copy and none can drift.
 *
 * Presentation only. The keys are the internal statuses, which are what the
 * database stores and the transition table speaks, and they are unchanged.
 * The Organiser never sees them: 'submitted' reads "Requested",
 * 'pending_clarification' reads "Awaiting your response", and 'approved' reads
 * "Planning", the customer's own word for that stage. There is no planning
 * status behind that label.
 */
export const ORGANISER_STATUS_LABEL = Object.freeze({
  [STATUS.DRAFT]: 'Draft',
  [STATUS.SUBMITTED]: 'Requested',
  [STATUS.UNDER_REVIEW]: 'Under review',
  [STATUS.PENDING_CLARIFICATION]: 'Awaiting your response',
  [STATUS.APPROVED]: 'Planning',
  [STATUS.SAFETY_REVIEW]: 'Safety review',
  [STATUS.SAFETY_APPROVED]: 'Safety approved',
  [STATUS.CONFIRMED]: 'Confirmed',
  [STATUS.COMPLETED]: 'Completed',
  [STATUS.REJECTED]: 'Rejected',
  [STATUS.CANCELLED]: 'Cancelled',
});


/**
 * What the Organiser sees for each status.
 *
 * Labels come from ORGANISER_STATUS_LABEL. Descriptions are written in the
 * second person because they are shown to the Organiser directly, and the
 * customer brief asks that the system "not assume that users understand
 * ConnectSphere's internal processes".
 *
 * Object.freeze is shallow, so each entry is frozen too.
 */
export const STATUS_DISPLAY = Object.freeze({
  [STATUS.DRAFT]: Object.freeze({
    label: ORGANISER_STATUS_LABEL[STATUS.DRAFT],
    group: STATUS_GROUP.DRAFT,
    description: 'Not yet submitted to ConnectSphere. You can keep editing it.',
  }),
  [STATUS.SUBMITTED]: Object.freeze({
    label: ORGANISER_STATUS_LABEL[STATUS.SUBMITTED],
    group: STATUS_GROUP.AWAITING_REVIEW,
    description: 'Received by ConnectSphere and waiting to be picked up by a Coordinator.',
  }),
  [STATUS.UNDER_REVIEW]: Object.freeze({
    label: ORGANISER_STATUS_LABEL[STATUS.UNDER_REVIEW],
    group: STATUS_GROUP.UNDER_REVIEW,
    description: 'A Coordinator is assessing your request.',
  }),
  [STATUS.PENDING_CLARIFICATION]: Object.freeze({
    label: ORGANISER_STATUS_LABEL[STATUS.PENDING_CLARIFICATION],
    group: STATUS_GROUP.ACTION_REQUIRED,
    description: 'A Coordinator needs more information from you before this can move forward.',
  }),
  [STATUS.APPROVED]: Object.freeze({
    label: ORGANISER_STATUS_LABEL[STATUS.APPROVED],
    group: STATUS_GROUP.APPROVED,
    description: 'Your request has been accepted. Arrangements will now begin.',
  }),
  [STATUS.SAFETY_REVIEW]: Object.freeze({
    label: ORGANISER_STATUS_LABEL[STATUS.SAFETY_REVIEW],
    group: STATUS_GROUP.AWAITING_REVIEW,
    description: 'A Safety Officer is reviewing the event arrangements.',
  }),
  [STATUS.SAFETY_APPROVED]: Object.freeze({
    label: ORGANISER_STATUS_LABEL[STATUS.SAFETY_APPROVED],
    group: STATUS_GROUP.APPROVED,
    description: 'The event arrangements have passed the safety review.',
  }),
  [STATUS.CONFIRMED]: Object.freeze({
    label: ORGANISER_STATUS_LABEL[STATUS.CONFIRMED],
    group: STATUS_GROUP.CONFIRMED,
    description: 'All arrangements are complete. Your event is going ahead.',
  }),
  [STATUS.COMPLETED]: Object.freeze({
    label: ORGANISER_STATUS_LABEL[STATUS.COMPLETED],
    group: STATUS_GROUP.COMPLETED,
    description: 'This event has taken place.',
  }),
  [STATUS.REJECTED]: Object.freeze({
    label: ORGANISER_STATUS_LABEL[STATUS.REJECTED],
    group: STATUS_GROUP.REJECTED,
    description: 'This request was not accepted. See the Coordinator notes for the reason.',
  }),
  [STATUS.CANCELLED]: Object.freeze({
    label: ORGANISER_STATUS_LABEL[STATUS.CANCELLED],
    group: STATUS_GROUP.CANCELLED,
    description: 'This event was called off.',
  }),
});


/**
 * Which status changes are legal.
 *
 * SCRUM-318 owns this table. It says which moves are valid; who may make each
 * one is checked in the story that performs it.
 *
 * Rules worth spelling out:
 *
 *  - pending_clarification goes back to under_review, not to submitted. The
 *    Coordinator already holds the request; the Organiser is answering them,
 *    not re-joining the queue.
 *
 *  - cancelled is reachable from submitted, under_review, pending_clarification,
 *    approved and confirmed. A draft is deleted rather than cancelled, because
 *    it has no coordinator yet to cancel it.
 *
 *  - rejected leads back to draft only: the Organiser may revise and resubmit.
 *    An approved event whose essential arrangements cannot be met is rejected.
 *    A confirmed event goes back to approved when a significant change needs
 *    re-planning.
 *
 *  - completed and cancelled are terminal: nothing leads out of them. A
 *    cancelled event is never reinstated; a new request is submitted instead.
 *
 * Clarification is requested from under_review only; submitted requests must
 * first be moved into review through the coordinator's review workflow.
 *
 * Migration 022 holds this same table in SQL, so the database function refuses
 * an illegal move whoever calls it. A test compares the two.
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  [STATUS.DRAFT]: Object.freeze([
    STATUS.SUBMITTED,
  ]),
  [STATUS.SUBMITTED]: Object.freeze([
    STATUS.UNDER_REVIEW,
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
    STATUS.REJECTED,
    STATUS.SAFETY_REVIEW,
    STATUS.CANCELLED,
  ]),
  [STATUS.SAFETY_REVIEW]: Object.freeze([
    STATUS.SAFETY_APPROVED,
    STATUS.APPROVED,
    STATUS.CANCELLED,
  ]),
  [STATUS.SAFETY_APPROVED]: Object.freeze([
    STATUS.CONFIRMED,
    STATUS.APPROVED,
    STATUS.CANCELLED,
  ]),
  [STATUS.CONFIRMED]: Object.freeze([
    STATUS.APPROVED,
    STATUS.COMPLETED,
    STATUS.CANCELLED,
  ]),
  [STATUS.COMPLETED]: Object.freeze([]),
  [STATUS.REJECTED]: Object.freeze([
    STATUS.DRAFT,
  ]),
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
 *  - approved, confirmed, completed, rejected and cancelled are out
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


/**
 * The label an Organiser sees for a status, for places that show only the
 * words and not the whole display.
 *
 * SCRUM-323. Reads through getStatusDisplay, so it follows SCRUM-47's
 * convention rather than inventing its own: a status this build does not know
 * is "Unknown Status", and nothing usable is "Status Unavailable". It never
 * returns undefined and never echoes an internal name it does not recognise.
 *
 * @param {string} status
 * @returns {string}
 */
export function getOrganiserStatusLabel(status) {
  return getStatusDisplay(status).label;
}
