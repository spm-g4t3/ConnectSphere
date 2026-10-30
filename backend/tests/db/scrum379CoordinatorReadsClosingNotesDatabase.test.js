/**
 * SCRUM-384 (SCRUM-379 AC2): the coordinator reads of an event return the closing notes the
 * complete function stored, and the Organiser reads do not, on the real schema.
 *
 * The services run against a PGlite database built from the baseline and every migration, through
 * the shared PostgREST adapter. The database clock that complete_event_request reads is pinned, and
 * every event time is a fixed offset from it, so no test depends on when it runs.
 */
import { describe, it, expect, beforeAll } from 'vitest';

import {
  getEventRequestForCoordinator,
  getEventRequestForOrganiser,
  listEventRequestsForCoordinator,
  listEventRequestsForOrganiser,
} from '../../src/services/eventRequestService.js';
import { pgliteSupabaseClient } from '../fixtures/pgliteSupabaseClient.js';
import { withSafetyReviewTransitionGuardDisabled } from '../fixtures/safetyReviewTestHelpers.js';
import { useSchemaDb, seedEvent, seedUser } from './helpers/schemaDb.js';

const NOW_ISO = '2030-06-15T09:00:00Z';
const NOW = new Date(NOW_ISO);
const at = (seconds) => new Date(NOW.getTime() + seconds * 1000).toISOString();
const HOUR = 3600;

const NOTES = 'Attendance 180 of 200.\nProjector failed at 7pm; two attendees complained.';

const BOOKING_STATUS_EMBED = (table) =>
  `(select coalesce(json_agg(json_build_object('status', b.status)), '[]'::json)
      from bookings b where b.event_request_id = ${table}.id) as bookings`;
const RESERVATION_EMBED = (table) =>
  `(select coalesce(json_agg(json_build_object(
      'flagged', r.flagged, 'released_at', r.released_at, 'flag_reason', r.flag_reason, 'flag_code', r.flag_code)), '[]'::json)
      from equipment_reservations r where r.event_request_id = ${table}.id) as equipment_reservations`;
const RESERVATION_EMBED_TEXT = /\bequipment_reservations\(flagged, released_at, flag_reason, flag_code\)/;

function pgliteClient(db) {
  return pgliteSupabaseClient(db, {
    columns(cols, table) {
      const rest = cols.replace(/\bbookings\(status\)/, '').replace(RESERVATION_EMBED_TEXT, '');
      if (/\w+\(/.test(rest)) {
        throw new Error(`pgliteClient: an embed in "${cols}" is not on this path`);
      }
      return cols
        .replace(/\bbookings\(status\)/, BOOKING_STATUS_EMBED(table))
        .replace(RESERVATION_EMBED_TEXT, RESERVATION_EMBED(table));
    },
  });
}

describe('SCRUM-384: closing notes on the coordinator reads, on the real schema', () => {
  const getDb = useSchemaDb();
  let db;
  let client;
  let organiser;
  let coordinator;
  let otherCoordinator;
  let completedWithNotes;
  let completedWithoutNotes;
  let confirmedNotEnded;
  let confirmedEnded;

  async function confirmedEvent({ coordinatorId = coordinator, end = at(-HOUR), name }) {
    const eventId = await seedEvent(db, {
      status: 'approved',
      organiser_id: organiser,
      event_name: name,
      assigned_coordinator_id: coordinatorId,
      reviewing_coordinator_id: coordinatorId,
      proposed_start: new Date(Date.parse(end) - 2 * HOUR * 1000).toISOString(),
      proposed_end: end,
    });
    await withSafetyReviewTransitionGuardDisabled(db, () => db.query(
      "update event_requests set status = 'confirmed' where id = $1",
      [eventId],
    ));
    return eventId;
  }

  const complete = (eventId, notes) =>
    db.query('select * from complete_event_request($1, $2, $3)', [eventId, coordinator, notes]);

  beforeAll(async () => {
    db = getDb();
    client = pgliteClient(db);
    organiser = await seedUser(db, { email: 'organiser384@example.com', role: 'event_organiser', fullName: 'Olivia Organiser' });
    coordinator = await seedUser(db, { email: 'coordinator384@example.com', role: 'event_coordinator' });
    otherCoordinator = await seedUser(db, { email: 'other384@example.com', role: 'event_coordinator' });
    await db.query(`create or replace function event_clock() returns timestamptz language sql as $$ select '${NOW_ISO}'::timestamptz $$`);

    completedWithNotes = await confirmedEvent({ name: 'Completed with notes', end: at(-3 * HOUR) });
    await complete(completedWithNotes, NOTES);
    completedWithoutNotes = await confirmedEvent({ name: 'Completed without notes', end: at(-2 * HOUR) });
    await complete(completedWithoutNotes, null);
    confirmedEnded = await confirmedEvent({ name: 'Confirmed and ended', end: at(-HOUR) });
    confirmedNotEnded = await confirmedEvent({ name: 'Confirmed, still to come', end: at(24 * HOUR) });
  }, 120_000);

  const byId = (events, id) => events.find((event) => event.id === id);

  describe('the assigned coordinator\'s list', () => {
    it('SCRUM379_AC2_a_completed_event_carries_the_notes_the_complete_function_stored', async () => {
      const events = await listEventRequestsForCoordinator(coordinator, { client });

      expect(byId(events, completedWithNotes)).toMatchObject({ status: 'completed', closingNotes: NOTES });
    });

    it('SCRUM379_AC2_the_notes_keep_their_line_breaks', async () => {
      const events = await listEventRequestsForCoordinator(coordinator, { client });

      expect(byId(events, completedWithNotes).closingNotes).toContain('\n');
    });

    it('SCRUM379_AC2_a_completed_event_without_notes_has_closingNotes_null', async () => {
      const events = await listEventRequestsForCoordinator(coordinator, { client });

      expect(byId(events, completedWithoutNotes)).toMatchObject({ status: 'completed', closingNotes: null });
    });

    it('SCRUM379_AC2_events_that_are_not_completed_have_closingNotes_null', async () => {
      const events = await listEventRequestsForCoordinator(coordinator, { client });

      expect(byId(events, confirmedEnded)).toMatchObject({ status: 'confirmed', closingNotes: null });
      expect(byId(events, confirmedNotEnded)).toMatchObject({ status: 'confirmed', closingNotes: null });
    });

    it('SCRUM379_AC2_another_coordinator_does_not_get_the_notes_in_their_list', async () => {
      const events = await listEventRequestsForCoordinator(otherCoordinator, { client });

      expect(events).toEqual([]);
    });
  });

  describe('the event page read', () => {
    it('SCRUM379_AC2_asked_for_the_notes_a_completed_event_returns_them', async () => {
      const event = await getEventRequestForCoordinator(completedWithNotes, { client, withClosingNotes: true });

      expect(event).toMatchObject({ id: completedWithNotes, status: 'completed', closingNotes: NOTES });
    });

    it('SCRUM379_AC2_asked_for_the_notes_an_event_without_them_returns_null', async () => {
      const event = await getEventRequestForCoordinator(completedWithoutNotes, { client, withClosingNotes: true });

      expect(event.closingNotes).toBeNull();
    });

    it('SCRUM379_AC2_not_asked_the_notes_are_not_read_at_all', async () => {
      const event = await getEventRequestForCoordinator(completedWithNotes, { client });

      expect(event).not.toHaveProperty('closingNotes');
      expect(JSON.stringify(event)).not.toContain('Projector failed');
    });
  });

  describe('what an Organiser reads', () => {
    it('SCRUM379_AC2_the_organisers_list_shows_the_completed_event_without_the_notes', async () => {
      const events = await listEventRequestsForOrganiser(organiser, { client });

      expect(byId(events, completedWithNotes)).toMatchObject({ status: 'completed' });
      expect(byId(events, completedWithNotes)).not.toHaveProperty('closingNotes');
      expect(JSON.stringify(events)).not.toContain('Projector failed');
      expect(JSON.stringify(events)).not.toContain('closing');
    });

    it('SCRUM379_AC2_the_organisers_single_read_returns_the_completed_event_without_the_notes', async () => {
      const event = await getEventRequestForOrganiser(completedWithNotes, organiser, { client });

      expect(event).toMatchObject({ id: completedWithNotes, status: 'completed' });
      expect(event).not.toHaveProperty('closingNotes');
      expect(JSON.stringify(event)).not.toContain('Projector failed');
    });
  });
});
