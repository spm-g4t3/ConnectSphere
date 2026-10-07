import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migration = (name) =>
  readFileSync(resolve(here, "../../db/migrations", name), "utf8");

const BASE = [
  "001_event_requests.sql",
  "005_event_request_details.sql",
  "007_user_roles.sql",
  "010_event_request_clarifications.sql",
];
const ASSIGNMENT = [
  "014_coordinator_assignment.sql",
  "015_assignment_function.sql",
  "016_submit_event_request.sql",
  "017_require_assigned_coordinator.sql",
];
const DECISION_STAND_IN = `
  alter table event_requests
    add column if not exists reviewing_coordinator_id uuid references auth.users(id);
`;
const STATUS_LIFECYCLE = [
  "020_event_status_lifecycle.sql",
  "021_event_status_history.sql",
  "022_event_status_transitions.sql",
];

describe("SCRUM-162 clarification transactions in Postgres", () => {
  let db;
  let organiser;
  let coordinator;
  let otherCoordinator;

  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
  const event = async (status = "under_review") =>
    (await one(
      `insert into event_requests
        (organiser_id, event_name, status, submitted_at, assigned_coordinator_id)
       values ($1, 'Clarification test', $2, now(), $3)
       returning id`,
      [organiser, status, coordinator],
    )).id;
  const history = async (id) =>
    (await db.query(
      `select entry_type, message, created_by, reply_by_date
         from event_request_clarification_history
        where event_request_id = $1
        order by created_at, id`,
      [id],
    )).rows;
  const notifications = async (id) =>
    (await db.query(
      "select recipient_id, type from notifications where payload->>'eventRequestId' = $1 order by created_at, id",
      [id],
    )).rows;
  const refused = async (promise) => {
    try {
      await promise;
      return null;
    } catch (error) {
      return error;
    }
  };

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      create schema auth;
      create table auth.users (
        id uuid primary key default gen_random_uuid(),
        email text
      );
    `);
    for (const name of BASE) await db.exec(migration(name));
    await db.exec(DECISION_STAND_IN);
    for (const name of ASSIGNMENT) await db.exec(migration(name));
    for (const name of STATUS_LIFECYCLE) await db.exec(migration(name));
    await db.exec(`
      create table notifications (
        id uuid primary key default gen_random_uuid(),
        recipient_id uuid not null references auth.users(id) on delete cascade,
        type text not null,
        booking_id uuid,
        block_id uuid,
        payload jsonb not null default '{}',
        read_at timestamptz,
        created_at timestamptz not null default now(),
        constraint notifications_type_known check (type in ('booking_flagged')),
        constraint notifications_booking_flagged_needs_refs check (
          type <> 'booking_flagged' or (booking_id is not null and block_id is not null)
        )
      );
    `);
    await db.exec(`
      create function reply_to_event_clarification(
        p_event_request_id uuid,
        p_organiser_id uuid,
        p_reply text
      )
      returns event_requests
      language sql
      as $$ select null::event_requests $$;
    `);
    await db.exec(migration("030_event_clarification_reply_by.sql"));
    await db.exec(migration("026_clarification_amendment_fields.sql"));

    organiser = (await one("insert into auth.users(email) values ('organiser@example.test') returning id")).id;
    coordinator = (await one("insert into auth.users(email) values ('coordinator@example.test') returning id")).id;
    otherCoordinator = (await one("insert into auth.users(email) values ('other@example.test') returning id")).id;
    await db.query(
      "insert into profiles (id, role) values ($1, 'event_organiser'), ($2, 'event_coordinator'), ($3, 'event_coordinator')",
      [organiser, coordinator, otherCoordinator],
    );
  }, 30000);

  afterAll(async () => {
    await db?.close();
  });

  it("records a future-dated question, text reply, repeat question and closure transactionally", async () => {
    const id = await event();
    const due = new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10);

    await db.query(
      "select * from request_event_clarification($1, $2, $2, $3, $4)",
      [id, coordinator, "Please confirm the attendee count.", due],
    );
    const pending = await one(
      "select status, clarification_reply_by_date from event_requests where id = $1",
      [id],
    );
    expect(pending.status).toBe("pending_clarification");
    expect(pending.clarification_reply_by_date.toISOString().slice(0, 10)).toBe(due);

    const secondOpen = await refused(db.query(
      "select * from request_event_clarification($1, $2, $2, 'Another question', null)",
      [id, coordinator],
    ));
    expect(secondOpen?.code).toBe("55000");
    expect(await history(id)).toHaveLength(1);
    expect(await notifications(id)).toHaveLength(1);

    await db.query("select * from reply_to_event_clarification($1, $2, $3)", [
      id, organiser, "The event expects 120 attendees.",
    ]);
    expect((await one("select status, clarification_reply_by_date from event_requests where id = $1", [id])))
      .toMatchObject({ status: "under_review", clarification_reply_by_date: null });

    await db.query(
      "select * from request_event_clarification($1, $2, $2, 'Please confirm the setup.', null)",
      [id, coordinator],
    );
    await db.query(
      "select * from close_event_clarification($1, $2, $2, 'We confirmed the answer by phone.')",
      [id, coordinator],
    );

    expect((await history(id)).map((entry) => entry.entry_type)).toEqual([
      "question", "reply", "question", "closure",
    ]);
    expect((await notifications(id)).map((entry) => entry.type)).toEqual([
      "clarification_requested",
      "clarification_replied",
      "clarification_requested",
      "clarification_closed",
    ]);
    expect((await notifications(id)).map((entry) => entry.recipient_id)).toEqual([
      organiser, coordinator, organiser, organiser,
    ]);
  });

  it("refuses wrong actors, wrong statuses, blank messages and expired dates without recording them", async () => {
    const id = await event();
    const due = new Date().toISOString().slice(0, 10);
    const wrongStatusId = await event("submitted");
    const wrongStatus = await refused(db.query(
      "select * from request_event_clarification($1, $2, $2, 'Question', null)",
      [wrongStatusId, coordinator],
    ));
    expect(wrongStatus?.code).toBe("55000");
    const wrongActor = await refused(db.query(
      "select * from request_event_clarification($1, $2, $3, 'Question', null)",
      [id, otherCoordinator, otherCoordinator],
    ));
    expect(wrongActor?.code).toBe("40001");

    const blank = await refused(db.query(
      "select * from request_event_clarification($1, $2, $2, '  ', null)",
      [id, coordinator],
    ));
    expect(blank?.code).toBe("22023");

    const expired = await refused(db.query(
      "select * from request_event_clarification($1, $2, $2, 'Question', $3)",
      [id, coordinator, due],
    ));
    expect(expired?.code).toBe("22023");

    await db.query(
      "select * from request_event_clarification($1, $2, $2, 'Question', null)",
      [id, coordinator],
    );
    const wrongCloser = await refused(db.query(
      "select * from close_event_clarification($1, $2, $2, 'Close it.')",
      [id, otherCoordinator],
    ));
    expect(wrongCloser?.code).toBe("42501");
    const wrongReplier = await refused(db.query(
      "select * from reply_to_event_clarification($1, $2, 'Reply.')",
      [id, otherCoordinator],
    ));
    expect(wrongReplier?.code).toBe("P0002");
    expect(await history(id)).toHaveLength(1);
    expect(await notifications(id))    .toHaveLength(1);
  });

  it("limits organiser amendments to fields requested by the coordinator", async () => {
    const id = await event();
    await db.query(
    `select * from request_event_clarification_with_fields(
      $1, $2, $2, 'Please update the name and attendance.', null, $3
    )`,
    [id, coordinator, ["eventName", "expectedAttendance"]],
    );

    const unrequested = await refused(db.query(
    `select * from reply_to_event_clarification_with_amendments(
      $1, $2, 'Here are the updates.', '{"purpose":"Not requested"}'::jsonb
    )`,
    [id, organiser],
    ));
    expect(unrequested?.code).toBe("22023");
    expect((await one("select status, event_name from event_requests where id = $1", [id])))
    .toMatchObject({ status: "pending_clarification", event_name: "Clarification test" });

    await db.query(
    `select * from reply_to_event_clarification_with_amendments(
      $1, $2, 'Updated as requested.', '{"eventName":"Updated event","expectedAttendance":125}'::jsonb
    )`,
    [id, organiser],
    );

    expect((await one(
    "select status, event_name, expected_attendance from event_requests where id = $1",
    [id],
    ))).toMatchObject({
    status: "under_review",
    event_name: "Updated event",
    expected_attendance: 125,
    });
    expect((await history(id)).map((entry) => entry.entry_type)).toEqual(["question", "reply"]);
    const requested = await one(
    "select requested_fields from event_request_clarification_history where event_request_id = $1 and entry_type = 'question'",
    [id],
    );
    expect(requested.requested_fields).toEqual(["eventName", "expectedAttendance"]);
  });

  it("makes history immutable and allows cancellation while a clarification is open", async () => {
    const id = await event();
    await db.query(
      "select * from request_event_clarification($1, $2, $2, 'Question', null)",
      [id, coordinator],
    );
    const entry = (await history(id))[0];
    const updateError = await refused(db.query(
      "update event_request_clarification_history set message = 'edited' where event_request_id = $1",
      [id],
    ));
    expect(updateError?.code).toBe("42501");

    const cancel = await db.query(
      "select * from change_event_request_status($1, 'pending_clarification', 'cancelled', $2, null, $2)",
      [id, coordinator],
    );
    expect(cancel.rows[0].status).toBe("cancelled");
    expect((await history(id))[0]).toEqual(entry);
  });
});
