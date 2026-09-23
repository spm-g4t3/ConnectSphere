/**
 * Typed errors shared by the service layer.
 *
 * Each carries an HTTP status so that Express, once it exists, can map any
 * service error to a response in one place rather than every route inventing
 * its own translation.
 */

export class AppError extends Error {
  constructor(message, status) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
  }
}

/**
 * Input the database or the domain rules refused.
 *
 * `details` lists every problem found, as [{ field, message }], so a caller
 * can fix a whole form in one pass instead of resubmitting to discover the
 * next fault. It defaults to [] for errors that are not field-specific.
 */
export class ValidationError extends AppError {
  constructor(message, details = []) {
    super(message, 400);
    this.details = details;
  }
}

/** The requested record does not exist. */
export class NotFoundError extends AppError {
  constructor(message) {
    super(message, 404);
  }
}

/**
 * The request conflicts with data already stored.
 *
 * SCRUM-126 added the options. `code` is a machine-readable reason, such as
 * VENUE_RETIRED, BLOCK_OVERLAPS_BLOCK or BLOCK_BOOKING_CONFLICT, so a client
 * can react to one kind of conflict without matching on prose. `conflicts`
 * lists the records that clashed. Both are optional, so every one-argument
 * caller is unaffected.
 *
 * `conflicts` takes one of two shapes, depending on `code`:
 *
 *  - BLOCK_OVERLAPS_BLOCK: [{ blockId }], the other active block the period
 *    overlaps -- or [] when the database did not name it (the 23P01 race).
 *  - BLOCK_BOOKING_CONFLICT (SCRUM-125): the approved bookings the period
 *    overlaps, as [{ bookingId, eventRequestId, eventName, startsAt, endsAt }].
 *    The caller may resend with confirmOverride and those booking ids to
 *    override them.
 *
 * Every other code carries [].
 *
 * `conflicts` rather than `details` on purpose: `details` means field faults
 * and only ValidationError carries it, which errors.test.js asserts.
 *
 * Note for SCRUM-127: handleError must serialise `code` and `conflicts` too,
 * or a client never sees them.
 */
export class ConflictError extends AppError {
  constructor(message, { code = null, conflicts = [] } = {}) {
    super(message, 409);
    this.code = code;
    this.conflicts = conflicts;
  }
}

/**
 * The caller is not signed in, or their token is no longer good.
 *
 * SCRUM-42. Added alongside the other three so a 401 has a home in the same
 * taxonomy, even though requireAuth currently answers directly rather than
 * throwing -- there is no app-level error handler for it to throw into yet.
 *
 * There is deliberately no ForbiddenError. Asking for a request that belongs
 * to another Organiser answers 404, not 403, because a 403 would confirm the
 * id exists and turn the endpoint into an enumeration oracle over a table
 * whose row level security is deny-all precisely so the API can be the gate.
 */
export class UnauthorizedError extends AppError {
  constructor(message) {
    super(message, 401);
  }
}
