/**
 * Tests for 034_setup_change_recheck.sql, read from the migration text.
 *
 * SCRUM-484 "Configure Venue Setup and Turnaround Times" (AC8, sub-task 3 of
 * the backend): when a venue's setup or turnaround really changes,
 * update_venue re-checks the venue's approved, not-yet-started bookings in the
 * same transaction, flags the ones whose occupied period now overlaps another
 * approved booking or an active block, and notifies each event's assigned
 * coordinator. 034 adds bookings.review_reason, widens
 * bookings_review_flag_paired, re-lists every notification type, and
 * redefines update_venue to return {flagged_bookings}.
 *
 * These pin the shape with every `--` comment stripped: the header explains
 * the rules in prose, so a rule that exists only in a comment must not count.
 * The behaviour is exercised against a real Postgres in
 * setupChangeRecheckDatabase.test.js.
 *
 * Same helpers as venueOccupancyCallersMigration.test.js.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '../../db/migrations');
const FILE = '034_setup_change_recheck.sql';

/**
 * A migration with every `--` comment stripped, whitespace collapsed,
 * lower-cased, and the space just inside parentheses removed (layout, not
 * behaviour).
 */
function normalised(name) {
  return readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8')
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .toLowerCase()
    .trim();
}

const SQL = normalised(FILE);
const SQL023 = normalised('023_venue_setup_time.sql');

/** One function's text in `sql`: from its `create or replace` to the `$$;` that ends it. */
function functionText(sql, name) {
  const from = sql.indexOf(`create or replace function ${name}(`);
  if (from === -1) return null;
  const end = sql.indexOf('$$;', sql.indexOf('$$', from) + 2);
  return end === -1 ? null : sql.slice(from, end + 3);
}

/** The header between `name(` and the `as $$` that opens the body. */
function headerOf(text) {
  return text.slice(0, text.indexOf('$$'));
}

/** The parameter types of a function header, defaults dropped: 'uuid, text, ...'. */
function parameterTypes(text) {
  const open = text.indexOf('(');
  const close = text.indexOf(') returns');
  return text
    .slice(open + 1, close)
    .split(',')
    .map((p) => p.trim().split(' ')[1])
    .join(', ');
}

const UPDATE_VENUE = functionText(SQL, 'update_venue');
const UPDATE_VENUE_023 = functionText(SQL023, 'update_venue');

/** The CHECK expression of a named constraint added in 034. */
function checkOf(name) {
  const m = SQL.match(new RegExp(`add constraint ${name} check \\((.*?)\\);`));
  return m ? m[1] : null;
}


describe('SCRUM-484 AC8: the review reason and the notification types (034)', () => {
  it('SCRUM484_AC8_review_reason_is_paired_with_the_flag', () => {
    expect(SQL).toContain('alter table bookings add column if not exists review_reason text;');

    // The reason is a code, from a named list.
    const drop = SQL.indexOf('alter table bookings drop constraint if exists bookings_review_reason_known;');
    const add = SQL.indexOf('add constraint bookings_review_reason_known');
    expect(drop).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(drop);
    expect(checkOf('bookings_review_reason_known')).toBe("review_reason in ('setup_or_turnaround_changed')");

    // The flag is a time together with a cause: a block (014) or a reason.
    const dropPaired = SQL.indexOf('alter table bookings drop constraint if exists bookings_review_flag_paired;');
    const addPaired = SQL.indexOf('add constraint bookings_review_flag_paired');
    expect(dropPaired).toBeGreaterThan(-1);
    expect(addPaired).toBeGreaterThan(dropPaired);
    expect(checkOf('bookings_review_flag_paired')).toBe(
      '(flagged_at is null) = (review_block_id is null and review_reason is null)',
    );
  });

  it('SCRUM484_AC8_notification_check_relists_every_type', () => {
    const drop = SQL.indexOf('alter table notifications drop constraint if exists notifications_type_known;');
    const add = SQL.indexOf('add constraint notifications_type_known');
    expect(drop).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(drop);

    const check = checkOf('notifications_type_known');
    const listed = [...check.matchAll(/'(\w+)'/g)].map((m) => m[1]);
    expect(check).toMatch(/^type in \(/);
    expect(listed).toEqual([
      'booking_flagged',
      'booking_request_withdrawn',
      'clarification_requested',
      'clarification_replied',
      'clarification_closed',
      'booking_flagged_setup_change',
    ]);
  });

  it('SCRUM484_AC8_new_type_has_its_own_refs_check', () => {
    expect(SQL).toContain(
      'alter table notifications drop constraint if exists notifications_setup_change_needs_booking;',
    );
    expect(checkOf('notifications_setup_change_needs_booking')).toBe(
      "type <> 'booking_flagged_setup_change' or booking_id is not null",
    );
  });
});


describe('SCRUM-484 AC8: update_venue re-checks in the same transaction (034)', () => {
  it('SCRUM484_AC8_recheck_runs_under_the_venue_lock_only_on_change', () => {
    expect(UPDATE_VENUE).not.toBeNull();
    const body = UPDATE_VENUE.slice(UPDATE_VENUE.indexOf('$$'));

    // In order: the venue row locked with its old minutes read, the update,
    // then the re-check guarded by a real change of either minute.
    const lock = body.indexOf(
      'select v.setup_minutes, v.turnaround_minutes into v_old_setup, v_old_turnaround from venues v where v.id = p_id for no key update;',
    );
    const update = body.indexOf('update venues set');
    const guard = body.indexOf(
      'if v_new_setup is distinct from v_old_setup or v_new_turnaround is distinct from v_old_turnaround then',
    );
    const recheck = body.indexOf('venue_occupancy_conflicts(');
    expect(lock).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(lock);
    expect(guard).toBeGreaterThan(update);
    expect(recheck).toBeGreaterThan(guard);

    // The new minutes are read back from the row after the update.
    const readNew = body.indexOf(
      'select v.setup_minutes, v.turnaround_minutes, v.name into v_new_setup, v_new_turnaround, v_venue_name from venues v where v.id = p_id;',
    );
    expect(readNew).toBeGreaterThan(update);
    expect(readNew).toBeLessThan(guard);

    // A missing venue is refused before anything is written.
    expect(body.indexOf("using errcode = 'no_data_found'")).toBeGreaterThan(lock);
    expect(body.indexOf("using errcode = 'no_data_found'")).toBeLessThan(update);
  });

  it('SCRUM484_AC8_update_venue_returns_flags_in_one_transaction', () => {
    // The exact 023 signature is dropped before the create: the return type
    // changes, which `create or replace` cannot do.
    const signature = parameterTypes(headerOf(UPDATE_VENUE_023));
    expect(signature).toBe('uuid, text, text, integer, text[], text[], text[], jsonb, integer, integer, uuid');
    const drop = SQL.indexOf(`drop function if exists update_venue(${signature});`);
    const create = SQL.indexOf('create or replace function update_venue(');
    expect(drop).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(drop);
    // Same parameters as 023, in the same order, with the same defaults.
    expect(parameterTypes(headerOf(UPDATE_VENUE))).toBe(signature);
    expect(headerOf(UPDATE_VENUE).slice(0, headerOf(UPDATE_VENUE).indexOf(') returns'))).toBe(
      headerOf(UPDATE_VENUE_023).slice(0, headerOf(UPDATE_VENUE_023).indexOf(') returns')),
    );

    // It now returns the flagged list.
    expect(headerOf(UPDATE_VENUE)).toMatch(/\) returns jsonb language plpgsql as $/);
    expect(headerOf(UPDATE_VENUE_023)).toMatch(/\) returns void language plpgsql as $/);
    expect(UPDATE_VENUE).toContain("return jsonb_build_object('flagged_bookings', v_flagged_list);");
    expect(UPDATE_VENUE).toContain("v_flagged_list jsonb := '[]'::jsonb;");

    // The flag and the notifications are inside the same function, so one
    // transaction: no second function, no exception handler swallowing them.
    expect(UPDATE_VENUE).toMatch(/update bookings b set status = 'flagged_for_review', review_reason = 'setup_or_turnaround_changed'/);
    expect(UPDATE_VENUE).toMatch(/insert into notifications \(recipient_id, type, booking_id, block_id, payload\)/);
    expect(UPDATE_VENUE).not.toMatch(/\bexception when\b/);
    expect(UPDATE_VENUE).not.toMatch(/\bcommit\b/);

    // The occupied period comes from 032's functions.
    expect(UPDATE_VENUE).toMatch(/venue_occupancy_conflicts\(p_id, b\.starts_at, b\.ends_at, true\)/);
    expect(UPDATE_VENUE).toMatch(/venue_occupied_period\(b\.starts_at, b\.ends_at, v_new_setup, v_new_turnaround\)/);
  });

  it('SCRUM484_AC8_recheck_writes_no_overlap_comparison_of_its_own', () => {
    // No range && and no strict comparison of a period column -- except the
    // "not started" filter, which compares a start with the clock.
    const body = UPDATE_VENUE.slice(UPDATE_VENUE.indexOf('$$')).split('b.starts_at > now()');
    expect(body).toHaveLength(2);
    const rest = body.join(' ');
    expect(rest).not.toMatch(/&&/);
    expect(rest).not.toMatch(/\b(?:\w+\.)?(?:starts_at|ends_at|proposed_start|proposed_end)\s*(?:<|>)/);
    expect(rest).not.toMatch(/tstzrange\(/);
    expect(rest).not.toMatch(/interval/);

    // The other side: an active block, or an approved booking other than itself.
    expect(UPDATE_VENUE).toContain(
      "where c.kind = 'block' or (c.kind = 'booking' and c.status = 'approved' and c.id <> b.id)",
    );
    // The candidates: approved, not started, at this venue.
    expect(UPDATE_VENUE).toContain(
      "where b.venue_id = p_id and b.status = 'approved' and b.starts_at > now() and exists (",
    );
  });

  it('SCRUM484_AC8_keeps_023_steps_the_audit_and_reloads_postgrest', () => {
    // 023's update and attribute steps, word for word: from the snapshot to
    // the attribute-change record.
    const from = '$$ declare v_before jsonb; begin ';
    const steps023 = UPDATE_VENUE_023.slice(
      UPDATE_VENUE_023.indexOf(from) + from.length,
      UPDATE_VENUE_023.indexOf(' end; $$;'),
    );
    expect(steps023).toMatch(/^v_before := venue_attribute_snapshot\(p_id\);/);
    expect(steps023).toMatch(/perform record_venue_attribute_change\(p_id, v_before, venue_attribute_snapshot\(p_id\), p_user_id\);$/);
    expect(UPDATE_VENUE).toContain(steps023);

    // The re-check comes after the audit, so the history row is written
    // whatever is flagged.
    expect(UPDATE_VENUE.indexOf('perform record_venue_attribute_change(')).toBeLessThan(
      UPDATE_VENUE.indexOf('if v_new_setup is distinct from v_old_setup'),
    );

    // PostgREST picks up the new return type, after the create.
    expect(SQL.lastIndexOf("notify pgrst, 'reload schema';")).toBeGreaterThan(
      SQL.indexOf('create or replace function update_venue('),
    );
  });
});


describe('SCRUM-484 AC9: the redefined update_venue keeps the audit (034)', () => {
  it('SCRUM484_AC9_redefined_update_venue_keeps_the_audit', () => {
    expect(UPDATE_VENUE).toContain('last_modified_by = p_user_id');
    expect(UPDATE_VENUE).toContain('coalesce(p_setup_minutes, setup_minutes)');
    expect(UPDATE_VENUE).toContain('coalesce(p_turnaround_minutes, turnaround_minutes)');
    expect(UPDATE_VENUE).toContain(
      'perform record_venue_attribute_change(p_id, v_before, venue_attribute_snapshot(p_id), p_user_id);',
    );
    // Flagging bookings writes no venue history of its own.
    expect(UPDATE_VENUE).not.toMatch(/insert into venue_change_history/);
    // Same as 023: no security definer.
    expect(headerOf(UPDATE_VENUE)).not.toMatch(/security definer/);
  });
});
