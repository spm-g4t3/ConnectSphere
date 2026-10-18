import { describe, expect, it } from 'vitest';
import {
  validateSignificantEventChange,
} from '../../src/validation/eventRequestValidation.js';

const NOW = new Date('2026-10-18T10:00:00Z');
const CURRENT = {
  eventName: 'Planning forum',
  purpose: 'Coordinate service delivery',
  description: 'Annual planning',
  proposedStart: '2027-04-01T09:00:00+08:00',
  proposedEnd: '2027-04-01T11:00:00+08:00',
  expectedAttendance: 60,
  venueRequirements: 'Lecture room',
  accessibilityRequirements: 'Step-free access',
  equipmentRequirements: 'Projector',
};

describe('SCRUM-395 significant-change validation', () => {
  it('SCRUM395_AC2_reuses_event_field_rules_and_returns_normalised_changes', () => {
    expect(validateSignificantEventChange({
      proposedStart: '2027-04-01T10:00:00+08:00',
      venueRequirements: '  Seminar room  ',
    }, CURRENT, { now: NOW })).toEqual({
      proposedStart: '2027-04-01T10:00:00+08:00',
      venueRequirements: 'Seminar room',
    });
  });

  it('SCRUM395_AC2_validates_the_merged_event_with_submission_requirements', () => {
    expect(() => validateSignificantEventChange({
      proposedEnd: '2027-03-30T11:00:00+08:00',
    }, CURRENT, { now: NOW })).toThrow(/later than the proposed start/i);

    expect(() => validateSignificantEventChange({
      proposedStart: '2026-10-17T10:00:00Z',
    }, CURRENT, { now: NOW })).toThrow(/in the future/i);
  });

  it('SCRUM395_AC2_rejects_missing_and_invalid_field_values', () => {
    expect(() => validateSignificantEventChange({}, CURRENT, { now: NOW }))
      .toThrow(/no changes supplied/i);
    expect(() => validateSignificantEventChange({
      expectedAttendance: 0,
    }, CURRENT, { now: NOW })).toThrow(/whole number greater than zero/i);
    expect(() => validateSignificantEventChange({
      proposedStart: null,
    }, CURRENT, { now: NOW })).toThrow(/cannot be null/i);
    expect(() => validateSignificantEventChange({
      unrelated: 'value',
    }, CURRENT, { now: NOW })).toThrow(/unsupported field/i);
  });

  it('SCRUM395_AC5_allows_a_reasoned_equipment_change_without_editing_lines', () => {
    expect(validateSignificantEventChange({
      equipmentChange: true,
    }, CURRENT, { now: NOW })).toEqual({ equipmentChange: true });
  });
});
