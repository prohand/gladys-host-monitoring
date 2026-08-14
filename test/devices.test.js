import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostMonitor, FEATURE } from '../src/devices/hostMonitor.js';
import {
  buildDiscoveredDevices,
  findOutdatedDevices,
  refreshDeviceNow,
} from '../src/devices/index.js';
import { createStateThrottle } from '../src/publish/throttle.js';
import { normalizeConfig } from '../src/config.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const GIB = 1024 ** 3;

/**
 * A metrics snapshot with every metric available, overridable per test.
 * @param {object} overrides - Values replacing the defaults.
 * @returns {object} The snapshot.
 */
function snapshot(overrides = {}) {
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
function createFixture({
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
function publishedByFeature(gladys, monitor) {
  const deviceId = monitor.deviceExternalId(gladys);
  return Object.fromEntries(
    gladys.published.map(({ featureExternalId, state }) => [
      featureExternalId.replace(`${deviceId}:`, ''),
      state,
    ]),
  );
}

test('the discovery payload declares the five read-only features', () => {
  const { monitor, gladys } = createFixture();
  const device = monitor.buildDevice(gladys, normalizeConfig());

  assert.equal(device.name, 'Machine hôte');
  assert.equal(device.external_id, monitor.deviceExternalId(gladys));
  assert.deepEqual(
    device.features.map((feature) => feature.external_id.split(':').pop()),
    [FEATURE.CPU, FEATURE.MEMORY, FEATURE.DISK, FEATURE.DISK_FREE, FEATURE.TEMPERATURE],
  );
  for (const feature of device.features) {
    assert.equal(feature.read_only, true, `${feature.name} is a measurement`);
    assert.equal(feature.has_feedback, false);
    assert.ok(Number.isFinite(feature.min) && Number.isFinite(feature.max));
  }
});

test('the device declares no poll_frequency: the refresh loop is the integration own', () => {
  // The Gladys core scheduler cannot go slower than one minute, which would
  // flood the history — see src/devices/hostMonitor.js.
  const { monitor, gladys } = createFixture();
  const device = monitor.buildDevice(gladys, normalizeConfig());
  assert.equal(device.poll_frequency, undefined);
});

test('the temperature feature is omitted when the machine exposes no sensor', () => {
  const { monitor, gladys } = createFixture({ sensorPath: null });
  const device = monitor.buildDevice(gladys, normalizeConfig());
  assert.deepEqual(
    device.features.map((feature) => feature.external_id.split(':').pop()),
    [FEATURE.CPU, FEATURE.MEMORY, FEATURE.DISK, FEATURE.DISK_FREE],
  );
});

test('the device name and the history flag follow the configuration', () => {
  const { monitor, gladys } = createFixture();
  const device = monitor.buildDevice(
    gladys,
    normalizeConfig({ device_name: 'NAS', keep_history: false }),
  );
  assert.equal(device.name, 'NAS');
  assert.ok(device.features.every((feature) => feature.keep_history === false));
});

test('a refresh publishes every metric, rounded', async () => {
  const { monitor, gladys } = createFixture();
  await monitor.actions.test_metrics(gladys, { config: normalizeConfig() });

  assert.deepEqual(publishedByFeature(gladys, monitor), {
    [FEATURE.CPU]: 12.3,
    [FEATURE.MEMORY]: 48.6,
    [FEATURE.DISK]: 61.2,
    [FEATURE.DISK_FREE]: 42.5,
    [FEATURE.TEMPERATURE]: 47.8,
  });
});

test('a second refresh with barely moved values publishes nothing', async () => {
  const { monitor, gladys } = createFixture({
    readings: [
      snapshot(),
      snapshot({ cpuPercent: 13.1, memoryPercent: 49.4, diskPercent: 61.5, temperature: 48.2 }),
    ],
  });
  const config = normalizeConfig();

  await monitor.actions.test_metrics(gladys, { config });
  const afterFirst = gladys.published.length;
  await monitor.actions.test_metrics(gladys, { config });

  assert.equal(gladys.published.length, afterFirst, 'nothing crossed the deadband');
});

test('only the metric that really moved is published', async () => {
  const { monitor, gladys } = createFixture({
    readings: [snapshot(), snapshot({ cpuPercent: 80 })],
  });
  const config = normalizeConfig();

  await monitor.actions.test_metrics(gladys, { config });
  gladys.published.length = 0;
  await monitor.actions.test_metrics(gladys, { config });

  assert.deepEqual(publishedByFeature(gladys, monitor), { [FEATURE.CPU]: 80 });
});

test('the free-space deadband is relative to the size of the filesystem', async () => {
  // 2% of a 100 GiB filesystem is 2 GiB: a 1 GiB move is held back, 3 GiB is not.
  const { monitor, gladys } = createFixture({
    readings: [snapshot(), snapshot({ diskFreeGib: 41.5 }), snapshot({ diskFreeGib: 39.5 })],
  });
  const config = normalizeConfig();

  await monitor.actions.test_metrics(gladys, { config });
  gladys.published.length = 0;

  await monitor.actions.test_metrics(gladys, { config });
  assert.equal(gladys.published.length, 0, '1 GiB is under the 2 GiB deadband');

  await monitor.actions.test_metrics(gladys, { config });
  assert.deepEqual(publishedByFeature(gladys, monitor), { [FEATURE.DISK_FREE]: 39.5 });
});

test('a flat metric is still published once per maximum interval', async () => {
  const { monitor, gladys, advance } = createFixture({ readings: [snapshot()] });
  const config = normalizeConfig({ max_interval_minutes: 60 });

  await monitor.actions.test_metrics(gladys, { config });
  gladys.published.length = 0;

  advance(59 * 60 * 1000);
  await monitor.actions.test_metrics(gladys, { config });
  assert.equal(gladys.published.length, 0);

  advance(2 * 60 * 1000);
  await monitor.actions.test_metrics(gladys, { config });
  assert.equal(gladys.published.length, 5, 'the heartbeat republishes every feature');
});

test('an unavailable metric publishes nothing rather than a zero', async () => {
  const { monitor, gladys } = createFixture({
    readings: [snapshot({ temperature: null, diskPercent: null, diskFreeGib: null })],
    sensorPath: null,
  });
  await monitor.actions.test_metrics(gladys, { config: normalizeConfig() });

  assert.deepEqual(publishedByFeature(gladys, monitor), {
    [FEATURE.CPU]: 12.3,
    [FEATURE.MEMORY]: 48.6,
  });
});

test('startPush reads immediately, then on every interval, and stops on cleanup', async () => {
  const { monitor, gladys, state } = createFixture();
  const timers = [];
  const monitorWithTimers = createHostMonitor({
    collector: {
      async read() {
        state.reads += 1;
        return snapshot();
      },
      reset() {},
    },
    resolveSensor: () => '/sys/fake/temp',
    setIntervalFn: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length - 1;
    },
    clearIntervalFn: (id) => {
      timers[id] = null;
    },
  });

  const stop = monitorWithTimers.startPush(gladys, normalizeConfig({ refresh_interval: 600 }));
  // Let the immediate first run settle.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(state.reads, 1, 'a snapshot is published right away, not one interval later');
  assert.equal(timers[0].ms, 600 * 1000, 'the interval comes from the configuration');

  stop();
  assert.equal(timers[0], null, 'the cleanup stops the loop');
  assert.equal(monitor.key, 'host');
});

test('list_temperature_sensors marks the sensor actually in use', async () => {
  const { monitor, gladys } = createFixture({
    sensorPath: '/hwmon/hwmon1/temp1_input',
    sensors: [
      { path: '/hwmon/hwmon1/temp1_input', name: 'coretemp', celsius: 55 },
      { path: '/thermal/thermal_zone0/temp', name: 'acpitz', celsius: 30 },
    ],
  });
  const message = await monitor.actions.list_temperature_sensors(gladys, {
    config: normalizeConfig(),
  });
  assert.match(message.fr, /> coretemp \(\/hwmon\/hwmon1\/temp1_input\): 55°C/);
  assert.match(message.fr, /^ {2}acpitz/m);
});

test('list_temperature_sensors explains an empty result instead of failing', async () => {
  const { monitor, gladys } = createFixture({ sensors: [], sensorPath: null });
  const message = await monitor.actions.list_temperature_sensors(gladys, {
    config: normalizeConfig(),
  });
  assert.match(message.en, /No readable temperature sensor/);
  assert.ok(message.fr.length > 0);
});

// --- Outdated devices --------------------------------------------------------
// The Gladys core never updates the features of a device the user already
// created: publishing a device again only refreshes the Discovery entry (and
// the device params). A device created by an older version therefore keeps
// feature external_ids we no longer publish, and every state we send for the
// new ones is dropped silently — the "no recent value" badge in the UI.

/**
 * Build the device the user would have created, from the devices we publish.
 * @param {object} gladys - The fake SDK.
 * @param {{drop?: number}} options - How many published features to leave out.
 * @returns {object} A device in the shape gladys.getDevices() returns.
 */
function createdDevice(gladys, { drop = 0 } = {}) {
  const [published] = buildDiscoveredDevices(gladys, normalizeConfig());
  return {
    name: published.name,
    external_id: published.external_id,
    features: published.features
      .slice(0, published.features.length - drop)
      .map(({ name, external_id: externalId }) => ({ name, external_id: externalId })),
  };
}

test('a device the user has not created yet is not reported as outdated', () => {
  const gladys = createFakeGladys();
  assert.deepEqual(findOutdatedDevices(gladys, [], normalizeConfig()), []);
});

test('a device carrying every published feature is not reported as outdated', () => {
  const gladys = createFakeGladys();
  const devices = [createdDevice(gladys)];
  assert.deepEqual(findOutdatedDevices(gladys, devices, normalizeConfig()), []);
});

test('a device missing a published feature is reported, with the missing ids', () => {
  const gladys = createFakeGladys();
  const [published] = buildDiscoveredDevices(gladys, normalizeConfig());
  const lastFeature = published.features[published.features.length - 1];

  const outdated = findOutdatedDevices(
    gladys,
    [createdDevice(gladys, { drop: 1 })],
    normalizeConfig(),
  );

  assert.equal(outdated.length, 1);
  assert.equal(outdated[0].deviceExternalId, published.external_id);
  assert.deepEqual(outdated[0].missingFeatures, [lastFeature.external_id]);
});

test('a device created under another external_id is left alone', () => {
  // Another integration, or a device of ours the user renamed at the Docker
  // level: not ours to judge.
  const gladys = createFakeGladys();
  const foreign = { name: 'Autre', external_id: 'ext:other:thing:1', features: [] };
  assert.deepEqual(findOutdatedDevices(gladys, [foreign], normalizeConfig()), []);
});

test('a device whose features are missing from the payload is reported', () => {
  // Defensive: the core always returns a features array, but a device with none
  // is exactly the case where every state we publish would be lost.
  const gladys = createFakeGladys();
  const [published] = buildDiscoveredDevices(gladys, normalizeConfig());
  const outdated = findOutdatedDevices(
    gladys,
    [{ name: published.name, external_id: published.external_id }],
    normalizeConfig(),
  );
  assert.equal(outdated.length, 1);
  assert.equal(outdated[0].missingFeatures.length, published.features.length);
});

// --- A device created after the refresh loop started -------------------------
// The loop publishes from the moment we are connected, so it sends states for
// feature external_ids that do not exist yet: Gladys drops them, but the
// throttle records them as published. Without a reset when the user finally
// creates the device, every metric looks "already sent and unchanged" and the
// new device shows nothing until a deadband is crossed or the heartbeat fires.

test('refreshNow republishes every metric, even when nothing moved', async () => {
  const { monitor, gladys } = createFixture({ readings: [snapshot()] });
  const config = normalizeConfig();

  // The states published while the device did not exist yet: Gladys dropped
  // these, but the throttle believes they landed.
  await monitor.actions.test_metrics(gladys, { config });
  gladys.published.length = 0;

  // A plain refresh holds everything back — this is the bug being fixed.
  await monitor.actions.test_metrics(gladys, { config });
  assert.equal(gladys.published.length, 0, 'the throttle holds back the unchanged snapshot');

  // The user creates the device: the full snapshot must go out immediately.
  await monitor.refreshNow(gladys, config);
  assert.deepEqual(publishedByFeature(gladys, monitor), {
    [FEATURE.CPU]: 12.3,
    [FEATURE.MEMORY]: 48.6,
    [FEATURE.DISK]: 61.2,
    [FEATURE.DISK_FREE]: 42.5,
    [FEATURE.TEMPERATURE]: 47.8,
  });
});

test('the device Gladys reports as created is routed to its blueprint', async () => {
  // Goes through the real registry, so it reads the machine running the tests:
  // which metrics are available depends on the host (no /data, no thermal zone
  // in CI), hence the assertion on "something was published", not on the five.
  const gladys = createFakeGladys();
  const [device] = buildDiscoveredDevices(gladys, normalizeConfig());
  assert.equal(await refreshDeviceNow(gladys, device, normalizeConfig()), true);
  assert.ok(gladys.published.length > 0, 'the freshly created device gets a snapshot');
});

test('a device belonging to another integration is left alone', async () => {
  const gladys = createFakeGladys();
  const handled = await refreshDeviceNow(
    gladys,
    { external_id: 'ext:other:thing:1' },
    normalizeConfig(),
  );
  assert.equal(handled, false);
  assert.equal(gladys.published.length, 0);
});

test('the throttle keeps a batch Gladys refused, so the next refresh retries it', async () => {
  const { monitor, gladys } = createFixture({ readings: [snapshot()] });
  const config = normalizeConfig();
  const accepted = gladys.publishStates;

  gladys.publishStates = async () => {
    throw new Error('Gladys is restarting');
  };
  await assert.rejects(() => monitor.actions.test_metrics(gladys, { config }));
  assert.equal(gladys.published.length, 0, 'nothing reached Gladys');

  // Same unchanged values: because nothing was committed, they are still due.
  gladys.publishStates = accepted;
  await monitor.actions.test_metrics(gladys, { config });
  assert.equal(gladys.published.length, 5, 'the refused snapshot is published again');
});
