# Historical registration migrations

These files preserve versions that may already be applied. They are **not part
of the active migration sequence** and must not be deployed or replayed.

079–081 were replaced by active migrations 092–094 after dev advanced to 089.
The earlier 088 reconciliation is also retained here for databases that applied
that revision. Original SQL contents are unchanged; upgrade tests use these
snapshots to verify existing registration data is preserved.

For fresh and existing deployments, apply SCRUM-494 / PR #68 first, then the
active `098_event_registration_persistence.sql`, `099_registration_eligibility.sql`
and `100_register_for_event.sql`. The unapplied 092-094 were renumbered after dev
advanced to 097. Consult the applied-migration ledger and the
registration deployment guide; do not execute this directory recursively.
