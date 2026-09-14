/**
 * Tests for the event request status vocabulary.
 *
 * SCRUM-44: Define and map event request status stages.
 *
 * Describe blocks are named after the acceptance criteria they cover, so a
 * requirement can be traced to the test that proves it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  STATUS,
  STATUS_GROUP,
  STATUS_DISPLAY,
  ALLOWED_TRANSITIONS,
  canTransition,
  getStatusDisplay,
} from '../../src/domain/eventRequestStatus.js';


const ALL_STATUSES = Object.values(STATUS);

/** Statuses nothing leads out of. */
const TERMINAL = [STATUS.COMPLETED, STATUS.REJECTED, STATUS.CANCELLED];

/** Everything still in flight -- all of which must be cancellable. */
const LIVE = ALL_STATUSES.filter((s) => !TERMINAL.includes(s));


// ---------------------------------------------------------------------------
// The JS list and the database enum must not drift apart
// ---------------------------------------------------------------------------
describe('STATUS mirrors the database enum', () => {
  /** Pull the enum values straight out of the migration, comments stripped. */
  function statusesDeclaredInSql() {
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(
      resolve(here, '../../db/migrations/001_event_requests.sql'),
      'utf8',
    );

    const block = sql.match(
      /create type event_request_status as enum \(([\s\S]*?)\);/i,
    );
    if (!block) throw new Error('could not find the enum in the migration');

    return [...block[1].replace(/--[^\n]*/g, '').matchAll(/'([a-z_]+)'/g)]
      .map((m) => m[1]);
  }

  it('declares exactly the same values as the SQL migration', () => {
    // The database is the source of truth. If this fails, one of the two files
    // was edited without the other and writes will be rejected at runtime.
    expect([...ALL_STATUSES].sort()).toEqual(statusesDeclaredInSql().sort());
  });

  it('has ten statuses', () => {
    expect(ALL_STATUSES).toHaveLength(10);
  });

  it('has no duplicate values', () => {
    expect(new Set(ALL_STATUSES).size).toBe(ALL_STATUSES.length);
  });
});


// ---------------------------------------------------------------------------
// AC2: "The status reflects relevant stages of the event planning process."
// ---------------------------------------------------------------------------
describe('AC2: every stage is described', () => {
  it.each(ALL_STATUSES)('%s has a complete display entry', (status) => {
    const display = STATUS_DISPLAY[status];

    expect(display).toBeDefined();
    expect(display.label.trim()).not.toBe('');
    expect(display.description.trim()).not.toBe('');
    expect(Object.values(STATUS_GROUP)).toContain(display.group);
  });

  it('gives each status a distinct label', () => {
    // Two stages sharing a label would be indistinguishable on screen.
    const labels = ALL_STATUSES.map((s) => STATUS_DISPLAY[s].label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('defines no group that no status uses', () => {
    const used = new Set(ALL_STATUSES.map((s) => STATUS_DISPLAY[s].group));
    expect([...Object.values(STATUS_GROUP)].sort()).toEqual([...used].sort());
  });
});


// ---------------------------------------------------------------------------
// AC3: "The Event Organiser can distinguish whether their request is awaiting
//       action, under review, approved, rejected, or confirmed."
// ---------------------------------------------------------------------------
describe('AC3: the Organiser can tell which stage they are at', () => {
  it.each([
    [STATUS.SUBMITTED, STATUS_GROUP.AWAITING_REVIEW],
    [STATUS.UNDER_REVIEW, STATUS_GROUP.UNDER_REVIEW],
    [STATUS.PENDING_CLARIFICATION, STATUS_GROUP.ACTION_REQUIRED],
    [STATUS.APPROVED, STATUS_GROUP.APPROVED],
    [STATUS.PLANNING, STATUS_GROUP.APPROVED],
    [STATUS.CONFIRMED, STATUS_GROUP.CONFIRMED],
    [STATUS.REJECTED, STATUS_GROUP.REJECTED],
  ])('%s is presented as %s', (status, group) => {
    expect(getStatusDisplay(status).group).toBe(group);
  });

  it('separates waiting on ConnectSphere from waiting on the Organiser', () => {
    // The decision behind splitting AC3's single "awaiting action" bucket:
    // the Organiser must know whether to sit tight or go and do something.
    expect(STATUS_GROUP.AWAITING_REVIEW).not.toBe(STATUS_GROUP.ACTION_REQUIRED);

    expect(getStatusDisplay(STATUS.SUBMITTED).group)
      .toBe(STATUS_GROUP.AWAITING_REVIEW);
    expect(getStatusDisplay(STATUS.PENDING_CLARIFICATION).group)
      .toBe(STATUS_GROUP.ACTION_REQUIRED);
  });

  it('returns the shape the API sends to React', () => {
    expect(getStatusDisplay(STATUS.UNDER_REVIEW)).toEqual({
      status: 'under_review',
      label: 'Under Review',
      group: STATUS_GROUP.UNDER_REVIEW,
      description: 'A Coordinator is assessing your request.',
    });
  });
});


// ---------------------------------------------------------------------------
// SCRUM-45 will enforce these rules when writing a status change
// ---------------------------------------------------------------------------
describe('only legal status transitions are permitted', () => {
  it.each(ALL_STATUSES)('%s declares its transitions', (status) => {
    expect(Object.hasOwn(ALLOWED_TRANSITIONS, status)).toBe(true);
  });

  it('never points at a status that does not exist', () => {
    // Catches a typo in the transition table that would silently block a move.
    for (const targets of Object.values(ALLOWED_TRANSITIONS)) {
      for (const target of targets) {
        expect(ALL_STATUSES).toContain(target);
      }
    }
  });

  it.each([
    [STATUS.DRAFT, STATUS.SUBMITTED],
    [STATUS.SUBMITTED, STATUS.UNDER_REVIEW],
    [STATUS.UNDER_REVIEW, STATUS.APPROVED],
    [STATUS.UNDER_REVIEW, STATUS.REJECTED],
    [STATUS.UNDER_REVIEW, STATUS.PENDING_CLARIFICATION],
    [STATUS.PENDING_CLARIFICATION, STATUS.UNDER_REVIEW],
    [STATUS.APPROVED, STATUS.PLANNING],
    [STATUS.PLANNING, STATUS.CONFIRMED],
    [STATUS.CONFIRMED, STATUS.COMPLETED],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each([
    // a rejected request must never quietly become live again
    [STATUS.REJECTED, STATUS.CONFIRMED],
    [STATUS.REJECTED, STATUS.UNDER_REVIEW],
    // nothing escapes a finished or abandoned request
    [STATUS.COMPLETED, STATUS.CANCELLED],
    [STATUS.CANCELLED, STATUS.DRAFT],
    // no skipping the review step
    [STATUS.SUBMITTED, STATUS.APPROVED],
    [STATUS.DRAFT, STATUS.CONFIRMED],
    // planning cannot run backwards
    [STATUS.CONFIRMED, STATUS.PLANNING],
  ])('refuses %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it.each(TERMINAL)('%s is terminal', (status) => {
    expect(ALLOWED_TRANSITIONS[status]).toEqual([]);
    for (const target of ALL_STATUSES) {
      expect(canTransition(status, target)).toBe(false);
    }
  });

  it.each(LIVE)('%s can be cancelled', (status) => {
    // The brief lets an Organiser cancel "due to unforeseen circumstances"
    // with no stage limit, so every live status reaches cancelled.
    expect(canTransition(status, STATUS.CANCELLED)).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// Unexpected input must be refused, not crash
// ---------------------------------------------------------------------------
describe('unexpected input', () => {
  // 'constructor' and '__proto__' find inherited properties on a plain object
  // lookup, which is why the module reads own keys only.
  const JUNK = ['constructor', '__proto__', 'toString', 'nonsense', '', null, undefined, 0, 42, {}, []];

  it.each(JUNK)('canTransition refuses %o as a starting status', (value) => {
    expect(() => canTransition(value, STATUS.DRAFT)).not.toThrow();
    expect(canTransition(value, STATUS.DRAFT)).toBe(false);
  });

  it.each(JUNK)('canTransition refuses %o as a target status', (value) => {
    expect(canTransition(STATUS.DRAFT, value)).toBe(false);
  });

  it.each(JUNK)('getStatusDisplay survives %o', (value) => {
    // Currently undefined. SCRUM-47 replaces this with a safe fallback object,
    // and this expectation changes with it.
    expect(() => getStatusDisplay(value)).not.toThrow();
    expect(getStatusDisplay(value)).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------
// The vocabulary is shared, so nothing may mutate it at runtime
// ---------------------------------------------------------------------------
describe('the vocabulary is immutable', () => {
  it('refuses changes to STATUS', () => {
    expect(() => { STATUS.DRAFT = 'something else'; }).toThrow();
    expect(STATUS.DRAFT).toBe('draft');
  });

  it('refuses changes to a display entry', () => {
    expect(() => { STATUS_DISPLAY[STATUS.DRAFT].label = 'Nope'; }).toThrow();
    expect(STATUS_DISPLAY[STATUS.DRAFT].label).toBe('Draft');
  });

  it('refuses changes to the transition table', () => {
    expect(() => { ALLOWED_TRANSITIONS[STATUS.REJECTED].push(STATUS.APPROVED); })
      .toThrow();
    expect(ALLOWED_TRANSITIONS[STATUS.REJECTED]).toEqual([]);
  });

  it('returns a frozen display object', () => {
    expect(Object.isFrozen(getStatusDisplay(STATUS.DRAFT))).toBe(true);
  });
});
