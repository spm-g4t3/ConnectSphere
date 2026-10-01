/**
 * Tests for the booking review columns, the notifications table,
 * flag_bookings_for_block and the redefined create_venue_block, read from the
 * migration text.
 *
 * SCRUM-128 (part of SCRUM-17, AC3). CI has no database, so these pin the
 * shape of 014_booking_review_notifications.sql with every `--` comment
 * stripped -- a rule that exists only in a comment does not count.
 *
 * 014 re-states 013's create_venue_block body, so 013's step order and its
 * "nothing written before the gate" rule are pinned here again: the copied
 * body must not drift from what 013's tests promise.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** The raw 014 migration, comments included. */
function rawSql() {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(
    resolve(here, '../../db/migrations/014_booking_review_notifications.sql'),
    'utf8',
  );
}

/** The 014 migration with every `--` comment stripped, whitespace collapsed. */
function migrationSql() {
  return rawSql().replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').toLowerCase();
}

const SQL = migrationSql();

const FLAG_START = 'create or replace function flag_bookings_for_block(';
const CREATE_START = 'create or replace function create_venue_block(';

/** One function's text: from its `create or replace` to the `$$;` that ends it. */
function functionText(start) {
  const from = SQL.indexOf(start);
  if (from === -1) return null;
  const end = SQL.indexOf('$$;', SQL.indexOf('$$', from) + 2);
  return end === -1 ? null : SQL.slice(from, end + 3);
}

/** The body between a function's $$ quotes. */
function bodyOf(text) {
  const open = text.indexOf('$$');
  const close = text.lastIndexOf('$$');
  return text.slice(open + 2, close);
}

const FLAG = functionText(FLAG_START);
const FLAG_BODY = FLAG ? bodyOf(FLAG) : '';
const CREATE = functionText(CREATE_START);
const CREATE_BODY = CREATE ? bodyOf(CREATE) : '';

/** The `alter table bookings add column ...;` statement. */
const BOOKINGS_ALTER = (SQL.match(/alter table bookings add column[^;]*;/) ?? [''])[0];

/** The `create table if not exists notifications ( ... );` statement. */
const NOTIFICATIONS_TABLE = (() => {
  const from = SQL.indexOf('create table if not exists notifications (');
  if (from === -1) return '';
  return SQL.slice(from, SQL.indexOf(');', SQL.indexOf('notifications_booking_flagged_needs_refs', from)) + 2);
})();

/** The UPDATE ... RETURNING inside flag_bookings_for_block. */
const FLAG_UPDATE = (FLAG_BODY.match(/update bookings b set ([\s\S]*?) returning b\.id/) ?? [])[0] ?? '';

/** The notifications insert inside flag_bookings_for_block. */
const NOTIFY_INSERT = (FLAG_BODY.match(/insert into notifications [^;]*;/) ?? [''])[0];


describe('the migration text', () => {
  it('defines both functions', () => {
    expect(FLAG).not.toBeNull();
    expect(CREATE).not.toBeNull();
  });

  it('finds the bookings alter, the notifications table, the update and the insert', () => {
    expect(BOOKINGS_ALTER).not.toBe('');
    expect(NOTIFICATIONS_TABLE).not.toBe('');
    expect(FLAG_UPDATE).not.toBe('');
    expect(NOTIFY_INSERT).not.toBe('');
  });
});


describe('bookings: review columns', () => {
  it('SCRUM17_AC3_adds_review_block_id_referencing_venue_blocks_on_delete_set_null', () => {
    expect(BOOKINGS_ALTER).toMatch(
      /add column if not exists review_block_id uuid references venue_blocks \(id\) on delete set null/,
    );
  });

  it('SCRUM17_AC3_adds_flagged_at_timestamptz', () => {
    expect(BOOKINGS_ALTER).toMatch(/add column if not exists flagged_at timestamptz/);
  });

  it('SCRUM17_AC3_adds_flagged_by_referencing_auth_users', () => {
    expect(BOOKINGS_ALTER).toMatch(
      /add column if not exists flagged_by uuid references auth\.users \(id\)/,
    );
  });

  it('keeps flagged_at and flagged_by nullable, and flagged_by is not cascaded', () => {
    expect(BOOKINGS_ALTER).not.toMatch(/not null/);
    expect(BOOKINGS_ALTER).not.toMatch(/flagged_by[^,;]*on delete cascade/);
  });

  it('SCRUM17_AC3_pairs_review_block_id_with_flagged_at', () => {
    expect(SQL).toMatch(
      /add constraint bookings_review_flag_paired check \( ?\( ?review_block_id is null ?\) = \( ?flagged_at is null ?\) ?\)/,
    );
  });

  it('guards the pairing constraint on pg_constraint so a re-run is safe', () => {
    const guard = SQL.indexOf(
      "if not exists ( select 1 from pg_constraint where conname = 'bookings_review_flag_paired' ) then",
    );
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(SQL.indexOf('add constraint bookings_review_flag_paired'));
  });

  it('does not tie the pairing to status', () => {
    const check = SQL.match(/add constraint bookings_review_flag_paired check ([^;]*);/);
    expect(check).not.toBeNull();
    expect(check[1]).not.toMatch(/status/);
  });

  it('SCRUM17_AC3_indexes_review_block_id_only_where_set', () => {
    expect(SQL).toMatch(
      /create index if not exists idx_bookings_review_block on bookings \(review_block_id\) where review_block_id is not null;/,
    );
  });
});


describe('notifications table', () => {
  it('SCRUM17_AC3_creates_notifications_idempotently_with_a_uuid_key', () => {
    expect(NOTIFICATIONS_TABLE).toMatch(/^create table if not exists notifications \(/);
    expect(NOTIFICATIONS_TABLE).toMatch(/id uuid primary key default gen_random_uuid\(\)/);
  });

  it('SCRUM17_AC3_recipient_is_required_and_cascades_with_the_account', () => {
    expect(NOTIFICATIONS_TABLE).toMatch(
      /recipient_id uuid not null references auth\.users \(id\) on delete cascade/,
    );
  });

  it('type is required text', () => {
    expect(NOTIFICATIONS_TABLE).toMatch(/type text not null/);
  });

  it('SCRUM17_AC3_booking_and_block_references_cascade', () => {
    expect(NOTIFICATIONS_TABLE).toMatch(/booking_id uuid references bookings \(id\) on delete cascade/);
    expect(NOTIFICATIONS_TABLE).toMatch(/block_id uuid references venue_blocks \(id\) on delete cascade/);
  });

  it('payload is required jsonb defaulting to an empty object', () => {
    expect(NOTIFICATIONS_TABLE).toMatch(/payload jsonb not null default '\{\}'/);
  });

  it('read_at is a nullable timestamp; created_at defaults to now()', () => {
    expect(NOTIFICATIONS_TABLE).toMatch(/read_at timestamptz,/);
    expect(NOTIFICATIONS_TABLE).not.toMatch(/read_at timestamptz not null/);
    expect(NOTIFICATIONS_TABLE).toMatch(/created_at timestamptz not null default now\(\)/);
  });

  it('has no is_read boolean', () => {
    expect(NOTIFICATIONS_TABLE).not.toMatch(/boolean/);
  });

  it('SCRUM17_AC3_type_check_allows_only_booking_flagged', () => {
    expect(NOTIFICATIONS_TABLE).toMatch(
      /constraint notifications_type_known check \(type in \('booking_flagged'\)\)/,
    );
  });

  it('SCRUM17_AC3_booking_flagged_needs_both_references', () => {
    expect(NOTIFICATIONS_TABLE).toMatch(
      /constraint notifications_booking_flagged_needs_refs check \( ?type <> 'booking_flagged' or \(booking_id is not null and block_id is not null\) ?\)/,
    );
  });

  it('SCRUM17_AC3_indexes_recipient_then_newest_first', () => {
    expect(SQL).toMatch(
      /create index if not exists idx_notifications_recipient_created on notifications \(recipient_id, created_at desc\);/,
    );
  });

  it('SCRUM17_AC3_enables_row_level_security_with_no_policies', () => {
    expect(SQL).toMatch(/alter table notifications enable row level security;/);
    expect(SQL).not.toMatch(/create policy/);
  });
});


describe('flag_bookings_for_block: signature', () => {
  it('SCRUM17_AC3_takes_block_booking_ids_and_optional_user', () => {
    expect(FLAG).toMatch(
      /flag_bookings_for_block\( ?p_block_id uuid, p_booking_ids uuid\[\], p_user_id uuid default null ?\)/,
    );
  });

  it('SCRUM17_AC3_returns_the_same_columns_as_the_conflict_helper', () => {
    expect(FLAG).toMatch(
      /returns table \( ?booking_id uuid, event_request_id uuid, event_name text, starts_at timestamptz, ends_at timestamptz ?\) language plpgsql as \$\$/,
    );
  });

  it('runs with invoker rights', () => {
    expect(FLAG).not.toMatch(/security definer/);
  });
});


describe('flag_bookings_for_block: the block', () => {
  it('reads only an active block', () => {
    expect(FLAG_BODY).toMatch(
      /select \* into v_block from venue_blocks vb where vb\.id = p_block_id and vb\.removed_at is null;/,
    );
  });

  it('raises no_data_found for a missing or removed block, before any write', () => {
    const raise = FLAG_BODY.search(
      /if not found then raise exception [^;]*errcode = 'no_data_found'/,
    );
    expect(raise).toBeGreaterThan(-1);
    expect(raise).toBeLessThan(FLAG_BODY.indexOf('update bookings'));
    expect(raise).toBeLessThan(FLAG_BODY.indexOf('insert into notifications'));
  });

  it('reads the venue name for the payload', () => {
    expect(FLAG_BODY).toMatch(/select v\.name into v_venue_name from venues v where v\.id = v_block\.venue_id;/);
  });
});


describe('flag_bookings_for_block: the update', () => {
  it('SCRUM17_AC3_sets_status_block_time_and_user', () => {
    expect(FLAG_UPDATE).toMatch(/set status = 'flagged_for_review', /);
    expect(FLAG_UPDATE).toMatch(/review_block_id = v_block\.id/);
    expect(FLAG_UPDATE).toMatch(/flagged_at = now\(\)/);
    expect(FLAG_UPDATE).toMatch(/flagged_by = p_user_id/);
  });

  it('SCRUM17_AC3_only_flags_listed_ids', () => {
    expect(FLAG_UPDATE).toMatch(/where b\.id = any \(coalesce\(p_booking_ids, '\{\}'\)\)/);
  });

  it('SCRUM17_AC3_only_flags_approved_bookings_on_the_blocks_venue', () => {
    expect(FLAG_UPDATE).toMatch(/and b\.status = 'approved'/);
    expect(FLAG_UPDATE).toMatch(/and b\.venue_id = v_block\.venue_id/);
  });

  it('SCRUM17_AC3_only_flags_bookings_overlapping_half_open', () => {
    expect(FLAG_UPDATE).toMatch(/and b\.starts_at < v_block\.ends_at/);
    expect(FLAG_UPDATE).toMatch(/and b\.ends_at > v_block\.starts_at/);
    expect(FLAG_UPDATE).not.toMatch(/<=|>=/);
  });

  it('collects exactly the updated ids via a CTE', () => {
    expect(FLAG_BODY).toMatch(/with flagged as \( update bookings b/);
    expect(FLAG_BODY).toMatch(
      /select coalesce\(array_agg\(flagged\.id order by flagged\.id\), '\{\}'::uuid\[\]\) into v_flagged from flagged;/,
    );
  });

  it('qualifies every column in the update with the b alias', () => {
    const where = FLAG_UPDATE.match(/where ([\s\S]*) returning/);
    expect(where).not.toBeNull();
    // Every bare column name on the booking side carries `b.`.
    for (const column of ['id', 'status', 'venue_id', 'starts_at', 'ends_at']) {
      expect(where[1]).toMatch(new RegExp(`b\\.${column}\\b`));
    }
  });
});


describe('flag_bookings_for_block: the notifications', () => {
  it('SCRUM17_AC3_inserts_booking_flagged_rows_for_flagged_bookings_only', () => {
    expect(NOTIFY_INSERT).toMatch(
      /^insert into notifications \(recipient_id, type, booking_id, block_id, payload\) select p\.id, 'booking_flagged', b\.id, v_block\.id, jsonb_build_object\(/,
    );
    expect(NOTIFY_INSERT).toMatch(/where b\.id = any \(v_flagged\)/);
  });

  it('SCRUM17_AC3_notifies_every_event_coordinator', () => {
    expect(NOTIFY_INSERT).toMatch(/cross join profiles p/);
    expect(NOTIFY_INSERT).toMatch(/and p\.role = 'event_coordinator';$/);
  });

  it('joins event_requests for the event name', () => {
    expect(NOTIFY_INSERT).toMatch(/join event_requests er on er\.id = b\.event_request_id/);
  });

  it('SCRUM17_AC3_payload_has_all_seven_camelcase_keys', () => {
    const payload = NOTIFY_INSERT.match(/jsonb_build_object\(([^)]*)\)/);
    expect(payload).not.toBeNull();
    const pairs = [
      ["'venuename'", 'v_venue_name'],
      ["'eventname'", 'er\\.event_name'],
      ["'startsat'", 'b\\.starts_at'],
      ["'endsat'", 'b\\.ends_at'],
      ["'reason'", 'v_block\\.reason'],
      ["'blockstartsat'", 'v_block\\.starts_at'],
      ["'blockendsat'", 'v_block\\.ends_at'],
    ];
    for (const [key, value] of pairs) {
      expect(payload[1], key).toMatch(new RegExp(`${key}, ${value}`));
    }
    // Exactly seven keys, nothing else.
    expect(payload[1].match(/'[a-z]+',/g)).toHaveLength(7);
  });

  it('keeps the camelCase in the raw file (lower-casing hides it above)', () => {
    const raw = rawSql();
    for (const key of [
      'venueName',
      'eventName',
      'startsAt',
      'endsAt',
      'reason',
      'blockStartsAt',
      'blockEndsAt',
    ]) {
      expect(raw).toContain(`'${key}',`);
    }
  });

  it('flags before it notifies, and returns last', () => {
    const update = FLAG_BODY.indexOf('update bookings b');
    const insert = FLAG_BODY.indexOf('insert into notifications');
    const ret = FLAG_BODY.indexOf('return query');
    expect(update).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(update);
    expect(ret).toBeGreaterThan(insert);
  });

  it('returns the flagged bookings soonest first, in the helper column order', () => {
    expect(FLAG_BODY).toMatch(
      /return query select b\.id, b\.event_request_id, er\.event_name, b\.starts_at, b\.ends_at from bookings b join event_requests er on er\.id = b\.event_request_id where b\.id = any \(v_flagged\) order by b\.starts_at, b\.id;/,
    );
  });
});


describe('flag_bookings_for_block: execute is revoked', () => {
  it('SCRUM17_AC3_revokes_execute_from_public_anon_and_authenticated', () => {
    expect(SQL).toMatch(
      /revoke execute on function flag_bookings_for_block\(uuid, uuid\[\], uuid\) from public, anon, authenticated;/,
    );
  });

  it('revokes after the function is defined', () => {
    expect(SQL.indexOf('revoke execute on function flag_bookings_for_block')).toBeGreaterThan(
      SQL.indexOf(FLAG_START),
    );
  });

  it('grants nothing back', () => {
    expect(SQL).not.toMatch(/\bgrant\b/);
  });
});


describe('no drop, no new rights', () => {
  it('SCRUM17_AC3_drops_no_function', () => {
    expect(SQL).not.toMatch(/drop function/);
  });

  it('SCRUM17_AC3_has_no_security_definer_or_search_path_outside_comments', () => {
    expect(SQL).not.toMatch(/security definer/);
    expect(SQL).not.toMatch(/set search_path/);
  });

  it('drops no table or column', () => {
    expect(SQL).not.toMatch(/drop table|drop column/);
  });
});


describe('create_venue_block signature', () => {
  it('SCRUM17_AC3_keeps_013s_eight_parameter_signature', () => {
    expect(SQL).toMatch(
      new RegExp(
        'create or replace function create_venue_block\\( ?' +
          'p_venue_id uuid, ' +
          'p_starts_at timestamptz, ' +
          'p_ends_at timestamptz, ' +
          'p_reason venue_block_reason, ' +
          'p_notes text default null, ' +
          'p_user_id uuid default null, ' +
          'p_confirm_override boolean default false, ' +
          'p_acknowledged_booking_ids uuid\\[\\] default null ?\\)',
      ),
    );
  });

  it('still returns jsonb in plpgsql', () => {
    expect(CREATE).toMatch(/\) returns jsonb language plpgsql as \$\$/);
  });

  it('defines create_venue_block exactly once', () => {
    expect(SQL.split(CREATE_START)).toHaveLength(2);
  });
});


describe('create_venue_block: order of the steps', () => {
  it('SCRUM17_AC3_steps_run_in_order_with_the_flag_after_the_insert', () => {
    const steps = [
      ['venue lock', 'from venues where id = p_venue_id for no key update;'],
      ['retired', "hint = 'venue_retired'"],
      ['period', 'if p_ends_at <= p_starts_at then'],
      ['block overlap', "hint = 'block_overlaps_block'"],
      ['booking lock', 'for no key update of b'],
      ['conflict return', "'outcome', 'conflict'"],
      ['insert', 'insert into venue_blocks'],
      ['flag', 'from flag_bookings_for_block(v_block.id, v_live_ids, p_user_id) f;'],
      ['created outcome', "'outcome', 'created'"],
    ];

    const positions = steps.map(([label, needle]) => [label, CREATE_BODY.indexOf(needle)]);
    for (const [label, at] of positions) {
      expect(at, label).toBeGreaterThan(-1);
    }
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i][1], `${positions[i - 1][0]} before ${positions[i][0]}`).toBeGreaterThan(
        positions[i - 1][1],
      );
    }
  });

  it('calls flag_bookings_for_block exactly once', () => {
    expect(CREATE_BODY.split('flag_bookings_for_block(')).toHaveLength(2);
  });

  it('takes the new block id from insert ... returning', () => {
    expect(CREATE_BODY).toMatch(/returning \* into v_block;/);
  });
});


describe('create_venue_block: the gate, re-pinned', () => {
  it('SCRUM17_AC3_gate_requires_confirm_and_every_live_booking_acknowledged', () => {
    expect(CREATE_BODY).toMatch(
      /if cardinality\(v_live_ids\) > 0 and not \( ?coalesce\(p_confirm_override, false\) and v_live_ids <@ coalesce\(p_acknowledged_booking_ids, '\{\}'\) ?\) then/,
    );
  });

  it('SCRUM17_AC3_conflict_branch_returns_before_any_write', () => {
    const conflictReturn = CREATE_BODY.indexOf(
      "return jsonb_build_object('outcome', 'conflict', 'conflicts', v_conflicts);",
    );
    expect(conflictReturn).toBeGreaterThan(-1);

    const beforeReturn = CREATE_BODY.slice(0, conflictReturn);
    expect(beforeReturn).not.toMatch(/\b(insert into|update \w+ set|delete from)\b/);
    expect(beforeReturn).not.toMatch(/flag_bookings_for_block/);
  });

  it('locks the approved, overlapping bookings as 013 does', () => {
    const where = CREATE_BODY.match(
      /with locked as \( select b\.id from bookings b where ([^)]*) order by b\.id for no key update of b \)/,
    );
    expect(where).not.toBeNull();
    expect(where[1]).toMatch(/b\.venue_id = p_venue_id/);
    expect(where[1]).toMatch(/b\.status = 'approved'/);
    expect(where[1]).toMatch(/b\.starts_at < p_ends_at/);
    expect(where[1]).toMatch(/b\.ends_at > p_starts_at/);
  });

  it('created_by and last_modified_by both take p_user_id', () => {
    expect(CREATE_BODY).toMatch(
      /insert into venue_blocks \( ?venue_id, starts_at, ends_at, reason, notes, created_by, last_modified_by ?\) values \( ?p_venue_id, p_starts_at, p_ends_at, p_reason, p_notes, p_user_id, p_user_id ?\)/,
    );
  });
});


describe('create_venue_block: the created outcome', () => {
  it('SCRUM17_AC3_created_outcome_includes_flagged_and_affected_bookings', () => {
    expect(CREATE_BODY).toMatch(
      /return jsonb_build_object\( ?'outcome', 'created', 'block', to_jsonb\(v_block\), 'affected_bookings', v_conflicts, 'flagged_bookings', v_flagged ?\);/,
    );
  });

  it('SCRUM17_AC3_flagged_list_defaults_to_an_empty_array_in_the_conflict_shape', () => {
    const agg = CREATE_BODY.match(
      /select coalesce\( ?jsonb_agg\( ?jsonb_build_object\(([^)]*)\) order by f\.starts_at, f\.booking_id ?\), '\[\]'::jsonb ?\) into v_flagged/,
    );
    expect(agg).not.toBeNull();
    expect(agg[1]).toMatch(
      /'booking_id', f\.booking_id, 'event_request_id', f\.event_request_id, 'event_name', f\.event_name, 'starts_at', f\.starts_at, 'ends_at', f\.ends_at/,
    );
  });

  it('declares v_flagged as jsonb', () => {
    expect(CREATE_BODY).toMatch(/v_flagged jsonb;/);
  });
});
