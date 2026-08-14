import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, DEFAULT_CONFIG } from '../src/config.js';

test('normalizeConfig returns the defaults when called with no argument', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
});

test('normalizeConfig keeps user values over the defaults', () => {
  const config = normalizeConfig({
    device_name: 'Raspberry Pi',
    disk_path: '/mnt/data',
    refresh_interval: 900,
  });
  assert.equal(config.device_name, 'Raspberry Pi');
  assert.equal(config.disk_path, '/mnt/data');
  assert.equal(config.refresh_interval, 900);
});

test('normalizeConfig coerces numeric strings coming from a form', () => {
  const config = normalizeConfig({ refresh_interval: '600', min_variation: '5' });
  assert.equal(config.refresh_interval, 600);
  assert.equal(config.min_variation, 5);
  assert.equal(typeof config.refresh_interval, 'number');
});

test('normalizeConfig falls back to the default for an empty or unparsable number', () => {
  assert.equal(normalizeConfig({ refresh_interval: '' }).refresh_interval, 300);
  assert.equal(normalizeConfig({ refresh_interval: 'soon' }).refresh_interval, 300);
  assert.equal(normalizeConfig({ min_variation: null }).min_variation, 2);
});

test('normalizeConfig clamps the refresh interval to the supported range', () => {
  // The guard that matters: nothing may make this integration write to the
  // Gladys database more than once a minute.
  assert.equal(normalizeConfig({ refresh_interval: 1 }).refresh_interval, 60);
  assert.equal(normalizeConfig({ refresh_interval: -300 }).refresh_interval, 60);
  assert.equal(normalizeConfig({ refresh_interval: 99999 }).refresh_interval, 3600);
});

test('normalizeConfig clamps the other numeric fields too', () => {
  assert.equal(normalizeConfig({ min_variation: -5 }).min_variation, 0);
  assert.equal(normalizeConfig({ min_variation: 500 }).min_variation, 50);
  assert.equal(normalizeConfig({ max_interval_minutes: 1 }).max_interval_minutes, 5);
  assert.equal(normalizeConfig({ max_interval_minutes: 99999 }).max_interval_minutes, 1440);
});

test('normalizeConfig trims strings and falls back when they are blank', () => {
  const config = normalizeConfig({ device_name: '  NAS  ', disk_path: '   ' });
  assert.equal(config.device_name, 'NAS');
  assert.equal(config.disk_path, DEFAULT_CONFIG.disk_path);
});

test('an empty temperature sensor path is kept: it means auto-detect', () => {
  assert.equal(normalizeConfig({ temperature_sensor_path: '   ' }).temperature_sensor_path, '');
  assert.equal(
    normalizeConfig({ temperature_sensor_path: ' /sys/class/thermal/thermal_zone0/temp ' })
      .temperature_sensor_path,
    '/sys/class/thermal/thermal_zone0/temp',
  );
});

test('keep_history defaults to true and only an explicit false disables it', () => {
  assert.equal(normalizeConfig().keep_history, true);
  assert.equal(normalizeConfig({ keep_history: true }).keep_history, true);
  assert.equal(normalizeConfig({ keep_history: false }).keep_history, false);
});
