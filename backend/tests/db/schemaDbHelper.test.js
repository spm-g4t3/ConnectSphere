import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { baselineFiles } from '../../db/loadSchema.js';
import { createSchemaDb } from './helpers/schemaDb.js';

// Every table the files create, read from the files themselves. A later
// migration may drop one, so the test checks containment, not equality.
function tablesInSchemaFiles() {
  const names = baselineFiles().flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/^\s*create table (?:if not exists )?(?:public\.)?(\w+)/gim)].map(
      (match) => match[1],
    ),
  );
  return [...new Set(names)].sort();
}

describe('SCRUM-572: createSchemaDb()', () => {
  let db;
  let other;

  beforeAll(async () => {
    [db, other] = await Promise.all([createSchemaDb(), createSchemaDb()]);
  }, 60_000);

  afterAll(async () => {
    await Promise.all([db?.close(), other?.close()]);
  });

  it('SCRUM572_schema_db_has_every_schema_file_table_and_the_supabase_roles', async () => {
    const expected = tablesInSchemaFiles();
    const { rows } = await db.query(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
    );

    expect(expected.length).toBeGreaterThan(30);
    expect(rows.map((r) => r.table_name)).toEqual(expect.arrayContaining(expected));
    // Suites switch to these roles to test grants, so the preamble must create them.
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await db.exec(`set role ${role}; reset role;`);
    }
  });

  it('SCRUM572_schema_db_calls_return_independent_databases', async () => {
    await db.query("insert into auth.users (email) values ('only-in-first@test')");

    const { rows } = await other.query("select count(*)::int as n from auth.users where email = 'only-in-first@test'");

    expect(rows[0].n).toBe(0);
  });
});
