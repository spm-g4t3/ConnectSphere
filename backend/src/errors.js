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

/** Input the database or the domain rules refused. */
export class ValidationError extends AppError {
  constructor(message) {
    super(message, 400);
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
