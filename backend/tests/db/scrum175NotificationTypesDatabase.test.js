import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createSchemaDb, seedEvent, seedUser } from './helpers/schemaDb.js';

// The notification types 042 adds for a confirmed event's changes, against the
// final schema: each needs its event, and widening the type list dropped none.
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_037 = resolve(here, '../../db/migrations/037_event_waiting_list.sql');
const MIGRATION_042 = resolve(here, '../../db/migrations/042_event_change_notification_types.sql');
const NEW_TYPES = ['event_confirmed', 'event_venue_changed'];
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
const liveTypes = async () => {
  const { rows } = await db.query(
    `select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'notifications'::regclass and conname = 'notifications_type_known'`,
  );
  expect(rows).toHaveLength(1);
  return typesIn(rows[0].def);
};

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

  it('SCRUM175_AC7_the_widened_list_keeps_037s_types_and_adds_each_new_type_once', async () => {
    const source037 = readFileSync(MIGRATION_037, 'utf8');
    const list037 = source037.match(/notifications_type_known check \(type = any \(array\[([\s\S]*?)\]\)\)/);
    expect(list037).not.toBeNull();

    const types = await liveTypes();
    expect(types).toEqual(expect.arrayContaining([...typesIn(list037[1]), ...NEW_TYPES]));
    expect(new Set(types).size).toBe(types.length);
  });

  // Another branch's migration may add a type before 042 runs (or 042 may be
  // pasted twice); 042 must keep that type and add nothing twice.
  it('SCRUM175_AC7_rerunning_042_keeps_a_type_another_migration_added', async () => {
    const before = await liveTypes();
    const withOther = [...before, 'another_branch_type'].map((t) => `'${t}'`).join(', ');
    await db.exec('begin');
    try {
      await db.exec(`alter table notifications drop constraint notifications_type_known;
        alter table notifications add constraint notifications_type_known check (type = any (array[${withOther}]))`);

      await db.exec(readFileSync(MIGRATION_042, 'utf8'));

      expect((await liveTypes()).sort()).toEqual([...before, 'another_branch_type'].sort());
    } finally {
      await db.exec('rollback');
    }
  });

  it.each(['event_cancelled', 'registration_promoted', 'event_significant_change_attendee', 'booking_released'])(
    'SCRUM175_AC7_existing_type_%s_still_inserts',
    async (type) => {
      const { rows } = await insert(type, event);
      expect(rows).toHaveLength(1);
    },
  );
});
