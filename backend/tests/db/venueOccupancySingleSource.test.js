/**
 * SCRUM-484 AC4: the occupied period is calculated by ONE shared function,
 * and it is the only calculation used wherever availability is decided.
 *
 * Sub-tasks 3 to 6 moved every caller onto venue_occupancy_conflicts() (032)
 * and retired SCRUM-139's JavaScript copy of the rule. These scans make sure
 * no second copy is left -- in the API's source, in the latest definition of
 * any SQL function, or in a PostgREST filter on bookings -- and that none can
 * quietly come back.
 *
 * Read from the text, comments stripped (a rule, or a name, that exists only
 * in a comment does not count), as the other SQL-text tests do.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(here, '../..');
const SRC = resolve(BACKEND, 'src');
const MIGRATIONS_DIR = resolve(BACKEND, 'db/migrations');

/** Every .js file under a directory, recursively. */
function jsFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return jsFiles(path);
    return path.endsWith('.js') ? [path] : [];
  });
}

/** JavaScript with block and line comments removed (a `//` after `:` is a URL, kept). */
function jsCode(path) {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** A migration with every `--` comment stripped, whitespace collapsed, lower-cased. */
function normalised(name) {
  return readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8')
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .toLowerCase();
}

const MIGRATIONS = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

/**
 * The latest definition of every SQL function still defined after all the
 * migrations run, in apply order. A function dropped after its last
 * definition (venue_block_booking_conflicts, 033) is gone and not listed.
 */
function latestFunctions() {
  const latest = new Map();
  for (const file of MIGRATIONS) {
    const sql = normalised(file);
    const events = [
      ...[...sql.matchAll(/create or replace function (\w+)\(/g)].map((m) => ({ kind: 'create', m })),
      ...[...sql.matchAll(/drop function (?:if exists )?(\w+)\(/g)].map((m) => ({ kind: 'drop', m })),
    ].sort((a, b) => a.m.index - b.m.index);
    for (const { kind, m } of events) {
      if (kind === 'drop') {
        latest.delete(m[1]);
        continue;
      }
      const open = sql.indexOf('$$', m.index);
      const close = sql.indexOf('$$;', open + 2);
      latest.set(m[1], { file, body: sql.slice(open + 2, close) });
    }
  }
  return latest;
}

const LATEST = latestFunctions();

/**
 * Anything that reads as a period overlap: a range `&&`, or a strict `<` / `>`
 * on a period column. `<=` / `>=` are left out on purpose: no half-open
 * overlap uses them, and the ones left are input validation ("a block must
 * end after it starts", "an end in the past"), not overlap tests.
 */
const OVERLAP = /&&|\b(?:\w+\.)?(?:starts_at|ends_at|proposed_start|proposed_end)\s*(?:<(?!=)|>(?!=))/g;

/** The functions that ARE the rule. */
const THE_RULE = new Set(['venue_occupied_period', 'venue_occupancy_conflicts']);

/**
 * The named exceptions: block against block, raw against raw (AC6 and the
 * design decision "a block is not padded"). venue_blocks_no_overlap in 011
 * is the guarantee; these only name the block that clashed.
 */
const BLOCK_VS_BLOCK = {
  create_venue_block: "tstzrange(starts_at, ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')",
  update_venue_block: "tstzrange(vb.starts_at, vb.ends_at, '[)') && tstzrange(v_starts_at, v_ends_at, '[)')",
};

/**
 * The other named exception: AC8's "not started" filter (034). update_venue
 * re-checks only approved bookings whose event has not started yet, written
 * `b.starts_at > now()`. It compares a booking's start with the clock, not two
 * periods, so it is no copy of the overlap rule; the overlap itself is asked
 * of venue_occupancy_conflicts(). Only this exact predicate, only in
 * update_venue: any other strict comparison there is still an offender.
 *
 * 035 writes it exactly twice: once in the old-clash set collected before
 * the venues row is updated, once in the new set after. SCRUM-493: 036 is
 * now the latest update_venue -- 035's body word for word plus the two
 * safety-text fields -- so it still writes it exactly twice.
 * The count is pinned, so a third copy -- or a stray one elsewhere in the
 * body -- fails instead of being swallowed by the exception.
 */
const NOT_STARTED = {
  update_venue: { text: 'b.starts_at > now()', count: 2 },
};


describe('SCRUM484_AC4 the JavaScript copy of the rule is gone', () => {
  it('SCRUM484_AC4_the_javascript_overlap_rule_is_removed', () => {
    expect(existsSync(resolve(SRC, 'domain/venueOccupancy.js'))).toBe(false);
    expect(existsSync(resolve(SRC, 'services/venueOccupancyService.js'))).toBe(false);

    const retired = /\b(isVenueFree|paddedPeriod|MAX_BUFFER_MINUTES|OCCUPYING_BOOKING_STATUSES|findOccupancies|findBlockedVenueIds)\b/;
    const imports = /from\s+['"][^'"]*\/(venueOccupancy|venueOccupancyService)(\.js)?['"]/;
    for (const path of jsFiles(SRC)) {
      const code = jsCode(path);
      const name = relative(BACKEND, path);
      expect(code, name).not.toMatch(retired);
      expect(code, name).not.toMatch(imports);
    }
  });
});


describe('SCRUM484_AC4 no copy of the overlap rule in SQL', () => {
  it('SCRUM484_AC4_no_copy_of_the_overlap_rule_remains_in_sql', () => {
    // The rule itself is there, defined last in 032.
    for (const name of THE_RULE) {
      expect(LATEST.get(name)?.file, name).toBe('032_venue_occupancy.sql');
    }
    // And the raw helper is not.
    expect(LATEST.has('venue_block_booking_conflicts')).toBe(false);
    // The scan replays every migration in the folder, so the latest
    // update_venue is the definition read here. Changed for SCRUM-493: 036
    // redefines update_venue (035's body plus emergency_access and
    // known_restrictions), so 036, not 035, is now the latest. Its re-check
    // is 035's unchanged, and NOT_STARTED's count of 2 still holds exactly.
    expect(LATEST.get('update_venue')?.file).toBe('036_venue_safety_facts.sql');

    const offenders = [];
    for (const [name, { file, body }] of LATEST) {
      if (THE_RULE.has(name)) continue;
      let rest = body;
      if (BLOCK_VS_BLOCK[name]) {
        expect(rest, `${file} ${name}: block-vs-block`).toContain(BLOCK_VS_BLOCK[name]);
        rest = rest.split(BLOCK_VS_BLOCK[name]).join(' ');
      }
      if (NOT_STARTED[name]) {
        const { text, count } = NOT_STARTED[name];
        const parts = rest.split(text);
        expect(parts.length - 1, `${file} ${name}: not-started filter, exactly ${count}x`).toBe(count);
        rest = parts.join(' ');
      }
      for (const m of rest.matchAll(OVERLAP)) {
        offenders.push(`${file} ${name}: ...${rest.slice(Math.max(0, m.index - 50), m.index + 50)}...`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('SCRUM484_AC4_the_only_overlap_constraint_is_venue_blocks_no_overlap', () => {
    // Outside function bodies, the one overlap written out is 011's exclusion
    // constraint on venue_blocks, raw against raw.
    const constraints = MIGRATIONS.flatMap((file) =>
      [...normalised(file).matchAll(/exclude using gist/g)].map(() => file),
    );
    expect(constraints).toEqual(['011_venue_blocks.sql']);
    expect(normalised('011_venue_blocks.sql')).toMatch(
      /constraint venue_blocks_no_overlap exclude using gist \(.*tstzrange\(starts_at, ends_at, '\[\)'\) with &&/,
    );
  });
});


describe('SCRUM484_AC4 no copy of the overlap rule in the services', () => {
  it('SCRUM484_AC4_no_copy_of_the_overlap_rule_remains_in_services', () => {
    // A PostgREST overlap filter on starts_at/ends_at is allowed only in the
    // blocks LISTING read the calendar uses (listVenueBlocks): it lists what a
    // window shows, decides no availability, and touches no bookings.
    const ALLOWED = new Set(['src/services/venueBlockService.js:listVenueBlocks']);
    const filter = /\.(lt|gt|lte|gte)\(\s*['"](starts_at|ends_at)['"]/g;

    const found = [];
    for (const path of jsFiles(resolve(SRC, 'services'))) {
      const code = jsCode(path);
      for (const m of code.matchAll(filter)) {
        const before = code.slice(0, m.index);
        const fns = [...before.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/g)];
        const fn = fns.length > 0 ? fns[fns.length - 1][1] : '(top level)';
        found.push(`${relative(BACKEND, path)}:${fn}`);

        // Never on bookings: the nearest .from(...) before it is not 'bookings'.
        const froms = [...before.matchAll(/\.from\(\s*['"](\w+)['"]/g)];
        const table = froms.length > 0 ? froms[froms.length - 1][1] : null;
        expect(table, `${relative(BACKEND, path)}:${fn}`).not.toBe('bookings');
      }
    }
    expect(found.length).toBeGreaterThan(0);
    for (const where of found) {
      expect(ALLOWED.has(where), where).toBe(true);
    }
  });
});
