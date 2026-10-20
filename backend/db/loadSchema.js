import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

const DB_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(DB_DIR, 'migrations');
const BASELINE_DIR = join(DB_DIR, 'baseline');

// What Supabase provides before any migration runs. The default privileges
// mirror Supabase's, so table and function ACLs fingerprint the same as live.
export const SUPABASE_PREAMBLE = `
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

function sqlFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

function moveBefore(names, moved, anchor) {
  const rest = names.filter((name) => name !== moved);
  const at = rest.indexOf(anchor);
  if (at === -1 || rest.length === names.length) {
    throw new Error(`Cannot place ${moved} before ${anchor}: file missing`);
  }
  rest.splice(at, 0, moved);
  return rest;
}

export function oldChainFiles() {
  let names = sqlFiles(MIGRATIONS_DIR);
  // Filename order does not apply on an empty database: 014 reads a column
  // that 025 adds, and 026 alters the table that 030 creates.
  names = moveBefore(names, '025_event_request_decisions.sql', '014_booking_review_notifications.sql');
  names = moveBefore(names, '030_event_clarification_reply_by.sql', '026_clarification_amendment_fields.sql');
  return names.map((name) => join(MIGRATIONS_DIR, name));
}

export function baselineFiles() {
  const baseline = sqlFiles(BASELINE_DIR).map((name) => join(BASELINE_DIR, name));
  // Migrations from 103 on are written after the squash and apply on top of it.
  const later = sqlFiles(MIGRATIONS_DIR)
    .filter((name) => Number.parseInt(name, 10) >= 103)
    .map((name) => join(MIGRATIONS_DIR, name));
  return [...baseline, ...later];
}

export async function createDatabase(files) {
  const db = new PGlite({ extensions: { btree_gist } });
  await db.exec(SUPABASE_PREAMBLE);
  for (const file of files) {
    try {
      await db.exec(readFileSync(file, 'utf8'));
    } catch (error) {
      error.message = `${file}: ${error.message}`;
      throw error;
    }
  }
  return db;
}
