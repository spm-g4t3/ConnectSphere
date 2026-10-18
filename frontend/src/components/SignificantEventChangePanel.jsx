import { useState } from "react";
import {
  applySignificantEventChange,
  previewSignificantEventChange,
} from "../services/eventRequestService";
import {
  toDatetimeLocalValue,
  toOffsetIsoString,
} from "../services/datetimeFormat";

function changedFields(eventRequest, fields, equipmentChange) {
  const changes = {};
  const proposedStart = toOffsetIsoString(fields.proposedStart);
  const proposedEnd = toOffsetIsoString(fields.proposedEnd);

  if (
    proposedStart &&
    new Date(proposedStart).getTime() !== new Date(eventRequest.proposedStart).getTime()
  ) changes.proposedStart = proposedStart;
  if (
    proposedEnd &&
    new Date(proposedEnd).getTime() !== new Date(eventRequest.proposedEnd).getTime()
  ) changes.proposedEnd = proposedEnd;

  const attendance = Number(fields.expectedAttendance);
  if (attendance !== eventRequest.expectedAttendance) {
    changes.expectedAttendance = attendance;
  }
  const venueRequirements = fields.venueRequirements.trim() || null;
  if (venueRequirements !== (eventRequest.venueRequirements?.trim() || null)) {
    changes.venueRequirements = venueRequirements;
  }
  const accessibilityRequirements = fields.accessibilityRequirements.trim() || null;
  if (accessibilityRequirements !== (eventRequest.accessibilityRequirements?.trim() || null)) {
    changes.accessibilityRequirements = accessibilityRequirements;
  }
  if (equipmentChange) changes.equipmentChange = true;
  return changes;
}

function formatTimestamp(value) {
  if (!value) return "Not recorded";
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? String(value) : instant.toLocaleString();
}

function ImpactStat({ label, value }) {
  return (
    <div className="event-significant-change__stat" role="group" aria-label={`${label}: ${value}`}>
      <strong aria-hidden="true">{value}</strong>
      <span aria-hidden="true">{label}</span>
    </div>
  );
}

function ImpactList({ title, items, name }) {
  if (items.length === 0) return null;
  return (
    <section className="event-significant-change__group">
      <h3>{title}</h3>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <span className="event-significant-change__item-name">
              {name(item)}
              {item.alreadyFlagged && (
                <em className="event-significant-change__tag">Already flagged</em>
              )}
            </span>
            {item.startsAt && item.endsAt && (
              <span className="event-significant-change__item-detail">
                {formatTimestamp(item.startsAt)} – {formatTimestamp(item.endsAt)}
              </span>
            )}
            {item.occupiedStartsAt && item.occupiedEndsAt && (
              <span className="event-significant-change__item-detail">
                Occupied {formatTimestamp(item.occupiedStartsAt)} – {formatTimestamp(item.occupiedEndsAt)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function SignificantEventChangePanel({
  eventRequest,
  onBack,
  onApplied,
}) {
  const [fields, setFields] = useState(() => ({
    proposedStart: toDatetimeLocalValue(eventRequest.proposedStart),
    proposedEnd: toDatetimeLocalValue(eventRequest.proposedEnd),
    expectedAttendance: String(eventRequest.expectedAttendance ?? ""),
    venueRequirements: eventRequest.venueRequirements ?? "",
    accessibilityRequirements: eventRequest.accessibilityRequirements ?? "",
  }));
  const [equipmentChange, setEquipmentChange] = useState(false);
  const [reason, setReason] = useState("");
  const [impact, setImpact] = useState(null);
  const [previewedChanges, setPreviewedChanges] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  function invalidatePreview(update) {
    update();
    setImpact(null);
    setPreviewedChanges(null);
    setConfirmed(false);
    setError(null);
  }

  async function handlePreview(event) {
    event.preventDefault();
    const changes = changedFields(eventRequest, fields, equipmentChange);
    if (!reason.trim()) {
      setError("A reason is required.");
      return;
    }
    if (Object.keys(changes).length === 0) {
      setError("Make at least one significant change before previewing.");
      return;
    }

    setLoading(true);
    setError(null);
    setConfirmed(false);
    try {
      const preview = await previewSignificantEventChange(eventRequest.id, changes);
      setImpact(preview);
      setPreviewedChanges(changes);
    } catch (requestError) {
      setError(
        `${requestError.response?.data?.error || "The impact preview could not be loaded."} No changes have been made.`,
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleApply() {
    if (!impact || !previewedChanges || !confirmed) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await applySignificantEventChange(eventRequest.id, {
        changes: previewedChanges,
        reason: reason.trim(),
        expectedImpact: impact,
      });
      onApplied?.(updated);
    } catch (requestError) {
      if (requestError.response?.data?.code === "SIGNIFICANT_CHANGE_IMPACT_CHANGED") {
        setImpact(null);
        setPreviewedChanges(null);
        setConfirmed(false);
      }
      setError(
        `${requestError.response?.data?.error || "The significant change could not be applied."} No changes have been made.`,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="event-significant-change-page">
      {onBack && (
        <button
          className="event-cancellation-page__back"
          type="button"
          onClick={onBack}
        >
          Back to event
        </button>
      )}
      <p className="eyebrow">Coordinator action</p>
      <h1>Significant change: {eventRequest.eventName}</h1>
      <p>Preview every affected arrangement before confirming. Nothing is automatically cancelled or un-booked.</p>
      <section className="event-significant-change">
        <form onSubmit={handlePreview}>
          <label>
            Event start
            <input
              type="datetime-local"
              required
              value={fields.proposedStart}
              onChange={(event) => invalidatePreview(() => setFields({
                ...fields, proposedStart: event.target.value,
              }))}
            />
          </label>
          <label>
            Event end
            <input
              type="datetime-local"
              required
              value={fields.proposedEnd}
              onChange={(event) => invalidatePreview(() => setFields({
                ...fields, proposedEnd: event.target.value,
              }))}
            />
          </label>
          <label>
            Expected attendance
            <input
              type="number"
              min="1"
              step="1"
              required
              value={fields.expectedAttendance}
              onChange={(event) => invalidatePreview(() => setFields({
                ...fields, expectedAttendance: event.target.value,
              }))}
            />
          </label>
          <label>
            Venue requirements
            <textarea
              rows={3}
              value={fields.venueRequirements}
              onChange={(event) => invalidatePreview(() => setFields({
                ...fields, venueRequirements: event.target.value,
              }))}
            />
          </label>
          <label>
            Accessibility requirements
            <textarea
              rows={3}
              value={fields.accessibilityRequirements}
              onChange={(event) => invalidatePreview(() => setFields({
                ...fields, accessibilityRequirements: event.target.value,
              }))}
            />
          </label>
          <label className="event-significant-change__equipment">
            <input
              type="checkbox"
              checked={equipmentChange}
              onChange={(event) => invalidatePreview(() => setEquipmentChange(event.target.checked))}
            />
            Record an equipment change. Equipment lines can be edited after the event returns to Approved through SCRUM-21.
          </label>
          <label>
            Reason for this change
            <textarea
              rows={3}
              maxLength={4000}
              required
              value={reason}
              onChange={(event) => invalidatePreview(() => setReason(event.target.value))}
            />
          </label>
          <button type="submit" disabled={loading || saving}>
            {loading ? "Loading impact..." : impact ? "Refresh impact preview" : "Preview significant change"}
          </button>
        </form>

        {impact && (
          <>
            <div className="event-significant-change__impact" aria-label="Significant change impact preview">
              <h2>What this change will affect</h2>
              <div className="event-significant-change__stats">
                <ImpactStat label="Venue bookings to flag" value={(impact.venueBookings ?? []).length} />
                <ImpactStat label="Equipment reservations to flag" value={(impact.equipmentReservations ?? []).length} />
                <ImpactStat label="Registered attendees to notify" value={impact.registeredAttendeesToNotify ?? 0} />
              </div>
              {impact.statusBefore !== impact.statusAfter && (
                <p className="event-significant-change__notice">
                  This {impact.statusBefore === "confirmed" ? "Confirmed event" : "event"} will return to Approved.
                </p>
              )}
              <ImpactList
                title="Venue bookings"
                items={impact.venueBookings ?? []}
                name={(item) => `${item.venueName || "Venue"}${item.venueLocation ? ` — ${item.venueLocation}` : ""}`}
              />
              <ImpactList
                title="Equipment reservations"
                items={impact.equipmentReservations ?? []}
                name={(item) => `${item.equipmentName || "Equipment"} (quantity ${item.quantity})`}
              />
              {impact.equipmentChangeRecorded && (
                <p className="event-significant-change__footnote">
                  Equipment lines will not be edited here; make those changes through SCRUM-21 after the revert.
                </p>
              )}
              <p className="event-significant-change__footnote">
                Flagged bookings and reservations remain in place for manual resolution.
              </p>
            </div>
            <div className="event-significant-change__confirmation">
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                I have reviewed this impact and confirm applying the significant change.
              </label>
              <button
                type="button"
                onClick={handleApply}
                disabled={!confirmed || saving || loading}
              >
                {saving ? "Applying change..." : "Confirm significant change"}
              </button>
            </div>
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </section>
    </main>
  );
}
