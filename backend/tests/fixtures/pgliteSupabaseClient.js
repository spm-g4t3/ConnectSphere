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
      const orderBy = [];
      // `= $n` for eq, `= any($n)` for in, so a list is one parameter.
      const query = () => {
        const clause = where.map(([column, , op], i) => `${column} ${op === 'in' ? `= any($${i + 1})` : `= $${i + 1}`}`).join(' and ');
        const order = orderBy.map(([column, ascending]) => `${column} ${ascending ? 'asc' : 'desc'}`).join(', ');
        return {
          sql: `select ${selected} from ${table}${clause ? ` where ${clause}` : ''}${order ? ` order by ${order}` : ''}`,
          params: where.map(([, value]) => value),
        };
      };
      const chain = {
        select(cols = '*') { selected = columns(cols, table); return chain; },
        eq(column, value) { where.push([column, value, 'eq']); return chain; },
        in(column, values) { where.push([column, values, 'in']); return chain; },
        order(column, { ascending = true } = {}) { orderBy.push([column, ascending]); return chain; },
        maybeSingle() {
          const { sql, params } = query();
          return answer(async () => (await db.query(sql, params)).rows[0] ?? null);
        },
        // A list read, as supabase-js resolves an awaited query.
        then(resolve, reject) {
          const { sql, params } = query();
          return answer(async () => (await db.query(sql, params)).rows).then(resolve, reject);
        },
      };
      return chain;
    },
  };
}
