/**
 * RLS enabled with no policies is what keeps anon/authenticated Supabase
 * clients out of notifications; only the backend's secret key reads it.
 * 014's own test pins the enable line, but a later migration could add a
 * policy, a grant or a disable and that test would not notice.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../db/migrations');

/** One migration with every `--` comment stripped, whitespace collapsed. */
function normalise(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').toLowerCase();
}

/** Every migration, in file order, as { file, sql }. */
function allMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sql: normalise(readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8')) }));
}

const TABLE = '(?:public\\.)?notifications\\b';

const enablesRls = (sql) =>
  new RegExp(`alter table (?:if exists )?(?:only )?${TABLE} enable row level security`, 'i').test(sql);

const disablesRls = (sql) =>
  new RegExp(`alter table (?:if exists )?(?:only )?${TABLE} disable row level security`, 'i').test(sql);

const createsPolicy = (sql) =>
  new RegExp(`create policy [^;]*? on (?:table )?${TABLE}`, 'i').test(sql);

const grantsToClientRoles = (sql) =>
  new RegExp(`grant [^;]*? on (?:table )?${TABLE}[^;]*? to [^;]*\\b(?:anon|authenticated|public)\\b`, 'i').test(sql);

const MIGRATIONS = allMigrations();

/** The files a detector flags, so a failure names the migration. */
const offenders = (detector) => MIGRATIONS.filter(({ sql }) => detector(sql)).map(({ file }) => file);

describe('the detectors', () => {
  const LEGIT_ENABLE = normalise('alter table notifications enable row level security;');
  const PLAIN_INSERT = normalise('insert into notifications (recipient_id, type) values ($1, $2);');

  it('reads every migration, not an empty directory', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(60);
  });

  it('enablesRls matches the 014 line', () => {
    expect(enablesRls(LEGIT_ENABLE)).toBe(true);
    expect(enablesRls(PLAIN_INSERT)).toBe(false);
  });

  it('disablesRls matches a disable and not the legitimate lines', () => {
    expect(disablesRls(normalise('ALTER TABLE public.notifications DISABLE ROW LEVEL SECURITY;'))).toBe(true);
    expect(disablesRls(LEGIT_ENABLE)).toBe(false);
    expect(disablesRls(PLAIN_INSERT)).toBe(false);
  });

  it('createsPolicy matches a policy and not the legitimate lines', () => {
    expect(
      createsPolicy(normalise('create policy "own rows" on public.notifications\n  for select using (recipient_id = auth.uid());')),
    ).toBe(true);
    expect(createsPolicy(normalise('create policy p on events for select using (true);'))).toBe(false);
    expect(createsPolicy(LEGIT_ENABLE)).toBe(false);
    expect(createsPolicy(PLAIN_INSERT)).toBe(false);
  });

  it('grantsToClientRoles matches a client grant and not the legitimate lines', () => {
    expect(grantsToClientRoles(normalise('grant select on table notifications to authenticated;'))).toBe(true);
    expect(grantsToClientRoles(normalise('GRANT ALL ON public.notifications TO anon, service_role;'))).toBe(true);
    expect(grantsToClientRoles(normalise('grant select on notifications to service_role;'))).toBe(false);
    expect(grantsToClientRoles(LEGIT_ENABLE)).toBe(false);
    expect(grantsToClientRoles(PLAIN_INSERT)).toBe(false);
  });
});

describe('notifications access control across every migration', () => {
  it('SCRUM172_AC8_row_level_security_stays_enabled', () => {
    expect(offenders(enablesRls).length).toBeGreaterThan(0);
    expect(offenders(disablesRls)).toEqual([]);
  });

  it('SCRUM172_AC8_no_migration_adds_a_policy_on_notifications', () => {
    expect(offenders(createsPolicy)).toEqual([]);
  });

  it('SCRUM172_AC8_no_migration_grants_notifications_to_client_roles', () => {
    expect(offenders(grantsToClientRoles)).toEqual([]);
  });
});
