// VenueBlocksPanel.jsx
//
// SCRUM-127 (part of SCRUM-17). Where a Venue Staff member blocks a venue
// (AC1), is shown the approved bookings a block would overlap and either picks
// another period or explicitly overrides (AC3), and shortens, extends or
// removes a block (AC4). Opened from VenueCatalogue's "Manage blocks" button
// as a full-page panel, like VenueDetail.
//
// This is the parent VenueBlockForm and BlockConflictList were written for:
// both are presentational, so every request, and everything the API says
// back, lives here.
//
// One request path, send(), serves both the plain submit and the override.
// The override is the same payload resent with the acknowledgement fields, so
// keeping one path means one double-submit guard and one outcome table.
//
// After every save or remove the list is refetched rather than spliced, for
// the reason VenueCatalogue gives: the server orders the rows, and the error
// paths need a refetch anyway, so one recovery path beats two.
//
// SCRUM-131 (AC4's "with the creating or amending user and timestamp
// recorded"). Each row says who created it and, once amended, who last
// changed it, and has a History button that opens the block's full trail
// (BlockHistory) under the row. One history is open at a time. History is a
// read, so it is offered on ended rows too and is never disabled: it clashes
// with no write in flight.
//
// currentUserId is a prop, not useAuth(): useAuth throws without an
// AuthProvider, and this panel's tests render without one. Without it, the
// signed-in user's own changes show as a short id instead of "you".

import { useCallback, useEffect, useState } from "react";
import {
  createVenueBlock,
  listVenueBlocks,
  removeVenueBlock,
  updateVenueBlock,
} from "../services/venueService";
import { blockErrorMessage, isStaleBlockError } from "../services/venueBlockErrors";
import { BLOCK_PHASE_LABELS, blockPhase } from "../services/venueBlockDisplay";
import { reasonLabel } from "../services/venueBlockReasons";
import { formatRange, formatTimestamp, shortId } from "../services/displayFormat";
import { blockAuditSummary } from "../services/venueBlockHistoryDisplay";
import VenueBlockForm from "./VenueBlockForm";
import BlockConflictList from "./BlockConflictList";
import BlockHistory, { BlockActor } from "./BlockHistory";

/** "1 booking was" / "3 bookings were". */
function bookingsWere(count) {
  return count === 1 ? "1 booking was" : `${count} bookings were`;
}

export default function VenueBlocksPanel({ venue, currentUserId }) {
  const [blocks, setBlocks] = useState([]);
  const [loadingBlocks, setLoadingBlocks] = useState(true);
  const [listError, setListError] = useState(null);

  // null | { mode: "create" } | { mode: "edit", block }
  const [formMode, setFormMode] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [serverErrors, setServerErrors] = useState([]); // a 400's details[]
  const [formError, setFormError] = useState(null);

  // The BLOCK_BOOKING_CONFLICT state. pendingPayload is what the form last
  // submitted, without any override fields, so the override resends exactly
  // the values the conflicts were computed for.
  const [conflicts, setConflicts] = useState([]);
  const [pendingPayload, setPendingPayload] = useState(null);
  const [overrideError, setOverrideError] = useState(null);
  const [clashingBlockIds, setClashingBlockIds] = useState([]); // BLOCK_OVERLAPS_BLOCK

  // null | { action: "saved" | "removed", flaggedBookings, overrode }
  const [notice, setNotice] = useState(null);
  const [panelError, setPanelError] = useState(null);
  // Seeded from the prop, then set by a VENUE_RETIRED answer: the venue can
  // be retired by someone else while this panel is open.
  const [venueRetired, setVenueRetired] = useState(Boolean(venue.retiredAt));

  // Per-row ids, as in VenueCatalogue's retire flow.
  const [confirmingRemoveId, setConfirmingRemoveId] = useState(null);
  const [removingId, setRemovingId] = useState(null);
  const [removeError, setRemoveError] = useState(null); // { id, message }

  // The block whose history is open, if any. One at a time, so the list
  // does not grow a trail under every row.
  const [historyBlockId, setHistoryBlockId] = useState(null);

  const fetchBlocks = useCallback(async () => {
    setLoadingBlocks(true);
    try {
      const data = await listVenueBlocks(venue.id);
      setBlocks(data);
      setListError(null);
    } catch (err) {
      setListError(blockErrorMessage(err, "list"));
    } finally {
      setLoadingBlocks(false);
    }
  }, [venue.id]);

  useEffect(() => {
    fetchBlocks();
  }, [fetchBlocks]);

  function clearConflicts() {
    setConflicts([]);
    setPendingPayload(null);
    setOverrideError(null);
  }

  function clearFormFeedback() {
    setServerErrors([]);
    setFormError(null);
    setClashingBlockIds([]);
    clearConflicts();
  }

  function openForm(mode) {
    clearFormFeedback();
    setNotice(null);
    setPanelError(null);
    setRemoveError(null);
    setConfirmingRemoveId(null);
    setFormMode(mode);
  }

  function closeForm() {
    clearFormFeedback();
    setFormMode(null);
  }

  async function send(payload, { overrode = false } = {}) {
    if (submitting) return; // closes the double-click window before it opens

    const action = formMode?.mode === "edit" ? "update" : "create";

    setSubmitting(true);
    setServerErrors([]);
    setFormError(null);
    setOverrideError(null);
    setClashingBlockIds([]);
    setNotice(null);
    setPanelError(null);

    try {
      const data =
        action === "update"
          ? await updateVenueBlock(venue.id, formMode.block.id, payload)
          : await createVenueBlock(venue.id, payload);

      closeForm();
      setNotice({
        action: "saved",
        flaggedBookings: data?.flaggedBookings ?? [],
        overrode,
      });
      await fetchBlocks();
    } catch (err) {
      const status = err.response?.status;
      const body = err.response?.data;
      const code = body?.code;

      if (status === 409 && code === "BLOCK_BOOKING_CONFLICT") {
        // The list replaces whatever was on screen. On a re-409 after an
        // override, BlockConflictList closes its own confirm when the set of
        // bookings differs, so nobody confirms bookings they have not seen.
        setConflicts(Array.isArray(body.conflicts) ? body.conflicts : []);
        // Kept as the original submit, never the override resend, so a second
        // override cannot carry the first one's stale acknowledgements.
        if (!overrode) setPendingPayload(payload);
        if (overrode) setOverrideError(blockErrorMessage(err, action));
      } else if (status === 400 && Array.isArray(body?.details) && body.details.length > 0) {
        setServerErrors(body.details);
      } else if (code === "BLOCK_OVERLAPS_BLOCK") {
        clearConflicts();
        setFormError(blockErrorMessage(err, action));
        setClashingBlockIds(
          (Array.isArray(body.conflicts) ? body.conflicts : [])
            .map((conflict) => conflict.blockId)
            .filter(Boolean),
        );
      } else if (code === "VENUE_RETIRED") {
        closeForm();
        setPanelError(blockErrorMessage(err, action));
        setVenueRetired(true);
      } else if (action === "update" && isStaleBlockError(err)) {
        // The block being edited is gone or ended; the form would only keep
        // offering a save that cannot succeed.
        closeForm();
        setPanelError(blockErrorMessage(err, action));
        await fetchBlocks();
      } else {
        setFormError(blockErrorMessage(err, action));
        // An unknown 409 on create says "the list has been refreshed", so
        // make that true; the form stays open with the user's values.
        if (status === 409) await fetchBlocks();
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleOverride(acknowledgedBookingIds) {
    if (!pendingPayload) return;
    send(
      { ...pendingPayload, confirmOverride: true, acknowledgedBookingIds },
      { overrode: true },
    );
  }

  async function handleRemove(block) {
    if (removingId) return; // closes the double-click window before it opens

    // confirmingRemoveId stays set until the finally, for the reason
    // VenueCatalogue's handleRetire gives: "Removing..." lives inside the
    // confirm block, which would otherwise unmount as the request starts.
    setRemovingId(block.id);
    setRemoveError(null);
    setNotice(null);
    setPanelError(null);

    try {
      await removeVenueBlock(venue.id, block.id);
      setNotice({ action: "removed", flaggedBookings: [], overrode: false });
      await fetchBlocks();
    } catch (err) {
      const message = blockErrorMessage(err, "remove");
      if (isStaleBlockError(err)) {
        // Panel-level, not on the row: a removed or missing block drops out
        // of the refetched list, and its row's error would vanish with it.
        setPanelError(message);
        await fetchBlocks();
      } else {
        setRemoveError({ id: block.id, message });
      }
    } finally {
      setRemovingId(null);
      setConfirmingRemoveId(null);
    }
  }

  const now = new Date();
  const rowActionsDisabled = Boolean(formMode) || Boolean(removingId);

  function renderNotice() {
    if (!notice) return null;
    const flagged = notice.flaggedBookings ?? [];

    return (
      <div className="venue-blocks__notice" role="status">
        <p>{notice.action === "removed" ? "Block removed." : "Block saved."}</p>
        {flagged.length > 0 && (
          <>
            <p>
              {bookingsWere(flagged.length)} flagged for review and Event Coordinators were
              notified:
            </p>
            <ul className="venue-blocks__flagged">
              {flagged.map((booking, i) => (
                <li key={booking.bookingId ?? i}>
                  <strong>{booking.eventName || "Unnamed event"}</strong>
                  <span>{formatRange(booking.startsAt, booking.endsAt)}</span>
                  <code title={booking.eventRequestId ?? undefined}>
                    {booking.eventRequestId ? shortId(booking.eventRequestId) : "no event"}
                  </code>
                </li>
              ))}
            </ul>
          </>
        )}
        {/* An override can flag nothing if the bookings stopped being
            approved in between. Said out loud, so it is not read as a fault. */}
        {notice.overrode && flagged.length === 0 && <p>No bookings were flagged.</p>}
      </div>
    );
  }

  function toggleHistory(blockId) {
    setHistoryBlockId((open) => (open === blockId ? null : blockId));
  }

  /** "Created <time> by <actor> · Last amended <time> by <actor>", or nothing. */
  function renderAudit(block) {
    const { created, amended } = blockAuditSummary(block);
    // Rows from before SCRUM-131's fields were read carry no createdAt.
    if (!created) return null;

    return (
      <p className="venue-blocks__audit">
        Created {formatTimestamp(created.at)}{" "}
        <BlockActor id={created.by} currentUserId={currentUserId} />
        {amended && (
          <>
            {" · Last amended "}
            {formatTimestamp(amended.at)}{" "}
            <BlockActor id={amended.by} currentUserId={currentUserId} />
          </>
        )}
      </p>
    );
  }

  function renderRow(block) {
    const phase = blockPhase(block, now);
    const ended = phase === "ended";
    const clashing = clashingBlockIds.includes(block.id);
    const confirming = confirmingRemoveId === block.id;
    const removing = removingId === block.id;
    const historyOpen = historyBlockId === block.id;
    const historyId = `block-history-${block.id}`;

    const className = [
      "venue-blocks__item",
      ended && "venue-blocks__item--ended",
      clashing && "venue-blocks__item--clash",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <li key={block.id} className={className}>
        <div className="venue-blocks__item-main">
          <strong>{reasonLabel(block.reason)}</strong>
          <span>{formatRange(block.startsAt, block.endsAt)}</span>
          <span className={`status-badge status--block-${phase}`}>
            {BLOCK_PHASE_LABELS[phase]}
          </span>
          {block.notes && <p className="venue-blocks__notes">{block.notes}</p>}
          {renderAudit(block)}
          {clashing && (
            <p className="venue-blocks__clash-note">Overlaps the period you chose</p>
          )}
          {ended && (
            <p className="venue-blocks__ended-note">
              Ended blocks are kept as a record and can&apos;t be changed.
            </p>
          )}
          {removeError?.id === block.id && (
            <p className="venue-blocks__error" role="alert">
              {removeError.message}
            </p>
          )}
        </div>

        <div className="venue-blocks__item-actions">
          {/* No Edit or Remove on an ended block: the server refuses both
              with BLOCK_ENDED, and a past closure is a record, not a
              setting. History stays -- it is a read. */}
          {!ended && !confirming && (
            <>
              {/* A change on a retired venue is refused with VENUE_RETIRED,
                  so Edit goes; Remove stays, because removing a block only
                  reduces blocking and the server allows it. */}
              <button
                onClick={() => openForm({ mode: "edit", block })}
                disabled={rowActionsDisabled || venueRetired}
                title={venueRetired ? "A retired venue cannot be blocked." : undefined}
              >
                Edit
              </button>
              <button
                onClick={() => setConfirmingRemoveId(block.id)}
                disabled={rowActionsDisabled}
              >
                Remove
              </button>
            </>
          )}

          {!ended && confirming && (
            <>
              <span>Remove this block? Bookings it flagged stay flagged for review.</span>
              <button onClick={() => handleRemove(block)} disabled={removing}>
                {removing ? "Removing..." : "Yes, remove"}
              </button>
              <button onClick={() => setConfirmingRemoveId(null)} disabled={removing}>
                Cancel
              </button>
            </>
          )}

          <button
            onClick={() => toggleHistory(block.id)}
            aria-expanded={historyOpen}
            aria-controls={historyId}
          >
            {historyOpen ? "Hide history" : "History"}
          </button>
        </div>

        {/* Keyed by block so a different row's history never inherits this
            one's entries. refreshKey is updatedAt: the refetch after a save
            changes it, and the open history refetches with it. */}
        {historyOpen && (
          <BlockHistory
            key={block.id}
            venueId={venue.id}
            blockId={block.id}
            refreshKey={block.updatedAt}
            currentUserId={currentUserId}
            id={historyId}
          />
        )}
      </li>
    );
  }

  return (
    <div className="venue-blocks">
      <h2>
        Blocks for {venue.name} — {venue.location}
      </h2>

      {panelError && (
        <p className="venue-blocks__error" role="alert">
          {panelError}
        </p>
      )}
      {renderNotice()}

      {!formMode && (
        <button
          onClick={() => openForm({ mode: "create" })}
          disabled={venueRetired}
          title={venueRetired ? "A retired venue cannot be blocked." : undefined}
        >
          + Add a block
        </button>
      )}

      {formMode && (
        <>
          {/* Re-keyed per block, as VenueBlockForm's header asks: its state is
              initialised once, from initialBlock. */}
          <VenueBlockForm
            key={formMode.block?.id ?? "new"}
            initialBlock={formMode.block ?? null}
            onSubmit={(payload) => send(payload)}
            onCancel={closeForm}
            submitting={submitting}
            serverErrors={serverErrors}
            formError={formError}
            onDatesChanged={clearConflicts}
            onDetailsChanged={clearConflicts}
          />
          {overrideError && (
            <p className="venue-blocks__error" role="alert">
              {overrideError}
            </p>
          )}
          <BlockConflictList
            conflicts={conflicts}
            onChangePeriod={clearConflicts}
            onConfirmOverride={handleOverride}
            submitting={submitting}
          />
        </>
      )}

      <section className="venue-blocks__current">
        <h3>Current and upcoming blocks</h3>

        {loadingBlocks && blocks.length === 0 && <p>Loading...</p>}
        {listError && (
          <p className="venue-blocks__error" role="alert">
            {listError}
          </p>
        )}
        {!loadingBlocks && !listError && blocks.length === 0 && (
          <p>This venue has no blocks.</p>
        )}

        {blocks.length > 0 && (
          <ul className="venue-blocks__list">{blocks.map(renderRow)}</ul>
        )}
      </section>
    </div>
  );
}
