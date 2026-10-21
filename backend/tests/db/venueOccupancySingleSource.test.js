/**
 * SCRUM-484 AC4: the occupied period is calculated by one shared SQL function.
 * These scans keep a second copy of the rule out of the API's source (comments
 * stripped); the SQL side is in schemaInvariantsDatabase.test.js.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(here, '../..');
const SRC = resolve(BACKEND, 'src');

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

describe('SCRUM484_AC4 the JavaScript copy of the rule is gone', () => {
  it('SCRUM484_AC4_the_javascript_overlap_rule_is_removed', () => {
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
        found.push(`${relative(BACKEND, path)}:${fn}`.replaceAll('\\', '/'));

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


// SCRUM-188 AC3 (SCRUM-193/194, B-AC3-01; SCRUM-484's unwritten B-AC4-18):
// the suitability check decides availability only through the shared
// function, the same one the search uses.
describe('SCRUM188_AC3 the suitability check uses the shared function', () => {
  it('SCRUM188_AC3_suitability_asks_the_shared_function_and_has_no_overlap_of_its_own', () => {
    const code = jsCode(resolve(SRC, 'services/venueSuitabilityService.js'));

    // Exactly one rpc, and it is venue_occupancy_conflicts, padded, with the
    // event's own holds excluded.
    const rpcs = [...code.matchAll(/\.rpc\(\s*['"](\w+)['"]\s*,\s*\{([^}]*)\}/g)];
    expect(rpcs.map((m) => m[1])).toEqual(['venue_occupancy_conflicts']);
    expect(rpcs[0][2]).toMatch(/p_pad_requested:\s*true/);
    expect(rpcs[0][2]).toMatch(/p_exclude_hold_event_id:\s*event\.id/);

    // No direct read of what occupies a venue: the only table read here is
    // the event's own bookings list (checkEventVenues), never blocks or holds.
    const tables = [...code.matchAll(/\.from\(\s*['"](\w+)['"]/g)].map((m) => m[1]);
    expect(tables).toEqual(['bookings']);

    // That bookings read is narrowed by event and status only, never by period.
    const read = code.slice(code.indexOf(".from('bookings')"), code.indexOf(".order('created_at')"));
    expect(read).not.toMatch(/\.(lt|gt|lte|gte|overlaps|range\w*)\(/);
    expect([...read.matchAll(/\.(eq|in)\(\s*['"](\w+)['"]/g)].map((m) => `${m[1]}:${m[2]}`)).toEqual([
      'eq:event_request_id',
      'in:status',
    ]);
  });
});
