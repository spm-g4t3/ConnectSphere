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

/** The request conflicts with data already stored. */
export class ConflictError extends AppError {
  constructor(message) {
    super(message, 409);
  }
}

/**
 * ConnectSphere cannot do this right now, but may be able to later.
 *
 * SCRUM-330, for SCRUM-327 AC5: an event request is submitted, and there is no
 * Event Coordinator to assign it to. The request is valid and the caller did
 * nothing wrong, so it is not a 400. Nothing about the request conflicts with
 * stored data, so it is not a 409 either; a 409 would tell the caller to
 * reload and reconsider, which would not help. Retrying later may succeed,
 * which is what 503 means and what the AC's own message tells the Organiser.
 * Having its own status is what lets the frontend show "try again later"
 * rather than "fix your input".
 */
export class ServiceUnavailableError extends AppError {
  constructor(message) {
    super(message, 503);
  }
}

/**
 * The caller is not signed in, or their token is no longer good.
 *
 * SCRUM-42. Added alongside the other three so a 401 has a home in the same
 * taxonomy, even though requireAuth currently answers directly rather than
 * throwing -- there is no app-level error handler for it to throw into yet.
 *
 * Asking for a request that belongs to another Organiser answers 404, not
 * 403, because a 403 would confirm the id exists and turn the endpoint into
 * an enumeration oracle over a table whose row level security is deny-all
 * precisely so the API can be the gate. That still holds for every Organiser
 * route. ForbiddenError below exists for the one case where it does not.
 */
export class UnauthorizedError extends AppError {
  constructor(message) {
    super(message, 401);
  }
}

/**
 * The caller may not do this to a record they are allowed to know exists.
 *
 * SCRUM-331, for SCRUM-327 AC6: only an event's assigned coordinator may hand
 * it to a colleague. This file used to say there would be no ForbiddenError,
 * because a 403 confirms an id exists. That reasoning is about a caller who
 * should not learn that, such as an Organiser probing for someone else's
 * request, and for them the answer stays 404.
 *
 * A coordinator is not that caller. Every Event Coordinator already sees every
 * queued event in the shared review queue (SCRUM-45), so a 403 tells them
 * nothing about which ids exist that they did not already know. What it tells
 * them is the true reason: the event exists, and it is not theirs to hand
 * over. A 404 there would be a false answer protecting nothing.
 *
 * So use this only where the caller can already see the record. Anywhere the
 * existence of a record is itself the secret, keep answering 404.
 */
export class ForbiddenError extends AppError {
  constructor(message) {
    super(message, 403);
  }
}
