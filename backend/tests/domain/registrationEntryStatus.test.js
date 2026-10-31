import { describe, it, expect } from 'vitest';

import { REGISTRATION_ENTRY_LABEL, registrationEntryLabel } from '../../src/domain/registrationEntryStatus.js';
import { useSchemaDb, checkListValues } from './helpers/schemaVocabulary.js';

const schemaDb = useSchemaDb();

describe('registration list labels', () => {
  it('SCRUM478_AC2_labels_exactly_the_statuses_the_database_stores', async () => {
    expect(Object.keys(REGISTRATION_ENTRY_LABEL).sort())
      .toEqual((await checkListValues(schemaDb(), 'event_registrations_status_known')).sort());
  });

  it('SCRUM478_AC2_names_an_unknown_or_inherited_status_unknown', () => {
    expect(registrationEntryLabel('cancelled')).toBe('Event cancelled');
    expect(registrationEntryLabel('constructor')).toBe('Unknown');
    expect(registrationEntryLabel(undefined)).toBe('Unknown');
  });
});
