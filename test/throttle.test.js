import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStateThrottle } from '../src/publish/throttle.js';

const MAX_INTERVAL_MS = 60 * 60 * 1000; // one hour

/**
 * Build a throttle driven by a clock the test controls.
 *
 * `publish` is the production path: select, then record what was accepted.
 * Tests that care about the split between the two call filter/commit directly.
 * @returns {{throttle: object, publish: Function, advance: (ms: number) => void}} The throttle and its clock.
 */
function createControlledThrottle() {
  let clock = 1_000_000;
  const throttle = createStateThrottle({ now: () => clock });
  return {
    throttle,
    publish: (readings, options) => {
      const kept = throttle.filter(readings, options);
      throttle.commit(kept);
      return kept;
    },
    advance: (ms) => {
      clock += ms;
    },
  };
}

test('the first reading of a feature is always published', () => {
  const { publish } = createControlledThrottle();
  const kept = publish([{ externalId: 'cpu', value: 12.3, deadband: 2 }], {
    maxIntervalMs: MAX_INTERVAL_MS,
  });
  assert.deepEqual(kept, [{ externalId: 'cpu', value: 12.3, deadband: 2 }]);
});

test('a move smaller than the deadband is dropped', () => {
  const { publish } = createControlledThrottle();
  publish([{ externalId: 'cpu', value: 40, deadband: 2 }], {
    maxIntervalMs: MAX_INTERVAL_MS,
  });
  const kept = publish([{ externalId: 'cpu', value: 41.5, deadband: 2 }], {
    maxIntervalMs: MAX_INTERVAL_MS,
  });
  assert.equal(kept.length, 0);
});

test('a move of exactly the deadband is published', () => {
  const { publish } = createControlledThrottle();
  publish([{ externalId: 'cpu', value: 40, deadband: 2 }], {
    maxIntervalMs: MAX_INTERVAL_MS,
  });
  const kept = publish([{ externalId: 'cpu', value: 42, deadband: 2 }], {
    maxIntervalMs: MAX_INTERVAL_MS,
  });
  assert.equal(kept.length, 1);
});

test('the deadband is measured against the last PUBLISHED value, so a slow drift eventually crosses it', () => {
  const { publish } = createControlledThrottle();
  publish([{ externalId: 'cpu', value: 40, deadband: 2 }], {
    maxIntervalMs: MAX_INTERVAL_MS,
  });
  // Three consecutive +1 steps: each one is under the deadband, but the third
  // is 3 points away from the last published value.
  assert.equal(
    publish([{ externalId: 'cpu', value: 41, deadband: 2 }], {
      maxIntervalMs: MAX_INTERVAL_MS,
    }).length,
    0,
  );
  assert.equal(
    publish([{ externalId: 'cpu', value: 42, deadband: 2 }], {
      maxIntervalMs: MAX_INTERVAL_MS,
    }).length,
    1,
  );
});

test('a flat metric is still published once per maximum interval', () => {
  const { publish, advance } = createControlledThrottle();
  const reading = [{ externalId: 'disk', value: 55, deadband: 2 }];
  publish(reading, { maxIntervalMs: MAX_INTERVAL_MS });

  advance(MAX_INTERVAL_MS - 1);
  assert.equal(publish(reading, { maxIntervalMs: MAX_INTERVAL_MS }).length, 0);

  advance(1);
  assert.equal(publish(reading, { maxIntervalMs: MAX_INTERVAL_MS }).length, 1);
});

test('the heartbeat timer restarts from the last published point', () => {
  const { publish, advance } = createControlledThrottle();
  publish([{ externalId: 'disk', value: 55, deadband: 2 }], {
    maxIntervalMs: MAX_INTERVAL_MS,
  });
  advance(MAX_INTERVAL_MS);
  publish([{ externalId: 'disk', value: 55, deadband: 2 }], {
    maxIntervalMs: MAX_INTERVAL_MS,
  });
  // Right after the heartbeat point, an unchanged value is held back again.
  advance(1000);
  assert.equal(
    publish([{ externalId: 'disk', value: 55, deadband: 2 }], {
      maxIntervalMs: MAX_INTERVAL_MS,
    }).length,
    0,
  );
});

test('a deadband of 0 publishes every reading', () => {
  const { publish } = createControlledThrottle();
  publish([{ externalId: 'cpu', value: 40, deadband: 0 }], {
    maxIntervalMs: MAX_INTERVAL_MS,
  });
  const kept = publish([{ externalId: 'cpu', value: 40, deadband: 0 }], {
    maxIntervalMs: MAX_INTERVAL_MS,
  });
  assert.equal(kept.length, 1);
});

test('unavailable readings are dropped instead of being published as a fake value', () => {
  const { publish } = createControlledThrottle();
  const kept = publish(
    [
      { externalId: 'temperature', value: null, deadband: 1 },
      { externalId: 'disk', value: Number.NaN, deadband: 1 },
      { externalId: 'cpu', value: 10, deadband: 1 },
    ],
    { maxIntervalMs: MAX_INTERVAL_MS },
  );
  assert.deepEqual(
    kept.map((reading) => reading.externalId),
    ['cpu'],
  );
});

test('each feature is throttled independently', () => {
  const { publish } = createControlledThrottle();
  publish(
    [
      { externalId: 'cpu', value: 10, deadband: 2 },
      { externalId: 'ram', value: 60, deadband: 2 },
    ],
    { maxIntervalMs: MAX_INTERVAL_MS },
  );
  const kept = publish(
    [
      { externalId: 'cpu', value: 90, deadband: 2 },
      { externalId: 'ram', value: 60.5, deadband: 2 },
    ],
    { maxIntervalMs: MAX_INTERVAL_MS },
  );
  assert.deepEqual(
    kept.map((reading) => reading.externalId),
    ['cpu'],
  );
});

test('reset() makes the next filter publish a full snapshot', () => {
  const { throttle, publish } = createControlledThrottle();
  const readings = [{ externalId: 'cpu', value: 40, deadband: 2 }];
  publish(readings, { maxIntervalMs: MAX_INTERVAL_MS });
  assert.equal(publish(readings, { maxIntervalMs: MAX_INTERVAL_MS }).length, 0);
  throttle.reset();
  assert.equal(publish(readings, { maxIntervalMs: MAX_INTERVAL_MS }).length, 1);
});

test('a reading that was filtered but never committed stays eligible', () => {
  // The publish call failed (Gladys restarting, network blip): nothing was
  // written, so the very next refresh must offer the reading again instead of
  // holding it back until it crosses the deadband a second time.
  const { throttle } = createControlledThrottle();
  const readings = [{ externalId: 'cpu', value: 40, deadband: 2 }];

  assert.equal(throttle.filter(readings, { maxIntervalMs: MAX_INTERVAL_MS }).length, 1);
  // No commit() — the batch never reached Gladys.
  assert.equal(throttle.filter(readings, { maxIntervalMs: MAX_INTERVAL_MS }).length, 1);
});

test('commit() records only the readings it is given', () => {
  const { throttle } = createControlledThrottle();
  const readings = [
    { externalId: 'cpu', value: 40, deadband: 2 },
    { externalId: 'ram', value: 60, deadband: 2 },
  ];
  const kept = throttle.filter(readings, { maxIntervalMs: MAX_INTERVAL_MS });
  throttle.commit(kept.filter((reading) => reading.externalId === 'cpu'));

  assert.deepEqual(
    throttle.filter(readings, { maxIntervalMs: MAX_INTERVAL_MS }).map((r) => r.externalId),
    ['ram'],
  );
});
