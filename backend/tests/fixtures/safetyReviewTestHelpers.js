// Legacy-state fixtures may need a status that production inserts must not use.
export async function withSafetyReviewTransitionGuardDisabled(db, seed) {
  await db.query('alter table event_requests disable trigger event_requests_safety_transitions');
  try {
    return await seed();
  } finally {
    await db.query('alter table event_requests enable trigger event_requests_safety_transitions');
  }
}
