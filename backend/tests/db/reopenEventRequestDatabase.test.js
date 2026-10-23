/**
 * SCRUM-355: a rejected request reopened, revised and resubmitted, against the
 * real schema. reopen_event_request (013) and the decision history (012).
 */

import { describe, it, expect } from 'vitest';

import { ROLE } from '../../src/domain/userRole.js';
import { useSchemaDb, seedEvent, seedUser } from './helpers/schemaDb.js';
import { queriesFor, refusal, expectSqlError } from './helpers/queries.js';
import { clientsCanExecute } from './helpers/grants.js';

const getDb = useSchemaDb();
const { one, rows } = queriesFor(getDb);

let counter = 0;
const user = (role) => seedUser(getDb(), { email: `u${counter += 1}@example.com`, role, fullName: `User ${counter}` });

async function people() {
  return {
    organiser: await user(ROLE.EVENT_ORGANISER),
    coordinator: await user(ROLE.EVENT_COORDINATOR),
    lead: await user(ROLE.EVENT_COORDINATOR_LEAD),
  };
}

const rejected = ({ organiser, coordinator }, note = 'The venue is too small.') =>
  seedEvent(getDb(), {
    status: 'rejected',
    organiser_id: organiser,
    assigned_coordinator_id: coordinator,
    reviewing_coordinator_id: coordinator,
    decision_note: note,
    proposed_start: new Date(Date.now() + 30 * 86_400_000),
    proposed_end: new Date(Date.now() + 30 * 86_400_000 + 7_200_000),
  });

const reopen = (id, caller) => getDb().query('select * from reopen_event_request($1, $2)', [id, caller]);
const submit = (id, caller) => getDb().query('select * from submit_event_request($1, now(), $2)', [id, caller]);
const row = (id) => one('select * from event_requests where id = $1', [id]);
const decisionHistory = (id) =>
  rows('select * from event_request_decision_history where event_request_id = $1 order by decided_at, id', [id]);
const statusHistory = (id) =>
  rows('select previous_status, new_status, changed_by, reason from event_request_status_history where event_request_id = $1 order by created_at, id', [id]);

// Assign, start the review and reject, through the real functions.
async function rejectAgain(id, { lead, coordinator }, note) {
  await getDb().query('select assign_event_request($1, $2, $3, null)', [id, coordinator, lead]);
  await getDb().query('select start_event_review($1, $2)', [id, coordinator]);
  await getDb().query("select decide_event_request($1, 'rejected', $2, $3, now())", [id, note, coordinator]);
}

describe('SCRUM-355: reopen_event_request', () => {
  it('SCRUM355_AC1_the_organiser_who_created_a_rejected_request_reopens_it', async () => {
    const who = await people();
    const id = await rejected(who);

    const { rows: [reopened] } = await reopen(id, who.organiser);

    expect(reopened.status).toBe('draft');
  });

  it('SCRUM355_AC1_another_organiser_is_answered_as_if_the_request_did_not_exist', async () => {
    const who = await people();
    const id = await rejected(who);
    const stranger = await user(ROLE.EVENT_ORGANISER);

    await expectSqlError(reopen(id, stranger), 'P0002');
    expect((await row(id)).status).toBe('rejected');
  });

  it.each([ROLE.EVENT_COORDINATOR, ROLE.EVENT_COORDINATOR_LEAD])(
    'SCRUM355_AC1_a_%s_is_refused_with_42501',
    async (role) => {
      const who = await people();
      const id = await rejected(who);

      await expectSqlError(reopen(id, await user(role)), '42501');
      expect((await row(id)).status).toBe('rejected');
    },
  );

  it('SCRUM355_AC1_a_null_caller_is_refused', async () => {
    const id = await rejected(await people());

    await expectSqlError(reopen(id, null), '42501');
  });

  it.each([
    ['draft', 'a Draft'],
    ['submitted', 'Submitted'],
    ['under_review', 'Under review'],
    ['approved', 'Approved'],
    ['cancelled', 'Cancelled'],
  ])('SCRUM355_AC1_a_%s_request_is_refused_with_its_status_named', async (status, words) => {
    const { organiser, coordinator } = await people();
    const id = await seedEvent(getDb(), {
      status,
      organiser_id: organiser,
      ...(status !== 'draft' && { assigned_coordinator_id: coordinator }),
    });

    const error = await refusal(reopen(id, organiser));

    expect(error.code).toBe('55000');
    expect(error.message).toBe(`This request is ${words}, and only a Rejected request can be reopened for revision`);
  });

  it('SCRUM355_AC2_the_rejection_moves_into_the_decision_history_and_is_no_longer_current', async () => {
    const who = await people();
    const id = await rejected(who, 'Too few marshals.');
    const before = await row(id);

    await reopen(id, who.organiser);

    const after = await row(id);
    expect(after).toMatchObject({
      status: 'draft',
      submitted_at: null,
      decision: null,
      decision_note: null,
      decided_by: null,
      decided_at: null,
      reviewing_coordinator_id: null,
    });
    expect(await decisionHistory(id)).toEqual([expect.objectContaining({
      decision: 'rejected',
      decision_note: 'Too few marshals.',
      decided_by: who.coordinator,
      decided_at: before.decided_at,
      superseded_reason: 'reopened_for_revision',
      superseded_by: who.organiser,
    })]);
  });

  it('SCRUM355_AC2_the_reopening_is_recorded_in_the_status_history', async () => {
    const who = await people();
    const id = await rejected(who);

    await reopen(id, who.organiser);

    expect(await statusHistory(id)).toEqual([{
      previous_status: 'rejected',
      new_status: 'draft',
      changed_by: who.organiser,
      reason: 'Reopened for revision',
    }]);
  });

  it('SCRUM355_AC3_the_reopened_request_is_edited_like_any_other_draft', async () => {
    const who = await people();
    const id = await rejected(who);
    await reopen(id, who.organiser);

    await getDb().query('update event_requests set expected_attendance = 80 where id = $1', [id]);

    expect((await row(id)).expected_attendance).toBe(80);
  });

  it('SCRUM355_AC4_resubmitting_returns_it_to_submitted_in_the_leads_unassigned_queue', async () => {
    const who = await people();
    const id = await rejected(who);
    await reopen(id, who.organiser);

    await submit(id, who.organiser);

    expect(await row(id)).toMatchObject({ status: 'submitted', assigned_coordinator_id: null });
  });

  it('SCRUM355_AC4_the_lead_can_assign_it_to_the_previous_coordinator', async () => {
    const who = await people();
    const id = await rejected(who);
    await reopen(id, who.organiser);
    await submit(id, who.organiser);

    await getDb().query('select assign_event_request($1, $2, $3, null)', [id, who.coordinator, who.lead]);

    expect((await row(id)).assigned_coordinator_id).toBe(who.coordinator);
  });

  it('SCRUM355_AC5_the_lead_is_notified_when_the_resubmission_arrives', async () => {
    const who = await people();
    const id = await rejected(who);
    await reopen(id, who.organiser);

    await submit(id, who.organiser);

    const notified = await rows(
      "select recipient_id from notifications where event_request_id = $1 and type = 'event_request_awaiting_assignment'",
      [id],
    );
    expect(notified.map((n) => n.recipient_id)).toContain(who.lead);
  });

  it('SCRUM355_AC6_AC8_the_request_keeps_its_id_and_every_history_across_two_rounds', async () => {
    const who = await people();
    const id = await rejected(who, 'First reason.');

    await reopen(id, who.organiser);
    await submit(id, who.organiser);
    await rejectAgain(id, who, 'Second reason.');
    await reopen(id, who.organiser);

    expect((await decisionHistory(id)).map((h) => h.decision_note)).toEqual(['First reason.', 'Second reason.']);
    expect((await statusHistory(id)).map((h) => `${h.previous_status}>${h.new_status}`)).toEqual([
      'rejected>draft',
      'draft>submitted',
      'submitted>under_review',
      'under_review>rejected',
      'rejected>draft',
    ]);
    expect(await rows('select new_coordinator_id from event_request_assignment_history where event_request_id = $1', [id]))
      .toEqual([{ new_coordinator_id: who.coordinator }]);
  });

  it('SCRUM355_AC7_a_reopened_request_cannot_be_deleted', async () => {
    const who = await people();
    const id = await rejected(who);
    await reopen(id, who.organiser);

    // restrict_violation: its decision and status histories both hold it.
    await expectSqlError(getDb().query('delete from event_requests where id = $1', [id]), '23001');
  });

  it('SCRUM355_AC1_only_the_api_may_call_it', async () => {
    expect(await clientsCanExecute(getDb(), 'reopen_event_request(uuid, uuid)', ['anon', 'authenticated', 'service_role']))
      .toEqual(['service_role']);
  });
});
