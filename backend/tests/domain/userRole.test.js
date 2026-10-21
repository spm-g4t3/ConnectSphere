/**
 * Tests for the user role vocabulary.
 *
 * The shared authorisation dependency SCRUM-15 needs for AC2's word
 * "authorised". Same treatment as tests/domain/eventRequestStatus.test.js:
 * the list in JavaScript and the list in Postgres must not drift, so the test
 * reads the enum from the built schema rather than trusting a second
 * hand-written copy.
 */

import { describe, it, expect } from 'vitest';

import { ROLE, ROLE_LABEL, isKnownRole, roleLabel } from '../../src/domain/userRole.js';
import { useSchemaDb, enumLabels } from './helpers/schemaVocabulary.js';

const schemaDb = useSchemaDb();

// Live predates the role migrations and kept this value; no profile uses it
// and no code knows it, so it is left out of the comparison.
const LEGACY_SQL_ROLES = ['technical_support'];

/** The enum's roles in Postgres order, without the legacy value. */
async function rolesInSchema() {
  return (await enumLabels(schemaDb(), 'user_role')).filter((role) => !LEGACY_SQL_ROLES.includes(role));
}


describe('ROLE mirrors the database enum', () => {
  it('SCRUM15_AC2_the_javascript_roles_match_the_sql_enum', async () => {
    // Compared as sets: the legacy value sits mid-enum, and no code orders or
    // compares roles by enum position.
    expect([...Object.values(ROLE)].sort()).toEqual((await rolesInSchema()).sort());
  });

  it('SCRUM485_AC1_there_are_exactly_seven_roles_and_no_duplicates', () => {
    // Was SCRUM15_AC2_there_are_exactly_five_roles_and_no_duplicates. Seven:
    // README's five, and SCRUM-485's two. A role appearing here without the
    // enum, or in the enum without this list, is the drift the test
    // above catches; this one catches a value listed twice.
    const roles = Object.values(ROLE);

    expect(roles).toHaveLength(7);
    expect(new Set(roles).size).toBe(7);
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


// ---------------------------------------------------------------------------
// SCRUM-485: the Event Coordinator Lead and the Safety Officer
// ---------------------------------------------------------------------------
// The cases in docs/test-cases/SCRUM-485.md that live in the role vocabulary
// and the enum. The case ID is at the start of each test's comment.

describe('SCRUM-485: the two new roles, as the code names them', () => {
  it('SCRUM485_AC1_the_two_roles_are_spelled_as_the_enum_spells_them', () => {
    // AC1-01. Lowercase snake_case, like every live value.
    expect(ROLE.EVENT_COORDINATOR_LEAD).toBe('event_coordinator_lead');
    expect(ROLE.SAFETY_OFFICER).toBe('safety_officer');
  });

  it('SCRUM485_AC1_the_labels_are_the_exact_names_in_the_plural', () => {
    // AC1-02. The label's one use is "This action is restricted to ...", so it
    // is plural like 'Event Coordinators'; the role's name inside it is AC1's.
    expect(ROLE_LABEL[ROLE.EVENT_COORDINATOR_LEAD]).toBe('Event Coordinator Leads');
    expect(ROLE_LABEL[ROLE.SAFETY_OFFICER]).toBe('Safety Officers');
  });

  it.each([ROLE.EVENT_COORDINATOR_LEAD, ROLE.SAFETY_OFFICER])(
    'SCRUM485_AC5_%s_is_a_known_role_with_its_own_label',
    (role) => {
      // AC5-06. Known, so requireRole names it in a 403, and roleLabel never
      // falls back to 'another role' for it.
      expect(isKnownRole(role)).toBe(true);
      expect(roleLabel(role)).toBe(ROLE_LABEL[role]);
      expect(roleLabel(role)).not.toBe('another role');
    },
  );

  it.each(['technical_support', 'event_coordinator_leader', 'EVENT_COORDINATOR_LEAD', 'Safety Officer', 'safety-officer'])(
    'SCRUM485_AC5_isKnownRole_refuses_%s',
    (value) => {
      // The dead live value is not a role the code knows; nor is a near miss
      // of a new one. The backend takes the role exactly as stored. Spelling
      // is forgiven only by the frontend's normaliseRole, never here.
      expect(isKnownRole(value)).toBe(false);
    },
  );

  it('SCRUM485_AC6_the_five_existing_roles_and_their_labels_are_unchanged', () => {
    // AC6-02. Written out rather than derived, so a change to any of them fails.
    expect(ROLE).toMatchObject({
      EVENT_ORGANISER: 'event_organiser',
      EVENT_COORDINATOR: 'event_coordinator',
      VENUE_STAFF: 'venue_staff',
      TECHNICAL_SUPPORT_STAFF: 'technical_support_staff',
      ATTENDEE: 'attendee',
    });
    expect(ROLE_LABEL).toMatchObject({
      event_organiser: 'Event Organisers',
      event_coordinator: 'Event Coordinators',
      venue_staff: 'Venue Staff',
      technical_support_staff: 'Technical Support Staff',
      attendee: 'Attendees',
    });
  });
});


describe('SCRUM-485: the built schema', () => {
  // PGlite, an in-process Postgres, with the schema applied for real, so these
  // prove what the enum accepts rather than what the files say.
  const newUser = async () =>
    (await schemaDb().query("insert into auth.users (email) values ('someone@x') returning id")).rows[0].id;

  it('SCRUM485_AC6_the_enum_holds_the_five_then_the_two_in_that_order', async () => {
    // AC6-01. The two were appended, so the existing five keep their place
    // ahead of them (the legacy value aside).
    expect(await rolesInSchema()).toEqual([
      'event_organiser',
      'event_coordinator',
      'venue_staff',
      'technical_support_staff',
      'attendee',
      'event_coordinator_lead',
      'safety_officer',
    ]);
  });

  it.each([ROLE.EVENT_COORDINATOR_LEAD, ROLE.SAFETY_OFFICER])(
    'SCRUM485_AC5_a_profile_can_hold_%s',
    async (role) => {
      // AC5-03.
      const id = await newUser();

      await schemaDb().query('insert into profiles (id, role) values ($1, $2)', [id, role]);

      const { rows: [stored] } = await schemaDb().query('select role::text from profiles where id = $1', [id]);
      expect(stored.role).toBe(role);
    },
  );

  it('SCRUM485_AC5_a_misspelt_role_is_refused_by_the_enum', async () => {
    // AC5-04. 22P02, invalid input value for an enum. The database is the
    // last word on spelling, so a typo in an account-creation script fails
    // loudly instead of creating a user no gate recognises.
    const id = await newUser();

    const err = await schemaDb()
      .query('insert into profiles (id, role) values ($1, $2)', [id, 'event_coordinator_leader'])
      .then(() => null, (e) => e);

    expect(err?.code).toBe('22P02');
  });

  it('SCRUM485_AC2_a_second_role_for_the_same_account_is_refused', async () => {
    // AC2-01. One role per account is the schema, not a convention: id is the
    // primary key of profiles, so a second row for the same user is refused
    // (23505), and the first is left as it was.
    const id = await newUser();
    await schemaDb().query('insert into profiles (id, role) values ($1, $2)', [id, ROLE.EVENT_COORDINATOR_LEAD]);

    const err = await schemaDb()
      .query('insert into profiles (id, role) values ($1, $2)', [id, ROLE.SAFETY_OFFICER])
      .then(() => null, (e) => e);

    expect(err?.code).toBe('23505');
    const { rows } = await schemaDb().query('select role::text from profiles where id = $1', [id]);
    expect(rows).toEqual([{ role: ROLE.EVENT_COORDINATOR_LEAD }]);
  });
});
