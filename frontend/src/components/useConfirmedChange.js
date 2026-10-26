// useConfirmedChange.js
//
// The flow the three screens share (the edit form, the damage and maintenance
// form, and the retire row) for a change that may leave reservations short:
//
//   start   asks the backend which reservations the change affects
//           - none: saves at once with an empty confirmed list (AC7)
//           - some: stops at "confirming" and shows them (AC2); nothing is saved
//   confirm saves with exactly the reservations that were shown
//   cancel  goes back; nothing was saved
//
// If the save is refused because the list moved since the preview, the new list
// replaces the old one, `stale` says so, and the staff member must confirm that
// list instead. A refusal never saves anything and never confirms by itself.
//
// `start` is given the calls each time, so one instance serves a screen that
// changes one thing at a time, such as the catalogue's retire button. Each call
// to start or cancel starts a new generation, and an answer that arrives for an
// older one is dropped, so a slow preview cannot reopen a confirmation the staff
// member has already left.

import { useCallback, useEffect, useRef, useState } from "react";
import { equipmentErrorMessages, isAffectedChangedError, affectedFromError } from "../services/equipmentErrors";

const IDLE = "idle";
const CHECKING = "checking";
const CONFIRMING = "confirming";
const SAVING = "saving";

export default function useConfirmedChange() {
  const [stage, setStage] = useState(IDLE);
  const [impact, setImpact] = useState(null);
  const [stale, setStale] = useState(false);
  const [errors, setErrors] = useState([]);

  // What the pending change needs to save and report. A ref, not state: it is
  // read when the staff member clicks Confirm and never drives what is drawn.
  const pending = useRef(null);
  // A second click, or a second change, while one is running is ignored.
  const running = useRef(false);
  const generation = useRef(0);

  // Leaving the screen while the preview is running must not go on to save: the
  // staff member walked away before seeing whether anything was affected. A save
  // that is already on its way cannot be stopped, and still refreshes the list.
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  const fail = useCallback((err, action, backTo, onFailure) => {
    const messages = equipmentErrorMessages(err, action);
    setErrors(messages);
    setStage(backTo);
    if (onFailure) onFailure(err, messages, backTo);
  }, []);

  // backTo is where a failed save returns to: the form when nothing was shown,
  // the confirmation when the staff member had already seen the list.
  const save = useCallback(
    async (ids, backTo, mine) => {
      const { save: doSave, onSaved, action, onFailure } = pending.current;
      setErrors([]);
      setStage(SAVING);
      try {
        await doSave(ids);
        if (generation.current === mine) {
          pending.current = null;
          setImpact(null);
          setStale(false);
          setStage(IDLE);
        }
        onSaved();
      } catch (err) {
        if (generation.current !== mine) return;
        if (isAffectedChangedError(err)) {
          // Nothing was saved. Show the list as it is now and ask again.
          setImpact((before) => ({
            usableBefore: before?.usableBefore ?? null,
            usableAfter: before?.usableAfter ?? null,
            affected: affectedFromError(err),
          }));
          setStale(true);
          setErrors([]);
          setStage(CONFIRMING);
          return;
        }
        fail(err, action, backTo, onFailure);
      } finally {
        if (generation.current === mine) running.current = false;
      }
    },
    [fail],
  );

  /**
   * @param {object} change
   * @param {() => Promise<{affected: object[], usableBefore: number, usableAfter: number}>} change.preview
   * @param {(confirmedReservationIds: string[]) => Promise<unknown>} change.save
   * @param {() => void} change.onSaved  called once, after the change is saved
   * @param {string} change.action  the equipmentErrors action for a failed save
   * @param {(err: unknown, messages: string[], stage: string) => void} [change.onFailure]
   *   called for every failure except the "list moved" refusal, with the stage the flow
   *   went back to ("idle" or "confirming")
   */
  const start = useCallback(
    async (change) => {
      if (running.current) return;
      running.current = true;
      const mine = ++generation.current;
      pending.current = change;
      setErrors([]);
      setStale(false);
      setImpact(null);
      setStage(CHECKING);

      let result;
      try {
        result = await change.preview();
      } catch (err) {
        if (generation.current !== mine) return;
        running.current = false;
        pending.current = null;
        fail(err, "preview", IDLE, change.onFailure);
        return;
      }
      if (generation.current !== mine) return;

      const affected = Array.isArray(result?.affected) ? result.affected : null;
      if (affected === null) {
        // Not an answer we can show. Saving on the strength of it could skip a confirmation.
        running.current = false;
        pending.current = null;
        fail(new Error("unreadable preview"), "preview", IDLE, change.onFailure);
        return;
      }

      if (affected.length === 0) {
        await save([], IDLE, mine);
        return;
      }

      running.current = false;
      setImpact({ affected, usableBefore: result.usableBefore, usableAfter: result.usableAfter });
      setStage(CONFIRMING);
    },
    [fail, save],
  );

  const confirm = useCallback(async () => {
    if (running.current || stage !== CONFIRMING) return;
    running.current = true;
    await save(
      impact.affected.map((item) => item.reservationId),
      CONFIRMING,
      generation.current,
    );
  }, [impact, save, stage]);

  const cancel = useCallback(() => {
    generation.current += 1;
    running.current = false;
    pending.current = null;
    setImpact(null);
    setStale(false);
    setErrors([]);
    setStage(IDLE);
  }, []);

  return {
    stage,
    busy: stage === CHECKING || stage === SAVING,
    confirming: stage === CONFIRMING,
    // The list is on screen: waiting for a decision, or being saved after one.
    reviewing: impact !== null && (stage === CONFIRMING || stage === SAVING),
    impact,
    stale,
    errors,
    start,
    confirm,
    cancel,
  };
}
