// EquipmentImpactConfirmation.jsx
//
// SCRUM-314, a subtask of SCRUM-310 "Handle Equipment Lost After Reservation".
// The step between "Save" and the change happening, when the change would leave
// reservations short: it lists them (event name, period, quantity, coordinator),
// says what confirming does, and saves nothing until the staff member confirms
// (AC2). Going back leaves everything as it was.
//
// It only draws what it is given. The flow lives in useConfirmedChange.

import { describeAffected, impactHeading } from "../services/equipmentImpactDisplay";

export default function EquipmentImpactConfirmation({
  typeName,
  impact,
  stale,
  busy,
  errors,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}) {
  const items = impact.affected.map(describeAffected);
  const none = items.length === 0;

  return (
    <section className="equipment-impact" aria-label={`Reservations affected: ${typeName}`}>
      <h3>Check before you save</h3>

      {stale && (
        <p className="equipment-errors" role="alert">
          The reservations this change affects have changed since you looked. Nothing was saved. This is the
          updated list.
        </p>
      )}

      <p>{impactHeading(impact.affected, impact.usableBefore, impact.usableAfter)}</p>

      {!none && (
        <>
          <p>
            Confirming flags them as equipment unavailable, sends their equipment requests back to Pending review and
            notifies the coordinators. The oldest reservations are kept.
          </p>
          <ul className="equipment-impact__list" aria-label="Affected reservations">
            {items.map((item) => (
              <li key={item.id} className="equipment-impact__item">
                <strong>{item.eventName}</strong>
                <span>{item.period}</span>
                <span>Quantity: {item.quantity}</span>
                <span>Coordinator: {item.coordinator}</span>
                {item.alreadyFlagged && <span>Already flagged</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {errors.length > 0 && (
        <ul className="equipment-errors" role="alert">
          {errors.map((message, index) => (
            <li key={index}>{message}</li>
          ))}
        </ul>
      )}

      <div className="equipment-impact__actions">
        <button type="button" disabled={busy} onClick={onConfirm}>
          {busy ? "Saving..." : confirmLabel}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          {cancelLabel}
        </button>
      </div>
    </section>
  );
}
