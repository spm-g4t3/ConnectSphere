import { describe, it, expect } from 'vitest';

import { REGISTRATION_STATUS, isRegistrationStatus } from '../../src/domain/registrationStatus.js';
import { REGISTRATION_STATUS as FRONTEND_STATUS } from '../../../frontend/src/services/registrationStatus.js';
import { useSchemaDb, checkListValues, columnDefault } from './helpers/schemaVocabulary.js';

const schemaDb = useSchemaDb();

describe('REGISTRATION_STATUS mirrors the database', () => {
  it('SCRUM472_AC1_statuses_match_the_sql_check_constraint', async () => {
    expect(Object.values(REGISTRATION_STATUS))
      .toEqual(await checkListValues(schemaDb(), 'event_registrations_status_known'));
  });

  it('SCRUM472_AC1_the_frontend_list_matches_the_backend_domain', () => {
    expect(FRONTEND_STATUS).toEqual(REGISTRATION_STATUS);
  });

  it('SCRUM472_AC6_a_new_row_is_registered_unless_told_otherwise', async () => {
    expect(await columnDefault(schemaDb(), 'event_registrations', 'status')).toBe("'registered'::text");
  });

  it('is frozen', () => {
    expect(Object.isFrozen(REGISTRATION_STATUS)).toBe(true);
  });
});

describe('isRegistrationStatus', () => {
  it.each(['registered', 'withdrawn', 'waitlisted', 'cancelled'])('SCRUM472_AC1_accepts_%s', (value) => {
    expect(isRegistrationStatus(value)).toBe(true);
  });

  it.each([['the wrong case', 'Waitlisted'], ['an inherited name', 'toString'], ['an empty string', ''], ['null', null], ['a number', 1]])(
    'SCRUM472_AC1_refuses_%s', (_label, value) => {
      expect(isRegistrationStatus(value)).toBe(false);
    },
  );
});
