/**
 * SCRUM-318 / SCRUM-327: there is one production path from draft to submitted.
 *
 * That path is submit_event_request (migration 016), called through rpc by
 * submitEventRequest. It is the only thing that sets status = 'submitted', and
 * it sets submitted_at, assigned_coordinator_id and the assignment history row
 * in the same statement block, so a request cannot become submitted without a
 * coordinator. SCRUM-318's status model says which moves are legal;
 * this function is how the draft -> submitted one is carried out.
 *
 * CI has no database, so this reads the source and the migrations as text, with
 * every `--` and `//` comment stripped so that a rule that exists only in a
 * comment does not count. What it cannot see -- that a refused submission
 * leaves the row a draft -- is proved by `npm run request:check` and by running
 * the function against a real Postgres.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { STATUS, canTransition } from '../../src/domain/eventRequestStatus.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../../src');
const MIGRATIONS = resolve(here, '../../db/migrations');

/** Every .js file under dir. */
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.js') ? [path] : [];
  });
}

/** Source with block and line comments removed, so prose cannot satisfy or trip a rule. */
function code(path) {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/[^:]\/\/.*$/gm, '');
}

/** A migration with every `--` comment stripped, whitespace collapsed, lower-cased. */
function sql(name) {
  return readFileSync(resolve(MIGRATIONS, name), 'utf8')
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const SOURCES = sourceFiles(SRC).map((path) => ({ path, text: code(path) }));
const relative = (path) => path.slice(SRC.length + 1).replaceAll('\\', '/');


describe('SCRUM-327 / SCRUM-318: the application has one draft -> submitted path', () => {
  it('calls submit_event_request from exactly one place', () => {
    const callers = SOURCES.filter(({ text }) => /rpc\(\s*['"]submit_event_request['"]/.test(text))
      .map(({ path }) => relative(path));

    expect(callers).toEqual(['services/eventRequestService.js']);
  });

  it("never writes status 'submitted' itself", () => {
    // An update such as .update({ status: STATUS.SUBMITTED }) would move a
    // request to submitted with no coordinator, which is the path 017's
    // constraint exists to refuse. It would also be a second place deciding
    // what submitting means.
    const writers = SOURCES.filter(({ text }) =>
      /\bstatus\s*:\s*(STATUS\.SUBMITTED|['"]submitted['"])/.test(text),
    ).map(({ path }) => relative(path));

    expect(writers).toEqual([]);
  });

  it('keeps status out of the columns an Organiser edit can write', () => {
    // PATCH /:id builds its update from COLUMN_BY_FIELD. If status were ever
    // in it, a request body could submit a draft without going through the
    // function.
    const service = SOURCES.find(({ path }) => relative(path) === 'services/eventRequestService.js').text;
    const map = service.match(/COLUMN_BY_FIELD\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/);

    expect(map).not.toBeNull();
    expect(map[1]).not.toMatch(/\bstatus\b/);
    expect(map[1]).not.toMatch(/submitted_at|assigned_coordinator_id/);
  });

  it('writes no status other than a new draft, anywhere in the application', () => {
    // SCRUM-321: a status change goes through change_event_request_status or
    // submit_event_request, which record it. A literal status in a write would
    // be a change that leaves no history. Creating a draft is the one status
    // written directly: it is not a transition, because nothing came before.
    const written = SOURCES.flatMap(({ path, text }) =>
      [...text.matchAll(/\bstatus\s*:\s*(STATUS\.\w+|['"][a-z_]+['"])/g)].map((m) => `${relative(path)}: ${m[0]}`),
    );

    expect(written).toEqual(['services/eventRequestService.js: status: STATUS.DRAFT']);
  });

  it('calls change_event_request_status from exactly one place', () => {
    const callers = SOURCES.filter(({ text }) => /rpc\(\s*['"]change_event_request_status['"]/.test(text))
      .map(({ path }) => relative(path));

    expect(callers).toEqual(['services/eventRequestService.js']);
  });

  it('only reads the status history table, and only from the service', () => {
    // SCRUM-322 reads it. Writing is for change_event_request_status and
    // submit_event_request, so no table call on it may insert, update, delete or
    // upsert.
    const touching = SOURCES.filter(({ text }) => /event_request_status_history/.test(text));

    expect(touching.map(({ path }) => relative(path))).toEqual(['services/eventRequestService.js']);

    const chains = [...touching[0].text.matchAll(/\.from\(\s*['"]event_request_status_history['"]\s*\)[^;]*;/g)]
      .map((m) => m[0]);

    expect(chains.length).toBeGreaterThan(0);
    for (const chain of chains) {
      expect(chain).toMatch(/\.select\(/);
      expect(chain).not.toMatch(/\.(insert|update|delete|upsert)\(/);
    }
  });
});


describe('SCRUM-327 / SCRUM-318: the database has one draft -> submitted path', () => {
  const migrations = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql'));

  it("sets status = 'submitted' only in the two definitions of submit_event_request", () => {
    const setters = migrations.filter((name) => /set status = 'submitted'/.test(sql(name)));

    // 016 created it and 021 replaced it with the version that also records
    // the status history. 041 (SCRUM-486) replaced it again, without the
    // coordinator: a new request now waits for the Event Coordinator Lead.
    // Each is the one definition in force at its time, and all three are
    // submit_event_request: this test failing when 041 arrived was it doing its
    // job, noticing a new writer of 'submitted', and the fix is to name 041
    // here, not to loosen the check. Any other file setting the status would
    // still fail it.
    expect(setters).toEqual([
      '016_submit_event_request.sql',
      '021_event_status_history.sql',
      '041_lead_assignment.sql',
    ]);
  });

  const fn = sql('021_event_status_history.sql');
  const start = fn.indexOf('create or replace function submit_event_request');
  // The current definition: 021 replaced 016's with one that also records the
  // status history. Only the function, not the rest of the file.
  const body = fn.slice(start, fn.indexOf('$$;', fn.indexOf('$$', start) + 2));

  it('refuses anything but a draft before it writes', () => {
    const guard = body.indexOf("status <> 'draft'");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf('update event_requests'));
  });

  it('chooses the coordinator once, with the one selection rule', () => {
    expect(body.match(/pick_event_coordinator\(/g)).toHaveLength(1);
    expect(body).not.toMatch(/count\(/);
  });

  it('sets status, submitted_at and the coordinator in one statement', () => {
    const update = body.match(/update event_requests set ([^;]*?) where id = p_event_request_id/);

    expect(update).not.toBeNull();
    expect(update[1]).toMatch(/status = 'submitted'/);
    expect(update[1]).toMatch(/submitted_at = p_submitted_at/);
    expect(update[1]).toMatch(/assigned_coordinator_id = v_coordinator/);
  });

  it('writes the assignment history once, after the update, in the same function', () => {
    const history = [...body.matchAll(/insert into event_request_assignment_history/g)];

    expect(history).toHaveLength(1);
    expect(history[0].index).toBeGreaterThan(body.indexOf('update event_requests'));
  });

  it('stops before writing when no coordinator is available', () => {
    const none = body.indexOf('if v_coordinator is null then');

    expect(none).toBeGreaterThan(-1);
    expect(body.slice(none, body.indexOf('end if', none))).toMatch(/raise exception/);
    expect(none).toBeLessThan(body.indexOf('update event_requests'));
  });

  it('is backed by the constraint that refuses a submitted request with no coordinator', () => {
    const constraint = sql('017_require_assigned_coordinator.sql');

    expect(constraint).toMatch(
      /add constraint event_requests_assigned_when_submitted check \( status in \('draft', 'cancelled'\) or assigned_coordinator_id is not null \)/,
    );
  });
});


describe('SCRUM-318: the lifecycle and the function agree about who can be submitted', () => {
  it('lets only a draft move to submitted, which is the status the function accepts', () => {
    const sources = Object.values(STATUS).filter((from) => canTransition(from, STATUS.SUBMITTED));

    expect(sources).toEqual([STATUS.DRAFT]);
  });

  it('lets a draft move only to submitted, so submitting is the one way out of draft', () => {
    const targets = Object.values(STATUS).filter((to) => canTransition(STATUS.DRAFT, to));

    expect(targets).toEqual([STATUS.SUBMITTED]);
  });
});
