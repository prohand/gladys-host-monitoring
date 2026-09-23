// -----------------------------------------------------------------------------
// Alert tracker: turns readings into "this crossed its threshold" events.
//
// Gladys 5.1 lets an integration fire its own scene triggers
// (`publishSceneEvent`). The SDK doctrine is strict about what deserves one:
// an event says "this HAPPENED", once per transition — never one event per
// reading, and never a value the scene would have to compare with `>` (that is
// what the published states are for). So the tracker only reports the two
// edges of an alert: `raised` when a metric reaches its threshold, `cleared`
// when it comes back down.
//
// Two details keep that honest:
//
//   1. HYSTERESIS — an alert clears a few points BELOW its threshold, not at
//      the threshold itself. A disk hovering at 89.9 / 90.1 % would otherwise
//      raise and clear at every refresh, and every scene bound to it would run
//      each time.
//   2. EVALUATE / COMMIT, like the state throttle — `evaluate()` is pure and
//      returns the transitions, `commit()` records one once Gladys accepted the
//      event. A transition whose POST /scene/event failed (Gladys restarting)
//      is detected again at the next refresh instead of being lost: a lost
//      "disk full" event is a scene that never ran.
//
// The state lives in memory only. After a restart, an alert that is still
// active is raised again on the first reading: better a repeated notification
// than a silent disk-full.
// -----------------------------------------------------------------------------

export const ALERT_STATUS = {
  RAISED: 'raised',
  CLEARED: 'cleared',
};

/**
 * Value below which an active alert clears.
 *
 * The margin is capped at half the threshold so a very low threshold (an
 * alert at 3 %) can still clear.
 * @param {number} threshold - Alert threshold.
 * @param {number} hysteresis - Nominal margin under the threshold.
 * @returns {number} The clearing value.
 */
function clearBelow(threshold, hysteresis) {
  return threshold - Math.min(hysteresis, threshold / 2);
}

/**
 * Build an alert tracker. It keeps, per metric, whether its alert is active —
 * nothing else.
 * @returns {{evaluate: Function, commit: Function, prune: Function, isActive: Function}} The tracker.
 */
export function createAlertTracker() {
  /** @type {Set<string>} */
  const active = new Set();

  return {
    /**
     * Compare the readings with their thresholds and list the transitions.
     *
     * Pure: it does not remember. Call `commit()` with each transition once
     * Gladys has accepted the event.
     *
     * A reading whose value is not finite (metric unavailable) changes
     * nothing: an unmounted disk is not a "disk no longer full". A threshold
     * of 0 disables the alert; an alert that was active when the user disabled
     * it is forgotten without a `cleared` event (see `prune()`).
     * @param {{metric: string, value: number|null, threshold: number, hysteresis: number}[]} readings - One reading per metric.
     * @returns {{metric: string, status: string, value: number, threshold: number}[]} The transitions, in reading order.
     */
    evaluate(readings) {
      const transitions = [];

      for (const { metric, value, threshold, hysteresis } of readings) {
        if (!Number.isFinite(value) || !(threshold > 0)) {
          continue;
        }
        const wasActive = active.has(metric);
        if (!wasActive && value >= threshold) {
          transitions.push({ metric, status: ALERT_STATUS.RAISED, value, threshold });
        } else if (wasActive && value < clearBelow(threshold, hysteresis)) {
          transitions.push({ metric, status: ALERT_STATUS.CLEARED, value, threshold });
        }
      }

      return transitions;
    },

    /**
     * Record a transition as delivered.
     * @param {{metric: string, status: string}} transition - A transition returned by evaluate().
     * @returns {void}
     */
    commit({ metric, status }) {
      if (status === ALERT_STATUS.RAISED) {
        active.add(metric);
      } else {
        active.delete(metric);
      }
    },

    /**
     * Forget the alerts whose threshold is now disabled, so re-enabling one
     * later starts from a clean state instead of an alert nobody sees clear.
     * @param {{metric: string, threshold: number}[]} thresholds - Current thresholds.
     * @returns {void}
     */
    prune(thresholds) {
      for (const { metric, threshold } of thresholds) {
        if (!(threshold > 0)) {
          active.delete(metric);
        }
      }
    },

    /**
     * Whether a metric is currently in alert (for the dashboard widget).
     * @param {string} metric - Metric key.
     * @returns {boolean} True while the alert is raised.
     */
    isActive(metric) {
      return active.has(metric);
    },
  };
}
