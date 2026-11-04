/**
 * The JavaScript mirror of the equipment_request_status enum matches the
 * database.
 *
 * SCRUM-21. The enum is read from the built schema, so adding a status to one
 * place and not the other fails here.
 */

import { describe, it, expect } from 'vitest';

import {
  EQUIPMENT_REQUEST_STATUS,
  EQUIPMENT_REQUEST_STATUS_LABEL,
  equipmentRequestStatusLabel,
} from '../../src/domain/equipmentRequestStatus.js';
import { useSchemaDb, enumLabels } from './helpers/schemaVocabulary.js';

const schemaDb = useSchemaDb();
const enumValues = () => enumLabels(schemaDb(), 'equipment_request_status');

describe('the equipment request status vocabulary', () => {
  it('SCRUM21_the_javascript_statuses_are_exactly_the_database_enum', async () => {
    expect(Object.values(EQUIPMENT_REQUEST_STATUS).sort()).toEqual((await enumValues()).sort());
  });

  it('SCRUM21_every_status_has_a_label_a_coordinator_can_read', async () => {
    for (const status of await enumValues()) {
      expect(EQUIPMENT_REQUEST_STATUS_LABEL[status], status).toEqual(expect.any(String));
    }
    expect(equipmentRequestStatusLabel('cannot_be_fully_arranged')).toBe('Cannot be fully arranged');
  });

  it('SCRUM21_an_unknown_status_comes_back_as_it_was_given', () => {
    expect(equipmentRequestStatusLabel('something_new')).toBe('something_new');
  });
});
