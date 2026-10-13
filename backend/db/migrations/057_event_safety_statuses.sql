-- 050_event_safety_statuses.sql
-- SCRUM-490: add the event stages used by the Safety Officer review.
--
-- Keep this migration limited to enum additions. PostgreSQL will not allow a
-- transaction to use a newly-added enum value before that transaction commits;
-- 051 therefore installs the functions and constraints that use these values.

alter type event_request_status add value if not exists 'safety_review';
alter type event_request_status add value if not exists 'safety_approved';
