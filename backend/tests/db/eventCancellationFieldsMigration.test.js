import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migration = (name) => readFileSync(resolve(here, '../../db/migrations', name), 'utf8');

describe('SCRUM-371: cancellation fields migration', () => {
  let db;
  let organiser;
  let coordinator;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create schema auth;
      create table auth.users (
        id uuid primary key default gen_random_uuid(),
        email text
      );
    `);
    await db.exec(migration('001_event_requests.sql'));
    await db.exec(migration('006_event_change_requests.sql'));
    organiser = (await one('insert into auth.users (email) values ($1) returning id', ['organiser@test'])).id;
    coordinator = (await one('insert into auth.users (email) values ($1) returning id', ['coordinator@test'])).id;
  });

  afterAll(async () => {
    await db?.close();
  });

  async function makeEvent() {
    return (
      await one(
        `insert into event_requests (organiser_id, event_name, status)
         values ($1, 'Test event', 'submitted')
         returning id`,
        [organiser],
      )
    ).id;
  }

  it('adds cancellation fields without changing event status', async () => {
    await db.exec(migration('042_event_cancellation_fields.sql'));

    const eventId = await makeEvent();
    const cancelledAt = '2026-10-10T07:00:00Z';
    const result = await one(
      `update event_requests
       set cancellation_reason = 'Venue unavailable',
           cancellation_initiator = 'organiser_request',
           cancelled_by = $2,
           cancelled_at = $3,
           attendee_message = 'The event will not go ahead.'
       where id = $1
       returning status, cancellation_reason, cancellation_initiator,
                 cancelled_by, cancelled_at, attendee_message`,
      [eventId, coordinator, cancelledAt],
    );

    expect(result).toMatchObject({
      status: 'submitted',
      cancellation_reason: 'Venue unavailable',
      cancellation_initiator: 'organiser_request',
      cancelled_by: coordinator,
      attendee_message: 'The event will not go ahead.',
    });
    expect(new Date(result.cancelled_at).toISOString()).toBe(new Date(cancelledAt).toISOString());
  });

  it('rejects a blank cancellation reason', async () => {
    await db.exec(migration('042_event_cancellation_fields.sql'));
    const eventId = await makeEvent();

    await expect(
      db.query(
        `update event_requests
         set cancellation_reason = '   '
         where id = $1`,
        [eventId],
      ),
    ).rejects.toThrow(/event_requests_cancellation_reason_nonblank/);
  });

  it('allows change requests to be closed with the event-cancelled outcome', async () => {
    await db.exec(migration('042_event_cancellation_fields.sql'));
    const eventId = await makeEvent();
    const requestId = (
      await one(
        `insert into event_change_requests
           (event_request_id, requested_by, change_field, requested_change)
         values ($1, $2, 'other', 'Change the event format')
         returning id`,
        [eventId, organiser],
      )
    ).id;

    const { result: processed } = await one(
      `select to_jsonb(process_change_request($1, 'event_cancelled', null, $2)) as result`,
      [requestId, coordinator],
    );

    expect(processed.status).toBe('processed');
    expect(processed.decision).toBe('event_cancelled');
    expect(processed.processed_by).toBe(coordinator);
    expect(processed.processed_at).not.toBeNull();
  });

  it('is safe to apply twice and does not redefine or write event status', async () => {
    const sql = migration('042_event_cancellation_fields.sql');
    await db.exec(sql);
    await db.exec(sql);

    const normalized = sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').toLowerCase();
    expect(normalized).not.toMatch(/update event_requests set status|status\s*=/);
    expect(normalized).not.toMatch(/create or replace function/);
  });
});
