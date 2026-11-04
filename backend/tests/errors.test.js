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
  ForbiddenError,
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
  // SCRUM-331. In the table for the same reason as the line above: it gets
  // every check the others get. Why it exists at all, when errors.js has said
  // there would be none, is argued in the hierarchy block below.
  { name: 'ForbiddenError', Err: ForbiddenError, status: 403 },
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

  it('keeps "you may not" apart from "there is no such thing"', () => {
    // SCRUM-327 AC6: only the event's assigned coordinator may hand it over.
    // When anyone else tries, the answer is 403.
    //
    // errors.js has deliberately had no ForbiddenError until now, and its
    // reason still holds where it was given. An Organiser who asks for another
    // Organiser's request gets 404, not 403, because a 403 would confirm the
    // id exists and turn the endpoint into a way of discovering which ids are
    // real. That reasoning applies to a caller who should not know the event
    // exists.
    //
    // It does not apply to a handover. Only Event Coordinators can reach the
    // reassign route at all (coordinatorOnly), and every coordinator already
    // sees every queued event in the shared review queue (SCRUM-45). A 403
    // tells a coordinator nothing about which ids exist that the queue has not
    // already shown them. What it does tell them is the true reason: the event
    // exists, and it is not theirs to hand on. A 404 there would be a false
    // answer, protecting nothing.
    //
    // So the two stay separate types. A catch written for a missing request
    // must not swallow a refusal, or the route would answer "not found" for an
    // event the coordinator can see in their own queue.
    expect(new ForbiddenError('x')).not.toBeInstanceOf(NotFoundError);
    expect(new NotFoundError('x')).not.toBeInstanceOf(ForbiddenError);
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
    expect(new ForbiddenError('x').details).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------
// SCRUM-126: a conflict can say which kind it is, and what it clashed with
// ---------------------------------------------------------------------------
describe('ConflictError code and conflicts', () => {
  it('defaults code to null and conflicts to [] for a one-argument caller', () => {
    const err = new ConflictError('venue is retired');

    expect(err.code).toBeNull();
    expect(err.conflicts).toEqual([]);
    expect(err.message).toBe('venue is retired');
  });

  it('keeps the code and conflicts it was given', () => {
    const conflicts = [{ id: 'b1' }, { id: 'b2' }];
    const err = new ConflictError('overlaps', { code: 'BLOCK_OVERLAPS_BLOCK', conflicts });

    expect(err.code).toBe('BLOCK_OVERLAPS_BLOCK');
    expect(err.conflicts).toEqual(conflicts);
  });

  it('defaults whichever option is left out', () => {
    expect(new ConflictError('x', { code: 'VENUE_RETIRED' }).conflicts).toEqual([]);
    expect(new ConflictError('x', { conflicts: [{ id: 'b1' }] }).code).toBeNull();
  });

  it('still answers 409 and carries no details when given options', () => {
    const err = new ConflictError('x', { code: 'VENUE_RETIRED', conflicts: [{ id: 'b1' }] });

    expect(err.status).toBe(409);
    expect(err.details).toBeUndefined();
    expect(err.name).toBe('ConflictError');
  });
});
