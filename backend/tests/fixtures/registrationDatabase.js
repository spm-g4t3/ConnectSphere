// The assignment/notification tables used by 091's schedule-change trigger.
// Registration columns and functions still come from the actual migrations.
export async function addRegistrationNotificationPrerequisites(db) {
  await db.exec(`
    alter table event_requests add column assigned_coordinator_id uuid references auth.users(id);
    create table notifications (
      id uuid primary key default gen_random_uuid(),
      recipient_id uuid not null references auth.users(id),
      type text not null,
      event_request_id uuid references event_requests(id),
      payload jsonb not null default '{}',
      constraint notifications_type_known check (type in ('booking_flagged'))
    );
    grant insert on notifications to service_role;
  `);
}
