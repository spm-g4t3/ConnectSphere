// The supabase-js shapes the services' write paths use, run on PGlite:
// rpc(fn, args) with named arguments, and from(table).select(cols).eq(...)
// .maybeSingle(). Errors come back in PostgREST's shape, so a service's own
// translation of a refusal is what a test exercises.

const answer = async (run) => {
  try {
    return { data: await run(), error: null };
  } catch (err) {
    return {
      data: null,
      error: { code: err.code, message: err.message, hint: err.hint, details: err.detail },
    };
  }
};

/**
 * `columns(cols, table)` turns the select list into SQL. PostgREST embeds
 * such as bookings(status) are not SQL, so a file whose path selects one
 * says how to read it (or drop it).
 */
export function pgliteSupabaseClient(db, { columns = (cols) => cols } = {}) {
  return {
    rpc(fn, args) {
      const names = Object.keys(args);
      const sql = `select * from ${fn}(${names.map((name, i) => `${name} => $${i + 1}`).join(', ')})`;
      return answer(async () => {
        const row = (await db.query(sql, names.map((name) => args[name]))).rows[0] ?? null;
        // A function returning jsonb comes back as one column named after it;
        // supabase-js hands over the value itself.
        const keys = row ? Object.keys(row) : [];
        return keys.length === 1 && keys[0] === fn ? row[fn] : row;
      });
    },
    from(table) {
      let selected = '*';
      const where = [];
      const chain = {
        select(cols = '*') { selected = columns(cols, table); return chain; },
        eq(column, value) { where.push([column, value]); return chain; },
        maybeSingle() {
          const clause = where.map(([column], i) => `${column} = $${i + 1}`).join(' and ');
          const sql = `select ${selected} from ${table}${clause ? ` where ${clause}` : ''}`;
          return answer(async () => (await db.query(sql, where.map(([, value]) => value))).rows[0] ?? null);
        },
        then() { throw new Error(`pgliteSupabaseClient: a list read on ${table} is not supported`); },
      };
      return chain;
    },
  };
}
