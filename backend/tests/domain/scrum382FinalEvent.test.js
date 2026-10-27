/**
 * SCRUM-382 (SCRUM-379 AC3): the shared "is this event final?" check.
 *
 * Pure: no database, no clock. The routes that use it are covered in
 * tests/routes/scrum382FinalEventRoutes.test.js and the guard itself, against
 * a real schema, in tests/middleware/scrum382FinalEventGuard.test.js.
 */
import { describe, it, expect } from 'vitest';

import {
  FINAL_EVENT_STATUSES,
  EVENT_FINAL_CODE,
  isFinalEventStatus,
  finalEventMessage,
  assertEventNotFinal,
} from '../../src/domain/finalEvent.js';
import { STATUS, ALLOWED_TRANSITIONS } from '../../src/domain/eventRequestStatus.js';
import { ConflictError } from '../../src/errors.js';

describe('SCRUM-382: isFinalEventStatus', () => {
  const finalStatuses = [STATUS.COMPLETED, STATUS.CANCELLED];
  const liveStatuses = Object.values(STATUS).filter((status) => !finalStatuses.includes(status));

  it.each(finalStatuses)('SCRUM382_AC3_%s_is_final', (status) => {
    expect(isFinalEventStatus(status)).toBe(true);
  });

  it.each(liveStatuses)('SCRUM382_AC3_%s_is_not_final', (status) => {
    expect(isFinalEventStatus(status)).toBe(false);
  });

  it('SCRUM382_AC3_every_status_is_classified_and_there_are_exactly_two_final_ones', () => {
    expect(Object.values(STATUS)).toHaveLength(11);
    expect(finalStatuses).toHaveLength(2);
    expect(liveStatuses).toHaveLength(9);
    expect(Object.values(STATUS).filter(isFinalEventStatus).sort()).toEqual(['cancelled', 'completed']);
  });

  it('SCRUM382_AC3_final_means_nothing_leads_out_of_the_status', () => {
    // If a status is ever added that nothing leads out of, or a final one gains a way out,
    // this fails and the guard has to be reconsidered with the transition table.
    const deadEnds = Object.entries(ALLOWED_TRANSITIONS)
      .filter(([, targets]) => targets.length === 0)
      .map(([status]) => status)
      .sort();
    expect(deadEnds).toEqual([...FINAL_EVENT_STATUSES].sort());
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['whitespace', ' '],
    ['a number', 1],
    ['an object', {}],
    ['an array holding a final status', ['completed']],
    ['a status this code has never heard of', 'archived'],
    ['Completed with a capital', 'Completed'],
    ['COMPLETED in capitals (a status group, not a status)', 'COMPLETED'],
    ['cancelled with trailing space', 'cancelled '],
  ])('SCRUM382_AC3_%s_is_not_final, so the guard never refuses what it cannot read', (_label, value) => {
    expect(isFinalEventStatus(value)).toBe(false);
  });

  it('SCRUM382_AC3_the_list_of_final_statuses_cannot_be_changed_by_a_caller', () => {
    expect(Object.isFrozen(FINAL_EVENT_STATUSES)).toBe(true);
    expect(() => FINAL_EVENT_STATUSES.push('approved')).toThrow(TypeError);
    expect(isFinalEventStatus('approved')).toBe(false);
  });
});

describe('SCRUM-382: the refusal', () => {
  it('SCRUM382_AC3_the_message_for_a_completed_event', () => {
    expect(finalEventMessage(STATUS.COMPLETED)).toBe('This event is completed and can no longer be changed');
  });

  it('SCRUM382_AC3_the_message_for_a_cancelled_event', () => {
    expect(finalEventMessage(STATUS.CANCELLED)).toBe('This event is cancelled and can no longer be changed');
  });

  it.each([STATUS.COMPLETED, STATUS.CANCELLED])('SCRUM382_AC3_assertEventNotFinal_throws_a_409_for_%s', (status) => {
    let thrown;
    try {
      assertEventNotFinal(status);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConflictError);
    expect(thrown.status).toBe(409);
    expect(thrown.code).toBe('EVENT_FINAL');
    expect(thrown.code).toBe(EVENT_FINAL_CODE);
    expect(thrown.conflicts).toEqual([]);
    expect(thrown.message).toBe(finalEventMessage(status));
  });

  it.each(Object.values(STATUS).filter((status) => status !== 'completed' && status !== 'cancelled'))(
    'SCRUM382_AC3_assertEventNotFinal_returns_normally_for_%s',
    (status) => {
      expect(assertEventNotFinal(status)).toBeUndefined();
    },
  );

  it.each([null, undefined, '', 'archived'])(
    'SCRUM382_AC3_assertEventNotFinal_does_not_throw_for_%s',
    (value) => {
      expect(() => assertEventNotFinal(value)).not.toThrow();
    },
  );

  it('SCRUM382_AC3_the_message_names_the_status_and_never_the_other_one', () => {
    expect(finalEventMessage(STATUS.COMPLETED)).not.toMatch(/cancelled/);
    expect(finalEventMessage(STATUS.CANCELLED)).not.toMatch(/completed/);
  });
});
