import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migration = (name) => readFileSync(resolve(here, '../../db/migrations', name), 'utf8');

describe('booking request status cancellation fix migration', () => {
  let db;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create type booking_status as enum (
        'approved',
        'flagged_for_review',
        'cancelled'
      );
    `);
    await db.exec(migration('046_booking_request_statuses_cancellation_fix.sql'));
  });

  afterAll(async () => {
    await db?.close();
  });

  it('adds the pending, rejected, and withdrawn booking states', async () => {
    const { rows } = await db.query(`
      select enumlabel
        from pg_enum
        join pg_type on pg_type.oid = pg_enum.enumtypid
       where pg_type.typname = 'booking_status'
    `);

    expect(rows.map(({ enumlabel }) => enumlabel)).toEqual([
      'approved',
      'flagged_for_review',
      'cancelled',
      'pending',
      'rejected',
      'withdrawn',
    ]);
  });

  it('can be applied again without duplicating enum labels', async () => {
    await db.exec(migration('046_booking_request_statuses_cancellation_fix.sql'));

    const { rows } = await db.query(`
      select enumlabel
        from pg_enum
        join pg_type on pg_type.oid = pg_enum.enumtypid
       where pg_type.typname = 'booking_status'
    `);

    expect(rows.filter(({ enumlabel }) => enumlabel === 'pending')).toHaveLength(1);
    expect(rows.filter(({ enumlabel }) => enumlabel === 'withdrawn')).toHaveLength(1);
  });
});
