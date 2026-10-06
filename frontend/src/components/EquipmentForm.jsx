// EquipmentForm.jsx
//
// SCRUM-280. Creates an equipment type (no `type` prop) or edits one (AC2, AC3).
//
// Create sends all five fields as typed and lets the backend judge them. Edit
// sends only the fields that changed, because PATCH leaves the rest alone, and
// says so itself when nothing changed rather than sending an empty body. A
// cleared total goes as null, which the backend answers with "is required".
// Every message the backend returns for a 400 is shown, not just the first.

import { useState } from "react";
import { createEquipment, updateEquipment } from "../services/equipmentService";
import { equipmentErrorMessages } from "../services/equipmentErrors";

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
  const [errors, setErrors] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  function bind(field) {
    return {
      value: values[field],
      onChange: (event) => setValues((current) => ({ ...current, [field]: event.target.value })),
    };
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    const payload = buildPayload(values, type);
    if (editing && Object.keys(payload).length === 0) {
      setErrors(["No changes to save."]);
      return;
    }

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

      {errors.length > 0 && (
        <ul className="equipment-errors" role="alert">
          {errors.map((message, index) => (
            <li key={index}>{message}</li>
          ))}
        </ul>
      )}

      <button type="submit" disabled={submitting}>
        {submitting ? "Saving..." : editing ? "Save changes" : "Add equipment type"}
      </button>
    </form>
  );
}
