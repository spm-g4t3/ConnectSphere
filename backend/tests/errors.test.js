/**
 * Tests for the typed errors shared by the service layer.
 *
 * These carry the HTTP status Express will map a service failure to, in one
 * place rather than every route inventing its own translation. That contract
 * is what is asserted here: nothing else in the suite checks it directly, and
 * a wrong status would surface as a wrong response long after the change.
 *
 * Describe blocks are named after the behaviour they pin down, so a
 * requirement traces to the test proving it.
 */

import { describe, it, expect } from 'vitest';

import {
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
  ServiceUnavailableError,
} from '../src/errors.js';

/**
 * Every concrete error, with the status Express must send for it.
 *
 * Objects rather than tuples so the titles can name fields ($name, $status)
 * instead of relying on positional printf placeholders, which silently print
 * the wrong element when the shape changes.
 */
const TYPED_ERRORS = [
  { name: 'ValidationError', Err: ValidationError, status: 400 },
  { name: 'NotFoundError', Err: NotFoundError, status: 404 },
  { name: 'ConflictError', Err: ConflictError, status: 409 },
  // SCRUM-330. Added to the same table rather than given tests of its own, so it
  // gets every check the other three get: status, message, hierarchy, name and
  // stack. The reason it exists is in the hierarchy block below.
  { name: 'ServiceUnavailableError', Err: ServiceUnavailableError, status: 503 },
];


// ---------------------------------------------------------------------------
// The status is the whole point of these classes
// ---------------------------------------------------------------------------
describe('each error carries the status Express should send', () => {
  it.each(TYPED_ERRORS)('$name reports $status', ({ Err, status }) => {
    expect(new Err('something went wrong').status).toBe(status);
  });

  it('lets AppError carry any status a future error needs', () => {
    expect(new AppError('teapot', 418).status).toBe(418);
  });

  it.each(TYPED_ERRORS)('$name keeps the message it was given', ({ Err }) => {
    expect(new Err('venue 42 not found').message).toBe('venue 42 not found');
  });
});


// ---------------------------------------------------------------------------
// One catch block has to be able to handle all of them
// ---------------------------------------------------------------------------
describe('the error hierarchy', () => {
  it.each(TYPED_ERRORS)('$name is an AppError', ({ Err }) => {
    expect(new Err('x')).toBeInstanceOf(AppError);
  });

  it.each(TYPED_ERRORS)('$name is still an Error', ({ Err }) => {
    // So it survives anything that only understands built-in errors --
    // console.error, a test runner's diff, an unhandled rejection handler.
    expect(new Err('x')).toBeInstanceOf(Error);
  });

  it.each(TYPED_ERRORS)('$name names itself, rather than reporting "Error"', ({ name, Err }) => {
    // errors.js sets this.name from the constructor, so a log line says which
    // kind of failure it was without anyone having to inspect the status.
    expect(new Err('x').name).toBe(name);
  });

  it.each(TYPED_ERRORS)('$name produces a usable stack trace', ({ Err }) => {
    expect(typeof new Err('x').stack).toBe('string');
  });

  it('distinguishes the types from each other', () => {
    // A catch that wants only one of them must not accidentally match another.
    expect(new NotFoundError('x')).not.toBeInstanceOf(ValidationError);
    expect(new ConflictError('x')).not.toBeInstanceOf(NotFoundError);
  });

  it('keeps "nobody is available" apart from "conflicts with the current state"', () => {
    // SCRUM-327 AC5. When no Event Coordinator can be assigned, the request
    // was valid and the Organiser did nothing wrong. Trying again later may
    // succeed, and the AC's own message tells them to. 409 would say the
    // request conflicts with its current state, and 400 would say to fix the
    // input; neither is true. 503 is what lets the frontend show "try again
    // later" rather than "fix your form", and the message only makes sense if
    // the status agrees with it. A catch written for ConflictError must
    // therefore not swallow this one.
    expect(new ServiceUnavailableError('x')).not.toBeInstanceOf(ConflictError);
    expect(new ServiceUnavailableError('x')).not.toBeInstanceOf(ValidationError);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-94: a form is reported whole, not one fault at a time
// ---------------------------------------------------------------------------
describe('ValidationError details', () => {
  it('defaults to an empty array for a problem that is not field-specific', () => {
    // So a caller can always map over details without checking it exists.
    expect(new ValidationError('expected an object').details).toEqual([]);
  });

  it('keeps every problem it was given, in order', () => {
    const details = [
      { field: 'name', message: 'is required' },
      { field: 'maxCapacity', message: 'must be greater than zero' },
    ];

    expect(new ValidationError('two faults', details).details).toEqual(details);
  });

  it('carries the field and message a form needs to mark its inputs', () => {
    const err = new ValidationError('one fault', [{ field: 'location', message: 'cannot be blank' }]);

    expect(err.details[0]).toEqual({ field: 'location', message: 'cannot be blank' });
  });

  it('is the only one of the typed errors that carries details', () => {
    expect(new NotFoundError('x').details).toBeUndefined();
    expect(new ConflictError('x').details).toBeUndefined();
    expect(new ServiceUnavailableError('x').details).toBeUndefined();
  });
});
