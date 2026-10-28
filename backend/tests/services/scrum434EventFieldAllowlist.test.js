/**
 * SCRUM-434 (AC4, AC6): the services Venue Staff and Technical Support read
 * through may take only these event columns. A new column in one of their
 * selects fails here, and whoever adds it has to say why that role needs it.
 *
 * Reads the source rather than running it: each of these selects is a string,
 * and the string is what decides what leaves the database.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const services = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/services');
const read = (file) => readFileSync(path.join(services, file), 'utf8');

// What a booking or equipment worker needs of an event: which one it is, when
// it is, who coordinates it, and where it stands.
const ALLOWED = new Set([
  'id', 'event_name', 'proposed_start', 'proposed_end', 'status',
  'assigned_coordinator_id', 'expected_attendance',
]);

// event_requests(a, b) and event_requests!inner(a, b) embeds.
const embeds = (source) =>
  [...source.matchAll(/event_requests(?:!inner)?\s*\(([^)]*)\)/g)].map((m) => m[1].split(',').map((c) => c.trim()).filter(Boolean));

// .from('event_requests') ... .select('a, b')
const direct = (source) =>
  [...source.matchAll(/\.from\('event_requests'\)\s*\.select\('([^']*)'\)/g)].map((m) => m[1].split(',').map((c) => c.trim()));

const FILES = ['venueHoldService.js', 'venueService.js', 'bookingRequestService.js', 'equipmentLineService.js'];

describe('SCRUM-434: event columns read for Venue Staff and Technical Support', () => {
  it.each(FILES)('SCRUM434_AC4_%s_reads_only_allowed_event_columns', (file) => {
    const source = read(file);
    const lists = [...embeds(source), ...direct(source)];

    for (const columns of lists) {
      for (const column of columns) {
        expect(ALLOWED, `${file} selects event column "${column}"`).toContain(column);
      }
    }
  });

  it('SCRUM434_AC4_the_scan_finds_the_selects_it_is_meant_to_guard', () => {
    // A scan that matched nothing would pass for ever; these are known to be there.
    expect(embeds(read('bookingRequestService.js')).flat()).toContain('event_name');
    expect(embeds(read('venueHoldService.js')).flat()).toContain('proposed_start');
    expect(direct(read('venueHoldService.js')).flat()).toContain('assigned_coordinator_id');
  });

  it('SCRUM434_AC4_the_hold_candidate_list_never_names_the_organiser_or_the_purpose', () => {
    const source = read('venueHoldService.js');
    const select = direct(source).flat().join(',');

    expect(select).not.toMatch(/organiser|purpose|description|requirements/);
  });
});
