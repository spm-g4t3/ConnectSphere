/**
 * SCRUM-434 (AC4): what Technical Support is shown of an event. The equipment
 * queue and the equipment review answer with the event's name, times and
 * coordinator, and nothing else of it. A canary in every column a
 * Technical Support user has no need of would show up in the answer if a later
 * change added the column to either function.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSchemaDb, seedEvent, seedUser } from './helpers/schemaDb.js';
import { queriesFor } from './helpers/queries.js';
import { asJson } from './helpers/equipment.js';

describe('SCRUM-434: Technical Support sees only the event details its equipment request needs', () => {
  let db;
  let eventId;
  let organiserId;
  const { one } = queriesFor(() => db);

  const CANARY = {
    purpose: 'CANARY-PURPOSE-private-reason-for-the-event',
    description: 'CANARY-DESCRIPTION-free-text-the-organiser-wrote',
    venue_requirements: 'CANARY-VENUE-REQUIREMENTS',
    accessibility_requirements: 'CANARY-ACCESSIBILITY',
    equipment_requirements: 'CANARY-EQUIPMENT-REQUIREMENTS',
  };
  const ORGANISER_NAME = 'CANARY Organiser Name';

  beforeAll(async () => {
    db = await createSchemaDb();
    organiserId = await seedUser(db, { email: 'org434@example.com', role: 'event_organiser', fullName: ORGANISER_NAME });
    const coordinator = await seedUser(db, { email: 'coord434@example.com', role: 'event_coordinator', fullName: 'Rae Coordinator' });
    await seedUser(db, { email: 'tech434@example.com', role: 'technical_support_staff', fullName: 'Tessa Support' });
    eventId = await seedEvent(db, {
      status: 'approved',
      organiser_id: organiserId,
      event_name: 'Canary Event',
      assigned_coordinator_id: coordinator,
      proposed_start: '2030-01-10T10:00:00Z',
      proposed_end: '2030-01-10T12:00:00Z',
      expected_attendance: 77,
      ...CANARY,
    });
    const type = (await one("insert into equipment_types (name, total_quantity) values ('Projector', 10) returning id")).id;
    await one('select add_equipment_line($1, $2, $3, $4, null)::text as answer', [eventId, coordinator, type, 2]);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  const everythingAnswered = (answer) => JSON.stringify(answer);

  it('SCRUM434_AC4_the_equipment_review_names_the_event_by_five_fields_only', async () => {
    const answer = asJson(await one('select equipment_review_for_event($1)::text as answer', [eventId]));

    expect(Object.keys(answer.event).sort()).toEqual(['assigned_coordinator_id', 'id', 'name', 'proposed_end', 'proposed_start']);
  });

  it('SCRUM434_AC4_the_equipment_review_carries_none_of_the_events_private_text', async () => {
    const text = everythingAnswered(asJson(await one('select equipment_review_for_event($1)::text as answer', [eventId])));

    for (const value of [...Object.values(CANARY), ORGANISER_NAME]) {
      expect(text).not.toContain(value);
    }
    expect(text).not.toContain(organiserId);
  });

  it('SCRUM434_AC4_the_queue_carries_none_of_the_events_private_text', async () => {
    const tech = (await one("select id from profiles where role::text = 'technical_support_staff'")).id;
    const answer = asJson(await one('select equipment_request_queue($1, null, true, 200)::text as answer', [tech]));
    const text = everythingAnswered(answer);

    expect(answer.requests).toHaveLength(1);
    for (const value of [...Object.values(CANARY), ORGANISER_NAME]) {
      expect(text).not.toContain(value);
    }
    expect(text).not.toContain(organiserId);
    // Nor the attendance, which no equipment decision needs.
    expect(Object.keys(answer.requests[0])).not.toContain('expected_attendance');
  });
});
