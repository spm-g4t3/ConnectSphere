import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  getRegistrationSettings,
  saveRegistrationSettings,
} from "../services/eventRegistrationService";
import { isRegistrationConfigurable } from "../services/registrationStatuses";

function loadErrorMessage(error) {
  const message = apiError(error);
  return message === "Unexpected server error"
    ? `${message} Check that the registration migrations are applied to the API database, then retry.`
    : message;
}

function toLocalInput(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function displayDate(value) {
  if (!value) return "Not set";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function displayStatus(value) {
  return value
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function apiError(error) {
  const body = error?.response?.data;
  if (body?.details?.length) {
    return body.details.map(({ field, message }) => `${field}: ${message}`).join(" ");
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
      opensAt: toLocalInput(data.settings.opensAt),
      closesAt: toLocalInput(data.settings.closesAt),
      capacity: data.settings.capacity ?? "",
      withdrawalDeadline: toLocalInput(data.settings.withdrawalDeadline),
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        withdrawalDeadline: toIso(form.withdrawalDeadline) || null,
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
            <p>Event status: <strong>{displayStatus(event.status)}</strong></p>
            <p>Event starts: {displayDate(event.proposedStart)}</p>
          </header>
          {settings && !editing && (
            <section className="event-registration-page__summary" aria-labelledby="registration-summary-heading">
              <h2 id="registration-summary-heading">Current registration</h2>
              <dl>
                <div><dt>Status</dt><dd>{settings.enabled ? "On" : "Off"}</dd></div>
                <div><dt>Opens</dt><dd>{displayDate(settings.opensAt)}</dd></div>
                <div><dt>Closes</dt><dd>{displayDate(settings.closesAt)}</dd></div>
                <div><dt>Capacity</dt><dd>{settings.capacity ?? "Unlimited"}</dd></div>
                <div>
                  <dt>Registered</dt>
                  <dd>{settings.registeredCount}{settings.capacity ? ` / ${settings.capacity}` : ""}</dd>
                </div>
                <div><dt>Withdrawal deadline</dt><dd>{displayDate(settings.withdrawalDeadline)}</dd></div>
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
              Current status: {displayStatus(event.status)}.
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
                  Closes at
                  <input
                    type="datetime-local"
                    required={form.enabled}
                    value={form.closesAt}
                    onChange={(inputEvent) => setForm({ ...form, closesAt: inputEvent.target.value })}
                  />
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
