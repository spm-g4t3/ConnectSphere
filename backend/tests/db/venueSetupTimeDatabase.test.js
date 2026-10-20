/**
 * SCRUM-484 AC9: a setup-only change made through update_venue writes exactly
 * one venue_change_history row (the record_venue_change trigger) holding just
 * setup_minutes, on the final schema. setupChangeRecheckDatabase.test.js
 * covers a combined setup and turnaround change; this covers setup on its own.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb } from './helpers/schemaDb.js';

const ms = (value) => new Date(value).getTime();

describe('SCRUM-484 AC9: a setup change made through update_venue is audited', () => {
  let db;
  let staff;
  let counter = 0;

  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const rows = async (sql, params) => (await db.query(sql, params)).rows;
  const history = (venueId) =>
    rows('select * from venue_change_history where venue_id = $1 order by changed_at, id', [venueId]);

  async function makeUser(role) {
    counter += 1;
    const id = (await one('insert into auth.users (email) values ($1) returning id', [`u${counter}@x`])).id;
    if (role) await db.query('insert into profiles (id, role) values ($1, $2)', [id, role]);
    return id;
  }

  beforeAll(async () => {
    db = await createSchemaDb();
    staff = await makeUser('venue_staff');
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it('SCRUM484_AC9_setup_change_writes_one_history_row', async () => {
    const V = (
      await one(
        `insert into venues (name, location, max_capacity)
         values ('Harbour Room', 'Block A', 200) returning id`,
      )
    ).id;
    expect((await one('select setup_minutes from venues where id = $1', [V])).setup_minutes).toBe(0);
    const before = await history(V);
    const startedAt = Date.now();

    await db.query('select update_venue(p_id => $1, p_setup_minutes => 30, p_user_id => $2)', [V, staff]);

    const finishedAt = Date.now();
    const after = await history(V);
    expect(after).toHaveLength(before.length + 1);
    const [row] = after.slice(before.length);
    expect(row.changed_by).toBe(staff);
    expect(row.old_values).toEqual({ setup_minutes: 0 });
    expect(row.new_values).toEqual({ setup_minutes: 30 });
    expect(ms(row.changed_at)).toBeGreaterThanOrEqual(startedAt - 1000);
    expect(ms(row.changed_at)).toBeLessThanOrEqual(finishedAt + 1000);
  });

  it('SCRUM20_SCRUM137_update_venue_never_treats_0_as_missing', async () => {
    // 0 is "no setup time", a real value: only null means "leave it as it is".
    const V = (
      await one(
        `insert into venues (name, location, max_capacity, setup_minutes)
         values ('Quay Room', 'Block B', 80, 30) returning id`,
      )
    ).id;

    await db.query('select update_venue(p_id => $1, p_setup_minutes => 0, p_user_id => $2)', [V, staff]);

    expect((await one('select setup_minutes from venues where id = $1', [V])).setup_minutes).toBe(0);
  });
});
