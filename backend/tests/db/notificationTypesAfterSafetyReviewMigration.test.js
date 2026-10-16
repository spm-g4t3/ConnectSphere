import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migration = (name) => readFileSync(resolve(here, '../../db/migrations', name), 'utf8');

// The list 071 leaves behind: 066's decision types are missing.
const AFTER_071 = [
  'booking_flagged', 'booking_request_withdrawn', 'clarification_requested',
  'clarification_replied', 'clarification_closed', 'booking_flagged_setup_change',
  'venue_hold_expired', 'event_cancelled', 'event_request_awaiting_assignment',
  'event_request_assigned', 'event_request_coordinator_assigned', 'safety_review_response',
  'safety_booking_flagged', 'safety_equipment_review', 'event_submitted_for_safety_review',
];

describe('075 restores the booking decision notification types', () => {
  let db;

  const withTypes = async (types) => {
    await db.exec(`
      create table notifications (id serial primary key, type text not null);
      alter table notifications add constraint notifications_type_known
        check (type in (${types.map((t) => `'${t}'`).join(', ')}));
    `);
  };
  const insert = (type) => db.query('insert into notifications (type) values ($1)', [type]);

  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
  }, 60_000);
  afterEach(async () => {
    await db.exec('drop table if exists notifications');
  });
  afterAll(async () => {
    await db.close();
  });

  it('SCRUM258_AC6_decision_types_insert_after_071_then_075', async () => {
    await withTypes(AFTER_071);
    await expect(insert('booking_request_approved')).rejects.toThrow(/notifications_type_known/);

    await db.exec(migration('075_notification_types_after_safety_review.sql'));

    for (const type of ['booking_request_approved', 'booking_request_rejected', 'booking_request_conflicting']) {
      await expect(insert(type)).resolves.toBeDefined();
    }
    await expect(insert('event_submitted_for_safety_review')).resolves.toBeDefined();
  });

  it('SCRUM258_AC6_keeps_a_type_a_later_migration_added', async () => {
    await withTypes([...AFTER_071, 'some_later_type']);

    await db.exec(migration('075_notification_types_after_safety_review.sql'));

    await expect(insert('some_later_type')).resolves.toBeDefined();
    await expect(insert('not_a_type')).rejects.toThrow(/notifications_type_known/);
  });
});
