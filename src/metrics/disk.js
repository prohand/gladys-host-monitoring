// -----------------------------------------------------------------------------
// Metric: DISK USAGE, read with statfs(2).
//
// A container sees its own root filesystem, not the host's, so the measured
// path matters: the default `/data` is the volume the Gladys supervisor mounts
// from the host, which lives on the same filesystem as the Gladys database.
// That is the number a user actually cares about ("is my Gladys box running out
// of space?"), and the user can point the integration at any other mounted path.
//
// The percentage matches what `df` prints: it is computed against the space
// available to a regular user, ignoring the blocks the filesystem reserves for
// root — otherwise a freshly formatted ext4 would already show ~5% used.
// -----------------------------------------------------------------------------

import { statfs } from 'node:fs/promises';

export const BYTES_PER_GIB = 1024 ** 3;

/**
 * Turn raw statfs figures into the values we publish.
 * @param {{bsize: number, blocks: number, bfree: number, bavail: number}} stats - Raw statfs output.
 * @returns {{totalBytes: number, freeBytes: number, usedPercent: number} | null} Disk figures, or null when unusable.
 */
export function computeDiskUsage(stats) {
  if (stats === null || typeof stats !== 'object') {
    return null;
  }
  const blockSize = Number(stats.bsize);
  const blocks = Number(stats.blocks);
  const freeBlocks = Number(stats.bfree);
  const availableBlocks = Number(stats.bavail);
  if (![blockSize, blocks, freeBlocks, availableBlocks].every(Number.isFinite) || blocks <= 0) {
    return null;
  }
  const usedBlocks = blocks - freeBlocks;
  // `df` denominator: what is used plus what a non-root user can still take.
  const usableBlocks = usedBlocks + availableBlocks;
  if (usableBlocks <= 0) {
    return null;
  }
  return {
    totalBytes: blocks * blockSize,
    freeBytes: availableBlocks * blockSize,
    usedPercent: Math.min(100, Math.max(0, (usedBlocks / usableBlocks) * 100)),
  };
}

/**
 * Read the usage of the filesystem holding a path.
 * @param {string} path - Any path on the filesystem to measure.
 * @param {{statfsFn?: Function}} options - Injectable dependencies, for tests.
 * @returns {Promise<{totalBytes: number, freeBytes: number, usedPercent: number} | null>} Disk figures, or null when unavailable.
 */
export async function readDisk(path, { statfsFn = statfs } = {}) {
  return computeDiskUsage(await statfsFn(path));
}
