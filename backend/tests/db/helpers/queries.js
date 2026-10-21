import { expect } from 'vitest';

// Takes a getter, as useSchemaDb returns, because a file's db is only assigned
// in beforeAll, after these are bound.
export function queriesFor(getDb) {
  return {
    one: async (sql, params) => (await getDb().query(sql, params)).rows[0],
    rows: async (sql, params) => (await getDb().query(sql, params)).rows,
  };
}

/** The error a promise rejected with; null if it resolved. */
export async function refusal(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

/** Expect a statement to be refused with this SQLSTATE (and constraint, when named). */
export async function expectSqlError(promise, code, constraint) {
  const error = await refusal(promise);
  expect(error, 'expected the statement to be refused').not.toBeNull();
  expect(error.code).toBe(code);
  if (constraint) expect(error.message).toContain(constraint);
}
