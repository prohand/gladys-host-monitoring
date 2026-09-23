// -----------------------------------------------------------------------------
// Host monitor fixture shared by the blueprint tests: metrics, sensors and
// clock are all controlled, the SDK is the in-memory fake.
// -----------------------------------------------------------------------------

import { createHostMonitor } from '../../src/devices/hostMonitor.js';
import { createStateThrottle } from '../../src/publish/throttle.js';
import { createFakeGladys } from './fakeGladys.js';

const GIB = 1024 ** 3;

/**
 * A metrics snapshot with every metric available, overridable per test.
 * @param {object} overrides - Values replacing the defaults.
 * @returns {object} The snapshot.
 */
export function snapshot(overrides = {}) {
  return {
    cpuPercent: 12.345,
    memoryPercent: 48.6,
    memoryTotalBytes: 8 * GIB,
    diskPercent: 61.2,
    diskFreeGib: 42.5,
    diskTotalBytes: 100 * GIB,
    temperature: 47.83,
    ...overrides,
  };
}

/**
 * Build a host monitor whose metrics, sensors and clock are all controlled.
 * @param {{readings?: object[], sensorPath?: string|null, sensors?: object[]}} options - Test doubles.
 * @returns {{monitor: object, gladys: object, advance: Function, reads: number}} The fixture.
 */
export function createFixture({
  readings = [snapshot()],
  sensorPath = '/sys/fake/temp',
  sensors = [],
} = {}) {
  let clock = 1_000_000;
  let index = 0;
  const state = { reads: 0 };
  const monitor = createHostMonitor({
    collector: {
      async read() {
        state.reads += 1;
        return readings[Math.min(index++, readings.length - 1)];
      },
      reset() {},
    },
    throttle: createStateThrottle({ now: () => clock }),
    resolveSensor: () => sensorPath,
    listSensors: () => sensors,
  });
  return {
    monitor,
    gladys: createFakeGladys(),
    state,
    advance: (ms) => {
      clock += ms;
    },
  };
}

/**
 * Index the published states by feature key, for readable assertions.
 * @param {object} gladys - The fake SDK.
 * @param {object} monitor - The blueprint under test.
 * @returns {Record<string, number>} The last published value per feature key.
 */
export function publishedByFeature(gladys, monitor) {
  const deviceId = monitor.deviceExternalId(gladys);
  return Object.fromEntries(
    gladys.published.map(({ featureExternalId, state }) => [
      featureExternalId.replace(`${deviceId}:`, ''),
      state,
    ]),
  );
}
