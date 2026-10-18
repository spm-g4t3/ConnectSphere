# Historical SCRUM-363 migrations

These snapshots preserve SQL that may already be applied. They are not part of
the active deployment sequence and must not be replayed on a live database.

Apply the pending active migrations `098_event_readiness_details.sql` and
`099_confirmation_revision.sql`, in that order, after the existing safety and
arrangement prerequisites. They replace 085-087 without changing stored events,
arrangements or status history. The obsolete three-argument confirmation RPC is
removed by 099; fresh databases do not need to create it first.

Original SQL contents are unchanged. SQL tests use archived 086 only as an
upgrade input; fresh-schema tests execute 098 and 099 directly.
