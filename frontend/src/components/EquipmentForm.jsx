// EquipmentForm.jsx
//
// SCRUM-280. Creates an equipment type (no `type` prop) or edits one (AC2, AC3).
//
// Create sends all five fields as typed and lets the backend judge them. Edit
// sends only the fields that changed, because PATCH leaves the rest alone, and
// says so itself when nothing changed rather than sending an empty body. A
// cleared total goes as null, which the backend answers with "is required".
// Every message the backend returns for a 400 is shown, not just the first.
//
// SCRUM-314: an edit that changes the total is checked first. The backend says
// which reservations a smaller total would leave short; none means the edit
// saves at once, some means they are listed and nothing is saved until the
// staff member confirms (useConfirmedChange). An edit that leaves the total
// alone cannot leave a reservation short and saves as before.

import { useState } from "react";
import { createEquipment, updateEquipment, previewEquipmentChange } from "../services/equipmentService";
import { equipmentErrorMessages } from "../services/equipmentErrors";
import EquipmentImpactConfirmation from "./EquipmentImpactConfirmation";
import useConfirmedChange from "./useConfirmedChange";

function buildPayload(values, type) {
  const next = {
    name: values.name,
    description: values.description,
    category: values.category,
    location: values.location,
    totalQuantity: values.totalQuantity === "" ? null : Number(values.totalQuantity),
  };
  if (!type) return next;

  const original = {
    name: type.name,
    description: type.description ?? "",
    category: type.category ?? "",
    location: type.location ?? "",
    totalQuantity: type.totalQuantity,
  };
  return Object.fromEntries(Object.entries(next).filter(([field, value]) => value !== original[field]));
}

export default function EquipmentForm({ type = null, onSaved }) {
  const editing = type !== null;
  const [values, setValues] = useState({
    name: type?.name ?? "",
    description: type?.description ?? "",
    category: type?.category ?? "",
    location: type?.location ?? "",
    totalQuantity: type ? String(type.totalQuantity) : "",
  });
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const flow = useConfirmedChange();

  function bind(field) {
    return {
      value: values[field],
      onChange: (event) => setValues((current) => ({ ...current, [field]: event.target.value })),
    };
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting || flow.busy) return;

    const payload = buildPayload(values, type);
    if (editing && Object.keys(payload).length === 0) {
      setErrors(["No changes to save."]);
      return;
    }

    if (editing && payload.totalQuantity !== undefined) {
      setErrors([]);
      const reason = note.trim();
      flow.start({
        // The edited fields go with the total so a bad or taken name is refused now,
        // not after the reservations have been confirmed.
        preview: () => previewEquipmentChange(type.id, payload),
        save: (confirmedReservationIds) =>
          updateEquipment(type.id, {
            ...payload,
            ...(reason !== "" && { note: reason }),
            confirmedReservationIds,
          }),
        onSaved,
        action: "save",
      });
      return;
    }

    flow.cancel();
    setSubmitting(true);
    setErrors([]);
    try {
      if (editing) await updateEquipment(type.id, payload);
      else await createEquipment(payload);
      onSaved();
    } catch (err) {
      setErrors(equipmentErrorMessages(err, "save"));
      setSubmitting(false);
    }
  }

  if (flow.reviewing) {
    return (
      <EquipmentImpactConfirmation
        typeName={type.name}
        impact={flow.impact}
        stale={flow.stale}
        busy={flow.busy}
        errors={flow.errors}
        confirmLabel={flow.impact.affected.length === 0 ? "Save changes" : "Confirm and flag these reservations"}
        cancelLabel="Go back"
        onConfirm={flow.confirm}
        onCancel={flow.cancel}
      />
    );
  }

  const shownErrors = errors.length > 0 ? errors : flow.errors;
  const working = submitting || flow.busy;

  return (
    <form className="equipment-form" onSubmit={handleSubmit} noValidate>
      <h2>{editing ? `Edit ${type.name}` : "Add an equipment type"}</h2>

      <div className="equipment-form__field">
        <label htmlFor="equipment-name">Name</label>
        <input id="equipment-name" type="text" {...bind("name")} />
      </div>
      <div className="equipment-form__field">
        <label htmlFor="equipment-description">Description</label>
        <input id="equipment-description" type="text" {...bind("description")} />
      </div>
      <div className="equipment-form__field">
        <label htmlFor="equipment-category">Category</label>
        <input id="equipment-category" type="text" {...bind("category")} />
      </div>
      <div className="equipment-form__field">
        <label htmlFor="equipment-location">Location</label>
        <input id="equipment-location" type="text" {...bind("location")} />
      </div>
      <div className="equipment-form__field">
        <label htmlFor="equipment-total">Total quantity</label>
        <input id="equipment-total" type="number" min="0" step="1" {...bind("totalQuantity")} />
      </div>

      {editing && (
        <div className="equipment-form__field">
          <label htmlFor="equipment-reason">Reason for a change to the total (optional)</label>
          <textarea id="equipment-reason" rows="2" value={note} onChange={(event) => setNote(event.target.value)} />
        </div>
      )}

      {shownErrors.length > 0 && (
        <ul className="equipment-errors" role="alert">
          {shownErrors.map((message, index) => (
            <li key={index}>{message}</li>
          ))}
        </ul>
      )}

      <button type="submit" disabled={working}>
        {flow.stage === "checking" ? "Checking..." : working ? "Saving..." : editing ? "Save changes" : "Add equipment type"}
      </button>
    </form>
  );
}
