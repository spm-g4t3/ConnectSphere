import { describe, expect, it } from 'vitest';
import { validateEventDetailsEdit } from '../../src/validation/eventRequestValidation.js';
import { ValidationError } from '../../src/errors.js';

const NOW = new Date('2026-10-18T10:00:00Z');

const faultsOf = (body) => {
  try {
    validateEventDetailsEdit(body, { now: NOW });
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    return err.details;
  }
  throw new Error('expected the body to be refused');
};

describe('SCRUM-387 event details edit validation', () => {
  it('SCRUM387_AC6_returns_the_changes_normalised_and_the_reason_trimmed', () => {
    expect(validateEventDetailsEdit({
      changes: { eventName: '  Planning forum  ', expectedAttendance: 80, description: null },
      expected: { eventName: 'Forum', expectedAttendance: 60, description: 'Annual' },
      reason: '  Asked by the Organiser  ',
    }, { now: NOW })).toEqual({
      changes: { eventName: 'Planning forum', expectedAttendance: 80, description: null },
      expected: { eventName: 'Forum', expectedAttendance: 60, description: 'Annual' },
      reason: 'Asked by the Organiser',
    });
  });

  it('SCRUM387_AC6_lists_every_fault_together', () => {
    const fields = faultsOf({
      changes: { eventName: '', venue: 'Hall B', proposedStart: '2026-01-01T09:00:00Z', expectedAttendance: 0 },
      expected: { eventName: 'Forum', expectedAttendance: 'sixty' },
      reason: '   ',
    }).map((fault) => fault.field);

    expect(fields).toEqual(expect.arrayContaining([
      'reason', 'venue', 'eventName', 'proposedStart', 'expectedAttendance',
      'expected.proposedStart', 'expected.expectedAttendance',
    ]));
  });

  it('SCRUM387_AC6_a_field_submission_requires_cannot_be_cleared', () => {
    expect(faultsOf({ changes: { eventName: null }, expected: { eventName: 'Forum' }, reason: 'Why' }))
      .toEqual([expect.objectContaining({ field: 'eventName' })]);
  });

  it('SCRUM387_AC6_an_end_before_a_start_sent_with_it_is_refused', () => {
    const faults = faultsOf({
      changes: { proposedStart: '2027-04-01T11:00:00+08:00', proposedEnd: '2027-04-01T09:00:00+08:00' },
      expected: { proposedStart: null, proposedEnd: null },
      reason: 'Why',
    });

    expect(faults.map((fault) => fault.field)).toContain('proposedEnd');
  });

  it.each([
    ['no_changes_object', { expected: {}, reason: 'Why' }, 'changes'],
    ['an_empty_changes_object', { changes: {}, expected: {}, reason: 'Why' }, 'changes'],
    ['no_expected_object', { changes: { purpose: 'New' }, reason: 'Why' }, 'expected'],
    ['a_reason_over_4000_characters', { changes: { purpose: 'New' }, expected: { purpose: 'Old' }, reason: 'é'.repeat(4001) }, 'reason'],
  ])('SCRUM387_AC6_%s_is_refused', (_label, body, field) => {
    expect(faultsOf(body).map((fault) => fault.field)).toContain(field);
  });

  it('SCRUM387_AC9_each_expected_value_is_checked_as_its_field_is_typed', () => {
    expect(validateEventDetailsEdit({
      changes: { proposedStart: '2027-04-01T10:00:00+08:00' },
      expected: { proposedStart: ' 2027-04-01T09:00:00+08:00 ' },
      reason: 'Why',
    }, { now: NOW }).expected).toEqual({ proposedStart: '2027-04-01T09:00:00+08:00' });

    expect(faultsOf({
      changes: { proposedStart: '2027-04-01T10:00:00+08:00', purpose: 'New' },
      expected: { proposedStart: 'next Tuesday', purpose: 42 },
      reason: 'Why',
    }).map((fault) => fault.field)).toEqual(['expected.proposedStart', 'expected.purpose']);
  });

  it('SCRUM387_AC6_a_reason_that_is_not_text_is_refused', () => {
    expect(faultsOf({ changes: { purpose: 'New' }, expected: { purpose: 'Old' }, reason: 42 }))
      .toEqual([expect.objectContaining({ field: 'reason' })]);
  });

  it('SCRUM387_AC6_a_reason_of_exactly_4000_characters_is_accepted', () => {
    const reason = '😀'.repeat(4000);

    expect(validateEventDetailsEdit(
      { changes: { purpose: 'New' }, expected: { purpose: 'Old' }, reason }, { now: NOW },
    ).reason).toBe(reason);
  });
});
