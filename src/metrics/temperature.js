// -----------------------------------------------------------------------------
// Metric: CPU TEMPERATURE, read from sysfs.
//
// Docker mounts /sys read-only inside containers, so the host thermal sensors
// are readable without any privilege. There is no portable "the CPU sensor",
// though: a Raspberry Pi exposes `cpu-thermal` under /sys/class/thermal, an
// Intel box exposes `coretemp` under /sys/class/hwmon, an AMD one `k10temp`,
// and a NAS may expose a dozen zones of which only one is the CPU.
//
// So we auto-detect: enumerate every sensor, score them by name, keep the best.
// The user can override the choice with a path in the configuration, and the
// `list_temperature_sensors` action shows what is actually visible — because
// "no temperature" on an unknown board must be diagnosable, not a mystery.
//
// Detection is synchronous on purpose: buildDevice() decides whether to declare
// the temperature feature at all, and a device must not advertise a sensor that
// will never publish a value. These are a handful of tiny sysfs reads.
// -----------------------------------------------------------------------------

import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'temperature' });

export const THERMAL_ZONE_DIR = '/sys/class/thermal';
export const HWMON_DIR = '/sys/class/hwmon';

// Sensor names known to be the CPU/SoC package, best first. Anything matching
// none of these is still usable, but only if nothing better shows up.
const CPU_SENSOR_PATTERNS = [
  /^coretemp$/i, // Intel package
  /^k10temp$/i, // AMD
  /^zenpower$/i, // AMD (community driver)
  /^cpu[-_ ]?thermal$/i, // Raspberry Pi and most ARM boards
  /^x86_pkg_temp$/i, // Intel, exposed as a thermal zone
  /^soc[-_ ]?thermal$/i, // Rockchip, Allwinner…
  /cpu/i, // anything else mentioning a CPU
];

// A plausible CPU temperature, in Celsius. Outside this range the file is not
// what we think it is (some sysfs entries hold millivolts or a sentinel).
const MIN_PLAUSIBLE_CELSIUS = -40;
const MAX_PLAUSIBLE_CELSIUS = 150;

/**
 * Score a sensor name: lower is better, Infinity for "usable but unidentified".
 * @param {string} name - Sensor name or thermal zone type.
 * @returns {number} Rank used to pick the best sensor.
 */
function scoreSensorName(name) {
  const index = CPU_SENSOR_PATTERNS.findIndex((pattern) => pattern.test(name));
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

/**
 * Read a small sysfs file, returning null instead of throwing: sysfs is full of
 * entries that exist but answer EIO/EACCES depending on the driver.
 * @param {string} path - File to read.
 * @param {Function} readFileSyncFn - Injectable node:fs readFileSync.
 * @returns {string | null} Trimmed content, or null when unreadable.
 */
function readSysfsSync(path, readFileSyncFn) {
  try {
    return readFileSyncFn(path, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * List a sysfs directory, returning [] instead of throwing when it is absent
 * (a kernel with no thermal framework, a non-Linux host).
 * @param {string} path - Directory to list.
 * @param {Function} readdirSyncFn - Injectable node:fs readdirSync.
 * @returns {string[]} Entry names, empty when the directory is unavailable.
 */
function listDirSync(path, readdirSyncFn) {
  try {
    return readdirSyncFn(path);
  } catch {
    return [];
  }
}

/**
 * Convert a raw sysfs reading to Celsius.
 *
 * Thermal zones and hwmon inputs are expressed in millidegrees, but a few
 * out-of-tree drivers publish plain degrees; the magnitude tells them apart.
 * @param {string | number | null} raw - Raw file content.
 * @returns {number | null} Temperature in Celsius, or null when implausible.
 */
export function parseTemperature(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return null;
  }
  const value = Number(String(raw).trim());
  if (!Number.isFinite(value)) {
    return null;
  }
  const celsius = Math.abs(value) > 1000 ? value / 1000 : value;
  if (celsius < MIN_PLAUSIBLE_CELSIUS || celsius > MAX_PLAUSIBLE_CELSIUS) {
    return null;
  }
  return celsius;
}

/**
 * Enumerate every readable temperature sensor visible from the container.
 * @param {{readdirSyncFn?: Function, readFileSyncFn?: Function, thermalDir?: string, hwmonDir?: string}} options - Injectable dependencies, for tests.
 * @returns {{path: string, name: string, celsius: number, score: number}[]} Sensors, best candidate first.
 */
export function listTemperatureSensors({
  readdirSyncFn = readdirSync,
  readFileSyncFn = readFileSync,
  thermalDir = THERMAL_ZONE_DIR,
  hwmonDir = HWMON_DIR,
} = {}) {
  const sensors = [];

  // /sys/class/thermal/thermal_zone<N>/{type,temp}
  for (const entry of listDirSync(thermalDir, readdirSyncFn)) {
    if (!entry.startsWith('thermal_zone')) {
      continue;
    }
    const path = `${thermalDir}/${entry}/temp`;
    const celsius = parseTemperature(readSysfsSync(path, readFileSyncFn));
    if (celsius === null) {
      continue;
    }
    const name = readSysfsSync(`${thermalDir}/${entry}/type`, readFileSyncFn) ?? entry;
    sensors.push({ path, name, celsius, score: scoreSensorName(name) });
  }

  // /sys/class/hwmon/hwmon<N>/{name,temp<M>_input,temp<M>_label}
  for (const entry of listDirSync(hwmonDir, readdirSyncFn)) {
    if (!entry.startsWith('hwmon')) {
      continue;
    }
    const chip = readSysfsSync(`${hwmonDir}/${entry}/name`, readFileSyncFn) ?? entry;
    for (const file of listDirSync(`${hwmonDir}/${entry}`, readdirSyncFn)) {
      if (!/^temp\d+_input$/.test(file)) {
        continue;
      }
      const path = `${hwmonDir}/${entry}/${file}`;
      const celsius = parseTemperature(readSysfsSync(path, readFileSyncFn));
      if (celsius === null) {
        continue;
      }
      const label = readSysfsSync(path.replace(/_input$/, '_label'), readFileSyncFn);
      const name = label === null ? chip : `${chip} ${label}`;
      sensors.push({
        path,
        name,
        celsius,
        score: Math.min(scoreSensorName(chip), scoreSensorName(name)),
      });
    }
  }

  // Best score first; ties broken by path so the choice is stable across restarts.
  return sensors.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path));
}

/**
 * Resolve the sensor to read: the configured path when the user set one,
 * otherwise the best auto-detected candidate.
 * @param {{temperature_sensor_path?: string}} config - Integration configuration.
 * @param {object} options - Injectable dependencies, forwarded to listTemperatureSensors.
 * @returns {string | null} Sysfs path to read, or null when no sensor is available.
 */
export function resolveTemperatureSensor(config = {}, options = {}) {
  const configured = (config.temperature_sensor_path ?? '').trim();
  if (configured !== '') {
    // Trust the user: a path that reads today may be flaky, and silently
    // falling back to another sensor would publish a different temperature
    // under the same name.
    return configured;
  }
  const [best] = listTemperatureSensors(options);
  if (best === undefined) {
    return null;
  }
  logger.debug(`Auto-detected CPU sensor: ${best.name} (${best.path})`);
  return best.path;
}

/**
 * Read a temperature sensor.
 * @param {string | null} path - Sysfs file to read.
 * @param {{readFileFn?: Function}} options - Injectable dependencies, for tests.
 * @returns {Promise<number | null>} Temperature in Celsius, or null when unavailable.
 */
export async function readTemperature(path, { readFileFn = readFile } = {}) {
  if (path === null || path === undefined || path === '') {
    return null;
  }
  try {
    return parseTemperature(await readFileFn(path, 'utf8'));
  } catch (err) {
    logger.warn(`Cannot read the temperature sensor ${path}: ${err.message}`);
    return null;
  }
}
