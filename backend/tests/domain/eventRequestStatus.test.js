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

/** Final: nothing leads out of them (SCRUM-318). Rejected is not, it reopens as a draft. */
const TERMINAL = [STATUS.COMPLETED, STATUS.CANCELLED];

/** The statuses SCRUM-318 allows the assigned coordinator to cancel from. */
const CANCELLABLE = [
  STATUS.SUBMITTED,
  STATUS.UNDER_REVIEW,
  STATUS.PENDING_CLARIFICATION,
  STATUS.APPROVED,
  STATUS.CONFIRMED,
];

/** Removed by SCRUM-318. Still in the database enum, which cannot drop a value; 020 refuses it. */
const OBSOLETE_STATUSES = ['planning'];


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

  it('only uses values the SQL migration declares', () => {
    // The database is the source of truth for what is storable. If this fails,
    // a status was added here without a migration and writes will be rejected
    // at runtime.
    expect(statusesDeclaredInSql()).toEqual(expect.arrayContaining(ALL_STATUSES));
  });

  it('leaves out only the statuses SCRUM-318 removed', () => {
    // 001 is append-only, so 'planning' stays in its enum: Postgres cannot
    // drop a value, and 020 refuses it with a constraint. Anything else
    // missing from STATUS is drift, not removal.
    const missing = statusesDeclaredInSql().filter((s) => !ALL_STATUSES.includes(s));
    expect(missing.sort()).toEqual([...OBSOLETE_STATUSES].sort());
  });

  it('has nine statuses', () => {
    expect(ALL_STATUSES).toHaveLength(9);
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
    [STATUS.CONFIRMED, STATUS_GROUP.CONFIRMED],    [STATUS.REJECTED, STATUS_GROUP.REJECTED],
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
      label: 'Under review',
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
    [STATUS.SUBMITTED, STATUS.PENDING_CLARIFICATION],
    [STATUS.UNDER_REVIEW, STATUS.APPROVED],
    [STATUS.UNDER_REVIEW, STATUS.REJECTED],
    [STATUS.UNDER_REVIEW, STATUS.PENDING_CLARIFICATION],
    [STATUS.PENDING_CLARIFICATION, STATUS.UNDER_REVIEW],
    [STATUS.CONFIRMED, STATUS.COMPLETED],
    // SCRUM-318 additions
    [STATUS.APPROVED, STATUS.CONFIRMED],
    [STATUS.CONFIRMED, STATUS.APPROVED],
    [STATUS.APPROVED, STATUS.REJECTED],
    [STATUS.REJECTED, STATUS.DRAFT],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each([
    // a rejected request is revised as a draft, never revived in place
    [STATUS.REJECTED, STATUS.CONFIRMED],
    [STATUS.REJECTED, STATUS.UNDER_REVIEW],
    [STATUS.REJECTED, STATUS.SUBMITTED],
    [STATUS.REJECTED, STATUS.APPROVED],
    [STATUS.REJECTED, STATUS.CANCELLED],
    // nothing escapes a finished or abandoned request
    [STATUS.COMPLETED, STATUS.CANCELLED],
    [STATUS.CANCELLED, STATUS.DRAFT],
    [STATUS.SUBMITTED, STATUS.APPROVED],
    [STATUS.DRAFT, STATUS.CONFIRMED],
    // a draft has no coordinator to cancel it; drafts are deleted
    [STATUS.DRAFT, STATUS.CANCELLED],
    // the stages are not skipped or run backwards, except confirmed -> approved
    [STATUS.UNDER_REVIEW, STATUS.CONFIRMED],
    [STATUS.UNDER_REVIEW, STATUS.SUBMITTED],
    [STATUS.APPROVED, STATUS.UNDER_REVIEW],
    [STATUS.CONFIRMED, STATUS.UNDER_REVIEW],
    [STATUS.CONFIRMED, STATUS.REJECTED],
    [STATUS.APPROVED, STATUS.COMPLETED],
    [STATUS.PENDING_CLARIFICATION, STATUS.APPROVED],
    [STATUS.PENDING_CLARIFICATION, STATUS.REJECTED],
  ])('refuses %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it('refuses every transition outside the SCRUM-318 table', () => {
    // The whole table, so a transition added by accident fails here even when
    // nobody thought to write a case for it.
    const permitted = new Set([
      'draft>submitted',
      'submitted>under_review',
      'submitted>pending_clarification',
      'under_review>pending_clarification',
      'pending_clarification>under_review',
      'under_review>approved',
      'under_review>rejected',
      'approved>rejected',
      'rejected>draft',
      'approved>confirmed',
      'confirmed>approved',
      'confirmed>completed',
      ...CANCELLABLE.map((s) => `${s}>cancelled`),
    ]);

    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`)
          .toBe(permitted.has(`${from}>${to}`));
      }
    }
  });

  it.each(TERMINAL)('%s is terminal', (status) => {
    expect(ALLOWED_TRANSITIONS[status]).toEqual([]);
    for (const target of ALL_STATUSES) {
      expect(canTransition(status, target)).toBe(false);
    }
  });

  it('does not treat rejected as terminal', () => {
    expect(ALLOWED_TRANSITIONS[STATUS.REJECTED]).toEqual([STATUS.DRAFT]);
  });

  it.each(CANCELLABLE)('%s can be cancelled', (status) => {
    expect(canTransition(status, STATUS.CANCELLED)).toBe(true);
  });

  it.each([STATUS.DRAFT, STATUS.REJECTED, ...TERMINAL.filter((s) => s !== STATUS.CANCELLED)])(
    '%s cannot be cancelled',
    (status) => {
      expect(canTransition(status, STATUS.CANCELLED)).toBe(false);
    },
  );
});


describe('SCRUM-318: obsolete statuses are not part of the lifecycle', () => {
  it.each(OBSOLETE_STATUSES)('%s is not a status', (status) => {
    expect(Object.values(STATUS)).not.toContain(status);
    expect(isKnownStatus(status)).toBe(false);
    expect(Object.hasOwn(ALLOWED_TRANSITIONS, status)).toBe(false);
  });

  it.each(OBSOLETE_STATUSES)('%s is refused as a starting status', (status) => {
    for (const target of ALL_STATUSES) {
      expect(canTransition(status, target)).toBe(false);
    }
  });

  it.each(OBSOLETE_STATUSES)('%s is refused as a target status', (status) => {
    for (const from of ALL_STATUSES) {
      expect(canTransition(from, status)).toBe(false);
    }
  });

  it.each(OBSOLETE_STATUSES)('%s is displayed as an unknown status', (status) => {
    expect(getStatusDisplay(status).group).toBe(STATUS_GROUP.UNKNOWN);
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
    expect(() => { ALLOWED_TRANSITIONS[STATUS.COMPLETED].push(STATUS.APPROVED); })
      .toThrow();
    expect(ALLOWED_TRANSITIONS[STATUS.COMPLETED]).toEqual([]);
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


// ---------------------------------------------------------------------------
// SCRUM-45 -- the statuses that make up the Event Coordinator's review queue
// ---------------------------------------------------------------------------
/**
 * Appended rather than folded into the blocks above, and the import below is
 * appended rather than added to the block at the top of the file, for the
 * reason tests/services/eventRequestService.test.js already states at its own
 * mid-file import: everything above this line is the regression gate for
 * SCRUM-44 and SCRUM-47, and the one thing that must be provable at a glance
 * is that not a character of it moved. An ESM import declaration is hoisted
 * wherever it is written, so this binds exactly as it would at the top.
 *
 * Acceptance criteria carried in the names:
 *   AC1 -- a Coordinator sees every request that is awaiting a decision
 *   AC2 -- and nothing they were never meant to see
 */
import { COORDINATOR_QUEUE_STATUSES } from '../../src/domain/eventRequestStatus.js';


describe('SCRUM-45: the review queue is a set of statuses, named in the domain', () => {
  it('SCRUM45_AC1_is_exactly_submitted_under_review_and_pending_clarification', () => {
    // Asserted as an ordered array rather than as a set, because this value is
    // handed straight to .in() and a reader comparing the service query with
    // this file should see the same three words in the same order. The order
    // itself is the order a request travels through them.
    expect(COORDINATOR_QUEUE_STATUSES).toEqual([
      STATUS.SUBMITTED,
      STATUS.UNDER_REVIEW,
      STATUS.PENDING_CLARIFICATION,
    ]);
  });

  it('SCRUM45_AC1_names_only_statuses_the_database_can_store', () => {
    // A typo here would not throw. It would be sent to Postgres inside an
    // IN list, match no row, and quietly shorten the queue -- which looks
    // exactly like "nothing is waiting" and is the hardest possible bug to
    // notice on a screen whose healthy state is often empty.
    for (const status of COORDINATOR_QUEUE_STATUSES) {
      expect(isKnownStatus(status)).toBe(true);
      expect(ALL_STATUSES).toContain(status);
    }
  });

  it('SCRUM45_AC2_never_admits_a_draft', () => {
    // Asserted, not assumed. There is no coordinator_id on event_requests and
    // no assignment model, so every Coordinator sees every row this list
    // admits: excluding draft IS the access control that keeps an Organiser's
    // private working copy private. Widening this array is what would breach
    // it, so the boundary gets a test of its own rather than riding along on
    // the equality check above.
    expect(COORDINATOR_QUEUE_STATUSES).not.toContain(STATUS.DRAFT);
  });

  it('SCRUM45_AC1_admits_no_status_a_decision_has_already_closed', () => {
    // A queue containing completed, rejected or cancelled work would never
    // empty, and "what is waiting for me" would stop being answerable by
    // looking at it. What a Coordinator does with a request after a decision
    // is a post-decision worklist, and whoever builds that screen owns its
    // own list.
    for (const status of [STATUS.COMPLETED, STATUS.REJECTED, STATUS.CANCELLED]) {
      expect(COORDINATOR_QUEUE_STATUSES).not.toContain(status);
    }
  });

  it('SCRUM45_AC1_cannot_be_widened_at_runtime', () => {
    // Frozen for the same reason STATUS and ALLOWED_TRANSITIONS are, with one
    // extra: this array is a privacy boundary, so a push() from anywhere in
    // the process would silently enlarge what every Coordinator can read.
    expect(Object.isFrozen(COORDINATOR_QUEUE_STATUSES)).toBe(true);
    expect(() => { COORDINATOR_QUEUE_STATUSES.push(STATUS.DRAFT); }).toThrow();
    expect(COORDINATOR_QUEUE_STATUSES).toHaveLength(3);
  });
});


// ---------------------------------------------------------------------------
// SCRUM-323 -- the Organiser-facing label for each status (SCRUM-318 AC7)
// ---------------------------------------------------------------------------
/**
 * Appended, with its import, for the reason the SCRUM-45 block above gives for
 * its own: everything above this line is the regression gate for SCRUM-44 and
 * SCRUM-47.
 *
 * AC7 is a table, and it is written out below in full rather than derived from
 * the module, so that a label changed by accident fails here and names the row.
 */
import { ORGANISER_STATUS_LABEL, getOrganiserStatusLabel } from '../../src/domain/eventRequestStatus.js';

const AC7_LABELS = [
  [STATUS.DRAFT, 'Draft'],
  [STATUS.SUBMITTED, 'Requested'],
  [STATUS.UNDER_REVIEW, 'Under review'],
  [STATUS.PENDING_CLARIFICATION, 'Awaiting your response'],
  [STATUS.APPROVED, 'Planning'],
  [STATUS.CONFIRMED, 'Confirmed'],
  [STATUS.COMPLETED, 'Completed'],
  [STATUS.REJECTED, 'Rejected'],
  [STATUS.CANCELLED, 'Cancelled'],
];

describe('SCRUM-323 AC7: every status has its Organiser label', () => {
  it.each(AC7_LABELS)('SCRUM323_AC7_shows_%s_as_%s', (status, label) => {
    expect(ORGANISER_STATUS_LABEL[status]).toBe(label);
    expect(getOrganiserStatusLabel(status)).toBe(label);
    expect(getStatusDisplay(status).label).toBe(label);
    expect(STATUS_DISPLAY[status].label).toBe(label);
  });

  it('SCRUM323_AC7_covers_exactly_the_statuses_there_are', () => {
    expect(AC7_LABELS.map(([status]) => status).sort()).toEqual([...ALL_STATUSES].sort());
    expect(Object.keys(ORGANISER_STATUS_LABEL).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it('SCRUM323_AC7_has_one_definition_the_display_reads_from', () => {
    // The display table holds no words of its own: each label is the map's.
    for (const status of ALL_STATUSES) {
      expect(STATUS_DISPLAY[status].label).toBe(ORGANISER_STATUS_LABEL[status]);
    }
  });

  it('SCRUM323_AC7_never_shows_an_internal_name_with_an_underscore', () => {
    for (const label of Object.values(ORGANISER_STATUS_LABEL)) {
      expect(label).not.toMatch(/_/);
    }
  });

  it('SCRUM323_AC7_labels_approved_as_planning_without_a_planning_status', () => {
    // "Planning" is the customer's word for the approved stage, and only a
    // label. Nothing stores or accepts it as a status.
    expect(ORGANISER_STATUS_LABEL[STATUS.APPROVED]).toBe('Planning');
    expect(Object.values(STATUS)).not.toContain('planning');
    expect(Object.keys(ORGANISER_STATUS_LABEL)).not.toContain('planning');
    expect(isKnownStatus('Planning')).toBe(false);
  });

  it('SCRUM323_AC7_leaves_the_internal_statuses_unchanged', () => {
    expect(Object.values(STATUS).sort()).toEqual([
      'approved', 'cancelled', 'completed', 'confirmed', 'draft',
      'pending_clarification', 'rejected', 'submitted', 'under_review',
    ]);
  });

  it('SCRUM323_AC7_cannot_be_edited_at_runtime', () => {
    expect(Object.isFrozen(ORGANISER_STATUS_LABEL)).toBe(true);
    expect(() => { ORGANISER_STATUS_LABEL[STATUS.APPROVED] = 'Approved'; }).toThrow();
    expect(ORGANISER_STATUS_LABEL[STATUS.APPROVED]).toBe('Planning');
  });
});


describe('SCRUM-323: a status that is not one of the nine', () => {
  // SCRUM-47's convention: a value that arrived but is not known is "Unknown
  // Status", and nothing usable is "Status Unavailable". Never undefined, and
  // never the unrecognised value itself.
  it.each(['planning', 'postponed', 'DRAFT', 'Requested', 'constructor', '__proto__'])(
    'SCRUM323_labels_%s as unknown',
    (value) => {
      expect(getOrganiserStatusLabel(value)).toBe(STATUS_FALLBACK.UNKNOWN.label);
    },
  );

  it.each([null, undefined, '', '   ', 42, {}, []])(
    'SCRUM323_labels_%o as unavailable',
    (value) => {
      expect(getOrganiserStatusLabel(value)).toBe(STATUS_FALLBACK.UNAVAILABLE.label);
    },
  );
});
