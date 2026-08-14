import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCpuTimes, computeUsage, createCpuReader } from '../src/metrics/cpu.js';
import { parseMemInfo, computeMemoryUsage } from '../src/metrics/memory.js';
import { computeDiskUsage } from '../src/metrics/disk.js';
import {
  parseTemperature,
  listTemperatureSensors,
  resolveTemperatureSensor,
} from '../src/metrics/temperature.js';

// --- CPU ---------------------------------------------------------------------

const PROC_STAT = `cpu  100 20 30 800 40 5 5 0 0 0
cpu0 50 10 15 400 20 2 2 0 0 0
intr 123456
ctxt 987654
`;

test('parseCpuTimes sums the aggregated cpu line, counting iowait as idle', () => {
  const times = parseCpuTimes(PROC_STAT);
  assert.equal(times.idle, 840); // idle 800 + iowait 40
  assert.equal(times.total, 1000); // 100+20+30+800+40+5+5
});

test('parseCpuTimes returns null when the aggregated line is missing or broken', () => {
  assert.equal(parseCpuTimes('cpu0 1 2 3 4\n'), null);
  assert.equal(parseCpuTimes('cpu  1 2\n'), null);
  assert.equal(parseCpuTimes(''), null);
});

test('computeUsage returns the busy ratio between two snapshots', () => {
  const usage = computeUsage({ idle: 800, total: 1000 }, { idle: 900, total: 1200 });
  // 200 jiffies elapsed, 100 of them idle -> 50% busy.
  assert.equal(usage, 50);
});

test('computeUsage refuses a non-positive delta (counter reset, resume from suspend)', () => {
  assert.equal(computeUsage({ idle: 800, total: 1000 }, { idle: 800, total: 1000 }), null);
  assert.equal(computeUsage({ idle: 800, total: 1000 }, { idle: 10, total: 20 }), null);
  assert.equal(computeUsage(null, { idle: 1, total: 2 }), null);
});

test('the first read samples a short window, later reads compare with the previous read', async () => {
  const samples = [
    'cpu  100 0 0 900 0 0 0 0\n', // first read
    'cpu  150 0 0 950 0 0 0 0\n', // end of the first sampling window
    'cpu  350 0 0 1150 0 0 0 0\n', // next refresh
  ];
  let index = 0;
  let slept = 0;
  const reader = createCpuReader({
    readFileFn: async () => samples[index++],
    sleep: async (ms) => {
      slept += ms;
    },
    firstReadWindowMs: 1000,
  });

  // Window: 100 jiffies elapsed, 50 idle -> 50%.
  assert.equal(await reader.read(), 50);
  assert.equal(slept, 1000, 'the first read must sample a window');

  // Since the end of that window: 400 elapsed, 200 idle -> 50%, no extra sleep.
  assert.equal(await reader.read(), 50);
  assert.equal(slept, 1000, 'later reads must not sleep');
});

// --- Memory ------------------------------------------------------------------

const PROC_MEMINFO = `MemTotal:        1024 kB
MemFree:          128 kB
MemAvailable:     512 kB
Buffers:           64 kB
Cached:           192 kB
`;

test('parseMemInfo converts the kB column to bytes', () => {
  const values = parseMemInfo(PROC_MEMINFO);
  assert.equal(values.get('MemTotal'), 1024 * 1024);
  assert.equal(values.get('MemAvailable'), 512 * 1024);
});

test('computeMemoryUsage uses MemAvailable, not MemFree', () => {
  const memory = computeMemoryUsage(parseMemInfo(PROC_MEMINFO));
  assert.equal(memory.totalBytes, 1024 * 1024);
  assert.equal(memory.usedPercent, 50); // 512 of 1024 kB available
});

test('computeMemoryUsage falls back to free + buffers + cache on old kernels', () => {
  const withoutAvailable = PROC_MEMINFO.split('\n')
    .filter((line) => !line.startsWith('MemAvailable'))
    .join('\n');
  const memory = computeMemoryUsage(parseMemInfo(withoutAvailable));
  // 128 + 64 + 192 = 384 kB reclaimable out of 1024.
  assert.equal(Math.round(memory.usedPercent), 63);
});

test('computeMemoryUsage returns null without a usable MemTotal', () => {
  assert.equal(computeMemoryUsage(parseMemInfo('MemFree: 128 kB\n')), null);
});

// --- Disk --------------------------------------------------------------------

test('computeDiskUsage matches df: root-reserved blocks are excluded', () => {
  // 1000 blocks of 1 KiB: 200 used, 750 available to a user, 50 reserved.
  const disk = computeDiskUsage({ bsize: 1024, blocks: 1000, bfree: 800, bavail: 750 });
  assert.equal(disk.totalBytes, 1000 * 1024);
  assert.equal(disk.freeBytes, 750 * 1024);
  // 200 / (200 + 750) = 21.05%, exactly what `df` prints.
  assert.equal(Math.round(disk.usedPercent * 100) / 100, 21.05);
});

test('computeDiskUsage returns null on unusable statfs output', () => {
  assert.equal(computeDiskUsage(null), null);
  assert.equal(computeDiskUsage({ bsize: 1024, blocks: 0, bfree: 0, bavail: 0 }), null);
});

// --- Temperature -------------------------------------------------------------

test('parseTemperature converts millidegrees and rejects implausible readings', () => {
  assert.equal(parseTemperature('47800\n'), 47.8);
  assert.equal(parseTemperature('42'), 42); // a driver publishing plain degrees
  assert.equal(parseTemperature('999000'), null); // 999 °C: not a temperature
  assert.equal(parseTemperature(''), null);
  assert.equal(parseTemperature(null), null);
});

/**
 * Build a fake sysfs tree for the sensor detection tests.
 * @param {Record<string, string|string[]>} tree - Files (string) and directories (array of names).
 * @returns {{readdirSyncFn: Function, readFileSyncFn: Function}} Injectable fs functions.
 */
function fakeSysfs(tree) {
  return {
    readdirSyncFn: (path) => {
      const entry = tree[path];
      if (!Array.isArray(entry)) {
        throw new Error(`ENOENT: ${path}`);
      }
      return entry;
    },
    readFileSyncFn: (path) => {
      const entry = tree[path];
      if (typeof entry !== 'string') {
        throw new Error(`ENOENT: ${path}`);
      }
      return entry;
    },
  };
}

const SYSFS = fakeSysfs({
  '/thermal': ['thermal_zone0', 'thermal_zone1', 'cooling_device0'],
  '/thermal/thermal_zone0/type': 'acpitz',
  '/thermal/thermal_zone0/temp': '30000',
  '/thermal/thermal_zone1/type': 'x86_pkg_temp',
  '/thermal/thermal_zone1/temp': '52000',
  '/hwmon': ['hwmon0', 'hwmon1'],
  '/hwmon/hwmon0': ['name', 'temp1_input'],
  '/hwmon/hwmon0/name': 'nvme',
  '/hwmon/hwmon0/temp1_input': '38000',
  '/hwmon/hwmon1': ['name', 'temp1_input', 'temp1_label', 'fan1_input'],
  '/hwmon/hwmon1/name': 'coretemp',
  '/hwmon/hwmon1/temp1_input': '55000',
  '/hwmon/hwmon1/temp1_label': 'Package id 0',
});

const SYSFS_OPTIONS = { ...SYSFS, thermalDir: '/thermal', hwmonDir: '/hwmon' };

test('listTemperatureSensors enumerates thermal zones and hwmon inputs, best first', () => {
  const sensors = listTemperatureSensors(SYSFS_OPTIONS);
  assert.deepEqual(
    sensors.map((sensor) => sensor.path),
    [
      '/hwmon/hwmon1/temp1_input', // coretemp: the CPU package
      '/thermal/thermal_zone1/temp', // x86_pkg_temp
      '/hwmon/hwmon0/temp1_input', // nvme: usable but not a CPU
      '/thermal/thermal_zone0/temp', // acpitz
    ],
  );
  assert.equal(sensors[0].name, 'coretemp Package id 0');
  assert.equal(sensors[0].celsius, 55);
});

test('listTemperatureSensors survives a machine with no sysfs thermal support', () => {
  assert.deepEqual(
    listTemperatureSensors({ ...fakeSysfs({}), thermalDir: '/x', hwmonDir: '/y' }),
    [],
  );
});

test('resolveTemperatureSensor auto-detects the CPU sensor', () => {
  assert.equal(resolveTemperatureSensor({}, SYSFS_OPTIONS), '/hwmon/hwmon1/temp1_input');
});

test('a configured sensor path always wins over auto-detection', () => {
  assert.equal(
    resolveTemperatureSensor(
      { temperature_sensor_path: '/thermal/thermal_zone0/temp' },
      SYSFS_OPTIONS,
    ),
    '/thermal/thermal_zone0/temp',
  );
});

test('resolveTemperatureSensor returns null when the machine exposes no sensor', () => {
  assert.equal(
    resolveTemperatureSensor({}, { ...fakeSysfs({}), thermalDir: '/x', hwmonDir: '/y' }),
    null,
  );
});
