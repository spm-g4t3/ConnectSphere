/**
 * SCRUM-486 (SCRUM-518), AC10-07: venue holds still expire after 052.
 *
 * 052 restates notifications_type_known, which is dropped and added whole
 * each time a type is added, so the list it restates is the list in force.
 * It must include venue_hold_expired, which 034's six do not. (Since the merge
 * of dev the list 052 restates is 048's eight, which include it; this suite
 * proves the venue-hold half, and 052's header argues the event_cancelled half.)
 * process_venue_hold_expiry (040) marks a lapsed hold expired and writes its
 * notice in one statement; if the type were not allowed, the notice insert
 * would fail and take the expiry with it, so holds would silently stop
 * expiring. docs/test-cases/SCRUM-486.md, AC10-04 (the list, pinned in
 * eventStatusLifecycleDatabase.test.js) and AC10-07 (the effect, here).
 *
 * Why a suite of its own rather than adding 052 to venueHoldsDatabase.test.js:
 * that suite is SCRUM-491's, and one of its cases writes an approved event
 * with no coordinator, which 017 has refused since SCRUM-330 and 052's relaxed
 * constraint still refuses (only a submitted request may have none). Adding
 * 052 there would break a SCRUM-491 test for a row production cannot hold.
 * Here every event has its coordinator, as in production.
 *
 * The migrations are venueHoldsDatabase's, with two differences: 025, SCRUM-19's
 * real decision columns, in place of that suite's stand-in, because 052
 * redefines decide_event_request, whose signature names 025's
 * event_request_decision type; and 039 and 052 at the end.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migration = (name) => readFileSync(resolve(here, '../../db/migrations', name), 'utf8');

const MIGRATIONS = [
  '001_event_requests.sql',
  '005_event_request_details.sql',
  '007_user_roles.sql',
  '010_event_request_clarifications.sql',
  '025_event_request_decisions.sql',
  '014_coordinator_assignment.sql',
  '002_venues.sql',
  '003_venue_audit.sql',
  '004_venue_functions.sql',
  '005_venue_retirement.sql',
  '008_venue_audit_completion.sql',
  '009_bookings.sql',
  '011_venue_blocks.sql',
  '012_venue_block_creation.sql',
  '013_venue_block_booking_conflicts.sql',
  '014_booking_review_notifications.sql',
  '015_venue_block_amend_remove.sql',
  '017_venue_turnaround.sql',
  '023_venue_setup_time.sql',
  '027_booking_request_statuses.sql',
  '028_booking_status_default_pending.sql',
  '030_create_booking_request.sql',
  '031_withdraw_booking_request.sql',
  '032_venue_occupancy.sql',
  '033_venue_occupancy_callers.sql',
  '034_setup_change_recheck.sql',
  '035_setup_change_recheck_refine.sql',
  '036_venue_safety_facts.sql',
  '040_venue_holds.sql',
  '039_coordinator_lead_and_safety_officer_roles.sql',
  '052_lead_assignment.sql',
];

/** 034's list: six types, without venue_hold_expired. Used only to show what restating it would do. */
const TYPES_034 = [
  'booking_flagged',
  'booking_request_withdrawn',
  'clarification_requested',
  'clarification_replied',
  'clarification_closed',
  'booking_flagged_setup_change',
];

const fromNow = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();

describe('SCRUM-486 AC10-07: venue holds still expire after 052', () => {
  let db;
  let organiser;
  let staff;
  let coordinator;
  let counter = 0;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const refusal = async (promise) => {
    try {
      await promise;
      return null;
    } catch (error) {
      return error;
    }
  };

  async function makeUser(role) {
    counter += 1;
    const id = (await one('insert into auth.users (email) values ($1) returning id', [`u${counter}@x`])).id;
    await db.query('insert into profiles (id, role) values ($1, $2)', [id, role]);
    return id;
  }

  /** An approved event with its coordinator, and a hold on a venue that lapsed five minutes ago. */
  async function lapsedHold() {
    counter += 1;
    const venueId = (await one(
      `insert into venues (name, location, max_capacity, setup_minutes, turnaround_minutes)
       values ($1, 'Block A', 200, 30, 45) returning id`,
      [`Harbour Room ${counter}`],
    )).id;
    const eventId = (await one(
      `insert into event_requests
         (organiser_id, event_name, status, proposed_start, proposed_end, expected_attendance,
          submitted_at, assigned_coordinator_id, reviewing_coordinator_id,
          decision, decided_by, decided_at)
       values ($1, $2, 'approved', $3, $4, 150, now(), $5, $5, 'approved', $5, now()) returning id`,
      [organiser, `Event ${counter}`, fromNow(14_400), fromNow(14_520), coordinator],
    )).id;
    const holdId = (await one(
      `insert into venue_holds (event_request_id, venue_id, placed_by, placed_at, expires_at)
       values ($1, $2, $3, $4, $5) returning id`,
      [eventId, venueId, staff, fromNow(-120), fromNow(-5)],
    )).id;
    return holdId;
  }

  const holdStatus = async (holdId) => (await one('select status from venue_holds where id = $1', [holdId])).status;

  async function restateTypes(types) {
    await db.exec('alter table notifications drop constraint if exists notifications_type_known');
    await db.exec(
      `alter table notifications add constraint notifications_type_known check (type in (${types.map((t) => `'${t}'`).join(', ')}))`,
    );
  }

  beforeAll(async () => {
    db = new PGlite({ extensions: { btree_gist } });
    await db.exec(`
      create schema auth;
      create table auth.users (id uuid primary key default gen_random_uuid(), email text);
      create role anon;
      create role authenticated;
    `);
    for (const name of MIGRATIONS) await db.exec(migration(name));
    organiser = await makeUser('event_organiser');
    staff = await makeUser('venue_staff');
    coordinator = await makeUser('event_coordinator');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it('SCRUM486_AC10_a_lapsed_hold_still_expires_and_is_notified_after_052', async () => {
    // AC10-07: process_venue_hold_expiry, run on a database that has had 052,
    // marks the hold expired and writes its venue_hold_expired notice.
    const holdId = await lapsedHold();

    await one('select process_venue_hold_expiry() as n');

    expect(await holdStatus(holdId)).toBe('expired');
    const notice = await one(
      "select recipient_id, type from notifications where venue_hold_id = $1", [holdId],
    );
    expect(notice).toEqual({ recipient_id: coordinator, type: 'venue_hold_expired' });
  });

  it("SCRUM486_AC10_restating_034s_list_would_break_hold_expiry_in_both_ways_052s_header_says", async () => {
    // The failure mode 052's header records, shown rather than asserted in a
    // comment, so the reason for restating 040's list can be checked.
    //
    // 1. With an expired hold's notice already present (the test above wrote
    //    one), re-adding 034's six is refused: 052 would not apply.
    const refused = await refusal(restateTypes(TYPES_034));
    expect(refused?.code).toBe('23514');

    // 2. With none present, it is accepted, and the next expiry run fails on
    //    its notice and takes the expiry with it: the hold stays active.
    await db.exec("delete from notifications where type = 'venue_hold_expired'");
    await restateTypes(TYPES_034);
    try {
      const holdId = await lapsedHold();

      const err = await refusal(one('select process_venue_hold_expiry() as n'));

      expect(err?.code).toBe('23514');
      expect(await holdStatus(holdId)).toBe('active');
    } finally {
      // Put back the list 052 restates, so nothing after this sees 034's.
      await restateTypes([
        ...TYPES_034,
        'venue_hold_expired',
        'event_cancelled',
        'event_request_awaiting_assignment',
        'event_request_assigned',
        'event_request_coordinator_assigned',
      ]);
    }
  });
});
