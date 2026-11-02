/**
 * Live proof for the venue search text (SCRUM-592).
 *
 * Run with: npm run venue-search:check
 *
 * Read-only: it inserts, updates and deletes nothing, so there is no cleanup.
 * Exits non-zero on any failure.
 *
 * The unit tests prove the filter string searchVenues builds. Only the real
 * PostgREST can show how that string is read: that a quoted comma or
 * parenthesis stays inside its value, and that an escaped % or _ is literal.
 * So every search here goes through the real searchVenues, and each text
 * search is compared with the answer worked out in JavaScript from the full
 * active list: a venue whose name or location contains the text, ignoring
 * case. An exact match means nothing was widened, narrowed or dropped.
 *
 * It relies on one venue in the shared project: "Meeting room", location
 * "Singapore", capacity 200, active (confirmed on 2 November 2026). If that
 * changes, the preflight says which venue it expected rather than failing
 * the checks below obscurely.
 */

import { supabase } from '../src/config/supabaseClient.js';
import { searchVenues } from '../src/services/venueService.js';
import { createHarness } from './lib/harness.js';

const EXPECTED = { name: 'Meeting room', location: 'Singapore', maxCapacity: 200 };

const harness = createHarness();
const { check } = harness;

/** The venue the checks are about, read by its exact name. */
async function findExpectedVenue() {
  const { data, error } = await supabase
    .from('venues')
    .select('id, name, location, max_capacity, retired_at')
    .eq('name', EXPECTED.name);
  if (error) throw new Error(`could not read venues: ${error.message}`);

  const active = (data ?? []).filter((row) => row.retired_at === null);
  if (active.length !== 1) {
    console.error(
      `  expected exactly one active venue named "${EXPECTED.name}" (location "${EXPECTED.location}", `
      + `capacity ${EXPECTED.maxCapacity}); found ${active.length} active of ${(data ?? []).length}.`,
    );
    return null;
  }
  const [venue] = active;
  if (venue.location !== EXPECTED.location || venue.max_capacity !== EXPECTED.maxCapacity) {
    console.error(
      `  "${EXPECTED.name}" is now at "${venue.location}", capacity ${venue.max_capacity}; `
      + `this check expects "${EXPECTED.location}", capacity ${EXPECTED.maxCapacity}.`,
    );
    return null;
  }
  return venue;
}

const contains = (value, text) => value.toLowerCase().includes(text.toLowerCase());

/** What a literal, case-insensitive search for `text` should return. */
function expectedIds(all, text, columns) {
  return all
    .filter((venue) => columns.some((column) => contains(venue[column], text)))
    .map((venue) => venue.id);
}

const ids = (venues) => venues.map((venue) => venue.id);
const sameIds = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);

async function main() {
  console.log('\nVenue search text check (SCRUM-592)\n');

  const venue = await findExpectedVenue();
  if (!venue) {
    harness.failures += 1;
    return;
  }
  check(`"${EXPECTED.name}" is active at "${EXPECTED.location}", capacity ${EXPECTED.maxCapacity}`, true);

  const all = await searchVenues();
  check('the unfiltered search returns it', ids(all).includes(venue.id), `${all.length} active venues`);

  // --- AC1: q matches the name or the location, ignoring case ---------------
  for (const q of ['meeting', 'MEETING ROOM', 'singapore']) {
    const found = await searchVenues({ q });
    check(`q "${q}" includes "${EXPECTED.name}"`, ids(found).includes(venue.id), `${found.length} found`);
  }

  // --- location keeps its meaning: location only ----------------------------
  const byLocation = await searchVenues({ location: 'meeting' });
  check(
    `location "meeting" does not include "${EXPECTED.name}" (location only, as before)`,
    !ids(byLocation).includes(venue.id),
    `${byLocation.length} found`,
  );

  // --- AC2: every character is literal --------------------------------------
  // _ and % were LIKE wildcards; * is PostgREST's alias for %, made literal by
  // searchVenues' includes() re-check (D3). Each must return only venues that
  // really contain it, and so certainly not every venue.
  for (const q of ['_', '%', '*']) {
    const found = await searchVenues({ q });
    const expected = expectedIds(all, q, ['name', 'location']);
    check(
      `q "${q}" returns only venues whose name or location contains it`,
      sameIds(ids(found), expected),
      `${found.length} of ${all.length} returned, ${expected.length} expected`,
    );
  }

  // PostgREST's own syntax, and the quote and backslash that escape it.
  for (const q of ['a,b', '(x)', 'a.b', 'x:y', '"', '\\']) {
    let found;
    try {
      found = await searchVenues({ q });
    } catch (err) {
      check(`q ${JSON.stringify(q)} resolves`, false, `${err.name}: ${err.message}`);
      continue;
    }
    const expected = expectedIds(all, q, ['name', 'location']);
    check(
      `q ${JSON.stringify(q)} resolves, and returns exactly the venues containing it`,
      sameIds(ids(found), expected),
      `${found.length} returned, ${expected.length} expected`,
    );
  }

  // The probes above mostly expect nothing. So each punctuation character the
  // live names and locations really hold is searched for too: a match there
  // shows the quoted, escaped value is read as the character itself.
  const held = new Set(
    all.flatMap((v) => [...`${v.name}${v.location}`]).filter((c) => /[^\p{L}\p{N}\s*]/u.test(c)),
  );
  if (held.size === 0) console.log('  (no punctuation in the live names or locations to probe)');
  for (const q of [...held].sort()) {
    const found = await searchVenues({ q });
    const expected = expectedIds(all, q, ['name', 'location']);
    check(
      `q ${JSON.stringify(q)}, found in the live data, returns exactly the venues containing it`,
      expected.length > 0 && sameIds(ids(found), expected),
      `${found.length} returned, ${expected.length} expected`,
    );
  }

  // The location filter is escaped the same way.
  for (const location of ['_', '%']) {
    const found = await searchVenues({ location });
    const expected = expectedIds(all, location, ['location']);
    check(
      `location "${location}" returns only venues whose location contains it`,
      sameIds(ids(found), expected),
      `${found.length} returned, ${expected.length} expected`,
    );
  }

  // Not a check: Postgres text cannot hold NUL, and no fix is built for it
  // (review §4). Printed so the answer is on record.
  try {
    const found = await searchVenues({ q: 'a\u0000b' });
    console.log(`  note  q "a\\u0000b" resolved with ${found.length} venue(s)`);
  } catch (err) {
    console.log(`  note  q "a\\u0000b" was refused: ${err.name} (${err.status ?? 'no status'}): ${err.message}`);
  }

  // --- AC3: the other filters still apply alongside q -----------------------
  const tooSmall = await searchVenues({ q: 'meeting', minCapacity: EXPECTED.maxCapacity + 1 });
  check(
    `q "meeting" with minCapacity ${EXPECTED.maxCapacity + 1} excludes it`,
    !ids(tooSmall).includes(venue.id),
  );
  const bigEnough = await searchVenues({ q: 'meeting', minCapacity: EXPECTED.maxCapacity });
  check(
    `q "meeting" with minCapacity ${EXPECTED.maxCapacity} includes it`,
    ids(bigEnough).includes(venue.id),
  );
}

main()
  .catch((err) => {
    console.error(`\nFailed: ${err.message}`);
    harness.failures += 1;
  })
  .finally(() => {
    if (harness.failures > 0) {
      console.error(`\n${harness.failures} check(s) failed.\n`);
      process.exit(1);
    }
    console.log('\nAll checks passed. Read-only: nothing was written.\n');
  });
