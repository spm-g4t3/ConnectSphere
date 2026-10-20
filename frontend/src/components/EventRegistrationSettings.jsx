import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  getRegistrationSettings,
  saveRegistrationSettings,
} from "../services/eventRegistrationService";
import { isRegistrationConfigurable } from "../services/registrationStatuses";
import { readStatusDisplay } from "../services/eventRequestStatusDisplay";
import {
  deviceTimeZoneLabel,
  formatVenueTimestamp,
  toDatetimeLocalValue,
  toOffsetIsoString,
} from "../services/datetimeFormat";

const FIELD_LABELS = {
  registrationEnabled: "Registration",
  registrationOpensAt: "Opening time",
  registrationClosesAt: "Closing time",
  registrationWithdrawalDeadline: "Withdrawal deadline",
  registrationCapacity: "Capacity",
  proposedStart: "Event start",
};

function loadErrorMessage(error) {
  const message = apiError(error);
  return message === "Unexpected server error"
    ? `${message} Check that the registration migrations are applied to the API database, then retry.`
    : message;
}

function toIso(value) {
  // The API reads null as "cleared"; toOffsetIsoString gives undefined for an empty input.
  return toOffsetIsoString(value) ?? null;
}

function displayStatus(event) {
  return readStatusDisplay(event).label;
}

function apiError(error) {
  const body = error?.response?.data;
  if (body?.details?.length) {
    return body.details
      .map(({ field, message }) => (FIELD_LABELS[field] ? `${FIELD_LABELS[field]}: ${message}` : message))
      .join(" ");
  }
  return body?.error || "Could not save registration settings.";
}

export default function EventRegistrationSettings({ eventId }) {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [editing, setEditing] = useState(false);
  const [event, setEvent] = useState(null);
  const canEdit = isRegistrationConfigurable(event?.status);

  function applyLoaded(data) {
    setEvent(data);
    setSettings(data.settings);
    setForm({
      enabled: data.settings.enabled,
      opensAt: toDatetimeLocalValue(data.settings.opensAt),
      closesAt: toDatetimeLocalValue(data.settings.closesAt),
      capacity: data.settings.capacity ?? "",
      withdrawalDeadline: toDatetimeLocalValue(data.settings.withdrawalDeadline),
    });
    setLoaded(true);
  }

  async function loadSettings() {
    setLoading(true);
    setError(null);
    try {
      applyLoaded(await getRegistrationSettings(eventId));
    } catch (loadError) {
      setError(loadErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    getRegistrationSettings(eventId)
      .then((data) => {
        if (active) applyLoaded(data);
      })
      .catch((loadError) => {
        if (active) setError(loadErrorMessage(loadError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // applyLoaded only calls state setters, so it is safe to leave out.
  }, [eventId]);

  async function save(eventObject) {
    eventObject.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await saveRegistrationSettings(eventId, {
        enabled: form.enabled,
        opensAt: toIso(form.opensAt),
        closesAt: toIso(form.closesAt),
        capacity: form.capacity === "" ? null : Number(form.capacity),
        withdrawalDeadline: toIso(form.withdrawalDeadline),
      });
      setSettings(updated);
      setEvent((current) => ({ ...current, settings: updated }));
      setSaved(true);
      setEditing(false);
    } catch (saveError) {
      setError(apiError(saveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="event-registration-page">
      {editing ? (
        <button
          type="button"
          className="event-registration-page__back"
          onClick={() => {
            setEditing(false);
            setError(null);
          }}
        >
          ← Back to registration settings
        </button>
      ) : (
        <Link className="event-registration-page__back" to="/registration">← Back to Registration</Link>
      )}
      {loading && <p role="status">Loading registration settings...</p>}
      {error && (
        <div className="event-registration-page__error" role="alert">
          <p>{error}</p>
          <button type="button" disabled={loading} onClick={loadSettings}>
            Retry loading settings
          </button>
        </div>
      )}
      {event && (
        <>
          <header className="event-registration-page__header">
            <p className="eyebrow">Event registration</p>
            <h1>{event.eventName}</h1>
            <p>Event status: <strong>{displayStatus(event)}</strong></p>
            <p>Event starts: {formatVenueTimestamp(event.proposedStart)}</p>
          </header>
          {settings && !editing && (
            <section className="event-registration-page__summary" aria-labelledby="registration-summary-heading">
              <h2 id="registration-summary-heading">Current registration</h2>
              <dl>
                <div><dt>Status</dt><dd>{settings.enabled ? "On" : "Off"}</dd></div>
                <div><dt>Opens</dt><dd>{formatVenueTimestamp(settings.opensAt)}</dd></div>
                <div><dt>Closes</dt><dd>{formatVenueTimestamp(settings.closesAt)}</dd></div>
                <div><dt>Capacity</dt><dd>{settings.capacity ?? "Unlimited"}</dd></div>
                <div>
                  <dt>Registered</dt>
                  <dd>{settings.registeredCount}{settings.capacity ? ` / ${settings.capacity}` : ""}</dd>
                </div>
                <div><dt>Withdrawal deadline</dt><dd>{formatVenueTimestamp(settings.withdrawalDeadline)}</dd></div>
              </dl>
              {saved && <p role="status">Registration settings saved.</p>}
              {canEdit && loaded && form && (
                <button
                  type="button"
                  className="event-registration-page__configure"
                  onClick={() => {
                    setSaved(false);
                    setEditing(true);
                  }}
                >
                  Configure registration
                </button>
              )}
            </section>
          )}
          {!canEdit && (
            <p className="event-registration-page__notice">
              Settings can only be changed while the event is Approved, Safety review, Safety approved or Confirmed.
              Current status: {displayStatus(event)}.
            </p>
          )}
          {canEdit && loaded && form && editing && (
            <form className="event-registration-page__form" aria-label="Registration settings" onSubmit={save}>
              <h2>Configure registration</h2>
              <p>Set when attendees can register and the maximum number of places available.</p>
              <label className="event-registration-page__toggle">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(inputEvent) => setForm({ ...form, enabled: inputEvent.target.checked })}
                />
                <span>Registration is on</span>
              </label>
              <div className="event-registration-page__fields">
                <label>
                  Opens at
                  <input
                    type="datetime-local"
                    required={form.enabled}
                    value={form.opensAt}
                    onChange={(inputEvent) => setForm({ ...form, opensAt: inputEvent.target.value })}
                  />
                </label>
                <label>
                  Closes at <span className="event-registration-page__optional">(optional)</span>
                  <input
                    type="datetime-local"
                    value={form.closesAt}
                    onChange={(inputEvent) => setForm({ ...form, closesAt: inputEvent.target.value })}
                  />
                  <span className="event-registration-page__hint">
                    Leave blank to keep registration open until you switch it off.
                  </span>
                </label>
                <label>
                  Maximum capacity <span className="event-registration-page__optional">(optional)</span>
                  <input
                    type="number"
                    min={settings.registeredCount || 1}
                    step="1"
                    value={form.capacity}
                    onChange={(inputEvent) => setForm({ ...form, capacity: inputEvent.target.value })}
                    placeholder="Unlimited"
                  />
                  <span className="event-registration-page__hint">
                    Cannot be lower than the {settings.registeredCount} attendees already registered.
                  </span>
                </label>
                <label>
                  Withdrawal deadline <span className="event-registration-page__optional">(optional)</span>
                  <input
                    type="datetime-local"
                    value={form.withdrawalDeadline}
                    onChange={(inputEvent) => setForm({ ...form, withdrawalDeadline: inputEvent.target.value })}
                  />
                </label>
              </div>
              {/* Typed in device time like the other forms; the summary reads Singapore time. */}
              <p className="event-registration-page__hint">
                Times are in your device's time zone ({deviceTimeZoneLabel()}).
              </p>
              <div className="event-registration-page__actions">
                <button type="submit" disabled={saving}>
                  {saving ? "Saving..." : "Save registration settings"}
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </main>
  );
}
