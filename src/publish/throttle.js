// -----------------------------------------------------------------------------
// State throttle: what actually protects the Gladys database.
//
// Gladys writes one history row for EVERY state an integration publishes
// (device.saveState inserts unconditionally when the feature keeps history —
// there is no server-side deduplication). A host monitor publishing five
// metrics on a short interval therefore writes millions of rows a year, most of
// them repeating the previous value.
//
// So the integration decides what deserves to be written, with two rules:
//
//   1. DEADBAND — publish a reading only when it moved by at least `deadband`
//      since the value we LAST PUBLISHED (not since the last reading, so slow
//      drifts still cross the threshold eventually instead of being lost).
//   2. HEARTBEAT — publish anyway when the last published point is older than
//      `maxIntervalMs`, so a perfectly flat metric still draws a continuous
//      line on the charts and Gladys never shows a stale "last seen" value.
//
// Both rules are per feature, and the thresholds come from the configuration:
// a user who wants every sample can set the deadband to 0.
// -----------------------------------------------------------------------------

/**
 * Build a state throttle. It keeps, per feature, the last value it let through
 * and when — nothing else, so it stays cheap and restart-safe (a restart simply
 * publishes a fresh point for every metric).
 * @param {{now?: () => number}} options - Injectable clock, for tests.
 * @returns {{filter: Function, reset: Function}} The throttle.
 */
export function createStateThrottle({ now = Date.now } = {}) {
  /** @type {Map<string, {value: number, publishedAt: number}>} */
  const lastPublished = new Map();

  return {
    /**
     * Keep only the readings worth writing to the database.
     *
     * Readings whose value is null/undefined/NaN are dropped silently: an
     * unavailable metric (no thermal sensor, unmounted disk) must not publish
     * a fake 0, which would show up as a real measurement on the charts.
     * @param {{externalId: string, value: number|null, deadband?: number}[]} readings - Candidate readings.
     * @param {{maxIntervalMs: number}} options - Heartbeat interval.
     * @returns {{externalId: string, value: number}[]} The readings to publish.
     */
    filter(readings, { maxIntervalMs }) {
      const timestamp = now();
      const kept = [];

      for (const reading of readings) {
        if (!Number.isFinite(reading.value)) {
          continue;
        }
        const previous = lastPublished.get(reading.externalId);
        const isFirstValue = previous === undefined;
        const movedEnough =
          !isFirstValue && Math.abs(reading.value - previous.value) >= (reading.deadband ?? 0);
        const heartbeatDue = !isFirstValue && timestamp - previous.publishedAt >= maxIntervalMs;

        if (isFirstValue || movedEnough || heartbeatDue) {
          lastPublished.set(reading.externalId, { value: reading.value, publishedAt: timestamp });
          kept.push(reading);
        }
      }

      return kept;
    },

    /**
     * Forget everything, so the next filter() publishes a full snapshot.
     * Used on (re)connection: Gladys may have missed what we held back.
     */
    reset() {
      lastPublished.clear();
    },
  };
}
