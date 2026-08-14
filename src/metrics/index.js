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
import { resolveTemperatureSensor, readTemperature } from './temperature.js';

const logger = createLogger({ name: 'metrics' });

/**
 * Run a metric reader, turning a failure into `null` and a log line.
 * @param {string} name - Metric name, for the log line.
 * @param {Function} read - Async reader.
 * @returns {Promise<*>} The reading, or null when it failed.
 */
async function safely(name, read) {
  try {
    return await read();
  } catch (err) {
    logger.warn(`Cannot read the ${name} metric: ${err.message}`);
    return null;
  }
}

/**
 * Build a stateful metrics collector (the CPU reader keeps the previous
 * /proc/stat snapshot between two reads).
 * @param {{cpuReader?: object, readMemoryFn?: Function, readDiskFn?: Function, readTemperatureFn?: Function, resolveTemperatureSensorFn?: Function}} options - Injectable dependencies, for tests.
 * @returns {{read: (config: object) => Promise<object>, reset: () => void}} The collector.
 */
export function createMetricsCollector({
  cpuReader = createCpuReader(),
  readMemoryFn = readMemory,
  readDiskFn = readDisk,
  readTemperatureFn = readTemperature,
  resolveTemperatureSensorFn = resolveTemperatureSensor,
} = {}) {
  return {
    /**
     * Read every metric of the host.
     * @param {object} config - Normalized integration configuration.
     * @returns {Promise<{cpuPercent: number|null, memoryPercent: number|null, memoryTotalBytes: number|null, diskPercent: number|null, diskFreeGib: number|null, diskTotalBytes: number|null, temperature: number|null}>} The snapshot.
     */
    async read(config) {
      const [cpuPercent, memory, disk, temperature] = await Promise.all([
        safely('CPU', () => cpuReader.read()),
        safely('memory', () => readMemoryFn()),
        safely('disk', () => readDiskFn(config.disk_path)),
        safely('temperature', () => readTemperatureFn(resolveTemperatureSensorFn(config))),
      ]);

      return {
        cpuPercent,
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
