/**
 * SCRUM-320: migration 020 makes the database agree with the nine-status model,
 * read from the migration's SQL text.
 *
 * CI has no database, so -- like the other tests in this folder -- this reads
 * the file with every `--` comment stripped (a rule that exists only in a
 * comment does not count), whitespace collapsed and lower-cased. The live proof
 * is running the migration twice against a database that has 001 to 018.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { STATUS } from '../../src/domain/eventRequestStatus.js';

const here = dirname(fileURLToPath(import.meta.url));

const sql = readFileSync(
  resolve(here, '../../db/migrations/020_event_status_lifecycle.sql'),
  'utf8',
)
  .replace(/--[^\n]*/g, '')
  .replace(/\s+/g, ' ')
  .toLowerCase();

/** The quoted values of the first `in ( ... )` list after `marker`. */
function listAfter(marker) {
  const at = sql.indexOf(marker);
  expect(at, `${marker} not found`).toBeGreaterThan(-1);
  const open = sql.indexOf('(', sql.indexOf(' in ', at));
  const close = sql.indexOf(')', open);
  return [...sql.slice(open, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('SCRUM-320: the lifecycle constraint', () => {
  it('lists exactly the statuses the domain module defines', () => {
    expect(listAfter('add constraint event_requests_status_in_lifecycle').sort())
      .toEqual(Object.values(STATUS).sort());
  });

  it("does not admit 'planning'", () => {
    expect(listAfter('add constraint event_requests_status_in_lifecycle'))
      .not.toContain('planning');
  });

  it('is guarded so the migration can run twice', () => {
    expect(sql).toMatch(
      /if not exists \( select 1 from pg_constraint where conname = 'event_requests_status_in_lifecycle'/,
    );
  });
});

describe("SCRUM-320: 'planning' rows are moved to 'approved'", () => {
  it('updates them before any constraint is added', () => {
    const move = sql.indexOf("update event_requests set status = 'approved' where status = 'planning'");
    expect(move).toBeGreaterThan(-1);
    expect(move).toBeLessThan(sql.indexOf('add constraint'));
  });
});

describe("SCRUM-320: 010's decision constraints lose 'planning' and nothing else", () => {
  it('requires a decision for the decided statuses, without planning', () => {
    expect(listAfter('add constraint event_requests_decided_status_has_decision').sort())
      .toEqual(['approved', 'completed', 'confirmed', 'rejected']);
  });

  it('admits a decision on the decided statuses and cancelled, without planning', () => {
    expect(listAfter('add constraint event_requests_decision_has_decided_status').sort())
      .toEqual(['approved', 'cancelled', 'completed', 'confirmed', 'rejected']);
  });

  it.each([
    'event_requests_decided_status_has_decision',
    'event_requests_decision_has_decided_status',
  ])('rewrites %s only while it still mentions planning', (name) => {
    expect(sql).toContain(`conname = '${name}'`);
    expect(sql).toContain("pg_get_constraintdef(oid) ilike '%planning%'");
  });
});

describe('SCRUM-320: what the migration leaves alone', () => {
  it('defines no function, so coordinator selection and handover are unchanged', () => {
    expect(sql).not.toMatch(/create (or replace )?function/);
  });

  it('creates no table, so status history is not built here', () => {
    expect(sql).not.toMatch(/create table/);
  });

  it('does not touch the enum type', () => {
    expect(sql).not.toMatch(/(create|alter|drop) type/);
  });
});
