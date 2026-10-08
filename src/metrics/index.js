// -----------------------------------------------------------------------------
// Metrics collector: one call, one snapshot of the host.
//
// Each metric lives in its own file (cpu.js, memory.js, disk.js,
// temperature.js) and knows nothing about Gladys. This module assembles them
// into the single reading the device blueprint publishes, and — importantly —
// makes an unavailable metric a `null` rather than a thrown error: a machine
// with no thermal sensor, or a disk path that was unmounted, must not stop the
// CPU and memory readings from being published.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { createCpuReader } from './cpu.js';
import { readMemory } from './memory.js';
import { readDisk, BYTES_PER_GIB } from './disk.js';
import { createTemperatureSensorResolver, readTemperature } from './temperature.js';

const logger = createLogger({ name: 'metrics' });

// Longest a single metric may take before it is reported unavailable for this
// refresh. statfs(2) on a hung NFS/CIFS mount never returns; without a bound
// the whole refresh never settled, the in-flight guard of the device was never
// released, and CPU and memory stopped being published along with the disk —
// test_metrics and read_metrics waited forever behind it.
export const METRIC_TIMEOUT_MS = 5000;

/**
 * Build the guarded runner of the metric readers: a failure or a timeout
 * becomes `null` and a log line.
 *
 * A timed-out read is NOT started again while it is still pending: a statfs
 * stuck in the kernel keeps its libuv thread-pool slot forever, and starting
 * one more per refresh would exhaust the pool (four threads) and freeze every
 * other file read of the process, /proc/stat included. The next refresh waits
 * on the same pending read instead — bounded by the same timeout.
 * @param {{timeoutMs?: number}} options - Injectable timeout, for tests.
 * @returns {(name: string, read: Function) => Promise<*>} The runner.
 */
function createSafeRunner({ timeoutMs = METRIC_TIMEOUT_MS } = {}) {
  /** @type {Map<string, Promise<*>>} */
  const pending = new Map();

  return async function safely(name, read) {
    let running = pending.get(name);
    if (running === undefined) {
      running = Promise.resolve().then(read);
      pending.set(name, running);
      running
        .finally(() => {
          pending.delete(name);
        })
        .catch(() => {});
    }
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer after ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      return await Promise.race([running, timeout]);
    } catch (err) {
      logger.warn(`Cannot read the ${name} metric: ${err.message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Build a stateful metrics collector (the CPU reader keeps the previous
 * /proc/stat snapshot between two reads, the sensor resolver the sensor in use).
 * @param {{cpuReader?: object, readMemoryFn?: Function, readDiskFn?: Function, readTemperatureFn?: Function, sensorResolver?: object, timeoutMs?: number}} options - Injectable dependencies, for tests.
 * @returns {{read: (config: object) => Promise<object>, reset: () => void}} The collector.
 */
export function createMetricsCollector({
  cpuReader = createCpuReader(),
  readMemoryFn = readMemory,
  readDiskFn = readDisk,
  readTemperatureFn = readTemperature,
  sensorResolver = createTemperatureSensorResolver(),
  timeoutMs = METRIC_TIMEOUT_MS,
} = {}) {
  const safely = createSafeRunner({ timeoutMs });

  /**
   * Read the remembered sensor and tell the resolver how it went.
   * @param {object} config - Normalized integration configuration.
   * @returns {Promise<number|null>} Temperature in Celsius, or null.
   */
  async function readSensor(config) {
    const path = sensorResolver.resolve(config);
    const celsius = await readTemperatureFn(path);
    sensorResolver.recordReading(path, celsius);
    return celsius;
  }

  return {
    /**
     * Read every metric of the host.
     * @param {object} config - Normalized integration configuration.
     * @returns {Promise<{cpuPercent: number|null, cpuWindowMs: number|null, memoryPercent: number|null, memoryTotalBytes: number|null, diskPercent: number|null, diskFreeGib: number|null, diskTotalBytes: number|null, temperature: number|null}>} The snapshot.
     */
    async read(config) {
      const [cpuPercent, memory, disk, temperature] = await Promise.all([
        safely('CPU', () => cpuReader.read()),
        safely('memory', () => readMemoryFn()),
        safely('disk', () => readDiskFn(config.disk_path)),
        safely('temperature', () => readSensor(config)),
      ]);

      return {
        cpuPercent,
        // How long the CPU usage was averaged over (null when unknown).
        cpuWindowMs: cpuPercent === null ? null : (cpuReader.lastWindowMs?.() ?? null),
        memoryPercent: memory?.usedPercent ?? null,
        memoryTotalBytes: memory?.totalBytes ?? null,
        diskPercent: disk?.usedPercent ?? null,
        diskFreeGib: disk === null ? null : disk.freeBytes / BYTES_PER_GIB,
        diskTotalBytes: disk?.totalBytes ?? null,
        temperature,
      };
    },

    reset() {
      cpuReader.reset();
    },
  };
}
