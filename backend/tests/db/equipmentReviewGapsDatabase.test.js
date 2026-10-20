/**
 * SCRUM-300: gaps found in the reservation review, run against the final schema
 * in a real Postgres (PGlite).
 *
 *   1. A review cannot be completed while a reservation is still flagged (AC7).
 *   2. A fully reserved request does not stick in Under review: starting a
 *      review runs the Arranged check.
 *   3. Keep is offered only where it can work: the review read says per
 *      reservation whether it can be kept.
 *
 * The lock order between an inventory change and a reservation is pinned in
 * equipmentReviewFollowupsDatabase.test.js.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedUser } from './helpers/schemaDb.js';
import { queriesFor, refusal } from './helpers/queries.js';
import { singleReviewerSteps } from './helpers/equipment.js';

const START = '2026-12-01T10:00:00Z';
const END = '2026-12-01T12:00:00Z';
const NEW_START = '2026-12-05T14:00:00Z';
const NEW_END = '2026-12-05T16:00:00Z';

describe('SCRUM-300: closing the review gaps in Postgres', () => {
  let db;
  let organiser;
  let coordinator;
  let reviewerA;

  const { one, rows } = queriesFor(() => db);
  const {
    newType, newEvent, add, removeLine, start, reserve, move, keep,
    markUnavailable, complete, review, changePeriod, lineNamed, status, history, liveReservations,
  } = singleReviewerSteps(() => ({ db, organiser, coordinator, reviewerA }), {
    start: START, end: END, newStart: NEW_START, newEnd: NEW_END,
  });

  beforeAll(async () => {
    db = await createSchemaDb();

    organiser = await seedUser(db, { email: 'organiser@example.com' });
    coordinator = await seedUser(db, { email: 'coordinator@example.com' });
    reviewerA = await seedUser(db, { email: 'tech-a@example.com' });
  }, 60000);

  describe('AC7: a review cannot be completed over a flagged reservation', () => {
    /** Line A fully reserved, line B short by four, both flagged by a date change, review restarted. */
    const flaggedReview = async () => {
      const typeA = await newType('Projector', 10);
      const typeB = await newType('Microphone', 1);
      const event = await newEvent();
      const state = await add(event, typeA, 2);
      const withB = await add(event, typeB, 5);
      const lineA = state.request.lines[0].id;
      const lineB = withB.request.lines.find((l) => l.id !== lineA).id;
      await start(event);
      await reserve(event, lineA, 2);
      await reserve(event, lineB, 1);
      await changePeriod(event);
      expect(await status(event)).toBe('pending_review');
      await start(event);
      await markUnavailable(event, lineB, 'Only one microphone exists');
      return { event, lineA, lineB };
    };

    it('SCRUM300_AC7_complete_review_refuses_while_a_reservation_is_flagged', async () => {
      const { event } = await flaggedReview();

      const err = await refusal(complete(event));

      expect(err?.code).toBe('55000');
      expect(err.message).toMatch(/Decide on each flagged reservation/);
      expect(err.message).toMatch(/Still to decide: 2/);
      expect(await status(event)).toBe('under_review');
      expect((await liveReservations(event)).every((r) => r.flagged)).toBe(true);
    });

    it('SCRUM300_AC7_complete_review_works_once_every_flagged_reservation_is_decided', async () => {
      const { event } = await flaggedReview();
      for (const { id } of await liveReservations(event)) await move(event, id);

      const state = await complete(event);

      expect(state.request.status).toBe('cannot_be_fully_arranged');
      expect((await liveReservations(event)).some((r) => r.flagged)).toBe(false);
    });

    it('SCRUM300_AC7_one_flagged_reservation_is_named_in_the_singular', async () => {
      const { event } = await flaggedReview();
      const [first] = await liveReservations(event);
      await move(event, first.id);

      const err = await refusal(complete(event));

      expect(err?.code).toBe('55000');
      expect(err.message).toMatch(/Still to decide: 1/);
    });
  });

  describe('a fully reserved request does not stay Under review', () => {
    it('SCRUM300_AC6_starting_a_review_arranges_a_request_whose_last_short_line_was_removed', async () => {
      const typeA = await newType('Projector', 10);
      const typeB = await newType('Microphone', 1);
      const event = await newEvent();
      const state = await add(event, typeA, 2);
      const withB = await add(event, typeB, 3);
      const lineA = state.request.lines[0].id;
      const lineB = withB.request.lines.find((l) => l.id !== lineA).id;
      await start(event);
      await reserve(event, lineA, 2);
      await reserve(event, lineB, 1);

      const afterRemoval = await removeLine(event, lineB);
      expect(afterRemoval.request.status).toBe('pending_review');

      const started = await start(event);

      expect(started.request.status).toBe('arranged');
      expect(await status(event)).toBe('arranged');
      expect(await history(event)).toEqual(['started', 'interrupted', 'started', 'arranged']);
    });

    it('SCRUM300_AC6_a_request_with_a_short_line_stays_under_review_when_the_review_starts', async () => {
      const type = await newType('Projector', 10);
      const event = await newEvent();
      await add(event, type, 4);

      const started = await start(event);

      expect(started.request.status).toBe('under_review');
      expect(await history(event)).toEqual(['started']);
    });

    it('SCRUM300_AC6_a_flagged_reservation_keeps_a_fully_reserved_request_under_review', async () => {
      const type = await newType('Projector', 10);
      const event = await newEvent();
      const state = await add(event, type, 2);
      await start(event);
      await reserve(event, state.request.lines[0].id, 2);
      expect(await status(event)).toBe('arranged');
      await changePeriod(event);
      expect(await status(event)).toBe('pending_review');

      const started = await start(event);

      expect(started.request.status).toBe('under_review');
      expect((await liveReservations(event))[0].flagged).toBe(true);
    });
  });

  describe('AC7: Keep is offered only where it can work', () => {
    const reservedAndFlagged = async (flagIt) => {
      const type = await newType('Projector', 10);
      const event = await newEvent();
      const state = await add(event, type, 2);
      const line = state.request.lines[0].id;
      await start(event);
      await reserve(event, line, 2);
      await flagIt({ event, type, line });
      return { event, type, line };
    };
    const restart = async (event) => {
      if ((await status(event)) !== 'under_review') await start(event);
      return review(event);
    };
    const reservationOf = (state) => lineNamed(state, state.request.lines[0].name).reservations[0];

    it('SCRUM300_AC7_a_reservation_that_is_not_flagged_cannot_be_kept', async () => {
      const type = await newType('Projector', 10);
      const event = await newEvent();
      const state = await add(event, type, 4);
      await start(event);
      await reserve(event, state.request.lines[0].id, 2);

      const reservation = (await review(event)).request.lines[0].reservations[0];

      expect(reservation.flagged).toBe(false);
      expect(reservation.can_keep).toBe(false);
    });

    it('SCRUM300_AC7_a_date_change_flag_cannot_be_kept_and_the_read_says_so', async () => {
      const { event } = await reservedAndFlagged(({ event: e }) => changePeriod(e));
      const state = await restart(event);
      const reservation = reservationOf(state);

      expect(reservation.flagged).toBe(true);
      expect(reservation.can_keep).toBe(false);
      const err = await refusal(keep(event, reservation.id));
      expect(err?.code).toBe('55000');
      expect(err.message).toMatch(/period no longer matches/);
    });

    it('SCRUM300_AC7_a_line_amended_up_flags_a_reservation_that_can_be_kept', async () => {
      const { event } = await reservedAndFlagged(({ line: l }) =>
        db.query('update equipment_lines set quantity = 3 where id = $1', [l]));
      const state = await restart(event);
      const reservation = reservationOf(state);

      expect(reservation.flagged).toBe(true);
      expect(reservation.can_keep).toBe(true);
      const kept = await keep(event, reservation.id);
      expect(lineNamed(kept, kept.request.lines[0].name).reservations[0].flagged).toBe(false);
    });

    it('SCRUM300_AC7_a_retired_type_flags_a_reservation_that_cannot_be_kept', async () => {
      const { event } = await reservedAndFlagged(({ type }) =>
        db.query('update equipment_types set retired_at = now() where id = $1', [type]));
      const state = await restart(event);

      expect(reservationOf(state).flagged).toBe(true);
      expect(reservationOf(state).can_keep).toBe(false);
    });
  });
});
