// EquipmentAvailabilityCheck.jsx
//
// SCRUM-70, the screen for SCRUM-23 "Check Equipment Availability for a
// Period". Technical Support Staff pick an equipment type, a quantity and a
// period, and see:
//   - the result, with its label (AC8): Fully available, Partially available
//     with the quantity, or Unavailable
//   - how the figure was reached (AC9): total, damaged or under maintenance,
//     reserved in the period, available
//   - the overlapping reservations, each with event, period and quantity (AC10)
//
// Nothing is validated here. The backend judges every input and lists every
// fault, and the screen shows all of them (hence noValidate and no `required`).
// The result is dropped as soon as an input changes, so what is on screen is
// always the answer to what is in the form. A check changes nothing (AC12).

import { useEffect, useState } from "react";
import { checkEquipmentAvailability, listActiveEquipmentTypes } from "../services/equipmentAvailabilityService";
import { availabilityErrorMessages } from "../services/availabilityErrors";
import { deviceTimeZoneLabel, toOffsetIsoString } from "../services/datetimeFormat";
import { formatRange } from "../services/displayFormat";
import "./EquipmentAvailabilityCheck.css";

const RESULT_CLASS = {
  "Fully available": "fully",
  "Partially available": "partially",
  Unavailable: "unavailable",
};

function summaryFor(result) {
  if (result.message) return result.message;
  if (result.result === "Fully available") {
    return `${result.quantityRequested} requested, ${result.quantityAvailable} available.`;
  }
  if (result.result === "Partially available") {
    return `Only ${result.quantityAvailable} of ${result.quantityRequested} requested are available.`;
  }
  return `None of the ${result.quantityRequested} requested are available.`;
}

function AvailabilityResult({ result }) {
  const { breakdown, reservations } = result;

  return (
    <section
      className={`availability-result availability-result--${RESULT_CLASS[result.result] ?? "unavailable"}`}
      aria-live="polite"
    >
      <h2>{result.result}</h2>
      <p>{summaryFor(result)}</p>

      {breakdown && (
        <>
          <h3>How this was worked out</h3>
          <table className="availability-breakdown">
            <tbody>
              <tr>
                <th scope="row">Total quantity</th>
                <td>{breakdown.total}</td>
              </tr>
              <tr>
                <th scope="row">
                  Damaged or under maintenance
                  <br />
                  <small>
                    {breakdown.damaged} damaged, {breakdown.underMaintenance} under maintenance
                  </small>
                </th>
                <td>{breakdown.damagedOrUnderMaintenance}</td>
              </tr>
              <tr>
                <th scope="row">Reserved in this period</th>
                <td>{breakdown.reserved}</td>
              </tr>
              <tr>
                <th scope="row">Available</th>
                <td>{breakdown.available}</td>
              </tr>
            </tbody>
          </table>

          <h3>Overlapping reservations ({reservations.length})</h3>
          {reservations.length === 0 ? (
            <p>No reservations overlap this period.</p>
          ) : (
            <table className="availability-reservations">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Period</th>
                  <th className="availability-reservations__number">Quantity</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {reservations.map((reservation) => (
                  <tr key={reservation.id}>
                    <td>{reservation.eventName}</td>
                    <td>{formatRange(reservation.startAt, reservation.endAt)}</td>
                    <td className="availability-reservations__number">{reservation.quantity}</td>
                    <td>
                      {reservation.flagged ? (
                        <span className="availability-reservations__flag">Flagged for review</span>
                      ) : (
                        "Reserved"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

const EMPTY_FORM = { equipmentTypeId: "", quantity: "", startAt: "", endAt: "" };

export default function EquipmentAvailabilityCheck() {
  const [types, setTypes] = useState(null);
  const [typesError, setTypesError] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState([]);
  const [result, setResult] = useState(null);
  const [checking, setChecking] = useState(false);

  // The picker's list, loaded once. Declared inside the effect, as React's docs
  // write a fetch, so a response arriving after unmounting is dropped.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await listActiveEquipmentTypes();
        if (!cancelled) setTypes(data);
      } catch (err) {
        if (!cancelled) setTypesError(availabilityErrorMessages(err, "load")[0]);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  function bind(field) {
    return {
      value: form[field],
      onChange: (event) => {
        setForm((current) => ({ ...current, [field]: event.target.value }));
        setResult(null);
      },
    };
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (checking) return;

    setChecking(true);
    setErrors([]);
    setResult(null);
    try {
      setResult(
        await checkEquipmentAvailability({
          equipmentTypeId: form.equipmentTypeId,
          quantity: form.quantity,
          startAt: toOffsetIsoString(form.startAt),
          endAt: toOffsetIsoString(form.endAt),
        }),
      );
    } catch (err) {
      setErrors(availabilityErrorMessages(err, "check"));
    } finally {
      setChecking(false);
    }
  }

  const noTypes = types !== null && types.length === 0;

  return (
    <div className="dashboard dashboard--tech-support availability-check">
      <h1>Check equipment availability</h1>

      {types === null && !typesError && <p>Loading equipment types...</p>}
      {typesError && <p role="alert">{typesError}</p>}
      {noTypes && <p>No active equipment types yet. Add one in the equipment catalogue first.</p>}

      <form onSubmit={handleSubmit} noValidate>
        <div className="availability-check__field">
          <label htmlFor="availability-type">Equipment type</label>
          <select id="availability-type" {...bind("equipmentTypeId")}>
            <option value="">Select an equipment type</option>
            {(types ?? []).map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
        </div>

        <div className="availability-check__field">
          <label htmlFor="availability-quantity">Quantity</label>
          <input id="availability-quantity" type="number" min="1" step="1" {...bind("quantity")} />
        </div>

        <div className="availability-check__field">
          <label htmlFor="availability-start">Start</label>
          <input id="availability-start" type="datetime-local" {...bind("startAt")} />
        </div>

        <div className="availability-check__field">
          <label htmlFor="availability-end">End</label>
          <input id="availability-end" type="datetime-local" {...bind("endAt")} />
        </div>

        <p className="availability-check__hint">
          Times are in your device&apos;s time zone ({deviceTimeZoneLabel()}).
        </p>

        {errors.length > 0 && (
          <ul className="availability-check__errors" role="alert">
            {errors.map((message, index) => (
              <li key={index}>{message}</li>
            ))}
          </ul>
        )}

        <button type="submit" disabled={checking || noTypes}>
          {checking ? "Checking..." : "Check availability"}
        </button>
      </form>

      {result && <AvailabilityResult result={result} />}
    </div>
  );
}
