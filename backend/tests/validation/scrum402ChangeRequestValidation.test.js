import { describe, expect, it } from 'vitest';
import {
  DECISION_NOTES_MAX_LENGTH,
  MAX_CHANGES_PER_REQUEST,
  validateCreateChangeRequest,
  validateProcessChangeRequest,
} from '../../src/validation/eventChangeRequestValidation.js';
import { ValidationError } from '../../src/errors.js';

const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const CHANGE_ID = '44444444-4444-4444-8444-444444444444';

const faultsOf = (fn) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    return err.details.map((d) => d.field);
  }
  throw new Error('expected a refusal');
};

describe('SCRUM-402 change request validation', () => {
  it('SCRUM402_AC1_a_group_comes_back_normalised_and_the_single_shape_as_it_always_did', () => {
    expect(validateCreateChangeRequest({
      eventRequestId: EVENT_ID,
      changes: [{ changeField: 'purpose', requestedChange: '  Alumni networking  ' }, { changeField: 'expected_attendance', requestedChange: '150' }],
    })).toEqual({
      eventRequestId: EVENT_ID,
      changes: [{ changeField: 'purpose', requestedChange: 'Alumni networking' }, { changeField: 'expected_attendance', requestedChange: '150' }],
    });
    expect(validateCreateChangeRequest({ eventRequestId: EVENT_ID, changeField: 'purpose', requestedChange: 'New' }))
      .toEqual({ eventRequestId: EVENT_ID, changeField: 'purpose', requestedChange: 'New' });
    expect(MAX_CHANGES_PER_REQUEST).toBe(9);
  });

  it('SCRUM402_AC1_every_fault_in_a_group_is_named_by_its_row', () => {
    expect(faultsOf(() => validateCreateChangeRequest({
      eventRequestId: EVENT_ID,
      changes: [null, { changeField: 'expected_attendance', requestedChange: 'many' }, { changeField: 'expected_attendance', requestedChange: '5' }],
    }))).toEqual(expect.arrayContaining([
      'changes[0].changeField', 'changes[0].requestedChange', 'changes[1].requestedChange', 'changes[2].changeField',
    ]));
    expect(faultsOf(() => validateCreateChangeRequest({ eventRequestId: EVENT_ID, changes: 'purpose' }))).toEqual(['changes']);
    expect(faultsOf(() => validateCreateChangeRequest({
      eventRequestId: EVENT_ID,
      changes: [{ changeField: 'cancellation', requestedChange: 'Called off' }, { changeField: 'other', requestedChange: 'And this' }],
    }))).toEqual(['changes']);
  });

  it('SCRUM402_AC3_a_note_is_at_most_2000_characters_counted_as_the_database_counts', () => {
    const at = '😀'.repeat(DECISION_NOTES_MAX_LENGTH);
    expect(validateProcessChangeRequest({ changeRequestId: CHANGE_ID, decision: 'rejected', decisionNotes: at }).decisionNotes).toBe(at);
    expect(faultsOf(() => validateProcessChangeRequest({ changeRequestId: CHANGE_ID, decision: 'rejected', decisionNotes: `${at}x` })))
      .toEqual(['decisionNotes']);
  });

  it('SCRUM402_AC4_the_expected_impact_is_passed_only_when_it_is_an_object', () => {
    const impact = { statusAfter: 'approved' };
    expect(validateProcessChangeRequest({ changeRequestId: CHANGE_ID, decision: 'approved', expectedImpact: impact }))
      .toEqual({ changeRequestId: CHANGE_ID, decision: 'approved', decisionNotes: null, expectedImpact: impact });
    expect(validateProcessChangeRequest({ changeRequestId: CHANGE_ID, decision: 'approved', expectedImpact: null }))
      .not.toHaveProperty('expectedImpact');
    expect(faultsOf(() => validateProcessChangeRequest({ changeRequestId: CHANGE_ID, decision: 'approved', expectedImpact: [] })))
      .toEqual(['expectedImpact']);
  });
});
