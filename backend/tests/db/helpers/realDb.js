// A real PostgreSQL server for the tests PGlite cannot run: PGlite has one
// connection, so it cannot show one transaction waiting on another's lock.
// Opt-in: set CONCURRENCY_DATABASE_URL to a disposable server, for example
//   docker run -d --rm --name connectsphere-race-pg -e POSTGRES_PASSWORD=race \
//     -p 127.0.0.1:55432:5432 postgres:17-alpine
//   CONCURRENCY_DATABASE_URL=postgres://postgres:race@127.0.0.1:55432/postgres
// The schema is built in its own database, dropped and recreated each run, the
// same way createSchemaDb builds it: Supabase's preamble, then every file.
import { readFileSync } from 'node:fs';
import { SUPABASE_PREAMBLE, baselineFiles } from '../../../db/loadSchema.js';

export const REAL_DB_URL = process.env.CONCURRENCY_DATABASE_URL;
const DATABASE = 'connectsphere_concurrency';

function guard(url) {
  const { hostname } = new URL(url);
  // Never the shared project: these tests drop and recreate a database.
  if (/supabase\.(co|com|net)$/.test(hostname) || hostname.includes('pooler.supabase')) {
    throw new Error(`Refusing to run concurrency tests against ${hostname}; use a disposable server.`);
  }
}

// The roles are cluster-wide, so a second run on the same server must not fail on them,
// nor two files building their databases at once (both can pass the check, one then loses).
const PREAMBLE = SUPABASE_PREAMBLE.replace(
  /create role (\w+) nologin( bypassrls)?;/g,
  (_match, role, bypass = '') => `do $$ begin
    if not exists (select 1 from pg_roles where rolname = '${role}') then
      create role ${role} nologin${bypass};
    end if;
  exception when duplicate_object or unique_violation then null;
  end $$;`,
);

/**
 * Builds the schema in a fresh database and returns a factory for new connections.
 * Each test file names its own database: files run in parallel, and each drops its own.
 */
export async function createRealSchemaDb({ database = DATABASE } = {}) {
  guard(REAL_DB_URL);
  const { default: pg } = await import('pg');
  const admin = new pg.Client({ connectionString: REAL_DB_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${database} with (force)`);
  await admin.query(`create database ${database}`);
  await admin.end();

  const url = new URL(REAL_DB_URL);
  url.pathname = `/${database}`;
  const connect = async ({ role } = {}) => {
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    if (role) await client.query(`set role ${role}`);
    client.pid = (await client.query('select pg_backend_pid() as pid')).rows[0].pid;
    return client;
  };

  const owner = await connect();
  await owner.query(PREAMBLE);
  for (const file of baselineFiles()) {
    try {
      await owner.query(readFileSync(file, 'utf8'));
    } catch (error) {
      error.message = `${file}: ${error.message}`;
      throw error;
    }
  }
  return { owner, connect };
}

/**
 * Resolves once `pid` is waiting on a lock, read from pg_stat_activity by
 * `observer`. This is what makes a race deterministic: the second transaction
 * is known to be queued behind the first before the first is allowed to finish.
 */
export async function waitUntilBlocked(observer, pid, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await observer.query(
      "select wait_event_type from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'", [pid],
    );
    if (rows.length) return;
    if (Date.now() > deadline) throw new Error(`backend ${pid} never waited on a lock`);
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}
