// EquipmentImpactConfirmation.jsx
//
// The step between "Save" and the change happening, when the change would leave
// reservations short: it lists them (event name, period, quantity, coordinator),
// says what confirming does, and saves nothing until the staff member confirms
// (AC2). Going back leaves everything as it was.
//
// It only draws what it is given. The flow lives in useConfirmedChange.

import { useEffect, useRef } from "react";
import { describeAffected, impactHeading } from "../services/equipmentImpactDisplay";
import Button from "./ui/Button";
import StatusBadge from "./ui/StatusBadge";

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
  // h3 under a catalogue section; h2 where it replaces a form under the panel's h1.
  headingLevel = 3,
}) {
  const Heading = `h${headingLevel}`;
  const headingRef = useRef(null);
  // This step replaces the button that led here (a form's Save, the retire
  // dialog), so its heading takes focus. It only appears after an action.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  const items = impact.affected.map(describeAffected);
  const none = items.length === 0;

  return (
    <section className="equipment-impact" aria-label={`Reservations affected: ${typeName}`}>
      <Heading ref={headingRef} tabIndex={-1} className="equipment-impact__heading">
        Check before you save
      </Heading>

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
                {item.alreadyFlagged && <StatusBadge tone="danger">Already flagged</StatusBadge>}
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
        <Button variant="danger" disabled={busy} onClick={onConfirm}>
          {busy ? "Saving..." : confirmLabel}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          {cancelLabel}
        </Button>
      </div>
    </section>
  );
}
