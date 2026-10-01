/**
 * Traceability for SCRUM-17 AC4: "Venue staff cannot change or clear a period
 * held by an approved booking."
 *
 * SCRUM-130. CI has no database, so this reads the block migrations' SQL text
 * with every `--` comment stripped -- a rule that exists only in a comment
 * does not count. Across 011..015, nothing may write a booking's period
 * (bookings.starts_at / bookings.ends_at), and the only UPDATE of bookings is
 * the one that sets status = 'flagged_for_review', inside
 * flag_bookings_for_block in 014.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const MIGRATIONS = [
  '011_venue_blocks.sql',
  '012_venue_block_creation.sql',
  '013_venue_block_booking_conflicts.sql',
  '014_booking_review_notifications.sql',
  '015_venue_block_amend_remove.sql',
];

/** A migration with every `--` comment stripped, whitespace collapsed, lower-cased. */
function normalised(name) {
  return readFileSync(resolve(here, `../../db/migrations/${name}`), 'utf8')
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const SQL = Object.fromEntries(MIGRATIONS.map((name) => [name, normalised(name)]));

/** `update [only] [public.]bookings [alias]` -- the target, not a join. */
const UPDATE_BOOKINGS = /\bupdate\s+(?:only\s+)?(?:public\.)?bookings\b/g;

/** Every UPDATE of bookings in a migration, with its offset and SET clause. */
function bookingUpdates(sql) {
  return [...sql.matchAll(UPDATE_BOOKINGS)].map((match) => {
    const rest = sql.slice(match.index);
    const set = rest.indexOf(' set ');
    const stops = [' where ', ' returning ', ';', ' from ']
      .map((stop) => rest.indexOf(stop, set))
      .filter((i) => i !== -1);
    return { index: match.index, setClause: rest.slice(set + 5, Math.min(...stops)).trim() };
  });
}

/** The column names a SET clause assigns, alias-qualified or not. */
function assignedColumns(setClause) {
  return [...setClause.matchAll(/(?:^|,)\s*(?:\w+\.)?(\w+)\s*=/g)].map((m) => m[1]);
}

/** One function's text: from its `create or replace` to the `$$;` that ends it. */
function functionSpan(sql, name) {
  const from = sql.indexOf(`create or replace function ${name}(`);
  if (from === -1) return null;
  const end = sql.indexOf('$$;', sql.indexOf('$$', from) + 2);
  return end === -1 ? null : { from, to: end + 3 };
}

const ALL_UPDATES = MIGRATIONS.flatMap((name) =>
  bookingUpdates(SQL[name]).map((u) => ({ name, ...u })),
);


describe('SCRUM17_AC4 the block migrations never write a booking period', () => {
  it('SCRUM17_AC4_all_five_migrations_were_read', () => {
    for (const name of MIGRATIONS) {
      expect(SQL[name].length, name).toBeGreaterThan(0);
    }
  });

  it('SCRUM17_AC4_no_update_of_bookings_sets_starts_at_or_ends_at', () => {
    for (const { name, setClause } of ALL_UPDATES) {
      const columns = assignedColumns(setClause);
      expect(columns, `${name}: set ${setClause}`).not.toContain('starts_at');
      expect(columns, `${name}: set ${setClause}`).not.toContain('ends_at');
    }
  });

  it('SCRUM17_AC4_no_migration_inserts_bookings', () => {
    for (const name of MIGRATIONS) {
      expect(SQL[name], name).not.toMatch(/\binsert\s+into\s+(?:public\.)?bookings\b/);
    }
  });

  it('SCRUM17_AC4_no_alter_table_bookings_touches_the_period_columns', () => {
    for (const name of MIGRATIONS) {
      const sql = SQL[name];
      for (const match of sql.matchAll(/\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?bookings\b/g)) {
        const statement = sql.slice(match.index, sql.indexOf(';', match.index));
        expect(statement, `${name}: ${statement}`).not.toMatch(/\b(starts_at|ends_at)\b/);
      }
    }
  });

  it('SCRUM17_AC4_no_trigger_is_created_on_bookings', () => {
    for (const name of MIGRATIONS) {
      expect(SQL[name], name).not.toMatch(/\bcreate\s+(?:or\s+replace\s+)?trigger\b[^;]*\bon\s+(?:public\.)?bookings\b/);
    }
  });
});


describe('SCRUM17_AC4 the only update of bookings is the review flag', () => {
  it('SCRUM17_AC4_there_is_exactly_one_update_of_bookings_and_it_is_in_014', () => {
    expect(ALL_UPDATES.map(({ name }) => name)).toEqual(['014_booking_review_notifications.sql']);
  });

  it("SCRUM17_AC4_it_sets_status_to_flagged_for_review_and_nothing_of_the_period", () => {
    const [{ setClause }] = ALL_UPDATES;
    expect(setClause).toMatch(/^status\s*=\s*'flagged_for_review'\s*,/);
    expect(assignedColumns(setClause)).toEqual([
      'status',
      'review_block_id',
      'flagged_at',
      'flagged_by',
    ]);
  });

  it('SCRUM17_AC4_it_lives_inside_flag_bookings_for_block', () => {
    const sql = SQL['014_booking_review_notifications.sql'];
    const span = functionSpan(sql, 'flag_bookings_for_block');
    expect(span).not.toBeNull();

    const [{ index }] = ALL_UPDATES;
    expect(index).toBeGreaterThan(span.from);
    expect(index).toBeLessThan(span.to);
  });

  it('SCRUM17_AC4_it_only_flags_approved_bookings', () => {
    const sql = SQL['014_booking_review_notifications.sql'];
    const [{ index }] = ALL_UPDATES;
    const statement = sql.slice(index, sql.indexOf(' returning ', index));
    expect(statement).toMatch(/\bwhere\b.*\bb\.status\s*=\s*'approved'/);
  });
});
