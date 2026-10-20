import { queriesFor } from './queries.js';
import { seedEvent } from './schemaDb.js';

// The equipment functions answer jsonb; ::text and JSON.parse keep the
// numbers and nulls exactly as Postgres wrote them.
export const asJson = (row) => JSON.parse(row.answer);

// Both factories take a getter for the file's state ({ db, organiser,
// coordinator, reviewerA }), because those are only assigned in beforeAll.
// Type and event names carry Math.random() so tests in one file never collide.

/** The reservation files' steps: each action names who takes it. */
export function reservationSteps(ctx, { start: START, end: END, newStart: NEW_START, newEnd: NEW_END }) {
  const { one, rows } = queriesFor(() => ctx().db);

  const newType = async (name, total = 10) =>
    (await one('insert into equipment_types (name, total_quantity) values ($1, $2) returning id', [name, total])).id;
  const newEvent = ({ status = 'approved', start = START, end = END } = {}) =>
    seedEvent(ctx().db, {
      status,
      organiser_id: ctx().organiser,
      assigned_coordinator_id: ctx().coordinator,
      event_name: `Event ${Math.random()}`,
      proposed_start: start,
      proposed_end: end,
    });

  const add = async (event, type, quantity) =>
    asJson(await one('select add_equipment_line($1, $2, $3, $4, null)::text as answer', [event, ctx().coordinator, type, quantity]));
  const start = async (event, who) =>
    asJson(await one('select start_equipment_review($1, $2)::text as answer', [event, who]));
  const reserve = async (event, who, line, quantity) =>
    asJson(await one('select reserve_equipment($1, $2, $3, $4)::text as answer', [event, who, line, quantity]));

  const reduce = async (event, who, id, quantity, reason = 'Not needed') =>
    asJson(await one('select reduce_equipment_reservation($1, $2, $3, $4, $5)::text as answer', [event, who, id, quantity, reason]));
  const release = async (event, who, id, reason = 'Returned') =>
    asJson(await one('select release_equipment_reservation($1, $2, $3, $4)::text as answer', [event, who, id, reason]));
  const move = async (event, who, id, reason = null) =>
    asJson(await one('select move_equipment_reservation($1, $2, $3, $4)::text as answer', [event, who, id, reason]));
  const keep = async (event, who, id, reason = null) =>
    asJson(await one('select keep_equipment_reservation($1, $2, $3, $4)::text as answer', [event, who, id, reason]));
  const reservation = (event) =>
    one(
      `select id, quantity, start_at, end_at, flagged, flag_reason, released_at, release_reason
         from equipment_reservations where event_request_id = $1 order by created_at, id limit 1`,
      [event],
    );
  const changePeriod = (event, s = NEW_START, e = NEW_END) =>
    ctx().db.query('update event_requests set proposed_start = $2, proposed_end = $3 where id = $1', [event, s, e]);
  const lineId = (state, name) => state.request.lines.find((l) => l.name === name).id;
  const live = (event) =>
    rows(
      'select quantity, start_at, end_at from equipment_reservations where event_request_id = $1 and released_at is null',
      [event],
    );
  const events = (event) =>
    rows(
      'select action, user_id, reason, quantity_before, quantity_after, start_after, end_after from equipment_reservation_events where event_request_id = $1 order by id',
      [event],
    );
  const requestStatus = async (event) =>
    (await one("select status::text as s from equipment_requests where event_request_id = $1 and status <> 'cancelled'", [event])).s;

  /** An approved event with one line, already Under review by reviewerA. */
  const reviewed = async (typeName, total, quantity, opts) => {
    const type = await newType(`${typeName} ${Math.random()}`, total);
    const event = await newEvent(opts);
    const state = await add(event, type, quantity);
    await start(event, ctx().reviewerA);
    return { event, type, line: state.request.lines[0].id };
  };

  return {
    newType, newEvent, add, start, reserve, reduce, release, move, keep,
    reservation, changePeriod, lineId, live, events, requestStatus, reviewed,
  };
}

/** The review follow-up files' steps: reviewerA takes every review action. */
export function singleReviewerSteps(ctx, { start: START, end: END, newStart: NEW_START, newEnd: NEW_END }) {
  const { one, rows } = queriesFor(() => ctx().db);
  const reviewer = () => ctx().reviewerA;

  const newType = async (name, total) =>
    (await one('insert into equipment_types (name, total_quantity) values ($1, $2) returning id', [`${name} ${Math.random()}`, total])).id;
  const newEvent = () =>
    seedEvent(ctx().db, {
      status: 'approved',
      organiser_id: ctx().organiser,
      event_name: `Event ${Math.random()}`,
      assigned_coordinator_id: ctx().coordinator,
      proposed_start: START,
      proposed_end: END,
    });

  const add = async (event, type, quantity) =>
    asJson(await one('select add_equipment_line($1, $2, $3, $4, null)::text as answer', [event, ctx().coordinator, type, quantity]));
  const removeLine = async (event, line) =>
    asJson(await one('select remove_equipment_line($1, $2, $3)::text as answer', [event, ctx().coordinator, line]));
  const start = async (event) =>
    asJson(await one('select start_equipment_review($1, $2)::text as answer', [event, reviewer()]));
  const reserve = async (event, line, quantity) =>
    asJson(await one('select reserve_equipment($1, $2, $3, $4)::text as answer', [event, reviewer(), line, quantity]));
  const move = async (event, id) =>
    asJson(await one('select move_equipment_reservation($1, $2, $3, null)::text as answer', [event, reviewer(), id]));
  const reduce = async (event, id, quantity) =>
    asJson(await one('select reduce_equipment_reservation($1, $2, $3, $4, $5)::text as answer', [event, reviewer(), id, quantity, 'Fewer needed']));
  const release = async (event, id) =>
    asJson(await one('select release_equipment_reservation($1, $2, $3, $4)::text as answer', [event, reviewer(), id, 'Not needed']));
  const keep = async (event, id) =>
    asJson(await one('select keep_equipment_reservation($1, $2, $3, null)::text as answer', [event, reviewer(), id]));
  const markUnavailable = async (event, line, note) =>
    asJson(await one('select mark_equipment_line_unavailable($1, $2, $3, $4)::text as answer', [event, reviewer(), line, note]));
  const complete = async (event) =>
    asJson(await one('select complete_equipment_review($1, $2)::text as answer', [event, reviewer()]));
  const review = async (event) =>
    asJson(await one('select equipment_review_for_event($1)::text as answer', [event]));

  const changePeriod = (event) =>
    ctx().db.query('update event_requests set proposed_start = $2, proposed_end = $3 where id = $1', [event, NEW_START, NEW_END]);
  const lineNamed = (state, name) => state.request.lines.find((l) => l.name === name);
  const status = async (event) =>
    (await one("select status::text as s from equipment_requests where event_request_id = $1 and status <> 'cancelled'", [event])).s;
  const history = async (event) =>
    (await rows(
      `select h.action from equipment_review_history h
         join equipment_requests r on r.id = h.equipment_request_id
        where r.event_request_id = $1 order by h.id`,
      [event],
    )).map((row) => row.action);
  const liveReservations = (event) =>
    rows(
      'select id, flagged from equipment_reservations where event_request_id = $1 and released_at is null order by created_at, id',
      [event],
    );

  return {
    newType, newEvent, add, removeLine, start, reserve, move, reduce, release, keep,
    markUnavailable, complete, review, changePeriod, lineNamed, status, history, liveReservations,
  };
}
