import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createSchemaDb, seedEvent, seedUser } from './helpers/schemaDb.js';

// The notification types 042 adds for a confirmed event's changes, against the
// final schema: each needs its event, and restating the type list dropped none.
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_037 = resolve(here, '../../db/migrations/037_event_waiting_list.sql');
const NEW_TYPES = ['event_confirmed', 'change_request_decided', 'event_venue_changed'];
let db;
let recipient;
let event;

const insert = (type, eventRequestId) => db.query(
  `insert into notifications (recipient_id, type, event_request_id, payload)
   values ($1, $2, $3, '{}'::jsonb) returning id`,
  [recipient, type, eventRequestId],
);
const refused = async (act, expected) => {
  await db.exec('begin');
  await expect(act()).rejects.toMatchObject(expected);
  await db.exec('rollback');
};
const typesIn = (text) => [...text.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

beforeAll(async () => {
  db = await createSchemaDb();
  recipient = await seedUser(db, { email: 'organiser@example.com', role: 'event_organiser' });
  event = await seedEvent(db, { organiser_id: recipient, event_name: 'Notified event' });
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('SCRUM175 042 notification types', () => {
  it.each(NEW_TYPES)('SCRUM175_AC7_%s_inserts_when_it_names_its_event', async (type) => {
    const { rows } = await insert(type, event);
    expect(rows).toHaveLength(1);
  });

  it.each(NEW_TYPES)('SCRUM175_AC7_%s_is_refused_without_an_event', async (type) => {
    await refused(() => insert(type, null), {
      code: '23514',
      constraint: `notifications_${type}_needs_event`,
    });
  });

  it('SCRUM175_AC7_an_unknown_type_is_still_refused', async () => {
    await refused(() => insert('event_reconfirmed_typo', event), {
      code: '23514',
      constraint: 'notifications_type_known',
    });
  });

  it('SCRUM175_AC7_the_restated_type_list_is_037s_list_plus_the_three_new_types', async () => {
    const source037 = readFileSync(MIGRATION_037, 'utf8');
    const list037 = source037.match(/notifications_type_known check \(type = any \(array\[([\s\S]*?)\]\)\)/);
    expect(list037).not.toBeNull();
    const expected = [...typesIn(list037[1]), ...NEW_TYPES].sort();

    const { rows } = await db.query(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'notifications'::regclass and conname = 'notifications_type_known'`,
    );
    expect(rows).toHaveLength(1);
    expect(typesIn(rows[0].def).sort()).toEqual(expected);
  });

  it.each(['event_cancelled', 'registration_promoted', 'event_significant_change_attendee', 'booking_released'])(
    'SCRUM175_AC7_existing_type_%s_still_inserts',
    async (type) => {
      const { rows } = await insert(type, event);
      expect(rows).toHaveLength(1);
    },
  );
});
