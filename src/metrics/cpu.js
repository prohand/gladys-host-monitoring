// -----------------------------------------------------------------------------
// Metric: CPU USAGE, read from /proc/stat.
//
// /proc/stat is not namespaced by Docker: the aggregated `cpu` line a container
// reads is the one of the HOST, which is exactly what we want to supervise.
//
// The kernel exposes cumulative counters (jiffies spent in each state since
// boot), not a percentage: a usage is always the ratio of two snapshots. We
// keep the snapshot of the previous read, so the published value is the average
// load over the refresh interval — the honest reading for a sensor sampled
// every few minutes. The very first read has no previous snapshot, so it takes
// a short sampling window instead of publishing nothing.
// -----------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export const PROC_STAT_PATH = '/proc/stat';

// Length of the sampling window used for the very first read only.
const FIRST_READ_WINDOW_MS = 1000;

/**
 * Parse the aggregated `cpu` line of /proc/stat.
 *
 * The line is `cpu user nice system idle iowait irq softirq steal guest ...`,
 * in jiffies since boot. Fields beyond `steal` (guest, guest_nice) are already
 * counted inside user/nice, so adding them would double-count.
 * @param {string} content - Raw content of /proc/stat.
 * @returns {{idle: number, total: number} | null} Cumulative counters, or null when the line is unusable.
 */
export function parseCpuTimes(content) {
  const line = String(content)
    .split('\n')
    .find((candidate) => candidate.startsWith('cpu '));
  if (line === undefined) {
    return null;
  }
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  // user, nice, system and idle are the four fields every kernel exposes.
  if (values.length < 4 || values.some((value) => !Number.isFinite(value))) {
    return null;
  }
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = values;
  // iowait is idle time too: the CPU is waiting, not working.
  const idleTotal = idle + iowait;
  return {
    idle: idleTotal,
    total: user + nice + system + idleTotal + irq + softirq + steal,
  };
}

/**
 * Compute the CPU usage between two snapshots.
 * @param {{idle: number, total: number} | null} previous - Older snapshot.
 * @param {{idle: number, total: number} | null} current - Newer snapshot.
 * @returns {number | null} Usage in percent, or null when the pair is unusable.
 */
export function computeUsage(previous, current) {
  if (previous === null || current === null) {
    return null;
  }
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  // A non-positive delta means the counters did not move or went backwards
  // (host resumed from suspend, counters reset): no usable ratio.
  if (totalDelta <= 0) {
    return null;
  }
  const usage = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Math.min(100, Math.max(0, usage));
}

/**
 * Build a stateful CPU reader. It remembers the previous snapshot, so each
 * read returns the average usage since the previous one.
 * @param {{path?: string, readFileFn?: Function, sleep?: Function, firstReadWindowMs?: number}} options - Injectable dependencies, for tests.
 * @returns {{read: () => Promise<number | null>, reset: () => void}} The reader.
 */
export function createCpuReader({
  path = PROC_STAT_PATH,
  readFileFn = readFile,
  sleep = delay,
  firstReadWindowMs = FIRST_READ_WINDOW_MS,
} = {}) {
  let previous = null;

  return {
    async read() {
      const current = parseCpuTimes(await readFileFn(path, 'utf8'));
      if (current === null) {
        return null;
      }
      if (previous === null) {
        // No history yet: sample a short window so the first refresh already
        // shows a value instead of an empty sensor.
        await sleep(firstReadWindowMs);
        const second = parseCpuTimes(await readFileFn(path, 'utf8'));
        previous = second ?? current;
        return computeUsage(current, second);
      }
      const usage = computeUsage(previous, current);
      previous = current;
      return usage;
    },

    reset() {
      previous = null;
    },
  };
}
