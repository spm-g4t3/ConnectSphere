import { useEffect, useRef, useState } from "react";
import { confirmEventRequest, getEventReadiness } from "../services/eventRequestService";
import ReadinessChecklist from "./ReadinessChecklist";

const ACCESS_ERRORS = {
  401: "Your session has expired. Please sign in again.",
  403: "Only the assigned Event Coordinator can confirm this event. Refresh the event to check its assignment.",
  404: "This event is no longer available.",
};

export default function EventConfirmationPanel({ eventRequest, onConfirmed, onStale }) {
  const revision = `${eventRequest.id}:${eventRequest.updatedAt ?? ""}`;
  const [readiness, setReadiness] = useState(null);
  const [acknowledgedRevision, setAcknowledgedRevision] = useState(null);
  const acknowledged = acknowledgedRevision === revision;
  const [readVersion, setReadVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [blockedRevision, setBlockedRevision] = useState(null);
  const blocked = blockedRevision === revision;
  const [refusal, setRefusal] = useState(null);
  const submitError = refusal?.revision === revision ? refusal.message : null;
  const outstanding = refusal?.revision === revision ? refusal.conflicts : null;
  const sending = useRef(false);
  const mounted = useRef(false);
  const currentRevision = useRef(revision);

  useEffect(() => { currentRevision.current = revision; }, [revision]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function read() {
      setLoading(true);
      setReadError(null);
      try {
        const result = await getEventReadiness(eventRequest.id, { noEquipmentConfirmed: acknowledged });
        if (result?.eventRequestId !== eventRequest.id || typeof result.ready !== "boolean" || !Array.isArray(result.items)) {
          throw new Error("Unexpected readiness response");
        }
        if (!cancelled) setReadiness({ data: result, revision, acknowledged });
      } catch (error) {
        if (!cancelled) {
          setReadiness(null);
          setReadError(ACCESS_ERRORS[error?.response?.status] ?? "The readiness checklist could not be loaded. Please try again.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    read();
    return () => { cancelled = true; };
  }, [eventRequest.id, revision, acknowledged, readVersion]);

  function refreshChecklist() {
    setLoading(true);
    setReadVersion((version) => version + 1);
  }

  const items = readiness?.data.items ?? [];
  const currentReadiness = readiness?.revision === revision && readiness?.acknowledged === acknowledged
    ? readiness.data : null;
  const acknowledgement = items.find((item) => item.key === "no_equipment_confirmation");
  const canSubmit = !loading && !submitting && !blocked && currentReadiness?.ready === true
    && (!acknowledgement || acknowledged);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!canSubmit || sending.current) return;
    sending.current = true;
    setSubmitting(true);
    setRefusal(null);
    let updated;
    try {
      updated = await confirmEventRequest(eventRequest.id, {
        noEquipmentConfirmed: acknowledged,
        ...(eventRequest.updatedAt != null ? { expectedUpdatedAt: eventRequest.updatedAt } : {}),
      });
      if (updated?.id !== eventRequest.id || updated.status !== "confirmed") {
        throw new Error("Unexpected confirmation response");
      }
    } catch (error) {
      if (!mounted.current || currentRevision.current !== revision) return;
      const status = error?.response?.status;
      const data = error?.response?.data;
      const message = ACCESS_ERRORS[status]
        ?? ((status === 409 || status === 400) && typeof data?.error === "string" ? data.error : null)
        ?? "Confirmation could not be verified. Check the event status before trying again.";
      setRefusal({ revision, message, conflicts: status === 409 && data?.code === "EVENT_NOT_READY"
        ? (Array.isArray(data.conflicts) ? data.conflicts : []) : null });
      if (status === 409 && data?.code === "EVENT_NOT_READY") {
        setAcknowledgedRevision(null);
      } else if (status === 401 || status === 403 || status === 404 || status === 409) {
        setBlockedRevision(revision);
      }
      refreshChecklist();
      // A failed refresh must not replace the original confirmation refusal.
      Promise.resolve().then(() => onStale?.(message)).catch(() => {});
      return;
    } finally {
      sending.current = false;
      if (mounted.current) setSubmitting(false);
    }
    if (mounted.current && currentRevision.current === revision) {
      setBlockedRevision(revision);
      onConfirmed(updated);
    }
  }

  return (
    <section className="safety-check-submission" aria-label="Confirm event">
      <h3>Confirm Event</h3>
      <p>Every arrangement below must be ready. Confirmation checks the current arrangements again.</p>
      {loading && <p role="status">Loading the readiness checklist...</p>}
      {!loading && readError && (
        <div role="alert">
          <p>{readError}</p>
          <button type="button" onClick={refreshChecklist}>Retry checklist</button>
        </div>
      )}
      {!loading && readiness && <ReadinessChecklist caption="Readiness checklist" items={items} />}
      <form onSubmit={handleSubmit} aria-busy={submitting}>
        {acknowledgement && (
          <div className="safety-check-submission__confirmation">
            <label>
              <input
                type="checkbox"
                checked={acknowledged}
                disabled={loading || submitting || blocked}
                onChange={(event) => {
                  setAcknowledgedRevision(event.target.checked ? revision : null);
                  refreshChecklist();
                }}
              />
              The organiser mentioned equipment, but none is needed for this event
            </label>
            <p>The organiser asked for:</p>
            <blockquote>{acknowledgement.organiserRequirements}</blockquote>
          </div>
        )}
        <button type="submit" disabled={!canSubmit}>{submitting ? "Confirming..." : "Confirm Event"}</button>
      </form>
      {submitError && <p role="alert">{submitError}</p>}
      {outstanding && <ReadinessChecklist caption="Still outstanding" items={outstanding} />}
    </section>
  );
}
