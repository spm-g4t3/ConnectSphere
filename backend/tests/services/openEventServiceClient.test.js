/**
 * SCRUM-495: the paths of the open events service the route tests' in-memory
 * client does not reach: the shared Supabase client used when none is passed,
 * and a read that answers with no rows and no error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { answers } = vi.hoisted(() => ({ answers: {} }));

// Every filter returns the same thenable, so the stub answers whatever the
// service chains onto a table with that table's configured answer.
vi.mock('../../src/config/supabaseClient.js', () => {
  const from = (table) => {
    const chain = new Proxy(
      {},
      {
        get: (_target, prop) =>
          prop === 'then'
            ? (resolve) => resolve(answers[table])
            : () => chain,
      },
    );
    return chain;
  };
  return { supabase: { from, rpc: () => Promise.resolve(answers.rpc) }, supabaseAdmin: {}, default: {} };
});

import { listOpenEvents, getOpenEvent } from '../../src/services/openEventService.js';
import { NotFoundError } from '../../src/errors.js';

const ATTENDEE_ID = '44444444-4444-4444-8444-444444444444';
const EVENT_ID = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-10-12T10:00:00.000Z');

const openRow = {
  id: EVENT_ID,
  event_name: 'Open Day',
  description: 'Come along.',
  proposed_start: '2026-10-25T09:00:00+00:00',
  proposed_end: '2026-10-25T17:00:00+00:00',
  status: 'confirmed',
  registration_enabled: true,
  registration_opens_at: '2026-10-01T00:00:00+00:00',
  registration_closes_at: '2026-10-20T00:00:00+00:00',
  registration_capacity: null,
};

beforeEach(() => {
  for (const key of Object.keys(answers)) delete answers[key];
});

describe('SCRUM495 the shared client and empty answers', () => {
  it('SCRUM495_AC7_reads_through_the_shared_supabase_client_when_none_is_passed', async () => {
    answers.event_requests = { data: [openRow], error: null };
    answers.rpc = { data: [], error: null };

    const events = await listOpenEvents({ attendeeId: ATTENDEE_ID, now: NOW });

    expect(events.map((event) => event.id)).toEqual([EVENT_ID]);
  });

  it('SCRUM495_AC7_lists_nothing_when_the_read_returns_no_rows_and_no_error', async () => {
    answers.event_requests = { data: null, error: null };

    await expect(listOpenEvents({ attendeeId: ATTENDEE_ID, now: NOW })).resolves.toEqual([]);
  });

  it('SCRUM495_AC7_treats_an_event_as_not_open_when_the_read_returns_no_rows_and_no_error', async () => {
    answers.event_requests = { data: null, error: null };

    await expect(getOpenEvent({ attendeeId: ATTENDEE_ID, eventId: EVENT_ID, now: NOW })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('SCRUM495_AC7_counts_no_registrations_when_the_database_returns_no_rows_and_no_error', async () => {
    answers.event_requests = { data: [openRow], error: null };
    answers.rpc = { data: null, error: null };

    const [event] = await listOpenEvents({ attendeeId: ATTENDEE_ID, now: NOW });

    expect(event).toMatchObject({ isRegistered: false, placesLeft: null, isFull: false });
  });
});
