/**
 * Tests for the shared HTTP error handler.
 *
 * SCRUM-127 (part of SCRUM-17). The venue block routes answer ConflictErrors
 * whose code and conflicts a client acts on, so the response shape of every
 * typed error is pinned here, and a 500 is shown not to leak its cause.
 *
 * No Express app is needed: the handler only calls res.status(...).json(...),
 * so a recording stand-in for res is enough.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import { createErrorHandler } from '../../src/http/handleError.js';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  UnauthorizedError,
} from '../../src/errors.js';

/** A res that records the status and body it was given. */
function fakeRes() {
  const res = { statusCode: null, body: undefined };
  res.status = vi.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body) => {
    res.body = body;
    return res;
  });
  return res;
}

const handleError = createErrorHandler('test route');

function respond(err) {
  const res = fakeRes();
  const returned = handleError(err, res);
  return { res, returned };
}

afterEach(() => {
  vi.restoreAllMocks();
});


describe('typed errors', () => {
  it('SCRUM17_AC1_ValidationError_is_400_with_error_and_details', () => {
    const details = [{ field: 'endsAt', message: 'must be in the future' }];
    const { res } = respond(new ValidationError('Invalid venue block details', details));
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid venue block details', details });
  });

  it('a ValidationError with no details still sends details []', () => {
    const { res } = respond(new ValidationError('A value was rejected by the database'));
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'A value was rejected by the database', details: [] });
  });

  it('SCRUM17_AC4_NotFoundError_is_404_with_exactly_error', () => {
    const { res } = respond(new NotFoundError('Block not found'));
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Block not found' });
    expect(res.body).not.toHaveProperty('code');
    expect(res.body).not.toHaveProperty('conflicts');
    expect(res.body).not.toHaveProperty('details');
  });

  it('SCRUM17_AC3_ConflictError_is_409_with_error_code_and_conflicts', () => {
    const conflicts = [{ bookingId: 'b1', eventRequestId: 'e1', eventName: 'X', startsAt: 's', endsAt: 'e' }];
    const { res } = respond(
      new ConflictError('This period overlaps approved bookings', {
        code: 'BLOCK_BOOKING_CONFLICT',
        conflicts,
      }),
    );
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: 'This period overlaps approved bookings',
      code: 'BLOCK_BOOKING_CONFLICT',
      conflicts,
    });
  });

  it('SCRUM17_AC4_one_argument_ConflictError_sends_code_null_and_conflicts_empty', () => {
    const { res } = respond(new ConflictError('Venue is already retired'));
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'Venue is already retired', code: null, conflicts: [] });
  });

  it('a stray code on a non-conflict typed error never reaches the client', () => {
    const err = new NotFoundError('gone');
    err.code = 'P0002';
    const { res } = respond(err);
    expect(res.body).toEqual({ error: 'gone' });
  });

  it('uses the status the error carries', () => {
    const { res } = respond(new UnauthorizedError('Authentication required'));
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
  });

  it('does not log a typed error', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    respond(new ConflictError('x', { code: 'BLOCK_REMOVED' }));
    expect(consoleError).not.toHaveBeenCalled();
  });
});


describe('untyped errors', () => {
  it('SCRUM17_AC4_is_500_without_leaking_the_message_and_logs_the_context', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('relation "venue_blocks" does not exist');
    err.code = '42P01';

    const { res } = respond(err);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Unexpected server error' });
    expect(JSON.stringify(res.body)).not.toMatch(/venue_blocks|42P01/);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith('Unexpected error in test route:', err);
  });

  it('each handler logs its own context label', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    createErrorHandler('venues route')(new Error('boom'), fakeRes());
    expect(consoleError.mock.calls[0][0]).toBe('Unexpected error in venues route:');
  });

  it('a non-Error throw is also a 500', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { res } = respond('just a string');
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Unexpected server error' });
  });
});


describe('ConflictError fallbacks (SCRUM-132)', () => {
  it('a ConflictError whose conflicts were explicitly null still sends conflicts []', () => {
    // The constructor's default only covers undefined; null passes straight
    // through, and a client must still be able to map over the key.
    const { res } = respond(new ConflictError('Venue is already retired', { code: 'X', conflicts: null }));
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'Venue is already retired', code: 'X', conflicts: [] });
  });
});
