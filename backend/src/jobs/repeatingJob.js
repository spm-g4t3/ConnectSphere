/**
 * The timer the minute jobs share: run once on start, so work that fell due
 * while the API was down is caught up, then every intervalMs. A tick that
 * arrives while the previous run is still waiting is skipped, so a slow
 * database never stacks calls. The interval is unref'd, so it never keeps
 * Node alive on its own.
 *
 * @param {() => Promise<unknown>} runOnce  must not throw; each job logs its own failures
 * @param {number} intervalMs
 * @returns {() => void} stop: clears the timer
 */
export function startRepeatingJob(runOnce, intervalMs) {
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      await runOnce();
    } finally {
      running = false;
    }
  }

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();

  return function stop() {
    clearInterval(timer);
  };
}
