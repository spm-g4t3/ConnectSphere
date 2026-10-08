/**
 * The JavaScript mirror of the equipment_request_status enum matches the
 * database.
 *
 * SCRUM-21. 022_equipment_schema.sql says the mirror is added with the first
 * endpoint that needs it "and a test should assert they match". This is that
 * test. It reads the enum straight out of the migration, so adding a status to
 * one place and not the other fails here.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  EQUIPMENT_REQUEST_STATUS,
  EQUIPMENT_REQUEST_STATUS_LABEL,
  equipmentRequestStatusLabel,
} from '../../src/domain/equipmentRequestStatus.js';

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(resolve(here, '../../db/migrations/022_equipment_schema.sql'), 'utf8');

/** The values of `create type equipment_request_status as enum (...)`, in order. */
function enumValues() {
  const block = schema.match(/create type equipment_request_status as enum \(([\s\S]*?)\);/);
  expect(block, 'the enum is in 022').not.toBeNull();
  return [...block[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
}

describe('the equipment request status vocabulary', () => {
  it('SCRUM21_the_javascript_statuses_are_exactly_the_database_enum', () => {
    expect(Object.values(EQUIPMENT_REQUEST_STATUS).sort()).toEqual(enumValues().sort());
  });

  it('SCRUM21_every_status_has_a_label_a_coordinator_can_read', () => {
    for (const status of enumValues()) {
      expect(EQUIPMENT_REQUEST_STATUS_LABEL[status], status).toEqual(expect.any(String));
    }
    expect(equipmentRequestStatusLabel('cannot_be_fully_arranged')).toBe('Cannot be fully arranged');
  });

  it('SCRUM21_an_unknown_status_comes_back_as_it_was_given', () => {
    expect(equipmentRequestStatusLabel('something_new')).toBe('something_new');
  });
});
