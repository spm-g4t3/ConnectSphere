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

import { useState } from "react";
import { recordEquipmentCondition } from "../services/equipmentService";
import { equipmentErrorMessages } from "../services/equipmentErrors";

function asQuantity(text) {
  return text === "" ? null : Number(text);
}

export default function EquipmentConditionForm({ type, onSaved }) {
  const [damaged, setDamaged] = useState(String(type.damagedQuantity));
  const [underMaintenance, setUnderMaintenance] = useState(String(type.underMaintenanceQuantity));
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  const usable = type.totalQuantity - Number(damaged || 0) - Number(underMaintenance || 0);

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    const payload = {};
    if (damaged !== String(type.damagedQuantity)) payload.damagedQuantity = asQuantity(damaged);
    if (underMaintenance !== String(type.underMaintenanceQuantity)) {
      payload.underMaintenanceQuantity = asQuantity(underMaintenance);
    }
    if (Object.keys(payload).length === 0) {
      setErrors(["Change at least one quantity."]);
      return;
    }
    payload.note = note;

    setSubmitting(true);
    setErrors([]);
    try {
      await recordEquipmentCondition(type.id, payload);
      onSaved();
    } catch (err) {
      setErrors(equipmentErrorMessages(err, "condition"));
      setSubmitting(false);
    }
  }

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

      {errors.length > 0 && (
        <ul className="equipment-errors" role="alert">
          {errors.map((message, index) => (
            <li key={index}>{message}</li>
          ))}
        </ul>
      )}

      <button type="submit" disabled={submitting}>
        {submitting ? "Saving..." : "Save quantities"}
      </button>
    </form>
  );
}
