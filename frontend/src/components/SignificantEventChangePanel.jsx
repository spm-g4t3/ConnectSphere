import { useEffect, useRef, useState } from "react";
import {
  applySignificantEventChange,
  previewSignificantEventChange,
} from "../services/eventRequestService";
import {
  toDatetimeLocalValue,
  toOffsetIsoString,
} from "../services/datetimeFormat";
import { formatDateTimeRange } from "../services/displayFormat";
import Button from "./ui/Button";
import ErrorNotice from "./ui/ErrorNotice";

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

function ImpactStat({ label, value }) {
  return (
    <div className="event-significant-change__stat" role="group" aria-label={`${label}: ${value}`}>
      <strong aria-hidden="true">{value}</strong>
      <span aria-hidden="true">{label}</span>
    </div>
  );
}

function ImpactList({ title, items, name, headingLevel }) {
  if (items.length === 0) return null;
  const Heading = `h${headingLevel}`;
  return (
    <section className="event-significant-change__group">
      <Heading>{title}</Heading>
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
                {formatDateTimeRange(item.startsAt, item.endsAt, "Not recorded")}
              </span>
            )}
            {item.occupiedStartsAt && item.occupiedEndsAt && (
              <span className="event-significant-change__item-detail">
                Occupied {formatDateTimeRange(item.occupiedStartsAt, item.occupiedEndsAt, "Not recorded")}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * @param {object} props
 * @param {number} [props.headingLevel]  the page title's level: 1 on the event's
 *   own page, 2 inside a list whose title is the h1
 */
export default function SignificantEventChangePanel({
  eventRequest,
  onBack,
  onApplied,
  headingLevel = 1,
}) {
  const Title = `h${headingLevel}`;
  const ImpactHeading = `h${headingLevel + 1}`;
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
  const headingRef = useRef(null);

  // The button that opened this page has gone, so focus starts on its title.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

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
        <Button variant="link" onClick={onBack}>
          Back to event
        </Button>
      )}
      <p className="eyebrow">Coordinator action</p>
      <Title ref={headingRef} tabIndex={-1}>Significant change: {eventRequest.eventName}</Title>
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
            Record an equipment change. Equipment lines can be edited on the event's Equipment section once it is back in Approved.
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
          <Button type="submit" disabled={loading || saving}>
            {loading ? "Loading impact..." : impact ? "Refresh impact preview" : "Preview significant change"}
          </Button>
        </form>

        {impact && (
          <>
            <div className="event-significant-change__impact" aria-label="Significant change impact preview">
              <ImpactHeading>What this change will affect</ImpactHeading>
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
                headingLevel={headingLevel + 2}
                title="Venue bookings"
                items={impact.venueBookings ?? []}
                name={(item) => `${item.venueName || "Venue"}${item.venueLocation ? ` — ${item.venueLocation}` : ""}`}
              />
              <ImpactList
                headingLevel={headingLevel + 2}
                title="Equipment reservations"
                items={impact.equipmentReservations ?? []}
                name={(item) => `${item.equipmentName || "Equipment"} (quantity ${item.quantity})`}
              />
              {(impact.pendingBookingRequests ?? []).length > 0 && (
                <>
                  <ImpactList
                    headingLevel={headingLevel + 2}
                    title="Pending venue requests still for the old time"
                    items={impact.pendingBookingRequests}
                    name={(item) => item.venueName || "Venue"}
                  />
                  <p className="event-significant-change__footnote">
                    Venue Staff will be told. Withdraw or re-request them if needed.
                  </p>
                </>
              )}
              {impact.equipmentChangeRecorded && (
                <p className="event-significant-change__footnote">
                  Equipment lines will not be edited here; edit them on the event's Equipment section once it is back in Approved.
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
              <Button
                onClick={handleApply}
                disabled={!confirmed || saving || loading}
              >
                {saving ? "Applying change..." : "Confirm significant change"}
              </Button>
            </div>
          </>
        )}
        {/* No Try again: the preview and the change are both resent from this form. */}
        {error && <ErrorNotice message={error} />}
      </section>
    </main>
  );
}
