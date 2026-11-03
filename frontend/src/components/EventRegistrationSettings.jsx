import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Button from "./ui/Button";
import LoadingText from "./ui/LoadingText";
import ErrorNotice from "./ui/ErrorNotice";
import useFocusAfterRetry from "./useFocusAfterRetry";
import {
  getRegistrationSettings,
  saveRegistrationSettings,
} from "../services/eventRegistrationService";
import { isRegistrationConfigurable } from "../services/registrationStatuses";
import { readStatusDisplay } from "../services/eventRequestStatusDisplay";
import {
  deviceTimeZoneLabel,
  toDatetimeLocalValue,
  toOffsetIsoString,
  VENUE_TIME_NOTE,
} from "../services/datetimeFormat";
import { formatDateTime } from "../services/displayFormat";
import { canRetryRead } from "../services/apiErrors";

const FIELD_LABELS = {
  registrationEnabled: "Registration",
  registrationOpensAt: "Opening time",
  registrationClosesAt: "Closing time",
  registrationWithdrawalDeadline: "Withdrawal deadline",
  registrationCapacity: "Capacity",
  registrationWaitlistEnabled: "Waiting list",
  proposedStart: "Event start",
};

function loadErrorMessage(error) {
  const message = apiError(error, "Could not load registration settings.");
  return message === "Unexpected server error"
    ? `${message} Check that the registration migrations are applied to the API database, then try again.`
    : message;
}

function toIso(value) {
  // The API reads null as "cleared"; toOffsetIsoString gives undefined for an empty input.
  return toOffsetIsoString(value) ?? null;
}

function displayStatus(event) {
  return readStatusDisplay(event).label;
}

function apiError(error, fallback = "Could not save registration settings.") {
  const body = error?.response?.data;
  if (body?.details?.length) {
    return body.details
      .map(({ field, message }) => (FIELD_LABELS[field] ? `${FIELD_LABELS[field]}: ${message}` : message))
      .join(" ");
  }
  return body?.error || fallback;
}

export default function EventRegistrationSettings({ eventId }) {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Kept apart: a failed read can be tried again, a failed save is saved again.
  const [loadError, setLoadError] = useState(null); // { message, retryable }
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
      waitlistEnabled: data.settings.waitlistEnabled === true,
    });
    setLoaded(true);
  }

  function failedLoad(err) {
    return { message: loadErrorMessage(err), retryable: canRetryRead(err) };
  }

  async function loadSettings() {
    setLoading(true);
    setLoadError(null);
    try {
      applyLoaded(await getRegistrationSettings(eventId));
    } catch (err) {
      setLoadError(failedLoad(err));
    } finally {
      setLoading(false);
    }
  }
  const { headingRef, retry } = useFocusAfterRetry(loadSettings);

  useEffect(() => {
    let active = true;
    getRegistrationSettings(eventId)
      .then((data) => {
        if (active) applyLoaded(data);
      })
      .catch((err) => {
        if (active) setLoadError(failedLoad(err));
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
        waitlistEnabled: form.waitlistEnabled,
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
        <Button
          variant="link"
          onClick={() => {
            setEditing(false);
            setError(null);
          }}
        >
          ← Back to registration settings
        </Button>
      ) : (
        <Link className="ui-button ui-button--link" to="/registration">← Back to Registration</Link>
      )}
      {/* Titled before the event loads, so loading and error states still have their h1. */}
      <header className="event-registration-page__header">
        {event && <p className="eyebrow">Event registration</p>}
        <h1 ref={headingRef} tabIndex={-1}>{event?.eventName || "Registration settings"}</h1>
        {event && (
          <>
            <p>Event status: <strong>{displayStatus(event)}</strong></p>
            {/* The first time on the page, so the one place the zone is said. */}
            <p>Event starts: {formatDateTime(event.proposedStart, "Not set")} {VENUE_TIME_NOTE}</p>
          </>
        )}
      </header>
      {loading && <LoadingText />}
      {loadError && <ErrorNotice message={loadError.message} onRetry={loadError.retryable ? retry : undefined} />}
      {/* No Try again: saving again is the retry. */}
      {error && <ErrorNotice message={error} />}
      {event && (
        <>
          {settings && !editing && (
            <section className="event-registration-page__summary" aria-labelledby="registration-summary-heading">
              <h2 id="registration-summary-heading">Current registration</h2>
              <dl>
                <div><dt>Status</dt><dd>{settings.enabled ? "On" : "Off"}</dd></div>
                <div><dt>Opens</dt><dd>{formatDateTime(settings.opensAt, "Not set")}</dd></div>
                <div><dt>Closes</dt><dd>{formatDateTime(settings.closesAt, "Not set")}</dd></div>
                <div><dt>Capacity</dt><dd>{settings.capacity ?? "Unlimited"}</dd></div>
                <div>
                  <dt>Registered</dt>
                  <dd>{settings.registeredCount}{settings.capacity ? ` / ${settings.capacity}` : ""}</dd>
                </div>
                <div><dt>Withdrawal deadline</dt><dd>{formatDateTime(settings.withdrawalDeadline, "Not set")}</dd></div>
                <div><dt>Waiting list</dt><dd>{settings.waitlistEnabled ? "On" : "Off"}</dd></div>
                <div><dt>Waitlisted</dt><dd>{settings.waitlistCount ?? 0}</dd></div>
              </dl>
              {saved && <p role="status">Registration settings saved.</p>}
              {canEdit && loaded && form && (
                <Button
                  onClick={() => {
                    setSaved(false);
                    setEditing(true);
                  }}
                >
                  Configure registration
                </Button>
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
              <label className="event-registration-page__toggle">
                <input
                  type="checkbox"
                  checked={form.waitlistEnabled}
                  onChange={(inputEvent) => setForm({ ...form, waitlistEnabled: inputEvent.target.checked })}
                />
                <span>Waiting list is on</span>
              </label>
              <p className="event-registration-page__hint">
                When the event is full, attendees can join a waiting list. A released place goes to the
                first person waiting while registration is open. Switching it off stops new joins; people
                already waiting keep their place.
              </p>
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
                <Button type="submit" disabled={saving}>
                  {saving ? "Saving..." : "Save registration settings"}
                </Button>
              </div>
            </form>
          )}
        </>
      )}
    </main>
  );
}
