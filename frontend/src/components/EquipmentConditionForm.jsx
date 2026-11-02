// EquipmentConditionForm.jsx
//
// SCRUM-280. Records how many units of a type are damaged and how many are
// under maintenance, with a note (AC4, AC5). Reducing a number is how units
// become usable again.
//
// Only the quantities that changed are sent, and the note always is: the
// backend refuses a note-less change, and refuses a request that changes
// nothing. The usable figure shown is a preview worked out from what is typed;
// the backend's answer is the one that counts.
//
// SCRUM-314: before saving, the backend is asked which reservations the change
// would leave short. None means it saves at once; some means they are listed
// and nothing is saved until the staff member confirms (useConfirmedChange).
// The note is checked first, so nobody confirms a list and is then told the
// note was missing.

import { useState } from "react";
import { previewEquipmentChange, recordEquipmentCondition } from "../services/equipmentService";
import EquipmentImpactConfirmation from "./EquipmentImpactConfirmation";
import useConfirmedChange from "./useConfirmedChange";

function asQuantity(text) {
  return text === "" ? null : Number(text);
}

export default function EquipmentConditionForm({ type, onSaved }) {
  const [damaged, setDamaged] = useState(String(type.damagedQuantity));
  const [underMaintenance, setUnderMaintenance] = useState(String(type.underMaintenanceQuantity));
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState([]);
  const flow = useConfirmedChange();

  const usable = type.totalQuantity - Number(damaged || 0) - Number(underMaintenance || 0);

  function handleSubmit(event) {
    event.preventDefault();
    if (flow.busy) return;

    const payload = {};
    if (damaged !== String(type.damagedQuantity)) payload.damagedQuantity = asQuantity(damaged);
    if (underMaintenance !== String(type.underMaintenanceQuantity)) {
      payload.underMaintenanceQuantity = asQuantity(underMaintenance);
    }
    if (Object.keys(payload).length === 0) {
      setErrors(["Change at least one quantity."]);
      return;
    }
    if (note.trim() === "") {
      setErrors(["Note: is required"]);
      return;
    }

    setErrors([]);
    flow.start({
      preview: () => previewEquipmentChange(type.id, payload),
      save: (confirmedReservationIds) =>
        recordEquipmentCondition(type.id, { ...payload, note, confirmedReservationIds }),
      onSaved,
      action: "condition",
    });
  }

  if (flow.reviewing) {
    return (
      <EquipmentImpactConfirmation
        typeName={type.name}
        impact={flow.impact}
        stale={flow.stale}
        busy={flow.busy}
        errors={flow.errors}
        confirmLabel={flow.impact.affected.length === 0 ? "Save quantities" : "Confirm and flag these reservations"}
        cancelLabel="Go back"
        onConfirm={flow.confirm}
        onCancel={flow.cancel}
      />
    );
  }

  const shownErrors = errors.length > 0 ? errors : flow.errors;

  return (
    <form className="equipment-form" onSubmit={handleSubmit} noValidate>
      <h2>Damage and maintenance: {type.name}</h2>
      <p>Total quantity: {type.totalQuantity}</p>

      <div className="equipment-form__field">
        <label htmlFor="equipment-damaged">Damaged units</label>
        <input id="equipment-damaged" type="number" min="0" step="1" value={damaged} onChange={(event) => setDamaged(event.target.value)} />
      </div>
      <div className="equipment-form__field">
        <label htmlFor="equipment-maintenance">Under maintenance units</label>
        <input id="equipment-maintenance" type="number" min="0" step="1" value={underMaintenance} onChange={(event) => setUnderMaintenance(event.target.value)} />
      </div>

      <p>
        {usable < 0
          ? `Damaged plus under maintenance is above the total (${type.totalQuantity}).`
          : `Usable after this change: ${usable}`}
      </p>

      <div className="equipment-form__field">
        <label htmlFor="equipment-note">Note</label>
        <textarea id="equipment-note" rows="3" value={note} onChange={(event) => setNote(event.target.value)} />
      </div>

      {shownErrors.length > 0 && (
        <ul className="equipment-errors" role="alert">
          {shownErrors.map((message, index) => (
            <li key={index}>{message}</li>
          ))}
        </ul>
      )}

      <button type="submit" disabled={flow.busy}>
        {flow.stage === "checking" ? "Checking..." : flow.busy ? "Saving..." : "Save quantities"}
      </button>
    </form>
  );
}
