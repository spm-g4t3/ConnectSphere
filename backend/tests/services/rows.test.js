/**
 * Tests for the row readers the services share.
 */

import { describe, it, expect, vi } from 'vitest';

import { one, readNames } from '../../src/services/rows.js';

describe('one', () => {
  it('returns an embedded object as it is', () => {
    const row = { id: 'a' };
    expect(one(row)).toBe(row);
  });

  it('takes the first of an embedded array', () => {
    expect(one([{ id: 'a' }, { id: 'b' }])).toEqual({ id: 'a' });
    expect(one([])).toBeUndefined();
  });

  it('passes a missing embed through', () => {
    expect(one(null)).toBeNull();
    expect(one(undefined)).toBeUndefined();
  });
});

function fakeDb(result) {
  const query = { select: vi.fn(() => query), in: vi.fn(async () => result) };
  return { from: vi.fn(() => query), query };
}

describe('readNames', () => {
  it('reads each distinct id once and maps a missing name to null', async () => {
    const db = fakeDb({ data: [{ id: 'a', full_name: 'Ada' }, { id: 'b', full_name: null }], error: null });

    const names = await readNames(db, ['a', null, 'b', 'a', undefined], vi.fn());

    expect(db.from).toHaveBeenCalledWith('profiles');
    expect(db.query.select).toHaveBeenCalledWith('id, full_name');
    expect(db.query.in).toHaveBeenCalledWith('id', ['a', 'b']);
    expect([...names]).toEqual([['a', 'Ada'], ['b', null]]);
  });

  it('skips the round trip when there is nobody to name', async () => {
    const db = fakeDb({ data: [], error: null });

    expect((await readNames(db, [null, undefined], vi.fn())).size).toBe(0);
    expect(db.from).not.toHaveBeenCalled();
  });

  it('reads no rows as an empty map', async () => {
    expect((await readNames(fakeDb({ data: null, error: null }), ['a'], vi.fn())).size).toBe(0);
  });

  it("throws the calling service's translation of a read error", async () => {
    const translated = new Error('translated');
    const translateError = vi.fn(() => translated);
    const raw = { code: '42501' };

    await expect(readNames(fakeDb({ data: null, error: raw }), ['a'], translateError)).rejects.toBe(translated);
    expect(translateError).toHaveBeenCalledWith(raw);
  });
});
