import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSchemaDb, functionSources } from './helpers/schemaDb.js';
import { queriesFor } from './helpers/queries.js';
import { clientsCanExecute } from './helpers/grants.js';
import {
  STATUS,
  isKnownStatus,
  ACTIVE_EVENT_STATUSES,
  FINISHED_EVENT_STATUSES,
} from '../../src/domain/eventRequestStatus.js';

// Rules of the final schema that no single behaviour test can show: what is
// absent everywhere, who may call what, lock order, and the shape the API and
// the other suites rely on. Read from the catalog of the built schema.

let db;
let sources;

beforeAll(async () => {
  db = await createSchemaDb();
  sources = await functionSources(db);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

const { one, rows } = queriesFor(() => db);

// A function's code with every `--` comment stripped, so a rule that exists
// only in a comment does not count; whitespace collapsed, lower-cased, and the
// space just inside parentheses removed (layout, not behaviour).
function body(name) {
  expect(sources[name], `${name} is not defined`).toBeDefined();
  return sources[name]
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .toLowerCase()
    .trim();
}

const procedure = (name) =>
  one(
    `select p.oid,
            pg_get_function_arguments(p.oid) as args,
            pg_get_function_result(p.oid) as result,
            p.provolatile as volatility,
            p.proisstrict as strict,
            p.prosecdef as definer,
            p.proconfig as config,
            l.lanname as language
       from pg_proc p
       join pg_language l on l.oid = p.prolang
      where p.pronamespace = 'public'::regnamespace
        and p.proname = $1`,
    [name],
  );

const constraintDef = async (table, name) =>
  (
    await one(
      `select pg_get_constraintdef(oid) as def
         from pg_constraint
        where conrelid = $1::regclass and conname = $2`,
      [table, name],
    )
  )?.def;

async function columns(table) {
  const found = await rows(
    `select column_name, data_type, is_nullable, column_default
       from information_schema.columns
      where table_schema = 'public' and table_name = $1`,
    [table],
  );
  return Object.fromEntries(found.map((column) => [column.column_name, column]));
}

const indexDef = async (name) => (await one('select indexdef from pg_indexes where indexname = $1', [name]))?.indexdef;

const hasPolicy = async (table) =>
  (await one('select count(*)::int as n from pg_policy where polrelid = $1::regclass', [table])).n > 0;

const rowLevelSecurity = async (table) =>
  (await one('select relrowsecurity from pg_class where oid = $1::regclass', [table])).relrowsecurity;

/** Every needle is present, in the order given. */
function expectInOrder(text, steps) {
  const positions = steps.map(([label, needle]) => [label, text.indexOf(needle)]);
  for (const [label, at] of positions) {
    expect(at, label).toBeGreaterThan(-1);
  }
  for (let i = 1; i < positions.length; i += 1) {
    expect(positions[i][1], `${positions[i - 1][0]} before ${positions[i][0]}`).toBeGreaterThan(positions[i - 1][1]);
  }
}

const count = (text, needle) => text.split(needle).length - 1;

/** The quoted values of a CHECK's list, in order. */
const quotedValues = (def) => [...def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);


describe('SCRUM-172 / SCRUM-17: client roles are kept out by row level security', () => {
  it('SCRUM172_AC8_row_level_security_stays_enabled', async () => {
    const open = await rows(
      `select relname from pg_class
        where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and not relrowsecurity`,
    );

    expect(open).toEqual([]);
  });

  it('SCRUM172_AC8_no_table_in_the_schema_has_a_policy', async () => {
    const policies = await rows(
      `select polrelid::regclass::text as tablename, polname
         from pg_policy p join pg_class c on c.oid = p.polrelid
        where c.relnamespace = 'public'::regnamespace`,
    );

    expect(policies).toEqual([]);
  });

  it('SCRUM17_AC3_enables_row_level_security_with_no_policies', async () => {
    expect(await rowLevelSecurity('notifications')).toBe(true);
    expect(await hasPolicy('notifications')).toBe(false);
  });

  it('SCRUM17_AC4_enables_rls_with_no_policy', async () => {
    expect(await rowLevelSecurity('venue_block_history')).toBe(true);
    expect(await hasPolicy('venue_block_history')).toBe(false);
  });
});


describe('SCRUM-172 / SCRUM-572: only the API may call a function', () => {
  // Every check trusts its p_caller argument, so a client allowed EXECUTE could
  // call as anyone. btree_gist's functions come from the extension and read no rows.
  const ourFunctions = () => rows(
    `select p.oid, p.oid::regprocedure::text as signature
       from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and not exists (
          select 1 from pg_depend d
           where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
        )`,
  );

  it('SCRUM172_AC8_no_function_in_the_schema_is_executable_by_a_client_role', async () => {
    const functions = await ourFunctions();
    const callable = [];
    for (const { oid, signature } of functions) {
      if ((await clientsCanExecute(db, oid)).length > 0) callable.push(signature);
    }

    expect(functions.length).toBeGreaterThan(100);
    expect(callable).toEqual([]);
  });

  it('SCRUM172_AC8_service_role_can_execute_every_function', async () => {
    const missing = [];
    for (const { oid, signature } of await ourFunctions()) {
      if ((await clientsCanExecute(db, oid, ['service_role'])).length === 0) missing.push(signature);
    }

    expect(missing).toEqual([]);
  });

  it('SCRUM172_AC8_a_function_created_later_starts_revoked_from_the_client_roles', async () => {
    // The default privileges, so a later migration cannot forget its revoke.
    await db.exec('begin');
    try {
      await db.exec('create function zz_later_function() returns int language sql as $$ select 1 $$');
      expect(await clientsCanExecute(db, 'zz_later_function()', ['anon', 'authenticated', 'service_role']))
        .toEqual(['service_role']);
    } finally {
      await db.exec('rollback');
    }
  });
});


describe('no function runs with definer rights', () => {
  it('SCRUM17_AC4_is_not_security_definer', async () => {
    const definers = await rows(
      "select proname from pg_proc where pronamespace = 'public'::regnamespace and prosecdef",
    );

    expect(definers).toEqual([]);
  });

  it('SCRUM17_AC3_has_no_security_definer_or_search_path_outside_comments', async () => {
    for (const name of ['create_venue_block', 'flag_bookings_for_block']) {
      const fn = await procedure(name);
      expect(fn.definer, name).toBe(false);
      expect(fn.config, name).toBeNull();
    }
  });
});


describe('SCRUM-318 / SCRUM-327: the database has one draft -> submitted path', () => {
  it("sets status = 'submitted' only in the two definitions of submit_event_request", () => {
    // An assignment in a SET list, never a WHERE comparison.
    const setters = Object.keys(sources).filter((name) =>
      /\bset\b(?:(?!\bwhere\b)[^;])*?\bstatus = 'submitted'/.test(body(name)),
    );

    expect(setters).toEqual(['submit_event_request']);
  });

  it('replaces the two-argument function so there is no way to submit without history', async () => {
    const fn = await procedure('submit_event_request');

    expect(fn.args).toBe('p_event_request_id uuid, p_submitted_at timestamp with time zone, p_changed_by uuid');
  });
});


describe('SCRUM-321: the status history', () => {
  it.each([
    ['the event', 'event_request_id', 'uuid', 'NO', 'event_request_status_history_event_request_id_fkey', 'FOREIGN KEY (event_request_id) REFERENCES event_requests(id) ON DELETE RESTRICT'],
    ['the previous status', 'previous_status', 'USER-DEFINED', 'NO'],
    ['the new status', 'new_status', 'USER-DEFINED', 'NO'],
    ['the user who caused it', 'changed_by', 'uuid', 'NO', 'event_request_status_history_changed_by_fkey', 'FOREIGN KEY (changed_by) REFERENCES auth.users(id) ON DELETE RESTRICT'],
    ['the reason, optional', 'reason', 'text', 'YES'],
    ['the date and time, set by the database', 'created_at', 'timestamp with time zone', 'NO'],
  ])('records %s', async (_label, column, type, nullable, fk, fkDef) => {
    const found = (await columns('event_request_status_history'))[column];

    expect(found?.data_type).toBe(type);
    expect(found.is_nullable).toBe(nullable);
    if (column === 'created_at') expect(found.column_default).toBe('now()');
    if (fk) expect(await constraintDef('event_request_status_history', fk)).toBe(fkDef);
  });

  it('refuses a blank reason', async () => {
    expect(await constraintDef('event_request_status_history', 'event_request_status_history_reason_not_blank')).toBe(
      'CHECK (((reason IS NULL) OR (length(TRIM(BOTH FROM reason)) > 0)))',
    );
  });

  it('is deny-all and indexed for reading one event oldest first', async () => {
    expect(await rowLevelSecurity('event_request_status_history')).toBe(true);
    expect(await hasPolicy('event_request_status_history')).toBe(false);
    expect(await indexDef('idx_event_request_status_history_event')).toMatch(/\(event_request_id, created_at\)$/);
  });

  it('has no other writer among the schema functions', () => {
    // Each writer records the row in the statement block that changes the
    // status, so the two stand or fall together.
    const writers = Object.fromEntries(
      Object.keys(sources)
        .map((name) => [name, count(body(name), 'insert into event_request_status_history')])
        .filter(([, n]) => n > 0),
    );

    expect(writers).toEqual({
      change_event_request_status: 1,
      decide_event_request: 1,
      respond_to_safety_review: 1,
      start_event_review: 1,
      submit_event_request: 1,
    });
  });
});


describe('SCRUM-318: change_event_request_status', () => {
  it('never raises with P0001, which the service reads as "no coordinator available"', () => {
    // A raise with no errcode defaults to P0001, which the service cannot map.
    const fn = body('change_event_request_status');
    const raises = [...fn.matchAll(/raise exception [^;]*;/g)].map((m) => m[0]);

    expect(raises.length).toBeGreaterThan(0);
    for (const raise of raises) expect(raise).toMatch(/using errcode/);
    expect(fn).not.toMatch(/errcode = 'raise_exception'|errcode = 'p0001'/);
  });

  it('does not touch assignment, the coordinator or the selection rule', () => {
    const fn = body('change_event_request_status');

    expect(fn).not.toMatch(/insert into event_request_assignment_history/);
    expect(fn).not.toMatch(/assigned_coordinator_id = /);
    expect(fn).not.toMatch(/pick_event_coordinator/);
  });

  it('is immutable, because the answer depends only on its arguments', async () => {
    expect((await procedure('event_request_status_allows')).volatility).toBe('i');
  });

  it('has one signature, so no overload is left behind', async () => {
    const fn = await procedure('event_request_status_allows');

    expect(fn.args).toBe('p_from event_request_status, p_to event_request_status');
    expect(fn.result).toBe('boolean');
    expect(fn.language).toBe('sql');
  });
});


describe('SCRUM-572: functions nothing calls are dropped', () => {
  it('has no auto-assignment helper and no clarification functions without fields', async () => {
    // A leftover would still be callable and could bypass the Lead's queue or
    // the requested-fields rule.
    const left = await rows(
      `select proname from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname = any($1)`,
      [['pick_event_coordinator', 'request_event_clarification', 'reply_to_event_clarification']],
    );

    expect(left).toEqual([]);
  });
});


describe('SCRUM-487: every event status is classified for the overview', () => {
  // The four buckets. Every enum value is in exactly one.
  const BUCKETS = {
    // Never on the overview: an unsubmitted request has no coordinator.
    draft: [STATUS.DRAFT],
    active: [...ACTIVE_EVENT_STATUSES],
    finished: [...FINISHED_EVENT_STATUSES],
    // Postgres cannot drop an enum value; the lifecycle constraint refuses it.
    retired: ['planning'],
  };
  const CLASSIFIED = Object.values(BUCKETS).flat();

  const enumValues = async () =>
    (await rows("select unnest(enum_range(null::event_request_status))::text as value")).map((r) => r.value);

  it('SCRUM487_AC2_every_event_status_in_the_database_is_draft_active_finished_or_retired', async () => {
    const values = await enumValues();
    expect(values.length).toBeGreaterThan(0);

    const missing = values.filter((value) => !CLASSIFIED.includes(value));
    const message = missing.map((value) => (
      `"${value}" is in the event_request_status enum but in no bucket. If it is an active status, `
        + 'add it to ACTIVE_EVENT_STATUSES (backend/src/domain/eventRequestStatus.js), or the Lead\'s '
        + 'coordinator overview (SCRUM-487) silently leaves its events out; if it is a finished one, to '
        + 'FINISHED_EVENT_STATUSES. Give it a STATUS_DISPLAY entry too (backend/src/domain/eventRequestStatus.js).'
    )).join('\n');

    expect(missing, message).toEqual([]);
  });

  it('SCRUM487_AC2_no_status_is_in_two_buckets', () => {
    const twice = [...new Set(CLASSIFIED.filter((value, i) => CLASSIFIED.indexOf(value) !== i))];

    expect(twice, `in more than one bucket: ${twice.join(', ')}`).toEqual([]);
  });

  it('SCRUM487_AC3_every_listed_status_exists_in_the_database', async () => {
    // A typo, or a status listed before its migration: the read would fail on it (22P02).
    const values = await enumValues();
    const unknown = [...ACTIVE_EVENT_STATUSES, ...FINISHED_EVENT_STATUSES].filter((value) => !values.includes(value));

    expect(unknown, `listed but not in the event_request_status enum: ${unknown.join(', ')}`).toEqual([]);
  });

  it('SCRUM487_AC2_every_live_status_has_a_display_label', async () => {
    // Otherwise the overview's column heading reads "Unknown".
    const unlabelled = (await enumValues()).filter((value) => !BUCKETS.retired.includes(value) && !isKnownStatus(value));

    expect(unlabelled, `no STATUS_DISPLAY entry in backend/src/domain/eventRequestStatus.js for: ${unlabelled.join(', ')}`).toEqual([]);
  });

  it('SCRUM487_AC2_the_retired_status_is_refused_by_the_lifecycle_constraint', async () => {
    const allowed = quotedValues(await constraintDef('event_requests', 'event_requests_status_in_lifecycle'));

    expect(allowed.length).toBeGreaterThan(0);
    for (const retired of BUCKETS.retired) expect(allowed).not.toContain(retired);
  });
});


describe('SCRUM-17 AC3: the booking review columns and the notifications table', () => {
  it('SCRUM17_AC3_adds_review_block_id_referencing_venue_blocks_on_delete_set_null', async () => {
    expect(await constraintDef('bookings', 'bookings_review_block_id_fkey')).toBe(
      'FOREIGN KEY (review_block_id) REFERENCES venue_blocks(id) ON DELETE SET NULL',
    );
  });

  it('SCRUM17_AC3_adds_flagged_at_timestamptz', async () => {
    expect((await columns('bookings')).flagged_at?.data_type).toBe('timestamp with time zone');
  });

  it('SCRUM17_AC3_adds_flagged_by_referencing_auth_users', async () => {
    expect(await constraintDef('bookings', 'bookings_flagged_by_fkey')).toBe('FOREIGN KEY (flagged_by) REFERENCES auth.users(id)');
  });

  it('keeps flagged_at and flagged_by nullable, and flagged_by is not cascaded', async () => {
    const found = await columns('bookings');

    expect(found.flagged_at.is_nullable).toBe('YES');
    expect(found.flagged_by.is_nullable).toBe('YES');
    expect(await constraintDef('bookings', 'bookings_flagged_by_fkey')).not.toMatch(/CASCADE/);
  });

  it('does not tie the pairing to status', async () => {
    expect(await constraintDef('bookings', 'bookings_review_flag_paired')).not.toMatch(/status/);
  });

  it('SCRUM17_AC3_indexes_review_block_id_only_where_set', async () => {
    expect(await indexDef('idx_bookings_review_block')).toMatch(
      /ON public\.bookings USING btree \(review_block_id\) WHERE \(review_block_id IS NOT NULL\)$/,
    );
  });

  it('SCRUM17_AC3_creates_notifications_idempotently_with_a_uuid_key', async () => {
    const found = await columns('notifications');

    expect(found.id.data_type).toBe('uuid');
    expect(found.id.column_default).toBe('gen_random_uuid()');
    expect(await constraintDef('notifications', 'notifications_pkey')).toBe('PRIMARY KEY (id)');
  });

  it('SCRUM17_AC3_recipient_is_required_and_cascades_with_the_account', async () => {
    expect((await columns('notifications')).recipient_id.is_nullable).toBe('NO');
    expect(await constraintDef('notifications', 'notifications_recipient_id_fkey')).toBe(
      'FOREIGN KEY (recipient_id) REFERENCES auth.users(id) ON DELETE CASCADE',
    );
  });

  it('type is required text', async () => {
    const { type } = await columns('notifications');

    expect(type.data_type).toBe('text');
    expect(type.is_nullable).toBe('NO');
  });

  it('SCRUM17_AC3_booking_and_block_references_cascade', async () => {
    expect(await constraintDef('notifications', 'notifications_booking_id_fkey')).toBe(
      'FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE',
    );
    expect(await constraintDef('notifications', 'notifications_block_id_fkey')).toBe(
      'FOREIGN KEY (block_id) REFERENCES venue_blocks(id) ON DELETE CASCADE',
    );
  });

  it('payload is required jsonb defaulting to an empty object', async () => {
    const { payload } = await columns('notifications');

    expect(payload.data_type).toBe('jsonb');
    expect(payload.is_nullable).toBe('NO');
    expect(payload.column_default).toBe("'{}'::jsonb");
  });

  it('read_at is a nullable timestamp; created_at defaults to now()', async () => {
    const found = await columns('notifications');

    expect(found.read_at.data_type).toBe('timestamp with time zone');
    expect(found.read_at.is_nullable).toBe('YES');
    expect(found.created_at.is_nullable).toBe('NO');
    expect(found.created_at.column_default).toBe('now()');
  });

  it('has no is_read boolean', async () => {
    const booleans = Object.values(await columns('notifications')).filter((c) => c.data_type === 'boolean');

    expect(booleans).toEqual([]);
  });

  it('SCRUM17_AC3_booking_flagged_needs_both_references', async () => {
    expect(await constraintDef('notifications', 'notifications_booking_flagged_needs_refs')).toBe(
      "CHECK (((type <> 'booking_flagged'::text) OR ((booking_id IS NOT NULL) AND (block_id IS NOT NULL))))",
    );
  });

  it('SCRUM17_AC3_indexes_recipient_then_newest_first', async () => {
    expect(await indexDef('idx_notifications_recipient_created')).toMatch(/\(recipient_id, created_at DESC\)$/);
  });
});


describe('SCRUM-17: the venue block functions', () => {
  const VENUE_LOCK = 'from venues where id = p_venue_id for no key update;';
  const BLOCK_LOCK = 'from venue_blocks vb where vb.id = p_block_id and vb.venue_id = p_venue_id for no key update;';

  /** The acknowledgement gate: from `if cardinality(` to the `then` that closes it. */
  function gateOf(text) {
    const from = text.indexOf('if cardinality(v_live_ids)');
    return from === -1 ? null : text.slice(from, text.indexOf(' then', from) + ' then'.length);
  }

  /** The block functions lock bookings by their occupied period, against an unpadded block. */
  const lockedCte = (startArg, endArg) =>
    'with locked as (select b.id from bookings b ' +
    "where b.status = 'approved' and b.id in (select c.id " +
    `from venue_occupancy_conflicts(p_venue_id, ${startArg}, ${endArg}, false) c ` +
    "where c.kind = 'booking') order by b.id for no key update of b)";

  describe('signatures and execute rights', () => {
    it.each([
      ['SCRUM17_AC3_signature_adds_the_override_parameters_with_defaults', 'create_venue_block',
        'p_venue_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_reason venue_block_reason, p_notes text DEFAULT NULL::text, p_user_id uuid DEFAULT NULL::uuid, p_confirm_override boolean DEFAULT false, p_acknowledged_booking_ids uuid[] DEFAULT NULL::uuid[]',
        'jsonb'],
      ['SCRUM17_AC4_takes_ten_parameters_with_p_notes_supplied_defaulting_false', 'update_venue_block',
        'p_venue_id uuid, p_block_id uuid, p_starts_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_ends_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_reason venue_block_reason DEFAULT NULL::venue_block_reason, p_notes text DEFAULT NULL::text, p_notes_supplied boolean DEFAULT false, p_user_id uuid DEFAULT NULL::uuid, p_confirm_override boolean DEFAULT false, p_acknowledged_booking_ids uuid[] DEFAULT NULL::uuid[]',
        'jsonb'],
      ['SCRUM17_AC4_takes_three_parameters', 'remove_venue_block',
        'p_venue_id uuid, p_block_id uuid, p_user_id uuid DEFAULT NULL::uuid',
        'jsonb'],
      ['SCRUM17_AC3_takes_block_booking_ids_and_optional_user', 'flag_bookings_for_block',
        'p_block_id uuid, p_booking_ids uuid[], p_user_id uuid DEFAULT NULL::uuid',
        'TABLE(booking_id uuid, event_request_id uuid, event_name text, starts_at timestamp with time zone, ends_at timestamp with time zone)'],
    ])('%s', async (_name, fn, args, result) => {
      const found = await procedure(fn);

      expect(found.args).toBe(args);
      expect(found.result).toBe(result);
    });

    it('SCRUM17_AC3_returns_the_same_columns_as_the_conflict_helper', async () => {
      // The flagged list keeps the conflict helper's five columns, in its order.
      expect((await procedure('flag_bookings_for_block')).result).toBe(
        'TABLE(booking_id uuid, event_request_id uuid, event_name text, starts_at timestamp with time zone, ends_at timestamp with time zone)',
      );
    });

    it.each([
      ['SCRUM17_AC3_revokes_execute_from_public_anon_and_authenticated', 'flag_bookings_for_block'],
      ['SCRUM17_AC4_revokes_update_venue_block_from_public_anon_and_authenticated', 'update_venue_block'],
      ['SCRUM17_AC4_revokes_remove_venue_block_from_public_anon_and_authenticated', 'remove_venue_block'],
    ])('%s', async (_name, fn) => {
      expect(await clientsCanExecute(db, (await procedure(fn)).oid)).toEqual([]);
    });
  });

  describe('create_venue_block', () => {
    it('SCRUM17_AC1_locks_the_venue_row_for_no_key_update', () => {
      expect(body('create_venue_block')).toMatch(/^declare [^;]*(?:;[^;]*)*?begin select retired_at into v_retired_at from venues where id = p_venue_id for no key update;/);
    });

    it('raises no_data_found for an unknown venue', () => {
      expect(body('create_venue_block')).toMatch(/if not found then raise exception [^;]* errcode = 'no_data_found'/);
    });

    it('raises PT409 with hint VENUE_RETIRED for a retired venue', () => {
      expect(body('create_venue_block')).toMatch(
        /if v_retired_at is not null then raise exception [^;]*errcode = 'pt409', hint = 'venue_retired'/,
      );
    });

    it('refuses null bounds and bad periods with invalid_parameter_value (22023)', () => {
      const fn = body('create_venue_block');

      expect(fn).toMatch(/if p_starts_at is null or p_ends_at is null then raise exception [^;]*errcode = 'invalid_parameter_value'/);
      expect(fn).toMatch(/if p_ends_at <= p_starts_at then raise exception [^;]*errcode = 'invalid_parameter_value'/);
      expect(fn).toMatch(/if p_ends_at <= now\(\) then raise exception [^;]*errcode = 'invalid_parameter_value'/);
    });

    it('SCRUM17_AC1_period_checks_come_before_the_first_tstzrange', () => {
      // tstzrange() itself raises a bare data exception on a reversed period.
      const fn = body('create_venue_block');
      const firstRange = fn.indexOf('tstzrange');

      expect(firstRange).toBeGreaterThan(-1);
      for (const check of ['if p_starts_at is null or p_ends_at is null then', 'if p_ends_at <= p_starts_at then', 'if p_ends_at <= now() then']) {
        expect(fn.indexOf(check), check).toBeGreaterThan(-1);
        expect(fn.indexOf(check), check).toBeLessThan(firstRange);
      }
    });

    it('SCRUM17_AC1_overlap_query_only_sees_active_blocks_with_half_open_ranges', () => {
      const overlapQuery = body('create_venue_block').match(/select id into v_overlap_id from venue_blocks where ([^;]*);/);

      expect(overlapQuery).not.toBeNull();
      expect(overlapQuery[1]).toMatch(/venue_id = p_venue_id/);
      expect(overlapQuery[1]).toMatch(/removed_at is null/);
      expect(overlapQuery[1]).toMatch(/tstzrange\(starts_at, ends_at, '\[\)'\) && tstzrange\(p_starts_at, p_ends_at, '\[\)'\)/);
    });

    it('raises PT409 with hint BLOCK_OVERLAPS_BLOCK and the clashing id in detail', () => {
      expect(body('create_venue_block')).toMatch(/errcode = 'pt409', hint = 'block_overlaps_block', detail = v_overlap_id::text/);
    });

    it('SCRUM484_AC4_block_create_locks_bookings_by_occupied_period', () => {
      const fn = body('create_venue_block');

      expect(fn).toContain(lockedCte('p_starts_at', 'p_ends_at'));
      // The conflict list is the same function's rows, restricted to the bookings locked.
      expect(fn).toContain(
        "from venue_occupancy_conflicts(p_venue_id, p_starts_at, p_ends_at, false) c where c.kind = 'booking' and c.id = any (v_live_ids)",
      );
    });

    it('SCRUM17_AC3_gate_requires_confirm_and_every_live_booking_acknowledged', () => {
      expect(body('create_venue_block')).toMatch(
        /if cardinality\(v_live_ids\) > 0 and not \(coalesce\(p_confirm_override, false\) and v_live_ids <@ coalesce\(p_acknowledged_booking_ids, '\{\}'\)\) then/,
      );
    });

    it('SCRUM17_AC3_conflict_branch_returns_before_any_write', () => {
      const fn = body('create_venue_block');
      const conflictReturn = fn.indexOf("return jsonb_build_object('outcome', 'conflict', 'conflicts', v_conflicts);");

      expect(conflictReturn).toBeGreaterThan(-1);
      const beforeReturn = fn.slice(0, conflictReturn);
      expect(beforeReturn).not.toMatch(/\b(insert into|update \w+ set|delete from)\b/);
      expect(beforeReturn).not.toMatch(/flag_bookings_for_block/);
    });

    it('SCRUM17_AC1_created_by_and_last_modified_by_both_take_p_user_id', () => {
      expect(body('create_venue_block')).toMatch(
        /insert into venue_blocks \(venue_id, starts_at, ends_at, reason, notes, created_by, last_modified_by\) values \(p_venue_id, p_starts_at, p_ends_at, p_reason, p_notes, p_user_id, p_user_id\)/,
      );
    });

    it('SCRUM17_AC3_steps_run_in_order_with_the_flag_after_the_insert', () => {
      expectInOrder(body('create_venue_block'), [
        ['venue lock', VENUE_LOCK],
        ['retired', "hint = 'venue_retired'"],
        ['period', 'if p_ends_at <= p_starts_at then'],
        ['block overlap', "hint = 'block_overlaps_block'"],
        ['booking lock', 'for no key update of b'],
        ['conflict return', "'outcome', 'conflict'"],
        ['insert', 'insert into venue_blocks'],
        ['flag', 'from flag_bookings_for_block(v_block.id, v_live_ids, p_user_id) f;'],
        ['created outcome', "'outcome', 'created'"],
      ]);
    });
  });

  describe('update_venue_block', () => {
    it('SCRUM17_AC4_locks_the_venue_before_the_block', () => {
      expectInOrder(body('update_venue_block'), [
        ['venue lock', VENUE_LOCK],
        ['block lock', BLOCK_LOCK],
      ]);
    });

    it('SCRUM17_AC4_scopes_the_block_lookup_by_block_and_venue', () => {
      expect(body('update_venue_block')).toContain(BLOCK_LOCK);
    });

    it('SCRUM17_AC4_raises_no_data_found_for_a_missing_venue_and_a_missing_block', () => {
      const fn = body('update_venue_block');

      expectInOrder(fn, [
        ['venue lock', VENUE_LOCK],
        ['venue not found', "errcode = 'no_data_found'"],
        ['block lock', BLOCK_LOCK],
      ]);
      expect(fn.slice(fn.indexOf(BLOCK_LOCK))).toMatch(/if not found then raise exception [^;]*errcode = 'no_data_found';/);
    });

    it('SCRUM17_AC4_refuses_removed_then_ended_then_retired', () => {
      expectInOrder(body('update_venue_block'), [
        ['block lock', BLOCK_LOCK],
        ['removed check', 'if v_block.removed_at is not null then'],
        ['removed hint', "hint = 'block_removed'"],
        ['ended check', 'if v_block.ends_at <= now() then'],
        ['ended hint', "hint = 'block_ended'"],
        ['retired check', 'if v_retired_at is not null then'],
        ['retired hint', "hint = 'venue_retired'"],
      ]);
    });

    it('SCRUM17_AC4_state_refusals_are_pt409', () => {
      const fn = body('update_venue_block');

      expect(fn).toMatch(/errcode = 'pt409', hint = 'block_removed'/);
      expect(fn).toMatch(/errcode = 'pt409', hint = 'block_ended'/);
      expect(fn).toMatch(/errcode = 'pt409', hint = 'venue_retired'/);
    });

    it('SCRUM17_AC4_coalesces_start_end_and_reason_onto_the_stored_row', () => {
      const fn = body('update_venue_block');

      expect(fn).toContain('v_starts_at := coalesce(p_starts_at, v_block.starts_at);');
      expect(fn).toContain('v_ends_at := coalesce(p_ends_at, v_block.ends_at);');
      expect(fn).toContain('v_reason := coalesce(p_reason, v_block.reason);');
    });

    it('SCRUM17_AC4_picks_notes_by_p_notes_supplied', () => {
      expect(body('update_venue_block')).toContain(
        'v_notes := case when coalesce(p_notes_supplied, false) then p_notes else v_block.notes end;',
      );
    });

    it('SCRUM17_AC4_checks_the_merged_order_and_future_end', () => {
      const fn = body('update_venue_block');

      expect(fn).toMatch(/if v_ends_at <= v_starts_at then raise exception [^;]*errcode = 'invalid_parameter_value';/);
      expect(fn).toMatch(/if v_ends_at <= now\(\) then raise exception [^;]*errcode = 'invalid_parameter_value';/);
    });

    it('SCRUM17_AC4_refuses_reason_other_without_notes_as_22023', () => {
      expect(body('update_venue_block')).toMatch(
        /if v_reason = 'other' and length\(trim\(coalesce\(v_notes, ''\)\)\) = 0 then raise exception [^;]*errcode = 'invalid_parameter_value';/,
      );
    });

    it('SCRUM17_AC4_every_22023_check_runs_before_the_first_tstzrange', () => {
      const fn = body('update_venue_block');
      const firstRange = fn.indexOf('tstzrange(');
      const checks = [...fn.matchAll(/errcode = 'invalid_parameter_value'/g)].map((m) => m.index);

      expect(firstRange).toBeGreaterThan(-1);
      expect(checks.length).toBeGreaterThanOrEqual(3);
      for (const at of checks) expect(at).toBeLessThan(firstRange);
    });

    describe('overlap with another block', () => {
      const overlap = () => (body('update_venue_block').match(/select vb\.id into v_overlap_id from venue_blocks vb where [^;]*;/) ?? [''])[0];

      it('SCRUM17_AC4_only_active_blocks_on_the_venue_count', () => {
        expect(overlap()).toContain('vb.venue_id = p_venue_id');
        expect(overlap()).toContain('vb.removed_at is null');
      });

      it('SCRUM17_AC4_excludes_the_block_being_amended', () => {
        expect(overlap()).toContain('vb.id <> p_block_id');
      });

      it('SCRUM17_AC4_compares_half_open_ranges_of_the_merged_period', () => {
        expect(overlap()).toContain("tstzrange(vb.starts_at, vb.ends_at, '[)') && tstzrange(v_starts_at, v_ends_at, '[)')");
      });

      it('SCRUM17_AC4_raises_block_overlaps_block_with_the_id_in_detail', () => {
        expect(body('update_venue_block')).toMatch(
          /if v_overlap_id is not null then raise exception [^;]*errcode = 'pt409', hint = 'block_overlaps_block', detail = v_overlap_id::text;/,
        );
      });
    });

    it('SCRUM484_AC4_block_amend_locks_bookings_by_occupied_period', () => {
      const fn = body('update_venue_block');

      // Against the merged bounds, never the raw parameters.
      expect(fn).toContain(lockedCte('v_starts_at', 'v_ends_at'));
      expect(fn).not.toContain('venue_occupancy_conflicts(p_venue_id, p_starts_at');
      expect(fn).toContain(
        "from venue_occupancy_conflicts(p_venue_id, v_starts_at, v_ends_at, false) c where c.kind = 'booking' and c.id = any (v_live_ids)",
      );
    });

    it('SCRUM17_AC3_gate_is_identical_to_create_venue_block_gate', () => {
      const createGate = gateOf(body('create_venue_block'));

      expect(createGate).not.toBeNull();
      expect(gateOf(body('update_venue_block'))).toBe(createGate);
    });

    it('SCRUM17_AC3_conflict_return_precedes_any_write', () => {
      const fn = body('update_venue_block');
      const conflictReturn = fn.indexOf("return jsonb_build_object('outcome', 'conflict', 'conflicts', v_conflicts);");

      expect(conflictReturn).toBeGreaterThan(-1);
      expect(conflictReturn).toBeLessThan(fn.indexOf('update venue_blocks'));
      const beforeReturn = fn.slice(0, conflictReturn);
      expect(beforeReturn).not.toMatch(/\b(insert into|update \w+( \w+)? set|delete from)\b/);
      expect(beforeReturn).not.toMatch(/flag_bookings_for_block/);
    });

    it('SCRUM17_AC4_steps_run_in_order', () => {
      expectInOrder(body('update_venue_block'), [
        ['venue lock', VENUE_LOCK],
        ['block lock', BLOCK_LOCK],
        ['removed', "hint = 'block_removed'"],
        ['ended', "hint = 'block_ended'"],
        ['retired', "hint = 'venue_retired'"],
        ['merge', 'v_starts_at := coalesce('],
        ['period', 'if v_ends_at <= v_starts_at then'],
        ['block overlap', "hint = 'block_overlaps_block'"],
        ['booking lock', 'for no key update of b'],
        ['conflict return', "'outcome', 'conflict'"],
        ['update', 'update venue_blocks'],
        ['flag', 'flag_bookings_for_block('],
        ['updated outcome', "'outcome', 'updated'"],
      ]);
    });

    it('SCRUM17_AC4_update_writes_the_merged_values_and_last_modified_by_the_user', () => {
      const update = (body('update_venue_block').match(/update venue_blocks vb set ([^;]*?) where vb\.id = p_block_id returning \* into v_block;/) ?? [])[1];

      expect(update).toBeDefined();
      for (const assignment of ['starts_at = v_starts_at', 'ends_at = v_ends_at', 'reason = v_reason', 'notes = v_notes', 'last_modified_by = p_user_id']) {
        expect(update).toContain(assignment);
      }
    });

    it('SCRUM17_AC3_flag_call_passes_the_amending_user', () => {
      const fn = body('update_venue_block');

      expect(fn).toContain('from flag_bookings_for_block(v_block.id, v_live_ids, p_user_id) f;');
      expect(count(fn, 'flag_bookings_for_block(')).toBe(1);
    });

    it('SCRUM17_AC3_never_updates_bookings_directly', () => {
      expect(body('update_venue_block')).not.toMatch(/update bookings/);
    });
  });

  describe('remove_venue_block', () => {
    it('SCRUM17_AC4_locks_the_venue_then_the_block', () => {
      expectInOrder(body('remove_venue_block'), [
        ['venue lock', VENUE_LOCK],
        ['block lock', BLOCK_LOCK],
      ]);
    });

    it('SCRUM17_AC4_raises_no_data_found_for_missing_venue_and_block', () => {
      expect(count(body('remove_venue_block'), "errcode = 'no_data_found'")).toBeGreaterThanOrEqual(2);
    });

    it('SCRUM17_AC4_refuses_removed_then_ended', () => {
      expectInOrder(body('remove_venue_block'), [
        ['block lock', BLOCK_LOCK],
        ['removed', "errcode = 'pt409', hint = 'block_removed'"],
        ['ended check', 'if v_block.ends_at <= now() then'],
        ['ended', "errcode = 'pt409', hint = 'block_ended'"],
        ['update', 'update venue_blocks'],
      ]);
    });

    it('SCRUM17_AC4_has_no_retired_venue_check', () => {
      expect(body('remove_venue_block')).not.toMatch(/venue_retired|retired_at/);
    });

    it('SCRUM17_AC4_soft_deletes_recording_who_and_when', () => {
      const update = (body('remove_venue_block').match(/update venue_blocks vb set ([^;]*?) where vb\.id = p_block_id/) ?? [])[1];

      expect(update).toBeDefined();
      expect(update).toContain('removed_at = now()');
      expect(update).toContain('removed_by = p_user_id');
      expect(update).toContain('last_modified_by = p_user_id');
    });

    it('SCRUM17_AC4_touches_no_booking_and_deletes_nothing', () => {
      const fn = body('remove_venue_block');

      expect(fn).not.toMatch(/update bookings/);
      expect(fn).not.toMatch(/flag_bookings_for_block/);
      // A removed block stays on record: nothing anywhere deletes one.
      expect(Object.keys(sources).filter((name) => /delete from venue_blocks/.test(body(name)))).toEqual([]);
    });

    it('SCRUM17_AC4_returns_removed_with_the_block', () => {
      expect(body('remove_venue_block')).toMatch(/return jsonb_build_object\('outcome', 'removed', 'block', to_jsonb\(v_block\)\);/);
    });
  });

  describe('flag_bookings_for_block', () => {
    const flagUpdate = () => (body('flag_bookings_for_block').match(/update bookings b set ([\s\S]*?) returning b\.id/) ?? [])[0] ?? '';

    it('raises no_data_found for a missing or removed block, before any write', () => {
      const fn = body('flag_bookings_for_block');
      const raise = fn.search(/if not found then raise exception [^;]*errcode = 'no_data_found'/);

      expect(fn).toMatch(/select \* into v_block from venue_blocks vb where vb\.id = p_block_id and vb\.removed_at is null;/);
      expect(raise).toBeGreaterThan(-1);
      expect(raise).toBeLessThan(fn.indexOf('update bookings'));
      expect(raise).toBeLessThan(fn.indexOf('insert into notifications'));
    });

    it('SCRUM17_AC3_sets_status_block_time_and_user', () => {
      expect(flagUpdate()).toMatch(/set status = 'flagged_for_review', /);
      expect(flagUpdate()).toMatch(/review_block_id = v_block\.id/);
      expect(flagUpdate()).toMatch(/flagged_at = now\(\)/);
      expect(flagUpdate()).toMatch(/flagged_by = p_user_id/);
    });

    it('SCRUM17_AC3_only_flags_listed_ids', () => {
      expect(flagUpdate()).toMatch(/where b\.id = any \(coalesce\(p_booking_ids, '\{\}'\)\)/);
    });

    it('SCRUM17_AC3_only_flags_approved_bookings_on_the_blocks_venue', () => {
      expect(flagUpdate()).toMatch(/and b\.status = 'approved'/);
      expect(flagUpdate()).toMatch(/and b\.venue_id = v_block\.venue_id/);
    });

    it('SCRUM17_AC3_payload_has_all_seven_camelcase_keys', () => {
      // Read with case kept: the API returns the payload to the frontend as stored.
      const source = sources.flag_bookings_for_block.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ');
      const insert = source.match(/insert into notifications [^;]*?'booking_flagged'[^;]*?jsonb_build_object\(([^)]*)\)/);

      expect(insert).not.toBeNull();
      const keys = [...insert[1].matchAll(/'(\w+)',/g)].map((m) => m[1]);
      expect(keys).toEqual(['venueName', 'eventName', 'startsAt', 'endsAt', 'reason', 'blockStartsAt', 'blockEndsAt']);
    });
  });
});


describe('SCRUM-17 AC4: the venue block history', () => {
  const insertBranch = () => {
    const fn = body('record_venue_block_change');
    const from = fn.indexOf("if tg_op = 'insert' then");
    return from === -1 ? '' : fn.slice(from, fn.indexOf('end if;', from) + 'end if;'.length);
  };
  const updatePath = () => {
    const fn = body('record_venue_block_change');
    return insertBranch() ? fn.slice(fn.indexOf(insertBranch()) + insertBranch().length) : '';
  };

  it('SCRUM17_AC4_has_a_uuid_primary_key_with_a_default', async () => {
    const { id } = await columns('venue_block_history');

    expect(id.data_type).toBe('uuid');
    expect(id.column_default).toBe('gen_random_uuid()');
    expect(await constraintDef('venue_block_history', 'venue_block_history_pkey')).toBe('PRIMARY KEY (id)');
  });

  it('SCRUM17_AC4_block_id_references_venue_blocks_on_delete_restrict', async () => {
    expect((await columns('venue_block_history')).block_id.is_nullable).toBe('NO');
    expect(await constraintDef('venue_block_history', 'venue_block_history_block_id_fkey')).toBe(
      'FOREIGN KEY (block_id) REFERENCES venue_blocks(id) ON DELETE RESTRICT',
    );
  });

  it('SCRUM17_AC4_nothing_cascades', async () => {
    const keys = await rows(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'venue_block_history'::regclass and contype = 'f'",
    );

    expect(keys.length).toBeGreaterThan(0);
    for (const { def } of keys) expect(def).not.toMatch(/CASCADE/);
  });

  it('SCRUM17_AC4_action_is_text_with_a_named_check_of_exactly_three_values', async () => {
    expect(quotedValues(await constraintDef('venue_block_history', 'venue_block_history_action_known'))).toEqual([
      'created', 'amended', 'removed',
    ]);
  });

  it('SCRUM17_AC4_action_is_not_an_enum', async () => {
    expect((await columns('venue_block_history')).action.data_type).toBe('text');
  });

  it('SCRUM17_AC4_changed_by_references_auth_users_and_is_nullable', async () => {
    expect((await columns('venue_block_history')).changed_by.is_nullable).toBe('YES');
    expect(await constraintDef('venue_block_history', 'venue_block_history_changed_by_fkey')).toBe(
      'FOREIGN KEY (changed_by) REFERENCES auth.users(id)',
    );
  });

  it('SCRUM17_AC4_changed_at_is_not_null_and_defaults_to_now', async () => {
    const { changed_at: changedAt } = await columns('venue_block_history');

    expect(changedAt.data_type).toBe('timestamp with time zone');
    expect(changedAt.is_nullable).toBe('NO');
    expect(changedAt.column_default).toBe('now()');
  });

  it('SCRUM17_AC4_old_and_new_values_are_jsonb_not_null', async () => {
    const found = await columns('venue_block_history');

    for (const column of ['old_values', 'new_values']) {
      expect(found[column].data_type, column).toBe('jsonb');
      expect(found[column].is_nullable, column).toBe('NO');
    }
  });

  it('SCRUM17_AC4_has_no_venue_id_column', async () => {
    expect(await columns('venue_block_history')).not.toHaveProperty('venue_id');
  });

  it('SCRUM17_AC4_indexes_block_id_then_changed_at_desc', async () => {
    expect(await indexDef('idx_venue_block_history_block')).toMatch(/\(block_id, changed_at DESC\)$/);
  });

  it('SCRUM17_AC4_defines_the_function_once_as_a_plpgsql_trigger', async () => {
    const fn = await procedure('record_venue_block_change');

    expect(fn.result).toBe('trigger');
    expect(fn.language).toBe('plpgsql');
  });

  it('SCRUM17_AC4_does_not_read_auth_uid', () => {
    // The API writes with the secret key, so auth.uid() would be null here.
    expect(body('record_venue_block_change')).not.toContain('auth.uid');
  });

  it('SCRUM17_AC4_insert_writes_a_created_row_by_last_modified_by_with_empty_old_values', () => {
    expect(insertBranch()).toContain(
      "values (new.id, 'created', new.last_modified_by, '{}'::jsonb, new_row - 'updated_at' - 'last_modified_by');",
    );
    expect(insertBranch()).toContain('return null;');
  });

  it('SCRUM17_AC4_the_new_row_is_the_whole_record', () => {
    expect(body('record_venue_block_change')).toContain('new_row jsonb := to_jsonb(new);');
    expect(updatePath()).toContain('old_row := to_jsonb(old);');
  });

  it('SCRUM17_AC4_update_diff_skips_updated_at_and_last_modified_by', () => {
    expect(updatePath()).toContain("if col in ('updated_at', 'last_modified_by') then continue; end if;");
  });

  it('SCRUM17_AC4_update_diff_uses_is_distinct_from', () => {
    expect(updatePath()).toContain('if old_row -> col is distinct from new_row -> col then');
    expect(updatePath()).toContain('for col in select jsonb_object_keys(new_row) loop');
  });

  it('SCRUM17_AC4_an_empty_diff_returns_before_the_update_insert', () => {
    const fn = body('record_venue_block_change');
    const inserts = [...fn.matchAll(/insert into venue_block_history/g)].map((m) => m.index);
    const emptyCheck = fn.indexOf("if old_changed = '{}'::jsonb then return null; end if;");

    expect(inserts).toHaveLength(2);
    expect(emptyCheck).toBeGreaterThan(inserts[0]);
    expect(emptyCheck).toBeLessThan(inserts[1]);
  });

  it('SCRUM17_AC4_names_removal_only_on_the_null_to_set_transition', () => {
    expect(updatePath()).toContain(
      "case when old.removed_at is null and new.removed_at is not null then 'removed' else 'amended' end",
    );
  });

  it('SCRUM17_AC4_the_update_row_records_last_modified_by_and_only_the_changed_keys', () => {
    expectInOrder(updatePath(), [
      ['insert', 'insert into venue_block_history (block_id, action, changed_by, old_values, new_values)'],
      ['block id', 'new.id,'],
      ['action', 'case when'],
      ['changed_by', 'new.last_modified_by,'],
      ['old', 'old_changed,'],
      ['new', 'new_changed);'],
    ]);
  });

  it('SCRUM17_AC4_never_writes_the_block_table_itself', () => {
    expect(body('record_venue_block_change')).not.toMatch(/update venue_blocks|insert into venue_blocks|delete from/);
  });

  it('SCRUM17_AC4_fires_after_insert_or_update_for_each_row', async () => {
    const trigger = await one(
      "select pg_get_triggerdef(oid) as def from pg_trigger where tgname = 'venue_blocks_record_change'",
    );

    expect(trigger?.def).toBe(
      'CREATE TRIGGER venue_blocks_record_change AFTER INSERT OR UPDATE ON public.venue_blocks FOR EACH ROW EXECUTE FUNCTION record_venue_block_change()',
    );
  });
});


describe('SCRUM-17 AC4: nothing writes a booking period', () => {
  /** Every UPDATE of bookings in every function, with the columns its SET assigns. */
  function bookingUpdates() {
    return Object.keys(sources).flatMap((name) => {
      const fn = body(name);
      return [...fn.matchAll(/\bupdate (?:only )?(?:public\.)?bookings\b/g)].map((match) => {
        const rest = fn.slice(match.index);
        const set = rest.indexOf(' set ');
        const stops = [' where ', ' returning ', ';', ' from '].map((stop) => rest.indexOf(stop, set)).filter((i) => i !== -1);
        const clause = rest.slice(set + 5, Math.min(...stops));
        return { name, clause, columns: [...clause.matchAll(/(?:^|,)\s*(?:\w+\.)?(\w+)\s*=/g)].map((m) => m[1]) };
      });
    });
  }

  it('SCRUM17_AC4_no_update_of_bookings_sets_starts_at_or_ends_at', () => {
    const updates = bookingUpdates();

    expect(updates.length).toBeGreaterThan(5);
    for (const { name, clause, columns: assigned } of updates) {
      expect(assigned, `${name}: set ${clause}`).not.toContain('starts_at');
      expect(assigned, `${name}: set ${clause}`).not.toContain('ends_at');
    }
  });

  it('SCRUM17_AC4_only_create_booking_request_inserts_bookings', () => {
    // The one insert is the booking request itself: a new row with the event's own period.
    const inserters = Object.keys(sources).filter((name) => /\binsert into (?:public\.)?bookings\b/.test(body(name)));

    expect(inserters).toEqual(['create_booking_request']);
  });

  it('SCRUM17_AC4_no_trigger_is_created_on_bookings', async () => {
    // Triggers on bookings may refuse or annotate a write, never move its period.
    const triggers = await rows(
      `select p.proname from pg_trigger t join pg_proc p on p.oid = t.tgfoid
        where t.tgrelid = 'bookings'::regclass and not t.tgisinternal`,
    );

    expect(triggers.length).toBeGreaterThan(0);
    for (const { proname } of triggers) {
      expect(body(proname), proname).not.toMatch(/\bnew\.(starts_at|ends_at)\s*:?=(?!=)/);
    }
  });
});


describe('SCRUM-484 AC3 and AC4: one occupied-period rule', () => {
  /** The formula, as venue_occupied_period writes it. */
  const FORMULA =
    'tstzrange(p_starts_at - make_interval(mins => p_setup_minutes), ' +
    "p_ends_at + make_interval(mins => p_turnaround_minutes), '[)')";

  it('SCRUM484_AC3_occupied_period_function_is_defined_once_with_the_formula', async () => {
    const fn = await procedure('venue_occupied_period');

    expect(fn.args).toBe(
      'p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_setup_minutes integer, p_turnaround_minutes integer',
    );
    expect(fn.result).toBe('tstzrange');
    expect(fn.volatility).toBe('i');
    expect(fn.strict).toBe(true);
    // Written once, there, and nowhere else.
    expect(Object.keys(sources).filter((name) => body(name).includes(FORMULA))).toEqual(['venue_occupied_period']);
    expect(body('venue_occupancy_conflicts')).not.toContain('tstzrange(');
  });

  it('SCRUM484_AC3_minutes_come_from_the_venue_not_the_caller', async () => {
    // No minutes parameter: the caller cannot supply its own.
    expect((await procedure('venue_occupancy_conflicts')).args).not.toMatch(/minutes/);
    const fn = body('venue_occupancy_conflicts');
    expect(fn).toMatch(/from venues v where v\.id = p_venue_id/);
    expect(fn).toMatch(/v\.setup_minutes/);
    expect(fn).toMatch(/v\.turnaround_minutes/);
  });

  it('SCRUM484_AC4_conflicts_function_uses_the_period_function_and_occupying_statuses', async () => {
    expect((await procedure('venue_occupancy_conflicts')).volatility).toBe('s');
    const fn = body('venue_occupancy_conflicts');

    expect(fn).not.toMatch(/\bfor (update|share|no key update|key share)\b/);
    // Bookings: the occupying allow-list, compared through the one formula.
    expect(fn).toContain("b.status in ('approved', 'flagged_for_review')");
    expect(fn).toMatch(/venue_occupied_period\(b\.starts_at, b\.ends_at, req\.setup_minutes, req\.turnaround_minutes\) && req\.period/);
    // Blocks: active only, raw (0, 0), compared through the one formula.
    expect(fn).toContain('vb.removed_at is null');
    expect(fn).toMatch(/venue_occupied_period\(vb\.starts_at, vb\.ends_at, 0, 0\) && req\.period/);
    // The requested range is padded only when p_pad_requested.
    expect(fn).toContain(
      'case when p_pad_requested then venue_occupied_period(p_starts_at, p_ends_at, ven.setup_minutes, ven.turnaround_minutes) else venue_occupied_period(p_starts_at, p_ends_at, 0, 0) end as period',
    );
  });

  it('SCRUM484_AC4_no_copy_of_the_overlap_rule_remains_in_sql', () => {
    // Anything that reads as a period overlap: a range `&&`, or a strict `<` / `>`
    // on a period column. `<=` / `>=` are input validation, never a half-open overlap.
    const OVERLAP = /&&|\b(?:\w+\.)?(?:starts_at|ends_at|proposed_start|proposed_end)\s*(?:<(?!=)|>(?!=))/g;
    // The functions that are the rule. pending_request_overlaps is the one home of
    // pending-vs-period overlap, which venue_occupancy_conflicts never answers.
    const THE_RULE = ['venue_occupied_period', 'venue_occupancy_conflicts', 'pending_request_overlaps'];
    // Block against block stays raw against raw (AC6); venue_blocks_no_overlap is the guarantee.
    const BLOCK_VS_BLOCK = {
      create_venue_block: "tstzrange(starts_at, ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')",
      update_venue_block: "tstzrange(vb.starts_at, vb.ends_at, '[)') && tstzrange(v_starts_at, v_ends_at, '[)')",
    };
    // SCRUM-174 AC5: a block tells the open requests it covers. Neither shared
    // function answers that (one skips open requests, the other would pad the block).
    const BLOCK_VS_OPEN_REQUEST = {
      flag_bookings_for_block:
        'venue_occupied_period(b.starts_at, b.ends_at, v.setup_minutes::integer, v.turnaround_minutes::integer) ' +
        '&& venue_occupied_period(v_block.starts_at, v_block.ends_at, 0, 0)',
    };
    // A start or end compared with the clock, not two periods, an exact number of times.
    const NOT_STARTED = {
      // The two clash sets, and the re-check of bookings shortened hours leave out.
      update_venue: { text: 'b.starts_at > now()', count: 3 },
      retire_venue: { text: 'b.ends_at > now()', count: 2 },
    };

    for (const name of THE_RULE) expect(sources[name], name).toBeDefined();
    expect(sources).not.toHaveProperty('venue_block_booking_conflicts');

    const offenders = [];
    for (const name of Object.keys(sources)) {
      if (THE_RULE.includes(name)) continue;
      let rest = body(name);
      if (BLOCK_VS_BLOCK[name]) {
        expect(rest, `${name}: block-vs-block`).toContain(BLOCK_VS_BLOCK[name]);
        rest = rest.split(BLOCK_VS_BLOCK[name]).join(' ');
      }
      if (BLOCK_VS_OPEN_REQUEST[name]) {
        const parts = rest.split(BLOCK_VS_OPEN_REQUEST[name]);
        expect(parts.length - 1, `${name}: block-vs-open-request, exactly 1x`).toBe(1);
        rest = parts.join(' ');
      }
      if (NOT_STARTED[name]) {
        const { text, count: times } = NOT_STARTED[name];
        const parts = rest.split(text);
        expect(parts.length - 1, `${name}: not-started filter, exactly ${times}x`).toBe(times);
        rest = parts.join(' ');
      }
      for (const m of rest.matchAll(OVERLAP)) {
        offenders.push(`${name}: ...${rest.slice(Math.max(0, m.index - 50), m.index + 50)}...`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('SCRUM484_AC4_the_only_overlap_constraint_is_venue_blocks_no_overlap', async () => {
    const exclusions = await rows(
      "select conname, pg_get_constraintdef(oid) as def from pg_constraint where contype = 'x' and connamespace = 'public'::regnamespace",
    );

    expect(exclusions.map((c) => c.conname)).toEqual(['venue_blocks_no_overlap']);
    expect(exclusions[0].def).toMatch(/^EXCLUDE USING gist \(.*tstzrange\(starts_at, ends_at, '\[\)'::text\) WITH &&\)/);
  });

  it('SCRUM484_AC4_available_venue_ids_returns_a_venue_id_table', async () => {
    const fn = await procedure('available_venue_ids');

    expect(fn.args).toMatch(/^p_venue_ids uuid\[\], p_starts_at timestamp with time zone, p_ends_at timestamp with time zone/);
    expect(fn.result).toBe('TABLE(venue_id uuid)');
    expect(fn.volatility).toBe('s');
  });
});


describe('SCRUM-484 AC8: the setup-change re-check in update_venue', () => {
  const LOCK =
    'select v.setup_minutes, v.turnaround_minutes into v_old_setup, v_old_turnaround from venues v where v.id = p_id for no key update;';
  const GUARD = 'if v_new_setup is distinct from v_old_setup or v_new_turnaround is distinct from v_old_turnaround then';

  /** The query that fills a set of clashing bookings, up to its `;`. */
  function candidateQuery(text, target) {
    const start = text.indexOf(`select coalesce(array_agg(b.id order by b.id), '{}'::uuid[]) into ${target} from bookings b`);
    return start === -1 ? null : { start, text: text.slice(start, text.indexOf(';', start) + 1) };
  }

  it('SCRUM484_AC8_recheck_runs_under_the_venue_lock_only_on_change', () => {
    const fn = body('update_venue');
    const guard = fn.indexOf(GUARD);

    // The venue row locked with its old minutes, the update, the new minutes
    // read back, then the re-check guarded by a real change of either.
    expectInOrder(fn, [
      ['lock', LOCK],
      ['missing venue refused', "using errcode = 'no_data_found'"],
      ['update', 'update venues set'],
      ['new minutes', 'select v.setup_minutes, v.turnaround_minutes, v.name into v_new_setup, v_new_turnaround, v_venue_name from venues v where v.id = p_id;'],
      ['guard', GUARD],
    ]);
    expect(fn.indexOf('venue_occupancy_conflicts(', guard)).toBeGreaterThan(guard);
  });

  it('SCRUM484_AC8_update_venue_returns_flags_in_one_transaction', async () => {
    const fn = body('update_venue');

    expect((await procedure('update_venue')).result).toBe('jsonb');
    expect(fn).toContain("return jsonb_build_object('flagged_bookings', v_flagged_list);");
    // The flag and the notifications are in this one function, with no handler swallowing them.
    expect(fn).toMatch(/update bookings b set status = 'flagged_for_review', review_reason = 'setup_or_turnaround_changed'/);
    expect(fn).toMatch(/insert into notifications \(recipient_id, type, booking_id, block_id, payload\)/);
    expect(fn).not.toMatch(/\bexception when\b/);
    expect(fn).not.toMatch(/\bcommit\b/);
  });

  it('SCRUM484_AC8_old_clash_set_is_collected_under_the_lock_before_the_update', () => {
    const fn = body('update_venue');
    const oldSet = candidateQuery(fn, 'v_old_clashing');

    expect(oldSet).not.toBeNull();
    expectInOrder(fn, [
      ['lock', LOCK],
      ['missing venue refused', "using errcode = 'no_data_found'"],
    ]);
    expect(oldSet.start).toBeGreaterThan(fn.indexOf("using errcode = 'no_data_found'"));
    expect(oldSet.start).toBeLessThan(fn.indexOf('update venues set'));
    // One venues lock, and the old set collected once.
    expect(count(fn, 'for no key update;')).toBe(1);
    expect(count(fn, 'into v_old_clashing')).toBe(1);
  });

  it('SCRUM484_AC8_old_and_new_sets_use_the_same_condition_and_function', () => {
    const fn = body('update_venue');
    const oldSet = candidateQuery(fn, 'v_old_clashing');
    const newSet = candidateQuery(fn, 'v_clashing');

    expect(newSet).not.toBeNull();
    // Word for word the same query; only the target differs.
    expect(oldSet.text).toBe(newSet.text.replace('into v_clashing', 'into v_old_clashing'));
    expect(newSet.text).toMatch(/venue_occupancy_conflicts\(p_id, b\.starts_at, b\.ends_at, true\)/);
  });
});


describe('SCRUM-15 / SCRUM-186 / SCRUM-20 / SCRUM-493: the venue fields', () => {
  it('SCRUM186_the_column_is_added_with_if_not_exists_smallint_not_null_default_0', async () => {
    const { turnaround_minutes: turnaround } = await columns('venues');

    expect(turnaround.data_type).toBe('smallint');
    expect(turnaround.is_nullable).toBe('NO');
    expect(turnaround.column_default).toBe('0');
  });

  it.each([
    ['SCRUM186_the_constraint_lists_exactly_the_agreed_values', 'venues_turnaround_minutes_allowed', 'turnaround_minutes'],
    ['SCRUM20_SCRUM137_the_constraint_lists_exactly_the_agreed_values', 'venues_setup_minutes_allowed', 'setup_minutes'],
  ])('%s', async (_name, constraint, column) => {
    expect(await constraintDef('venues', constraint)).toBe(
      `CHECK ((${column} = ANY (ARRAY[0, 15, 30, 45, 60, 90, 120])))`,
    );
  });

  it.each(['emergency_access', 'known_restrictions'])(
    'SCRUM493_AC1_%s_check_has_the_length_bound_and_the_non_whitespace_rule',
    async (column) => {
      expect(await constraintDef('venues', `venues_${column}_length`)).toBe(
        `CHECK (((${column} IS NULL) OR (((char_length(${column}) >= 1) AND (char_length(${column}) <= 2000)) AND (${column} ~ '[^[:space:]]'::text))))`,
      );
    },
  );

  it('SCRUM493_AC1_the_check_and_the_trim_use_the_same_whitespace_class', () => {
    // So the database and the trim agree on what blank is. btrim() strips only spaces.
    for (const name of ['create_venue', 'update_venue']) {
      expect(count(body(name), "'^[[:space:]]+|[[:space:]]+$'"), name).toBe(2);
      expect(body(name), name).not.toMatch(/\bbtrim\(|\btrim\(/);
    }
  });

  it('SCRUM493_AC1_the_new_signatures_add_two_text_parameters_before_the_user', async () => {
    const tail =
      'p_turnaround_minutes integer DEFAULT NULL::integer, p_setup_minutes integer DEFAULT NULL::integer, ' +
      'p_emergency_access text DEFAULT NULL::text, p_known_restrictions text DEFAULT NULL::text, p_user_id uuid DEFAULT NULL::uuid';
    const create = await procedure('create_venue');
    const update = await procedure('update_venue');

    expect(create.args).toBe(
      "p_name text, p_location text, p_max_capacity integer, p_layouts text[] DEFAULT '{}'::text[], p_accessibility text[] DEFAULT '{}'::text[], " +
      `p_facilities text[] DEFAULT '{}'::text[], p_hours jsonb DEFAULT '[]'::jsonb, ${tail}`,
    );
    expect(create.result).toBe('uuid');
    expect(update.args).toBe(
      'p_id uuid, p_name text DEFAULT NULL::text, p_location text DEFAULT NULL::text, p_max_capacity integer DEFAULT NULL::integer, ' +
      'p_layouts text[] DEFAULT NULL::text[], p_accessibility text[] DEFAULT NULL::text[], p_facilities text[] DEFAULT NULL::text[], ' +
      `p_hours jsonb DEFAULT NULL::jsonb, ${tail}, p_hours_flag_booking_ids uuid[] DEFAULT NULL::uuid[]`,
    );
    expect(update.result).toBe('jsonb');
  });

  const ATTRIBUTE_TABLES = ['venue_room_layouts', 'venue_accessibility_features', 'venue_facilities', 'venue_operating_hours'];

  it.each(ATTRIBUTE_TABLES)('SCRUM20_SCRUM137_create_venue_still_writes_%s', (table) => {
    expect(body('create_venue')).toContain(`insert into ${table} (venue_id,`);
  });

  it.each(ATTRIBUTE_TABLES)('SCRUM20_SCRUM137_update_venue_still_replaces_%s_only_when_given', (table) => {
    expectInOrder(body('update_venue'), [
      [`delete ${table}`, `delete from ${table} where venue_id = p_id;`],
      [`insert ${table}`, `insert into ${table} (venue_id,`],
    ]);
  });

  it.each(['p_layouts', 'p_accessibility', 'p_facilities', 'p_hours'])(
    'SCRUM20_SCRUM137_update_venue_still_guards_%s_with_is_not_null',
    (param) => {
      expect(body('update_venue')).toContain(`if ${param} is not null then`);
    },
  );

  it('SCRUM186_venue_attribute_snapshot_is_only_called_not_changed', () => {
    // The minutes stay out of the snapshot so a change is recorded once, by
    // record_venue_change's diff.
    expect(body('venue_attribute_snapshot')).not.toMatch(/turnaround|setup/);
  });

  describe('SCRUM186 the per-weekday operating hours model', () => {
    it('SCRUM186_one_window_per_day_primary_key_venue_id_day_of_week', async () => {
      expect(await constraintDef('venue_operating_hours', 'venue_operating_hours_pkey')).toBe('PRIMARY KEY (venue_id, day_of_week)');
    });

    it('SCRUM186_day_of_week_is_checked_between_0_and_6', async () => {
      expect((await columns('venue_operating_hours')).day_of_week.data_type).toBe('smallint');
      expect(await constraintDef('venue_operating_hours', 'venue_operating_hours_day_of_week_check')).toBe(
        'CHECK (((day_of_week >= 0) AND (day_of_week <= 6)))',
      );
    });

    it('SCRUM575_AC3_closing_may_be_earlier_than_opening_but_never_equal', async () => {
      expect(await constraintDef('venue_operating_hours', 'venue_operating_hours_ordered')).toBeUndefined();
      expect(await constraintDef('venue_operating_hours', 'venue_operating_hours_not_empty')).toBe('CHECK ((closes_at <> opens_at))');
    });

    it('SCRUM186_opens_and_closes_are_time_of_day_not_null', async () => {
      const found = await columns('venue_operating_hours');

      for (const column of ['opens_at', 'closes_at']) {
        expect(found[column].data_type, column).toBe('time without time zone');
        expect(found[column].is_nullable, column).toBe('NO');
      }
    });

    it('SCRUM186_there_is_no_closed_flag_a_missing_day_is_closed', async () => {
      expect(Object.keys(await columns('venue_operating_hours')).sort()).toEqual(['closes_at', 'day_of_week', 'opens_at', 'venue_id']);
    });
  });
});


describe('SCRUM-23: equipment_availability is the one read-only answer', () => {
  it('SCRUM23_AC12_is_one_create_or_replace_function_returning_jsonb', async () => {
    // functionSources refuses an overload, so the name is one function.
    expect(sources.equipment_availability).toBeDefined();
    expect((await procedure('equipment_availability')).result).toBe('jsonb');
  });

  it('SCRUM23_AC12_takes_the_type_the_period_and_an_optional_event', async () => {
    expect((await procedure('equipment_availability')).args).toBe(
      'p_equipment_type_id uuid, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_event_request_id uuid DEFAULT NULL::uuid',
    );
  });

  it('SCRUM23_AC3_counts_only_reservations_of_this_type', () => {
    expect(body('equipment_availability')).toMatch(/where r\.equipment_type_id = p_equipment_type_id\b/);
  });
});
