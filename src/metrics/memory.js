// -----------------------------------------------------------------------------
// Metric: MEMORY USAGE, read from /proc/meminfo.
//
// Like /proc/stat, /proc/meminfo is not namespaced: a container reads the
// figures of the host.
//
// We report the usage based on MemAvailable, not on MemFree. MemFree ignores
// the page cache, so it makes every healthy Linux box look like it is out of
// memory; MemAvailable is the kernel's own estimate of what a new workload
// could actually claim. Kernels older than 3.14 do not expose it, hence the
// documented fallback.
// -----------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';

export const PROC_MEMINFO_PATH = '/proc/meminfo';

/**
 * Parse /proc/meminfo into a map of byte values.
 *
 * Lines look like `MemTotal:       16316360 kB`; the unit column is always kB
 * when present, and absent for the few counters expressed in pages.
 * @param {string} content - Raw content of /proc/meminfo.
 * @returns {Map<string, number>} Values in bytes, keyed by field name.
 */
export function parseMemInfo(content) {
  const values = new Map();
  for (const line of String(content).split('\n')) {
    const match = line.match(/^(\w+):\s+(\d+)(?:\s+(\w+))?/);
    if (match === null) {
      continue;
    }
    const [, key, amount, unit] = match;
    const parsed = Number(amount);
    if (!Number.isFinite(parsed)) {
      continue;
    }
    values.set(key, unit === 'kB' ? parsed * 1024 : parsed);
  }
  return values;
}

/**
 * Compute total and available memory from parsed /proc/meminfo values.
 * @param {Map<string, number>} values - Output of parseMemInfo.
 * @returns {{totalBytes: number, availableBytes: number, usedPercent: number} | null} Memory figures, or null when unusable.
 */
export function computeMemoryUsage(values) {
  const total = values.get('MemTotal');
  if (!Number.isFinite(total) || total <= 0) {
    return null;
  }
  let available = values.get('MemAvailable');
  if (!Number.isFinite(available)) {
    // Pre-3.14 kernels: reclaimable memory is roughly free + buffers + cache.
    available =
      (values.get('MemFree') ?? 0) + (values.get('Buffers') ?? 0) + (values.get('Cached') ?? 0);
  }
  available = Math.min(total, Math.max(0, available));
  return {
    totalBytes: total,
    availableBytes: available,
    usedPercent: ((total - available) / total) * 100,
  };
}

/**
 * Read the current memory usage of the host.
 * @param {{path?: string, readFileFn?: Function}} options - Injectable dependencies, for tests.
 * @returns {Promise<{totalBytes: number, availableBytes: number, usedPercent: number} | null>} Memory figures, or null when unavailable.
 */
export async function readMemory({ path = PROC_MEMINFO_PATH, readFileFn = readFile } = {}) {
  return computeMemoryUsage(parseMemInfo(await readFileFn(path, 'utf8')));
}
