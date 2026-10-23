import { describe, it, expect, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { SUPABASE_PREAMBLE } from '../../db/loadSchema.js';
import { diffRows, fingerprint, parseCsv, toCsv } from '../../scripts/schema-fingerprint.js';

// Small enough to build fast, but with each kind the squash proof relies on:
// an enum, a table, a function and a revoke. The three seed tables are there
// because the fingerprint reads them by name.
const SCHEMA = `
  create table room_layouts (code text primary key, label text not null);
  create table accessibility_features (code text primary key, label text not null);
  create table facilities (code text primary key, label text not null);
  insert into room_layouts values ('theatre', 'Theatre');

  create type booking_status as enum ('pending', 'confirmed');
  create table bookings (id uuid primary key default gen_random_uuid(), status booking_status not null);
  create function count_bookings() returns bigint language sql stable as $$ select count(*) from bookings $$;
  revoke execute on function count_bookings() from public;
`;

// Each test boots two fresh PGlite databases, which can take longer than the
// 5s default on a loaded runner.
describe('schema fingerprint', { timeout: 30_000 }, () => {
  const opened = [];

  async function build(extra = '') {
    const db = new PGlite({ extensions: { btree_gist } });
    opened.push(db);
    await db.exec(SUPABASE_PREAMBLE + SCHEMA + extra);
    return fingerprint(db);
  }

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.close()));
  });

  // Builds two PGlite databases in the test itself, so a busy full run outlasts the 5 s default.
  it('SCRUM572_fingerprint_a_changed_function_body_changes_only_the_function_row', async () => {
    const before = await build();
    const after = await build(`
      create or replace function count_bookings() returns bigint language sql stable
        as $$ select count(*) from bookings where status = 'confirmed' $$;
    `);

    const { onlyA, onlyB, changed } = diffRows(before, after);

    expect(onlyA).toEqual([]);
    expect(onlyB).toEqual([]);
    expect(changed.map((r) => [r.kind, r.name])).toEqual([['function', 'count_bookings()']]);
  }, 30_000);

  // Builds two PGlite databases in the test itself, so a busy full run outlasts the 5 s default.
  it('SCRUM572_fingerprint_revoking_execute_from_anon_changes_only_the_function_acl_row', async () => {
    const before = await build();
    const after = await build('revoke execute on function count_bookings() from anon;');

    const { onlyA, onlyB, changed } = diffRows(before, after);

    expect(onlyA).toEqual([]);
    expect(onlyB).toEqual([]);
    expect(changed).toEqual([
      {
        kind: 'function_acl',
        name: 'count_bookings()',
        a: 'anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE',
        b: 'authenticated:EXECUTE,service_role:EXECUTE',
      },
    ]);
  }, 30_000);

  it('SCRUM572_fingerprint_csv_round_trips_commas_quotes_and_newlines', () => {
    // The shapes Supabase's CSV export produces for constraint and view text.
    const rows = [
      { kind: 'constraint', name: 't.c', detail: `c CHECK ((type = ANY (ARRAY['a'::text, 'b'::text])))` },
      { kind: 'function', name: 'f(a integer, b text)', detail: 'says "hi",\nthen\r\nleaves' },
      { kind: 'table', name: 'empty', detail: '' },
    ];

    expect(parseCsv(toCsv(rows))).toEqual(rows);

    // A spreadsheet-style export: BOM, CRLF row ends, every field quoted.
    const exported = '\uFEFF"kind","name","detail"\r\n"table","empty",""\r\n';
    expect(parseCsv(exported)).toEqual([rows[2]]);
  });
});
