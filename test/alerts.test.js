import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAlertTracker, ALERT_STATUS } from '../src/publish/alerts.js';

/**
 * One disk reading against a 90 % threshold, 5 points of hysteresis.
 * @param {number|null} value - The reading.
 * @param {number} threshold - Alert threshold.
 * @returns {object[]} The readings array evaluate() expects.
 */
function disk(value, threshold = 90) {
  return [{ metric: 'disk', value, threshold, hysteresis: 5 }];
}

/**
 * The production path: evaluate, then commit every transition as delivered.
 * @param {object} tracker - The alert tracker.
 * @param {object[]} readings - Readings to evaluate.
 * @returns {string[]} The statuses of the delivered transitions.
 */
function deliver(tracker, readings) {
  const transitions = tracker.evaluate(readings);
  transitions.forEach((transition) => tracker.commit(transition));
  return transitions.map((transition) => transition.status);
}

test('an alert is raised once when the threshold is reached, not at every reading', () => {
  const tracker = createAlertTracker();
  assert.deepEqual(deliver(tracker, disk(80)), [], 'below the threshold: nothing happened');
  assert.deepEqual(deliver(tracker, disk(90)), [ALERT_STATUS.RAISED]);
  assert.deepEqual(deliver(tracker, disk(95)), [], 'still full: no second event');
  assert.equal(tracker.isActive('disk'), true);
});

test('an alert clears under the hysteresis margin, not at the threshold', () => {
  // A disk hovering around 90 % must not run the scenes at every refresh.
  const tracker = createAlertTracker();
  deliver(tracker, disk(91));
  assert.deepEqual(deliver(tracker, disk(89)), [], 'just under the threshold: still in alert');
  assert.deepEqual(deliver(tracker, disk(86)), [], 'inside the margin: still in alert');
  assert.deepEqual(deliver(tracker, disk(84.9)), [ALERT_STATUS.CLEARED]);
  assert.equal(tracker.isActive('disk'), false);
});

test('a low threshold can still clear', () => {
  // With a 4 % threshold, a 5-point margin would ask for a negative reading.
  const tracker = createAlertTracker();
  deliver(tracker, disk(5, 4));
  assert.deepEqual(deliver(tracker, disk(1.9, 4)), [ALERT_STATUS.CLEARED]);
});

test('starting below the threshold fires no "cleared" event', () => {
  const tracker = createAlertTracker();
  assert.deepEqual(deliver(tracker, disk(10)), []);
});

test('an unavailable metric changes nothing', () => {
  // An unmounted disk is not a disk that stopped being full.
  const tracker = createAlertTracker();
  deliver(tracker, disk(95));
  assert.deepEqual(deliver(tracker, disk(null)), []);
  assert.deepEqual(deliver(tracker, disk(Number.NaN)), []);
  assert.equal(tracker.isActive('disk'), true);
});

test('a threshold of 0 disables the alert, and prune() forgets an active one', () => {
  const tracker = createAlertTracker();
  assert.deepEqual(deliver(tracker, disk(95, 0)), []);

  deliver(tracker, disk(95));
  tracker.prune(disk(95, 0));
  assert.equal(tracker.isActive('disk'), false, 'a disabled alert is not left active');
  assert.deepEqual(
    deliver(tracker, disk(95)),
    [ALERT_STATUS.RAISED],
    're-enabled: raised again from a clean state',
  );
});

test('an undelivered transition is detected again at the next reading', () => {
  // evaluate() does not remember: the event Gladys refused is fired again.
  const tracker = createAlertTracker();
  assert.equal(tracker.evaluate(disk(95)).length, 1);
  assert.equal(tracker.isActive('disk'), false);
  assert.deepEqual(deliver(tracker, disk(95)), [ALERT_STATUS.RAISED]);
});

test('each metric has its own alert', () => {
  const tracker = createAlertTracker();
  const transitions = tracker.evaluate([
    { metric: 'cpu', value: 95, threshold: 90, hysteresis: 5 },
    { metric: 'memory', value: 50, threshold: 90, hysteresis: 5 },
    { metric: 'temperature', value: 85, threshold: 80, hysteresis: 3 },
  ]);
  assert.deepEqual(
    transitions.map(({ metric, status, value, threshold }) => [metric, status, value, threshold]),
    [
      ['cpu', ALERT_STATUS.RAISED, 95, 90],
      ['temperature', ALERT_STATUS.RAISED, 85, 80],
    ],
  );
});
