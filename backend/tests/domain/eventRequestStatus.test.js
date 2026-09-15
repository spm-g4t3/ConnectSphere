/**
 * Tests for the event request status vocabulary.
 *
 * SCRUM-44: Define and map event request status stages.
 * SCRUM-47: Handle unavailable or unknown request status states.
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
  STATUS_FALLBACK,
  canTransition,
  getStatusDisplay,
  isKnownStatus,
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

  it('defines no group that nothing uses', () => {
    // Still "no dead groups", but since SCRUM-47 a group may be claimed by a
    // fallback rather than by a status. UNAVAILABLE and UNKNOWN are reachable
    // states of the page, so they are not dead -- they are just not stages.
    const used = new Set([
      ...ALL_STATUSES.map((s) => STATUS_DISPLAY[s].group),
      ...Object.values(STATUS_FALLBACK).map((f) => f.group),
    ]);
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
    // Since SCRUM-47 this returns a fallback rather than undefined, so the UI
    // is never handed nothing. Which fallback is asserted below.
    expect(() => getStatusDisplay(value)).not.toThrow();
    expect(getStatusDisplay(value)).toBeDefined();
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


// ---------------------------------------------------------------------------
// SCRUM-47: Handle unavailable or unknown request status states
//
// AC1: "The Event Organiser can view the current status of their submitted
//       event request." A page that renders nothing meets that worse than one
//       that says the status could not be read.
// ---------------------------------------------------------------------------
describe('AC1: the Organiser is never shown nothing', () => {
  /** Nothing usable arrived -- not a status, and never could have been one. */
  const NOTHING_USABLE = [
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a number', 42],
    ['zero', 0],
    ['an object', {}],
    ['an array', []],
    ['a boolean', false],
  ];

  /** A value arrived, and it is the kind of thing a status could be. */
  const UNRECOGNISED = ['nonsense', 'postponed', 'DRAFT', 'constructor', '__proto__', 'toString'];

  it.each([...NOTHING_USABLE, ...UNRECOGNISED.map((v) => [v, v])])(
    'returns something renderable for %s',
    (_label, value) => {
      expect(getStatusDisplay(value)).toBeDefined();
    },
  );

  it.each([...NOTHING_USABLE, ...UNRECOGNISED.map((v) => [v, v])])(
    'returns the same four fields for %s as for a real status',
    (_label, value) => {
      // The point of the fallback: React has one rendering path, not two.
      expect(Object.keys(getStatusDisplay(value)).sort())
        .toEqual(Object.keys(getStatusDisplay(STATUS.SUBMITTED)).sort());
    },
  );

  it.each([...NOTHING_USABLE, ...UNRECOGNISED.map((v) => [v, v])])(
    'gives %s a non-blank label and description',
    (_label, value) => {
      const display = getStatusDisplay(value);
      expect(display.label.trim()).not.toBe('');
      expect(display.description.trim()).not.toBe('');
    },
  );
});


describe('unavailable is told apart from unknown', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a number', 42],
    ['an object', {}],
  ])('reports %s as unavailable, because no value arrived', (_label, value) => {
    expect(getStatusDisplay(value).label).toBe('Status Unavailable');
    expect(getStatusDisplay(value).group).toBe(STATUS_GROUP.UNAVAILABLE);
  });

  it.each(['nonsense', 'postponed', 'archived', 'DRAFT', '__proto__'])(
    'reports %s as unknown, because a value arrived that we do not know',
    (value) => {
      expect(getStatusDisplay(value).label).toBe('Unknown Status');
      expect(getStatusDisplay(value).group).toBe(STATUS_GROUP.UNKNOWN);
    },
  );

  it('keeps the two messages distinct', () => {
    // One asks the Organiser to refresh; the other tells them refreshing will
    // not help. Collapsing them would send half of them down the wrong path.
    expect(STATUS_FALLBACK.UNAVAILABLE.description)
      .not.toBe(STATUS_FALLBACK.UNKNOWN.description);
  });

  it('tells the Organiser to retry only when retrying could work', () => {
    expect(STATUS_FALLBACK.UNAVAILABLE.description).toMatch(/refresh/i);
    expect(STATUS_FALLBACK.UNKNOWN.description).not.toMatch(/refresh/i);
  });

  it('points at the Event Coordinator rather than at internal process', () => {
    // The customer brief asks that the system not assume users understand
    // ConnectSphere's internal processes.
    expect(STATUS_FALLBACK.UNAVAILABLE.description).toMatch(/coordinator/i);
    expect(STATUS_FALLBACK.UNKNOWN.description).toMatch(/coordinator/i);
  });

  it('is case-sensitive, so a near-miss is unknown rather than guessed at', () => {
    // 'DRAFT' is not 'draft'. Guessing would mean the page silently disagrees
    // with the database about which stage the request is at.
    expect(getStatusDisplay('DRAFT').group).toBe(STATUS_GROUP.UNKNOWN);
    expect(getStatusDisplay(STATUS.DRAFT).group).toBe(STATUS_GROUP.DRAFT);
  });
});


describe('the fallback payload', () => {
  it('echoes an unrecognised status so it can be reported', () => {
    // A stale frontend is the usual cause, so the value nobody recognised is
    // the single most useful thing to put in a bug report.
    expect(getStatusDisplay('postponed').status).toBe('postponed');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an object', {}],
  ])('reports a null status for %s rather than echoing it', (_label, value) => {
    // status is a string field in the API contract. Echoing an object into it
    // would move the problem into the frontend instead of stopping it here.
    expect(getStatusDisplay(value).status).toBeNull();
  });

  it('is frozen, like a real status display', () => {
    const display = getStatusDisplay('nonsense');
    expect(() => { display.label = 'changed'; }).toThrow();
  });

  it.each(Object.keys(STATUS_FALLBACK))('STATUS_FALLBACK.%s cannot be edited', (key) => {
    expect(() => { STATUS_FALLBACK[key].label = 'changed'; }).toThrow();
  });

  it('uses groups that no real status claims', () => {
    // Otherwise the UI would style a failure the same as a stage.
    const stageGroups = ALL_STATUSES.map((s) => STATUS_DISPLAY[s].group);
    expect(stageGroups).not.toContain(STATUS_GROUP.UNAVAILABLE);
    expect(stageGroups).not.toContain(STATUS_GROUP.UNKNOWN);
  });
});


describe('isKnownStatus', () => {
  it.each(ALL_STATUSES)('recognises %s', (status) => {
    expect(isKnownStatus(status)).toBe(true);
  });

  it.each(['nonsense', 'DRAFT', '', '   ', 'constructor', '__proto__', null, undefined, 42, {}, []])(
    'refuses %o',
    (value) => {
      expect(isKnownStatus(value)).toBe(false);
    },
  );

  it('is how a caller tells a real status from a fallback', () => {
    // getStatusDisplay always returns something now, so "is this real?" can no
    // longer be answered by checking for undefined.
    expect(isKnownStatus(STATUS.SUBMITTED)).toBe(true);
    expect(getStatusDisplay('postponed')).toBeDefined();
    expect(isKnownStatus('postponed')).toBe(false);
  });
});
