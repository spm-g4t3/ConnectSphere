/**
 * Tests for the user role vocabulary.
 *
 * The shared authorisation dependency SCRUM-15 needs for AC2's word
 * "authorised". Same treatment as tests/domain/eventRequestStatus.test.js:
 * the list in JavaScript and the list in Postgres must not drift, so the test
 * reads the migrations rather than trusting a second hand-written copy.
 *
 * SCRUM-485 (SCRUM-507) added two roles in a new migration, 039, rather than by
 * editing 007. Before that, this file read only 007's `create type` block and
 * asserted five roles, so 039 would have been invisible to it: the JavaScript
 * list would have gained two values that, as far as the test knew, the
 * database did not have. It now reads 007's created values plus every
 * `alter type user_role add value` in any migration, so a role added later is
 * compared too, without anyone remembering to update this file.
 *
 * What it still cannot see: the live database. It compares the JavaScript list
 * with what the repository declares, and the live enum has drifted from that
 * once already. It holds technical_support, which no migration declares, from
 * before 007 existed (007 creates the enum only `if not exists`, so it never
 * ran there). A query on 10 October found no profile using it. Only a query
 * against the live database can check the live enum.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

import { ROLE, ROLE_LABEL, isKnownRole, roleLabel } from '../../src/domain/userRole.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(here, '../../db/migrations');

/** A migration's text with its `--` comments removed. */
function sqlOf(name) {
  // Comments out first: 007's header says "To add a value later:  alter type
  // user_role add value 'x';", and 039's header quotes its own statements.
  // Read with the comments in, 'x' would count as a role.
  return readFileSync(resolve(MIGRATIONS, name), 'utf8').replace(/--[^\n]*/g, '');
}

/**
 * Every role the repository's migrations declare, in the order a database
 * built from them would hold: the values `create type user_role` creates, then
 * each `alter type user_role add value`, file by file in name order, which is
 * the order they are applied in.
 *
 * Also returns which files contributed, so a test can check that the parse
 * found something rather than passing on an empty match.
 */
function rolesInMigrations() {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  const created = [];
  const added = [];

  for (const file of files) {
    const sql = sqlOf(file);

    const block = sql.match(/create type user_role as enum \(([\s\S]*?)\);/i);
    if (block) {
      created.push({ file, values: [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) });
    }

    const values = [...sql.matchAll(/alter type user_role add value (?:if not exists )?'([a-z_]+)'/gi)]
      .map((m) => m[1]);
    if (values.length > 0) added.push({ file, values });
  }

  if (created.length !== 1) {
    throw new Error(`expected one migration to create user_role, found ${created.length}`);
  }

  return {
    created: created[0],
    added,
    all: [...created[0].values, ...added.flatMap((a) => a.values)],
  };
}


describe('ROLE mirrors the database enum', () => {
  it('SCRUM15_AC2_the_javascript_roles_match_the_sql_enum', () => {
    // Every migration that declares a role, not 007 alone (see the header).
    expect([...Object.values(ROLE)].sort()).toEqual(rolesInMigrations().all.sort());
  });

  it('SCRUM485_AC1_there_are_exactly_seven_roles_and_no_duplicates', () => {
    // Was SCRUM15_AC2_there_are_exactly_five_roles_and_no_duplicates. Seven:
    // README's five, and SCRUM-485's two. A role appearing here without a
    // migration, or in a migration without this list, is the drift the test
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


describe('SCRUM-485: migration 039, read as text', () => {
  const FILE = '039_coordinator_lead_and_safety_officer_roles.sql';

  it('SCRUM485_AC5_039_adds_the_two_values_and_nothing_else', () => {
    // AC5-01. Two statements, comments aside. Nothing that uses the new
    // values, because Postgres refuses a new enum value in the transaction
    // that adds it, and nothing else that could hide among them.
    const statements = sqlOf(FILE).split(';').map((st) => st.trim()).filter(Boolean);

    expect(statements).toEqual([
      "alter type user_role add value if not exists 'event_coordinator_lead'",
      "alter type user_role add value if not exists 'safety_officer'",
    ]);
  });

  it('SCRUM485_AC5_the_parse_finds_039_and_reads_no_comment_as_a_role', () => {
    // So the comparison at the top cannot pass on an empty or wrong match:
    // 007 is the one file that creates the type, 039 is found as a file that
    // adds to it, and the 'x' in 007's own comment is not taken for a role.
    const { created, added, all } = rolesInMigrations();

    expect(created.file).toBe('007_user_roles.sql');
    expect(created.values).toHaveLength(5);
    expect(added).toContainEqual({ file: FILE, values: ['event_coordinator_lead', 'safety_officer'] });
    expect(all).not.toContain('x');
  });
});


describe('SCRUM-485: a database built from the migrations', () => {
  // PGlite, an in-process Postgres, as in tests/db/eventStatusLifecycleDatabase:
  // the real migrations, applied for real, so these prove what the enum
  // accepts rather than what the files say. Built from 007 and every migration
  // that adds a role, found by the same parse as above.
  //
  // Not the live database. It has technical_support besides; see the header.
  let db;
  const migration = (name) => readFileSync(resolve(MIGRATIONS, name), 'utf8');
  const roleFiles = () => rolesInMigrations().added.map((a) => a.file);

  beforeAll(async () => {
    db = new PGlite();
    // 007's profiles table references auth.users, which Supabase provides.
    await db.exec(`
      create schema auth;
      create table auth.users (id uuid primary key default gen_random_uuid(), email text);
    `);
    await db.exec(migration('007_user_roles.sql'));
    for (const file of roleFiles()) await db.exec(migration(file));
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  const enumValues = async () =>
    (await db.query('select unnest(enum_range(null::user_role))::text as role')).rows.map((r) => r.role);
  const newUser = async () =>
    (await db.query("insert into auth.users (email) values ('someone@x') returning id")).rows[0].id;

  it('SCRUM485_AC6_the_enum_holds_the_five_then_the_two_in_that_order', async () => {
    // AC6-01. add value appends, so the existing five are untouched and first.
    expect(await enumValues()).toEqual([
      'event_organiser',
      'event_coordinator',
      'venue_staff',
      'technical_support_staff',
      'attendee',
      'event_coordinator_lead',
      'safety_officer',
    ]);
  });

  it('SCRUM485_AC5_the_javascript_roles_are_exactly_what_the_built_enum_holds', async () => {
    // The text comparison at the top, checked against Postgres itself.
    expect([...Object.values(ROLE)].sort()).toEqual((await enumValues()).sort());
  });

  it('SCRUM485_AC5_running_039_again_changes_nothing', async () => {
    // AC5-02. `if not exists` makes a second run a no-op rather than an error.
    const before = await enumValues();

    await db.exec(migration('039_coordinator_lead_and_safety_officer_roles.sql'));

    expect(await enumValues()).toEqual(before);
  });

  it.each([ROLE.EVENT_COORDINATOR_LEAD, ROLE.SAFETY_OFFICER])(
    'SCRUM485_AC5_a_profile_can_hold_%s',
    async (role) => {
      // AC5-03. In its own statement, after 039 has committed: the
      // transaction rule only forbids using a value where it was added.
      const id = await newUser();

      await db.query('insert into profiles (id, role) values ($1, $2)', [id, role]);

      const { rows: [stored] } = await db.query('select role::text from profiles where id = $1', [id]);
      expect(stored.role).toBe(role);
    },
  );

  it('SCRUM485_AC5_a_misspelt_role_is_refused_by_the_enum', async () => {
    // AC5-04. 22P02, invalid input value for an enum. The database is the
    // last word on spelling, so a typo in an account-creation script fails
    // loudly instead of creating a user no gate recognises.
    const id = await newUser();

    const err = await db
      .query('insert into profiles (id, role) values ($1, $2)', [id, 'event_coordinator_leader'])
      .then(() => null, (e) => e);

    expect(err?.code).toBe('22P02');
  });

  it('SCRUM485_AC2_a_second_role_for_the_same_account_is_refused', async () => {
    // AC2-01. One role per account is the schema, not a convention: id is the
    // primary key of profiles, so a second row for the same user is refused
    // (23505), and the first is left as it was.
    const id = await newUser();
    await db.query('insert into profiles (id, role) values ($1, $2)', [id, ROLE.EVENT_COORDINATOR_LEAD]);

    const err = await db
      .query('insert into profiles (id, role) values ($1, $2)', [id, ROLE.SAFETY_OFFICER])
      .then(() => null, (e) => e);

    expect(err?.code).toBe('23505');
    const { rows } = await db.query('select role::text from profiles where id = $1', [id]);
    expect(rows).toEqual([{ role: ROLE.EVENT_COORDINATOR_LEAD }]);
  });
});
