// -----------------------------------------------------------------------------
// Gladys 5.1 capabilities of the host blueprint: the `threshold_alert` scene
// trigger, the `read_metrics` scene action and the `host_health` widget.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import {
  FEATURE,
  SCENE_TRIGGER,
  WIDGET,
  WIDGET_ACTION,
  buildAlertEventData,
} from '../src/devices/hostMonitor.js';
import { normalizeConfig } from '../src/config.js';
import { createFixture, snapshot } from './helpers/hostFixture.js';

/**
 * Pretend the user created the host device, with the features it publishes.
 * @param {object} fixture - A host fixture.
 * @param {object} config - Normalized configuration.
 * @returns {void}
 */
function createDevice({ monitor, gladys }, config) {
  gladys.devices = [monitor.buildDevice(gladys, config)];
}

/**
 * Pull the widget content, as the core does.
 * @param {object} fixture - A host fixture.
 * @param {object} config - Normalized configuration.
 * @param {object} request - The widget.get payload (settings, units).
 * @returns {Promise<object>} The content.
 */
function getWidget({ monitor, gladys }, config, request = {}) {
  return monitor.widgets[WIDGET.HOST_HEALTH].get(gladys, { settings: {}, ...request, config });
}

// --- Scene trigger -----------------------------------------------------------

test('a metric reaching its threshold fires the scene trigger once', async () => {
  const fixture = createFixture({
    readings: [snapshot({ diskPercent: 91.04 }), snapshot({ diskPercent: 92 })],
  });
  const config = normalizeConfig({ device_name: 'NAS' });

  await fixture.monitor.actions.test_metrics(fixture.gladys, { config });
  await fixture.monitor.actions.test_metrics(fixture.gladys, { config });

  assert.deepEqual(fixture.gladys.sceneEvents, [
    {
      key: SCENE_TRIGGER.THRESHOLD_ALERT,
      data: {
        metric: 'disk',
        status: 'raised',
        value: 91,
        threshold: 90,
        unit: '%',
        metric_label: 'Utilisation disque',
        device_name: 'NAS',
        message: 'NAS : Utilisation disque à 91 % (seuil 90 %)',
      },
    },
  ]);
});

test('the alert clears once the metric comes back under the margin', async () => {
  const fixture = createFixture({
    readings: [snapshot({ temperature: 85 }), snapshot({ temperature: 76.5 })],
  });
  const config = normalizeConfig();

  await fixture.monitor.actions.test_metrics(fixture.gladys, { config });
  await fixture.monitor.actions.test_metrics(fixture.gladys, { config });

  assert.deepEqual(
    fixture.gladys.sceneEvents.map(({ data }) => [data.metric, data.status, data.value]),
    [
      ['temperature', 'raised', 85],
      ['temperature', 'cleared', 76.5],
    ],
  );
});

test('an event Gladys refused is fired again at the next refresh', async () => {
  const fixture = createFixture({ readings: [snapshot({ cpuPercent: 97 })] });
  const config = normalizeConfig();
  const accepted = fixture.gladys.publishSceneEvent;

  fixture.gladys.publishSceneEvent = async () => {
    throw new Error('Gladys is restarting');
  };
  // The failure never reaches the caller: the states still go out.
  await fixture.monitor.actions.test_metrics(fixture.gladys, { config });
  assert.equal(fixture.gladys.published.length, 5);

  fixture.gladys.publishSceneEvent = accepted;
  await fixture.monitor.actions.test_metrics(fixture.gladys, { config });
  assert.deepEqual(
    fixture.gladys.sceneEvents.map(({ data }) => [data.metric, data.status]),
    [['cpu', 'raised']],
  );
});

test('the alerts ignore the throttle: a held-back state still raises its alert', async () => {
  // 89 -> 90 is under the 2-point deadband, so no state is published, but the
  // threshold was crossed and the scene must run.
  const fixture = createFixture({
    readings: [snapshot({ memoryPercent: 89 }), snapshot({ memoryPercent: 90 })],
  });
  const config = normalizeConfig();

  await fixture.monitor.actions.test_metrics(fixture.gladys, { config });
  fixture.gladys.published.length = 0;
  await fixture.monitor.actions.test_metrics(fixture.gladys, { config });

  assert.equal(fixture.gladys.published.length, 0, 'the throttle held the state back');
  assert.deepEqual(
    fixture.gladys.sceneEvents.map(({ data }) => data.metric),
    ['memory'],
  );
});

test('a disabled threshold fires nothing', async () => {
  const fixture = createFixture({ readings: [snapshot({ cpuPercent: 100 })] });
  await fixture.monitor.actions.test_metrics(fixture.gladys, {
    config: normalizeConfig({ alert_cpu_percent: 0 }),
  });
  assert.deepEqual(fixture.gladys.sceneEvents, []);
});

test('the cleared message says the metric came back', () => {
  const data = buildAlertEventData(
    { metric: 'cpu', status: 'cleared', value: 40, threshold: 90 },
    normalizeConfig(),
  );
  assert.equal(data.message, 'Machine hôte : Utilisation CPU revenue à 40 % (seuil 90 %)');
});

// --- Scene action ------------------------------------------------------------

test('read_metrics returns the readings as outputs, through the throttle', async () => {
  const fixture = createFixture();
  const config = normalizeConfig();

  const outputs = await fixture.monitor.sceneActions.read_metrics(fixture.gladys, {
    fields: {},
    config,
  });
  assert.deepEqual(outputs, {
    cpu_percent: 12.3,
    memory_percent: 48.6,
    disk_percent: 61.2,
    disk_free_gib: 42.5,
    temperature: 47.8,
    summary: 'CPU 12.3 %, mémoire 48.6 %, disque 61.2 % (42.5 Gio libres), température 47.8 °C',
  });

  // A scene running this every minute must not write a row per metric each time.
  fixture.gladys.published.length = 0;
  await fixture.monitor.sceneActions.read_metrics(fixture.gladys, { fields: {}, config });
  assert.equal(fixture.gladys.published.length, 0);
});

test('read_metrics reports an unavailable metric as null, never as 0', async () => {
  const fixture = createFixture({ readings: [snapshot({ temperature: null })] });
  const outputs = await fixture.monitor.sceneActions.read_metrics(fixture.gladys, {
    fields: {},
    config: normalizeConfig(),
  });
  assert.equal(outputs.temperature, null);
  assert.match(outputs.summary, /température n\/a/);
});

// --- Widget ------------------------------------------------------------------

test('the widget waits for the first reading', async () => {
  const fixture = createFixture();
  const content = await getWidget(fixture, normalizeConfig());
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(content.components[0].type, 'text');
  assert.equal(content.components.at(-1).action.key, WIDGET_ACTION.REFRESH);
});

test('before the device exists, the widget shows the last reading inline', async () => {
  const fixture = createFixture();
  const config = normalizeConfig();
  await fixture.monitor.actions.test_metrics(fixture.gladys, { config });

  const content = await getWidget(fixture, config);
  assert.deepEqual(validateWidgetContent(content), []);
  assert.deepEqual(
    content.components.filter((c) => c.type === 'gauge').map((c) => c.value),
    [12.3, 48.6, 61.2],
  );
  assert.ok(
    content.components.every((c) => c.device_feature === undefined && c.type !== 'chart'),
    'nothing to bind to, no history to plot',
  );
  assert.equal(content.ttl_seconds, config.refresh_interval);
});

test('once the device exists, the tiles and the chart are bound to its features', async () => {
  const fixture = createFixture();
  const config = normalizeConfig();
  createDevice(fixture, config);
  await fixture.monitor.actions.test_metrics(fixture.gladys, { config });

  const content = await getWidget(fixture, config, { settings: { chart_interval: 'last-week' } });
  assert.deepEqual(validateWidgetContent(content), []);

  const deviceId = fixture.monitor.deviceExternalId(fixture.gladys);
  const bound = content.components
    .filter((c) => c.type === 'gauge' || c.type === 'value')
    .map((c) => c.device_feature.replace(`${deviceId}:`, ''));
  assert.deepEqual(bound, [
    FEATURE.CPU,
    FEATURE.MEMORY,
    FEATURE.DISK,
    FEATURE.TEMPERATURE,
    FEATURE.DISK_FREE,
  ]);

  const chart = content.components.find((c) => c.type === 'chart');
  assert.equal(chart.interval, 'last-week');
  assert.equal(chart.device_features.length, 3);
});

test('no chart without history, nor when the setting hides it', async () => {
  const config = normalizeConfig({ keep_history: false });
  const fixture = createFixture();
  createDevice(fixture, config);
  await fixture.monitor.actions.test_metrics(fixture.gladys, { config });
  const withoutHistory = await getWidget(fixture, config);
  assert.ok(!withoutHistory.components.some((c) => c.type === 'chart'));

  const other = createFixture();
  createDevice(other, normalizeConfig());
  await other.monitor.actions.test_metrics(other.gladys, { config: normalizeConfig() });
  const hidden = await getWidget(other, normalizeConfig(), {
    settings: { chart_interval: 'none' },
  });
  assert.ok(!hidden.components.some((c) => c.type === 'chart'));
});

test('an active alert turns its tile and its status row red', async () => {
  const fixture = createFixture({ readings: [snapshot({ diskPercent: 95 })] });
  const config = normalizeConfig();
  await fixture.monitor.actions.test_metrics(fixture.gladys, { config });

  const content = await getWidget(fixture, config);
  assert.deepEqual(validateWidgetContent(content), []);
  const diskGauge = content.components.find((c) => c.type === 'gauge' && c.value === 95);
  assert.equal(diskGauge.color, 'danger');
  const cpuGauge = content.components.find((c) => c.type === 'gauge' && c.value === 12.3);
  assert.equal(cpuGauge.color, undefined, 'the others keep the neutral styling');

  const rows = content.components.find((c) => c.type === 'status').items;
  assert.deepEqual(
    rows.map((row) => row.color),
    ['success', 'success', 'danger', 'success'],
  );
});

test('a us user sees the inline temperature in Fahrenheit', async () => {
  const fixture = createFixture({ readings: [snapshot({ temperature: 50 })] });
  const config = normalizeConfig();
  await fixture.monitor.actions.test_metrics(fixture.gladys, { config });

  const content = await getWidget(fixture, config, { units: 'us' });
  const temperature = content.components.find((c) => c.icon === 'thermometer');
  assert.equal(temperature.value, 122);
  assert.equal(temperature.unit, '°F');
});

test('each refresh nudges the widget, and its button reads the metrics', async () => {
  const fixture = createFixture();
  const config = normalizeConfig();
  const widget = fixture.monitor.widgets[WIDGET.HOST_HEALTH];

  const message = await widget.action(fixture.gladys, WIDGET_ACTION.REFRESH, {}, { config });
  assert.match(message.fr, /5 état\(s\) publié\(s\)/);
  assert.deepEqual(fixture.gladys.widgetRefreshes, [WIDGET.HOST_HEALTH]);

  await assert.rejects(() => widget.action(fixture.gladys, 'unknown', {}, { config }));
});
