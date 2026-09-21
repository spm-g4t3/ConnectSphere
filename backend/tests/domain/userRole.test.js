/**
 * Tests for the user role vocabulary.
 *
 * The shared authorisation dependency SCRUM-15 needs for AC2's word
 * "authorised". Same treatment as tests/domain/eventRequestStatus.test.js:
 * the list in JavaScript and the list in Postgres must not drift, so the test
 * reads the migration rather than trusting a second hand-written copy.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROLE, ROLE_LABEL, isKnownRole, roleLabel } from '../../src/domain/userRole.js';

const here = dirname(fileURLToPath(import.meta.url));


describe('ROLE mirrors the database enum', () => {
  /** Pull the enum values straight out of the migration, comments stripped. */
  function rolesInMigration() {
    const sql = readFileSync(
      resolve(here, '../../db/migrations/007_user_roles.sql'),
      'utf8',
    );

    const block = sql.match(/create type user_role as enum \(([\s\S]*?)\);/i);
    if (!block) throw new Error('could not find the enum in the migration');

    return [...block[1].replace(/--[^\n]*/g, '').matchAll(/'([a-z_]+)'/g)]
      .map((m) => m[1]);
  }

  it('SCRUM15_AC2_the_javascript_roles_match_the_sql_enum', () => {
    expect([...Object.values(ROLE)].sort()).toEqual(rolesInMigration().sort());
  });

  it('SCRUM15_AC2_there_are_exactly_five_roles_and_no_duplicates', () => {
    const roles = Object.values(ROLE);

    // Five, because README.md names five. A sixth appearing here without a
    // migration is exactly the drift this file exists to catch.
    expect(roles).toHaveLength(5);
    expect(new Set(roles).size).toBe(5);
  });

  it('SCRUM15_AC2_every_role_has_a_label', () => {
    for (const role of Object.values(ROLE)) {
      expect(typeof ROLE_LABEL[role]).toBe('string');
      expect(ROLE_LABEL[role].length).toBeGreaterThan(0);
    }
  });

  it('SCRUM15_AC2_no_label_exists_for_a_role_that_is_not_in_the_vocabulary', () => {
    expect(Object.keys(ROLE_LABEL).sort()).toEqual([...Object.values(ROLE)].sort());
  });
});


describe('an unrecognised role is never treated as a known one', () => {
  // Inherited properties are the dangerous case: on an authorisation path,
  // reporting true for 'constructor' would be wrong in the direction that
  // opens an endpoint rather than closes one.
  const JUNK = ['constructor', '__proto__', 'toString', '', 'admin', 'VENUE_STAFF',
                'Venue_Staff', null, undefined, 0, 1, {}, []];

  it.each(JUNK)('SCRUM15_AC2_isKnownRole_refuses_%s', (value) => {
    expect(isKnownRole(value)).toBe(false);
  });

  it('SCRUM15_AC2_accepts_every_real_role', () => {
    for (const role of Object.values(ROLE)) {
      expect(isKnownRole(role)).toBe(true);
    }
  });

  it('SCRUM15_AC2_is_case_sensitive_rather_than_guessing', () => {
    // 'Venue_Staff' is a typo, not a synonym. Guessing here would mean the
    // enum and the gate disagree about what a role is.
    expect(isKnownRole('Venue_Staff')).toBe(false);
    expect(isKnownRole(ROLE.VENUE_STAFF)).toBe(true);
  });

  it('SCRUM15_AC2_roleLabel_never_echoes_an_unrecognised_value_back', () => {
    // The label reaches a caller in a 403 body, so an unknown value must not
    // be reflected into the response.
    expect(roleLabel('<script>')).toBe('another role');
    expect(roleLabel(null)).toBe('another role');
    expect(roleLabel(ROLE.VENUE_STAFF)).toBe('Venue Staff');
  });
});


describe('the vocabulary cannot be edited at runtime', () => {
  it('SCRUM15_AC2_ROLE_is_frozen', () => {
    expect(Object.isFrozen(ROLE)).toBe(true);
    expect(() => { ROLE.ADMIN = 'admin'; }).toThrow(TypeError);
  });

  it('SCRUM15_AC2_ROLE_LABEL_is_frozen', () => {
    expect(Object.isFrozen(ROLE_LABEL)).toBe(true);
  });
});
