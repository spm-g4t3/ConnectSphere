// VenueHoldsPanel.jsx
//
// SCRUM-491 "Place a Tentative Venue Hold with Expiry - Venue Staff". Where a
// Venue Staff member places a tentative hold on a venue for an Approved event
// (AC1, AC2), sees why one is refused -- the bookings, blocks or other
// events' holds in the way, each with its occupied period (AC4) -- and sees
// the venue's active holds and when each expires. Opened from VenueCatalogue's
// "Place hold" button as a full-page panel, beside "Manage blocks", the way
// VenueBlocksPanel is.
//
// The parent VenueHoldForm was written for: the form is presentational, so
// every request, and everything the API says back, lives here.
//
// There is no release or edit: an early release is out of scope, and a hold
// ends on its own when its expiry passes (AC7). A hold whose expiry passes
// while the panel is open drops off the list at the next render rather than
// waiting for a refetch, because from that moment it holds nothing.
//
// After a hold is placed the list is refetched rather than spliced, for the
// reason VenueBlocksPanel gives: the server orders the rows and joins the
// names, and the error paths need a refetch anyway.
//
// currentUserId is a prop, not useAuth(), for the reason VenueBlocksPanel
// gives: this panel's tests render without an AuthProvider.

import { useCallback, useEffect, useState } from "react";
import { getHoldCandidates, listVenueHolds, placeVenueHold } from "../services/venueService";
import { holdConflicts, holdErrorMessage } from "../services/venueHoldErrors";
import { formatRange, formatTimestamp } from "../services/displayFormat";
import { formatOccupiedPeriod } from "../services/occupiedPeriodDisplay";
import { reasonLabel } from "../services/venueBlockReasons";
import VenueHoldForm from "./VenueHoldForm";
import { BlockActor } from "./BlockHistory";
import Button from "./ui/Button";
import StatusBadge from "./ui/StatusBadge";
import { HOLD_TONE } from "../services/venueStatusTones";

/** "1 thing is" / "3 things are", for the conflict heading. */
function thingsAre(count) {
  return count === 1 ? "1 thing is" : `${count} things are`;
}

/** One conflict row's label and detail, by kind (AC4). */
function conflictText(conflict) {
  if (conflict.kind === "block") {
    return {
      label: "Blocked",
      detail: conflict.reason ? reasonLabel(conflict.reason) : null,
      period: formatRange(conflict.startsAt, conflict.endsAt),
    };
  }
  return {
    label: conflict.kind === "hold" ? "Tentatively held" : "Booked",
    detail: conflict.eventName || "Unnamed event",
    // Setup · Event · Turnaround: the whole time that event keeps the venue.
    period: formatOccupiedPeriod(conflict),
  };
}

export default function VenueHoldsPanel({ venue, currentUserId }) {
  const [holds, setHolds] = useState([]);
  const [loadingHolds, setLoadingHolds] = useState(true);
  const [listError, setListError] = useState(null);

  // The event picker, loaded each time the form opens so it is never staler
  // than the moment Venue Staff start choosing.
  const [candidates, setCandidates] = useState([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [candidatesError, setCandidatesError] = useState(null);

  const [formOpen, setFormOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverErrors, setServerErrors] = useState([]); // a 400's details[]
  const [formError, setFormError] = useState(null);
  const [conflicts, setConflicts] = useState([]); // HOLD_PERIOD_CONFLICT

  // null | { eventName, expiresAt }
  const [notice, setNotice] = useState(null);
  const [panelError, setPanelError] = useState(null);
  // Seeded from the prop, then set by a VENUE_RETIRED answer: the venue can
  // be retired by someone else while this panel is open.
  const [venueRetired, setVenueRetired] = useState(Boolean(venue.retiredAt));

  const fetchHolds = useCallback(async () => {
    setLoadingHolds(true);
    try {
      const data = await listVenueHolds(venue.id);
      setHolds(data);
      setListError(null);
    } catch (err) {
      setListError(holdErrorMessage(err, "list"));
    } finally {
      setLoadingHolds(false);
    }
  }, [venue.id]);

  const fetchCandidates = useCallback(async () => {
    setLoadingCandidates(true);
    try {
      const data = await getHoldCandidates();
      setCandidates(data);
      setCandidatesError(null);
    } catch (err) {
      setCandidatesError(holdErrorMessage(err, "candidates"));
    } finally {
      setLoadingCandidates(false);
    }
  }, []);

  useEffect(() => {
    fetchHolds();
  }, [fetchHolds]);

  function clearFormFeedback() {
    setServerErrors([]);
    setFormError(null);
    setConflicts([]);
  }

  function openForm() {
    clearFormFeedback();
    setNotice(null);
    setPanelError(null);
    setFormOpen(true);
    fetchCandidates();
  }

  function closeForm() {
    clearFormFeedback();
    setFormOpen(false);
  }

  // No `if (submitting) return` here: VenueHoldForm's submit handler already
  // refuses while a request is in flight, and its button is disabled.
  async function send(payload) {
    setSubmitting(true);
    clearFormFeedback();
    setNotice(null);
    setPanelError(null);

    try {
      const data = await placeVenueHold(venue.id, payload);
      const event = candidates.find((candidate) => candidate.id === payload.eventRequestId);

      closeForm();
      setNotice({
        eventName: event?.eventName || "the event",
        expiresAt: data.hold.expiresAt,
      });
      await fetchHolds();
    } catch (err) {
      const status = err.response?.status;
      const body = err.response?.data;
      const code = body?.code;

      if (status === 400 && Array.isArray(body?.details) && body.details.length > 0) {
        setServerErrors(body.details);
      } else if (code === "VENUE_RETIRED") {
        closeForm();
        setPanelError(holdErrorMessage(err, "place"));
        setVenueRetired(true);
      } else {
        setFormError(holdErrorMessage(err, "place"));
        setConflicts(holdConflicts(err));
        // The event is no longer Approved, or the event or venue is gone:
        // the picker is out of date. An existing hold for this event should
        // be on the list, so make sure it is.
        if (code === "EVENT_NOT_APPROVED" || status === 404) await fetchCandidates();
        if (code === "HOLD_EXISTS") await fetchHolds();
      }
    } finally {
      setSubmitting(false);
    }
  }

  function renderConflicts() {
    if (conflicts.length === 0) return null;

    return (
      <section className="venue-holds__conflicts">
        <h3>{thingsAre(conflicts.length)} in the way of this event&apos;s period</h3>
        <ul className="venue-holds__conflict-list">
          {conflicts.map((conflict, i) => {
            const { label, detail, period } = conflictText(conflict);
            return (
              <li key={conflict.bookingId ?? conflict.blockId ?? conflict.holdId ?? i}>
                <strong>{label}</strong>
                {detail && <span>{detail}</span>}
                <span>{period}</span>
              </li>
            );
          })}
        </ul>
      </section>
    );
  }

  /** "by you", "by <name>", or a short id when the name is unknown. */
  function renderPlacer(hold) {
    if (hold.placedByName && hold.placedBy !== currentUserId) {
      return <span>by {hold.placedByName}</span>;
    }
    return <BlockActor id={hold.placedBy} currentUserId={currentUserId} />;
  }

  const now = new Date();
  // AC7: a hold past its expiry holds nothing, whether or not the server has
  // marked it yet.
  const activeHolds = holds.filter((hold) => new Date(hold.expiresAt) > now);

  return (
    <div className="venue-holds">
      <h2>
        Tentative holds for {venue.name} — {venue.location}
      </h2>

      {panelError && (
        <p className="venue-holds__error" role="alert">
          {panelError}
        </p>
      )}
      {notice && (
        <div className="venue-holds__notice" role="status">
          <p>
            Hold placed. {venue.name} is tentatively held for {notice.eventName} until{" "}
            {formatTimestamp(notice.expiresAt)}.
          </p>
        </div>
      )}

      {!formOpen && (
        <Button
          onClick={openForm}
          disabled={venueRetired}
          title={venueRetired ? "A retired venue cannot be held." : undefined}
        >
          + Place a hold
        </Button>
      )}

      {formOpen && (
        <>
          <VenueHoldForm
            candidates={candidates}
            loadingCandidates={loadingCandidates}
            candidatesError={candidatesError}
            onSubmit={send}
            onCancel={closeForm}
            submitting={submitting}
            serverErrors={serverErrors}
            formError={formError}
            onChanged={() => setConflicts([])}
          />
          {renderConflicts()}
        </>
      )}

      <section className="venue-holds__current">
        <h3>Active holds</h3>

        {loadingHolds && holds.length === 0 && <p>Loading...</p>}
        {listError && (
          <p className="venue-holds__error" role="alert">
            {listError}
          </p>
        )}
        {!loadingHolds && !listError && activeHolds.length === 0 && (
          <p>This venue has no active holds.</p>
        )}

        {activeHolds.length > 0 && (
          <ul className="venue-holds__list">
            {activeHolds.map((hold) => (
              <li key={hold.id} className="venue-holds__item">
                <div className="venue-holds__item-main">
                  <strong>{hold.eventName || "Unnamed event"}</strong>
                  <span>{formatRange(hold.eventStartsAt, hold.eventEndsAt, "no date")}</span>
                  <StatusBadge tone={HOLD_TONE}>Tentatively held</StatusBadge>
                  <p className="venue-holds__audit">
                    Expires {formatTimestamp(hold.expiresAt)} · Placed{" "}
                    {formatTimestamp(hold.placedAt)} {renderPlacer(hold)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
