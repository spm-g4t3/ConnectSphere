/**
 * Tests for the shared Postgres error translator.
 *
 * Each service's own tests pin its mapping end to end; these pin the parts
 * they all lean on: the order code, message, fallback, and each handler kind.
 */

import { describe, it, expect } from 'vitest';

import {
  createPgTranslator,
  forCodes,
  rejected,
  invalid,
  forbidden,
  missingReference,
  untyped,
  notFound,
  conflict,
  hintConflict,
} from '../../src/http/pgErrors.js';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  ForbiddenError,
} from '../../src/errors.js';

const UUID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('createPgTranslator', () => {
  it('returns null for no error', () => {
    expect(createPgTranslator()(null)).toBeNull();
  });

  it('leaves an unlisted code untyped, with the message or a fixed one', () => {
    const translate = createPgTranslator();

    const withMessage = translate({ code: '42P01', message: 'relation missing' });
    expect(withMessage.constructor).toBe(Error);
    expect(withMessage.message).toBe('relation missing');
    expect(translate({ code: '42P01' }).message).toBe('Unexpected database error');
  });

  it('passes the message, defaulting to empty, and the raw error to the handler', () => {
    const seen = [];
    const translate = createPgTranslator({
      codes: { '22023': (detail, error) => seen.push([detail, error]) },
    });
    const error = { code: '22023', hint: 'H' };

    translate(error);

    expect(seen).toEqual([['', error]]);
  });

  it('uses missingMessage when the error has no message', () => {
    const translate = createPgTranslator({
      missingMessage: 'Unexpected database error',
      codes: { P0002: (message) => new NotFoundError(message) },
      fallback: (message) => new Error(message),
    });

    expect(translate({ code: 'P0002' }).message).toBe('Unexpected database error');
    // An empty message is kept: only a missing one is replaced.
    expect(translate({ code: 'XX000', message: '' }).message).toBe('');
  });

  it('lets the code decide before any message pattern', () => {
    const translate = createPgTranslator({
      codes: { '23514': rejected },
      messages: [[/not found/i, notFound('Gone')]],
    });

    expect(translate({ code: '23514', message: 'row not found' })).toBeInstanceOf(ValidationError);
    expect(translate({ code: 'XX000', message: 'row not found' })).toBeInstanceOf(NotFoundError);
  });

  it('tries message patterns in order, then the fallback', () => {
    const translate = createPgTranslator({
      messages: [
        [/not found/i, notFound('Gone')],
        [/already been processed/i, invalid],
      ],
      fallback: (detail, error) => new ConflictError(detail, { code: error.hint }),
    });

    expect(translate({ message: 'not found and already been processed' })).toBeInstanceOf(NotFoundError);
    expect(translate({ message: 'already been processed' })).toBeInstanceOf(ValidationError);

    const fallen = translate({ code: 'PT409', message: 'other', hint: 'H' });
    expect(fallen).toBeInstanceOf(ConflictError);
    expect(fallen.code).toBe('H');
  });

  it('never treats an inherited property name as a listed code', () => {
    const translate = createPgTranslator();

    expect(translate({ code: 'constructor', message: 'odd' }).constructor).toBe(Error);
  });
});

describe('handlers', () => {
  it('rejected wraps the driver message; invalid passes it through', () => {
    expect(rejected('bad')).toEqual(new ValidationError('A value was rejected by the database: bad'));
    expect(invalid('bad').message).toBe('bad');
    expect(invalid('bad').details).toEqual([]);
  });

  it('missingReference and forbidden', () => {
    expect(missingReference('fk').message).toBe('A referenced record does not exist: fk');
    expect(forbidden('no')).toBeInstanceOf(ForbiddenError);
    expect(forbidden('no').message).toBe('no');
  });

  it('untyped is a plain Error, never a typed one', () => {
    expect(untyped('').constructor).toBe(Error);
    expect(untyped('').message).toBe('Unexpected database error');
  });

  it('notFound uses its own message only when the error has none', () => {
    const handler = notFound('Venue not found');

    expect(handler('').message).toBe('Venue not found');
    expect(handler('Venue 1 not found').message).toBe('Venue 1 not found');
  });

  it('conflict carries its code, or null, and no conflicts', () => {
    expect(conflict('BOOKING_CHANGED')('changed')).toMatchObject({
      message: 'changed', code: 'BOOKING_CHANGED', conflicts: [],
    });
    expect(conflict()('changed').code).toBeNull();
  });

  it('forCodes maps every code to the one handler', () => {
    expect(forCodes(new Set(['22023', '22P02']), invalid)).toEqual({ '22023': invalid, '22P02': invalid });
  });
});

describe('hintConflict', () => {
  const handler = hintConflict({ HOLD_EXISTS: (holdId) => ({ kind: 'hold', holdId }) });

  it('makes the hint the code and the uuid in details the conflict list', () => {
    const err = handler('exists', { hint: 'HOLD_EXISTS', details: ` ${UUID} ` });

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toBe('exists');
    expect(err.code).toBe('HOLD_EXISTS');
    expect(err.conflicts).toEqual([{ kind: 'hold', holdId: UUID }]);
  });

  it('trusts only a uuid in details', () => {
    expect(handler('x', { hint: 'HOLD_EXISTS', details: 'not-an-id' }).conflicts).toEqual([]);
    expect(handler('x', { hint: 'HOLD_EXISTS', details: { id: UUID } }).conflicts).toEqual([]);
  });

  it('lists nothing for a hint it was not given, or no hint', () => {
    const other = handler('x', { hint: 'VENUE_RETIRED', details: UUID });
    expect(other.code).toBe('VENUE_RETIRED');
    expect(other.conflicts).toEqual([]);

    const none = handler('x', { details: UUID });
    expect(none.code).toBeNull();
    expect(none.conflicts).toEqual([]);
  });

  it('with no hints at all, still carries the hint as the code', () => {
    const err = hintConflict()('refused', { hint: 'BOOKING_NOT_FLAGGED', details: UUID });

    expect(err.code).toBe('BOOKING_NOT_FLAGGED');
    expect(err.conflicts).toEqual([]);
  });

  it('never calls an inherited property as a conflict builder', () => {
    expect(handler('x', { hint: 'constructor', details: UUID }).conflicts).toEqual([]);
  });
});
