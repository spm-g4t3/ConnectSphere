/**
 * SCRUM-318 / SCRUM-327: the application moves a draft to submitted only
 * through submit_event_request. Read from the API's source with comments
 * stripped; the database side is in schemaInvariantsDatabase.test.js.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { STATUS, canTransition } from '../../src/domain/eventRequestStatus.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../../src');

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
