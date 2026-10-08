// EventEquipmentSection.jsx
//
// SCRUM-247, for SCRUM-21 (Record Equipment Requirements for an Event). The
// "Equipment needed" section of the coordinator's event panel: the lines the
// coordinator has recorded for this event, and, for the event's assigned
// coordinator while it is Approved, the add, edit and remove actions.
//
// Its own file, with one import and one line in CoordinatorRequestDetail, so
// the coordinator panel that several stories are changing stays nearly
// untouched.
//
// What the screen decides and what the server decides. `canEdit` and `status`
// are conveniences, as isAssignedCoordinator is in the panel: they save the
// wrong person, or the wrong status, a button that can only be refused. The
// gate is the database function behind each route (037), which checks the
// assigned coordinator and the Approved status under the event's row lock.
// When the server refuses anyway, because the panel's copy was stale, the
// message is chosen by status code, not taken from the server, and the list is
// read again so the screen stops offering what it just learned it cannot do.
//
// The forms are noValidate on purpose. The number inputs keep min and step for
// their spinners, but the browser's own tooltip would otherwise stop the submit
// and the screen's sentence, the same one in every browser, would never show.
//
// Every write answers with the whole equipment state, and that response
// replaces what is on screen. No list is spliced by hand.
//
// The free-text "Equipment" line in the panel's Requirements section is the
// organiser's own wording and is left where it is. These lines are the
// coordinator's structured record against the catalogue.

import { useEffect, useState } from "react";
import {
  addEquipmentLine,
  amendEquipmentLine,
  getActiveEquipmentTypes,
  getEventEquipment,
  removeEquipmentLine,
} from "../services/eventEquipmentService";
import "./EventEquipmentSection.css";

/** The backend's limit on technical notes (equipmentLineValidation.js). */
const MAX_NOTES_LENGTH = 1000;

// Keyed by status code, as the panel's other tables are: the database's own
// messages are written for developers.
const WRITE_ERROR_MESSAGES = {
  403: "This event is no longer assigned to you, so you cannot change its equipment. Go back and reopen it to see who holds it now.",
  404: "That equipment line, or the event itself, no longer exists. The list below has been refreshed.",
  409: "Equipment can only be changed while the event is Approved, and this event has moved on. Go back and reopen it to see where it stands.",
};
const WRITE_ERROR_FALLBACK = "The equipment could not be saved. Try again.";

const FIELD_LABELS = {
  equipmentTypeId: "Equipment type",
  quantity: "Quantity",
  technicalNotes: "Technical notes",
  changes: "Changes",
};

// Why there is nothing to press, for a status the coordinator cannot change
// equipment in. "approved" is the one status that offers actions.
const NOT_EDITABLE_TEXT = {
  draft: "Equipment can be recorded once the request is approved.",
  submitted: "Equipment can be recorded once the request is approved.",
  under_review: "Equipment can be recorded once the request is approved.",
  pending_clarification: "Equipment can be recorded once the request is approved.",
  rejected: "Equipment cannot be recorded for a rejected request.",
  // SCRUM-21 AC10, as replaced by Week 7: locked from Safety review onwards.
  // The names are the ones 037 refuses (SCRUM-488 adds the statuses).
  safety_review: "Equipment on this event can only be changed as a significant change.",
  safety_approved: "Equipment on this event can only be changed as a significant change.",
  confirmed: "Equipment on a confirmed event can only be changed as a significant change.",
};
const NOT_EDITABLE_FALLBACK = "Equipment cannot be changed while the event is in this status.";

function isWholeNumberOfOneOrMore(text) {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 1;
}

/** A 400's own details, which name fields and never ids, or the generic line. */
function messageForWrite(err) {
  const status = err?.response?.status;
  if (status === 400) {
    const details = err.response.data?.details;
    if (Array.isArray(details) && details.length > 0) {
      return details
        .map(({ field, message }) => `${FIELD_LABELS[field] ?? "Equipment"}: ${message}`)
        .join(". ");
    }
    return WRITE_ERROR_FALLBACK;
  }
  return WRITE_ERROR_MESSAGES[status] ?? WRITE_ERROR_FALLBACK;
}

const isRefusalOfTheState = (err) => [403, 404, 409].includes(err?.response?.status);

/**
 * @param {Object}  props
 * @param {string}  props.requestId   the event request's id
 * @param {string}  props.status      the event's current status, e.g. "approved"
 * @param {boolean} props.canEdit     true for the event's assigned coordinator
 */
export default function EventEquipmentSection({ requestId, status, canEdit }) {
  const [equipment, setEquipment] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [types, setTypes] = useState([]);
  const [typesError, setTypesError] = useState(null);

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const [typeId, setTypeId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [notes, setNotes] = useState("");
  const [addError, setAddError] = useState(null);

  const [editingId, setEditingId] = useState(null);
  const [editQuantity, setEditQuantity] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editError, setEditError] = useState(null);

  const [removingId, setRemovingId] = useState(null);
  const [removeError, setRemoveError] = useState(null);

  const editable = Boolean(canEdit) && status === "approved";

  async function load() {
    try {
      setEquipment(await getEventEquipment(requestId));
      setLoadError(null);
    } catch {
      setLoadError("Could not load this event's equipment.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    getEventEquipment(requestId)
      .then((data) => {
        if (!cancelled) setEquipment(data);
      })
      .catch(() => {
        if (!cancelled) setLoadError("Could not load this event's equipment.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  // The catalogue is needed only to fill the add form's picker, so it is read
  // only for someone who can see that form. Active types only: a retired type
  // cannot be chosen (the server refuses it as well).
  useEffect(() => {
    if (!editable) return undefined;
    let cancelled = false;
    getActiveEquipmentTypes()
      .then((items) => {
        if (!cancelled) {
          setTypes(items);
          setTypesError(null);
        }
      })
      .catch(() => {
        if (!cancelled) setTypesError("Could not load the equipment catalogue.");
      });
    return () => {
      cancelled = true;
    };
  }, [editable]);

  const request = equipment?.request ?? null;
  const lines = request?.lines ?? [];
  const onEvent = new Set(lines.map((line) => line.equipmentTypeId));
  const choosable = types.filter((type) => !onEvent.has(type.id));

  /** After the server refuses because the screen's copy was stale: read again. */
  async function refreshAfterRefusal(err) {
    if (isRefusalOfTheState(err)) await load();
  }

  async function handleAdd(event) {
    event.preventDefault();
    setNotice(null);

    if (!typeId) {
      setAddError("Choose an equipment type.");
      return;
    }
    if (!isWholeNumberOfOneOrMore(quantity)) {
      setAddError("Enter a quantity that is a whole number of 1 or more.");
      return;
    }

    setBusy(true);
    setAddError(null);
    try {
      const name = types.find((type) => type.id === typeId)?.name ?? "Equipment";
      const next = await addEquipmentLine(requestId, {
        equipmentTypeId: typeId,
        quantity: Number(quantity.trim()),
        technicalNotes: notes.trim() === "" ? undefined : notes.trim(),
      });
      setEquipment(next);
      setTypeId("");
      setQuantity("1");
      setNotes("");
      setNotice(`${name} added.`);
    } catch (err) {
      setAddError(messageForWrite(err));
      await refreshAfterRefusal(err);
    } finally {
      setBusy(false);
    }
  }

  function startEdit(line) {
    setNotice(null);
    setRemovingId(null);
    setRemoveError(null);
    setEditingId(line.id);
    setEditQuantity(String(line.quantity));
    setEditNotes(line.technicalNotes ?? "");
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
  }

  async function handleSave(event, line) {
    event.preventDefault();
    setNotice(null);

    if (!isWholeNumberOfOneOrMore(editQuantity)) {
      setEditError("Enter a quantity that is a whole number of 1 or more.");
      return;
    }

    // Only what changed is sent, so a save that changes nothing makes no call
    // and the server never has to refuse an empty amendment.
    const changes = {};
    if (Number(editQuantity.trim()) !== line.quantity) {
      changes.quantity = Number(editQuantity.trim());
    }
    const trimmedNotes = editNotes.trim();
    if (trimmedNotes !== (line.technicalNotes ?? "")) {
      changes.technicalNotes = trimmedNotes === "" ? null : trimmedNotes;
    }
    if (Object.keys(changes).length === 0) {
      cancelEdit();
      return;
    }

    setBusy(true);
    setEditError(null);
    try {
      setEquipment(await amendEquipmentLine(requestId, line.id, changes));
      setEditingId(null);
      setNotice(`${line.name} updated.`);
    } catch (err) {
      setEditError(messageForWrite(err));
      await refreshAfterRefusal(err);
    } finally {
      setBusy(false);
    }
  }

  function askToRemove(line) {
    setNotice(null);
    setEditingId(null);
    setEditError(null);
    setRemoveError(null);
    setRemovingId(line.id);
  }

  async function handleRemove(line) {
    setBusy(true);
    setRemoveError(null);
    try {
      setEquipment(await removeEquipmentLine(requestId, line.id));
      setRemovingId(null);
      setNotice(`${line.name} removed.`);
    } catch (err) {
      setRemoveError(messageForWrite(err));
      await refreshAfterRefusal(err);
    } finally {
      setBusy(false);
    }
  }

  let whyNoActions = null;
  if (!editable) {
    whyNoActions = canEdit
      ? NOT_EDITABLE_TEXT[status] ?? NOT_EDITABLE_FALLBACK
      : "Only the assigned coordinator can change this event's equipment.";
  }

  return (
    <section className="event-equipment">
      <h3>
        Equipment needed
        {request && (
          <span className="event-equipment__status">{request.statusLabel}</span>
        )}
      </h3>

      {loading && <p>Loading equipment...</p>}
      {loadError && (
        <p className="coordinator-clarification__error" role="status">
          {loadError}
        </p>
      )}

      {!loading && !loadError && lines.length === 0 && (
        <p>No equipment has been requested for this event.</p>
      )}

      {lines.length > 0 && (
        <ul className="event-equipment__lines">
          {lines.map((line) => (
            <li key={line.id}>
              {editingId === line.id ? (
                <form className="event-equipment__form" noValidate onSubmit={(event) => handleSave(event, line)}>
                  <strong>{line.name}</strong>
                  <label>
                    {`Quantity for ${line.name}`}
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={editQuantity}
                      disabled={busy}
                      onChange={(event) => setEditQuantity(event.target.value)}
                    />
                  </label>
                  <label>
                    {`Technical notes for ${line.name}`}
                    <textarea
                      value={editNotes}
                      maxLength={MAX_NOTES_LENGTH}
                      disabled={busy}
                      onChange={(event) => setEditNotes(event.target.value)}
                    />
                  </label>
                  {editError && (
                    <p className="coordinator-clarification__error" role="alert">
                      {editError}
                    </p>
                  )}
                  <div className="event-equipment__actions">
                    <button type="submit" disabled={busy}>
                      {busy ? "Saving..." : "Save changes"}
                    </button>
                    <button type="button" disabled={busy} onClick={cancelEdit}>
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="event-equipment__summary">
                    <strong>{line.name}</strong>
                    <span>{`Quantity: ${line.quantity}`}</span>
                    {line.typeRetired && (
                      <small>This equipment type has been retired.</small>
                    )}
                  </div>
                  <p className="event-equipment__notes">
                    {line.technicalNotes ?? "No technical notes."}
                  </p>
                  {editable && removingId !== line.id && (
                    <div className="event-equipment__actions">
                      <button
                        type="button"
                        aria-label={`Edit ${line.name}`}
                        disabled={busy}
                        onClick={() => startEdit(line)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${line.name}`}
                        disabled={busy}
                        onClick={() => askToRemove(line)}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                  {editable && removingId === line.id && (
                    <div className="event-equipment__confirm">
                      <p>
                        {lines.length === 1
                          ? `Remove ${line.name}? It is the last line, so the equipment request will be cancelled.`
                          : `Remove ${line.name} from this event?`}
                      </p>
                      {removeError && (
                        <p className="coordinator-clarification__error" role="alert">
                          {removeError}
                        </p>
                      )}
                      <div className="event-equipment__actions">
                        <button type="button" disabled={busy} onClick={() => handleRemove(line)}>
                          {busy ? "Removing..." : "Yes, remove"}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setRemovingId(null);
                            setRemoveError(null);
                          }}
                        >
                          Keep it
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {notice && (
        <p className="event-equipment__notice" role="status">
          {notice}
        </p>
      )}

      {whyNoActions && <p className="event-equipment__why">{whyNoActions}</p>}

      {editable && (
        <form className="event-equipment__form event-equipment__add" noValidate onSubmit={handleAdd}>
          <h4>Add equipment</h4>
          {typesError && (
            <p className="coordinator-clarification__error" role="status">
              {typesError}
            </p>
          )}
          {!typesError && types.length > 0 && choosable.length === 0 && (
            <p>Every active equipment type is already on this event.</p>
          )}
          <label>
            Equipment type
            <select
              value={typeId}
              disabled={busy || choosable.length === 0}
              onChange={(event) => setTypeId(event.target.value)}
            >
              <option value="">Choose a type</option>
              {choosable.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Quantity
            <input
              type="number"
              min="1"
              step="1"
              value={quantity}
              disabled={busy}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </label>
          <label>
            Technical notes (optional)
            <textarea
              value={notes}
              maxLength={MAX_NOTES_LENGTH}
              disabled={busy}
              onChange={(event) => setNotes(event.target.value)}
            />
          </label>
          {addError && (
            <p className="coordinator-clarification__error" role="alert">
              {addError}
            </p>
          )}
          <div className="event-equipment__actions">
            <button type="submit" disabled={busy || choosable.length === 0}>
              {busy ? "Adding..." : "Add equipment"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
