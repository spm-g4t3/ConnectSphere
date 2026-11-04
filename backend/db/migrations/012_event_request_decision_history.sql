-- Migration 012: decisions that are no longer current (N29).
-- The current decision stays on event_requests. When it is superseded, as when a
-- rejected request is reopened for revision, it is copied here first, so the
-- request keeps every decision it has had.

create table if not exists event_request_decision_history (
  id uuid not null default gen_random_uuid(),
  event_request_id uuid not null,
  decision event_request_decision not null,
  decision_note text,
  decided_by uuid not null,
  decided_at timestamptz not null,
  superseded_reason text not null,
  superseded_by uuid not null,
  superseded_at timestamptz not null default now(),
  constraint event_request_decision_history_pkey primary key (id),
  -- restrict, so a request with a decision history cannot be deleted (SCRUM-355 AC7).
  constraint event_request_decision_history_event_request_id_fkey foreign key (event_request_id) references event_requests(id) on delete restrict,
  constraint event_request_decision_history_decided_by_fkey foreign key (decided_by) references auth.users(id) on delete restrict,
  constraint event_request_decision_history_superseded_by_fkey foreign key (superseded_by) references auth.users(id) on delete restrict,
  constraint event_request_decision_history_rejection_has_reason check ((decision <> 'rejected'::event_request_decision) or ((decision_note is not null) and (length(trim(decision_note)) > 0))),
  constraint event_request_decision_history_superseded_reason_known check (superseded_reason = any (array['reopened_for_revision'::text]))
);
create index if not exists idx_event_request_decision_history_event on event_request_decision_history (event_request_id, decided_at, id);
alter table event_request_decision_history enable row level security;
