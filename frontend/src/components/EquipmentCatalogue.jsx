// EquipmentCatalogue.jsx
//
// SCRUM-280, the screen for SCRUM-275 "Maintain Equipment Catalogue and
// Status". Technical Support Staff only (the route guards it, and every
// backend call refuses anyone else).
//
// Lists every type with total, damaged, under maintenance and usable, with
// retired types in their own section, and from it staff can create and edit a
// type (AC2, AC3), record damaged and under-maintenance quantities with a note
// (AC4, AC5), retire and reinstate (AC6), and open a type's change history
// (AC8).
//
// Follows VenueCatalogue: one panel at a time with a Back button rather than a
// modal, a two-step confirm for retiring, and a refetch after every change
// rather than splicing a response into the list.
//
// SCRUM-314: retiring a type that has reservations shows them under its row and
// saves nothing until they are confirmed (the same step the edit and damage
// forms use); a type with no reservations retires at once after the existing
// "Confirm retire".

import { Fragment, useCallback, useEffect, useState } from "react";
import {
  listEquipment,
  retireEquipment,
  reinstateEquipment,
  previewEquipmentChange,
} from "../services/equipmentService";
import { equipmentErrorMessages, isStaleEquipmentError } from "../services/equipmentErrors";
import EquipmentImpactConfirmation from "./EquipmentImpactConfirmation";
import useConfirmedChange from "./useConfirmedChange";
import EquipmentForm from "./EquipmentForm";
import EquipmentConditionForm from "./EquipmentConditionForm";
import EquipmentHistory from "./EquipmentHistory";
import "./EquipmentCatalogue.css";

const COLUMNS = 8;

function EquipmentTable({
  types, retired, confirmingId, busyId, rowError, flow, onPanel, onConfirm, onCancelRetire, onChangeRetirement,
}) {
  return (
    <table className="equipment-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Category</th>
          <th>Location</th>
          <th className="equipment-table__number">Total</th>
          <th className="equipment-table__number">Damaged</th>
          <th className="equipment-table__number">Under maintenance</th>
          <th className="equipment-table__number">Usable</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {types.map((type) => {
          const reinstating = busyId === type.id;
          const confirming = confirmingId === type.id;
          const retiring = confirming && flow.busy;
          const reviewing = confirming && flow.reviewing;
          const anyBusy = Boolean(busyId) || flow.busy || flow.reviewing;
          return (
            <Fragment key={type.id}>
            <tr>
              <td>{type.name}</td>
              <td>{type.category ?? "-"}</td>
              <td>{type.location ?? "-"}</td>
              <td className="equipment-table__number">{type.totalQuantity}</td>
              <td className="equipment-table__number">{type.damagedQuantity}</td>
              <td className="equipment-table__number">{type.underMaintenanceQuantity}</td>
              <td className="equipment-table__number">{type.usableQuantity}</td>
              <td>
                <div className="equipment-table__actions">
                  <button aria-label={`Edit ${type.name}`} onClick={() => onPanel({ mode: "edit", type })}>
                    Edit
                  </button>
                  {!retired && (
                    <button
                      aria-label={`Damage and maintenance for ${type.name}`}
                      onClick={() => onPanel({ mode: "condition", type })}
                    >
                      Damage and maintenance
                    </button>
                  )}
                  <button aria-label={`History for ${type.name}`} onClick={() => onPanel({ mode: "history", type })}>
                    History
                  </button>
                  {retired ? (
                    <button
                      aria-label={`Reinstate ${type.name}`}
                      disabled={anyBusy}
                      onClick={() => onChangeRetirement(type, "reinstate")}
                    >
                      {reinstating ? "Reinstating..." : "Reinstate"}
                    </button>
                  ) : confirming ? (
                    <>
                      <button
                        aria-label={`Confirm retire ${type.name}`}
                        disabled={anyBusy}
                        onClick={() => onChangeRetirement(type, "retire")}
                      >
                        {retiring ? "Checking..." : "Confirm retire"}
                      </button>
                      <button
                        aria-label={`Cancel retire ${type.name}`}
                        disabled={flow.busy}
                        onClick={onCancelRetire}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button aria-label={`Retire ${type.name}`} disabled={anyBusy} onClick={() => onConfirm(type.id)}>
                      Retire
                    </button>
                  )}
                </div>
              </td>
            </tr>
            {reviewing && (
              <tr>
                <td colSpan={COLUMNS}>
                  <EquipmentImpactConfirmation
                    typeName={type.name}
                    impact={flow.impact}
                    stale={flow.stale}
                    busy={flow.busy}
                    errors={flow.errors}
                    confirmLabel={
                      flow.impact.affected.length === 0 ? "Retire" : "Retire and flag these reservations"
                    }
                    cancelLabel="Keep this type"
                    onConfirm={flow.confirm}
                    onCancel={onCancelRetire}
                  />
                </td>
              </tr>
            )}
            {rowError?.id === type.id && (
              <tr>
                <td colSpan={COLUMNS}>
                  <ul className="equipment-errors" role="alert">
                    {rowError.messages.map((message, index) => (
                      <li key={index}>{message}</li>
                    ))}
                  </ul>
                </td>
              </tr>
            )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

export default function EquipmentCatalogue() {
  const [types, setTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // { mode: "create" } | { mode: "edit" | "condition" | "history", type } | null
  const [activePanel, setActivePanel] = useState(null);

  // Per row, as in VenueCatalogue: ids rather than booleans, so one row's
  // request does not grey out every other row's buttons.
  const [confirmingId, setConfirmingId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [rowError, setRowError] = useState(null); // { id, messages }

  // SCRUM-314: the retire flow, which previews the reservations a retirement
  // would leave short and asks for a confirmation when there are any.
  const retireFlow = useConfirmedChange();

  // The list stays on screen while it refreshes after a change, so this does
  // not raise `loading` again: it starts true and drops once the first load
  // settles. (It also keeps setState out of the synchronous part of the effect
  // below, which react-hooks/set-state-in-effect rejects.)
  const refreshTypes = useCallback(async () => {
    try {
      setTypes(await listEquipment());
      setLoadError(null);
    } catch (err) {
      setLoadError(equipmentErrorMessages(err, "load")[0]);
    }
  }, []);

  // The first load. Declared inside the effect, which is how React's own docs
  // write a fetch, so a response that arrives after unmounting is dropped.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await listEquipment();
        if (!cancelled) {
          setTypes(data);
          setLoadError(null);
        }
      } catch (err) {
        if (!cancelled) setLoadError(equipmentErrorMessages(err, "load")[0]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  function handleSaved() {
    setActivePanel(null);
    refreshTypes();
  }

  async function reinstate(type) {
    setBusyId(type.id);
    setRowError(null);
    try {
      await reinstateEquipment(type.id);
      await refreshTypes();
    } catch (err) {
      setRowError({ id: type.id, messages: equipmentErrorMessages(err, "reinstate") });
      // Our copy of the row is stale, whoever made it so.
      if (isStaleEquipmentError(err)) await refreshTypes();
    } finally {
      setBusyId(null);
      setConfirmingId(null);
    }
  }

  function retire(type) {
    setRowError(null);
    retireFlow.start({
      preview: () => previewEquipmentChange(type.id, { retire: true }),
      save: (confirmedReservationIds) => retireEquipment(type.id, { confirmedReservationIds }),
      action: "retire",
      onSaved: async () => {
        setConfirmingId(null);
        await refreshTypes();
      },
      onFailure: async (err, messages, backTo) => {
        // Failing before the staff member saw a list, or because our copy of the
        // row is stale, closes the confirmation, as it always did. A failure
        // while they are looking at the list stays in front of them.
        const stale = isStaleEquipmentError(err);
        if (backTo === "idle" || stale) {
          if (stale) retireFlow.cancel();
          setRowError({ id: type.id, messages });
          setConfirmingId(null);
        }
        if (stale) await refreshTypes();
      },
    });
  }

  function changeRetirement(type, action) {
    return action === "retire" ? retire(type) : reinstate(type);
  }

  function cancelRetire() {
    retireFlow.cancel();
    setRowError(null);
    setConfirmingId(null);
  }

  if (activePanel) {
    const { mode, type } = activePanel;
    return (
      <div className="dashboard dashboard--tech-support equipment-catalogue">
        <section>
          <button onClick={() => setActivePanel(null)}>&larr; Back to the equipment catalogue</button>
          {mode === "create" && <EquipmentForm onSaved={handleSaved} />}
          {mode === "edit" && <EquipmentForm type={type} onSaved={handleSaved} />}
          {mode === "condition" && <EquipmentConditionForm type={type} onSaved={handleSaved} />}
          {mode === "history" && <EquipmentHistory type={type} />}
        </section>
      </div>
    );
  }

  const active = types.filter((type) => !type.retiredAt);
  const retired = types.filter((type) => type.retiredAt);
  const tableProps = {
    confirmingId,
    busyId,
    rowError,
    flow: retireFlow,
    onPanel: setActivePanel,
    onConfirm: setConfirmingId,
    onCancelRetire: cancelRetire,
    onChangeRetirement: changeRetirement,
  };

  return (
    <div className="dashboard dashboard--tech-support equipment-catalogue">
      <h1>Equipment catalogue</h1>

      <section>
        <div className="equipment-catalogue__bar">
          <h2>Active equipment</h2>
          <button onClick={() => setActivePanel({ mode: "create" })}>Add equipment type</button>
        </div>
        {loading && <p>Loading equipment...</p>}
        {loadError && <p role="alert">{loadError}</p>}
        {!loading && !loadError && active.length === 0 && <p>No active equipment types yet.</p>}
        {active.length > 0 && <EquipmentTable types={active} retired={false} {...tableProps} />}
      </section>

      {retired.length > 0 && (
        <section>
          <h2>Retired equipment</h2>
          <EquipmentTable types={retired} retired {...tableProps} />
        </section>
      )}
    </div>
  );
}
