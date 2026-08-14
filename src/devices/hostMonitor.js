// -----------------------------------------------------------------------------
// Device type: HOST SUPERVISION
//
// A single read-only device carrying the health of the machine Gladys runs on:
// CPU usage, memory usage, disk usage, free disk space and CPU temperature.
//
// Why this device drives its OWN refresh loop instead of using `poll_frequency`
// and the SDK's onPoll: the Gladys core scheduler only knows a fixed set of
// poll frequencies, the slowest being one minute
// (DEVICE_POLL_FREQUENCIES in the Gladys server constants — 1s, 2s, 10s, 15s,
// 30s, 60s; anything else is rejected). One minute is far too fast for host
// supervision and would write ~2.6 million history rows a year for five
// metrics. So the device declares no poll frequency, starts its own timer
// through `startPush` (default: every 5 minutes) and filters what it publishes
// through the state throttle. See src/publish/throttle.js.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { createMetricsCollector } from '../metrics/index.js';
import { createStateThrottle } from '../publish/throttle.js';
import { listTemperatureSensors, resolveTemperatureSensor } from '../metrics/temperature.js';
import { BYTES_PER_GIB } from '../metrics/disk.js';

const DEVICE_TYPE = 'host';

const logger = createLogger({ name: DEVICE_TYPE });

// The supervised machine is the one running this container: there is exactly
// one, and its identifier must stay stable across restarts and upgrades. The
// container hostname would not be (Docker regenerates it), and the SDK already
// namespaces every external id with the integration selector.
const PLATFORM_DEVICE_ID = 'local';

// Feature keys, kept in one place so discovery and publishing always agree.
export const FEATURE = {
  CPU: 'cpu-usage',
  MEMORY: 'memory-usage',
  DISK: 'disk-usage',
  DISK_FREE: 'disk-free',
  TEMPERATURE: 'cpu-temperature',
};

// Deadband used for the free-space reading when the filesystem size is
// unknown: 1 GiB is a sane "worth writing down" step on any real disk.
const FALLBACK_DISK_DEADBAND_GIB = 1;

/**
 * Round to a fixed number of decimals — a value published with full floating
 * point precision would defeat the deadband (every sample differs).
 * @param {number|null} value - Value to round.
 * @param {number} decimals - Number of decimals to keep.
 * @returns {number|null} The rounded value, or null when the input was null.
 */
function round(value, decimals) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Build the host supervision blueprint.
 *
 * Everything it talks to is injectable so the behaviour can be tested without
 * a Linux host, a Gladys server or a real clock.
 * @param {{collector?: object, throttle?: object, listSensors?: Function, resolveSensor?: Function, setIntervalFn?: Function, clearIntervalFn?: Function}} options - Injectable dependencies, for tests.
 * @returns {object} The device blueprint, in the shape src/devices/index.js expects.
 */
export function createHostMonitor({
  collector = createMetricsCollector(),
  throttle = createStateThrottle(),
  listSensors = listTemperatureSensors,
  resolveSensor = resolveTemperatureSensor,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  // Guard against overlapping runs: a slow read (an unresponsive NFS mount on
  // the measured path) must not stack timers on top of each other.
  let refreshInFlight = false;

  /**
   * Read every metric and publish the ones that passed the throttle.
   * @param {object} gladys - The SDK instance.
   * @param {object} config - Normalized configuration.
   * @returns {Promise<{metrics: object, publishedCount: number}>} What was read and how much of it was published.
   */
  async function refresh(gladys, config) {
    const ids = gladys.externalIds(DEVICE_TYPE, PLATFORM_DEVICE_ID);
    const metrics = await collector.read(config);

    // A percentage reading and a free-space reading do not deserve the same
    // threshold: the disk deadband is the same relative move, expressed in GiB.
    const diskDeadbandGib = Number.isFinite(metrics.diskTotalBytes)
      ? (config.min_variation / 100) * (metrics.diskTotalBytes / BYTES_PER_GIB)
      : FALLBACK_DISK_DEADBAND_GIB;

    const readings = [
      {
        externalId: ids.feature(FEATURE.CPU),
        value: round(metrics.cpuPercent, 1),
        deadband: config.min_variation,
      },
      {
        externalId: ids.feature(FEATURE.MEMORY),
        value: round(metrics.memoryPercent, 1),
        deadband: config.min_variation,
      },
      {
        externalId: ids.feature(FEATURE.DISK),
        value: round(metrics.diskPercent, 1),
        deadband: config.min_variation,
      },
      {
        externalId: ids.feature(FEATURE.DISK_FREE),
        value: round(metrics.diskFreeGib, 2),
        deadband: diskDeadbandGib,
      },
      {
        externalId: ids.feature(FEATURE.TEMPERATURE),
        value: round(metrics.temperature, 1),
        deadband: config.min_variation_temperature,
      },
    ];

    const toPublish = throttle.filter(readings, {
      maxIntervalMs: config.max_interval_minutes * 60 * 1000,
    });

    if (toPublish.length > 0) {
      await gladys.publishStates(
        toPublish.map(({ externalId, value }) => ({
          device_feature_external_id: externalId,
          state: value,
        })),
      );
    }

    logger.info(
      `Read: CPU ${format(metrics.cpuPercent, '%')} / RAM ${format(metrics.memoryPercent, '%')} / ` +
        `disk ${format(metrics.diskPercent, '%')} (${format(metrics.diskFreeGib, ' GiB free')}) / ` +
        `temp ${format(metrics.temperature, '°C')} -> ${toPublish.length}/${readings.length} state(s) published`,
    );

    return { metrics, publishedCount: toPublish.length };
  }

  return {
    key: DEVICE_TYPE,

    deviceExternalId(gladys) {
      return gladys.externalIds(DEVICE_TYPE, PLATFORM_DEVICE_ID).device;
    },

    buildDevice(gladys, config) {
      const ids = gladys.externalIds(DEVICE_TYPE, PLATFORM_DEVICE_ID);
      // No `poll_frequency`: the refresh loop is ours (see the file header).
      const device = {
        name: config.device_name,
        external_id: ids.device,
        features: [
          percentFeature({
            name: 'Utilisation CPU',
            externalId: ids.feature(FEATURE.CPU),
            keepHistory: config.keep_history,
          }),
          percentFeature({
            name: 'Utilisation mémoire',
            externalId: ids.feature(FEATURE.MEMORY),
            keepHistory: config.keep_history,
          }),
          percentFeature({
            name: 'Utilisation disque',
            externalId: ids.feature(FEATURE.DISK),
            keepHistory: config.keep_history,
          }),
          {
            name: 'Espace disque libre',
            external_id: ids.feature(FEATURE.DISK_FREE),
            category: DEVICE_FEATURE_CATEGORIES.DATA,
            type: DEVICE_FEATURE_TYPES.DATA.SIZE,
            unit: DEVICE_FEATURE_UNITS.GIGABYTE,
            min: 0,
            max: 100000,
            read_only: true,
            has_feedback: false,
            keep_history: config.keep_history,
          },
        ],
      };

      // Only advertise the temperature when a sensor is actually readable: a
      // feature that never receives a value is worse than a missing one, it
      // looks broken forever on the device screen.
      if (resolveSensor(config) !== null) {
        device.features.push({
          name: 'Température CPU',
          external_id: ids.feature(FEATURE.TEMPERATURE),
          category: DEVICE_FEATURE_CATEGORIES.DEVICE_TEMPERATURE_SENSOR,
          type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
          unit: DEVICE_FEATURE_UNITS.CELSIUS,
          min: -20,
          max: 120,
          read_only: true,
          has_feedback: false,
          keep_history: config.keep_history,
        });
      } else {
        logger.info('No CPU temperature sensor detected: the temperature feature is not published');
      }

      return device;
    },

    /**
     * Start the refresh loop. Returns the cleanup function the registry stores,
     * called on disconnection, on shutdown, and before restarting the loop with
     * a new configuration.
     * @param {object} gladys - The SDK instance.
     * @param {object} config - Normalized configuration.
     * @returns {Function} Cleanup function stopping the loop.
     */
    startPush(gladys, config) {
      const intervalMs = config.refresh_interval * 1000;
      logger.info(`Starting the refresh loop, every ${config.refresh_interval}s`);

      const run = async () => {
        if (refreshInFlight) {
          logger.warn('Previous refresh still running, skipping this tick');
          return;
        }
        refreshInFlight = true;
        try {
          await refresh(gladys, config);
        } catch (err) {
          logger.error('Refresh failed', err);
        } finally {
          refreshInFlight = false;
        }
      };

      // Publish a first snapshot right away: waiting a full interval after a
      // restart would leave the dashboard on stale values.
      run();
      const timer = setIntervalFn(run, intervalMs);

      return () => {
        clearIntervalFn(timer);
        logger.info('Refresh loop stopped');
      };
    },

    /**
     * Forget the published values, so the next refresh publishes a full
     * snapshot. Called on (re)connection: while we were disconnected Gladys
     * kept no state of what we held back.
     */
    resetThrottle() {
      throttle.reset();
    },

    // Manifest actions: buttons rendered in the Configuration screen. Both are
    // diagnosis tools — "why is my temperature missing?" must be answerable
    // from the UI, without reading container logs.
    actions: {
      async test_metrics(gladys, { config }) {
        logger.info('Action test_metrics -> immediate read');
        const { metrics, publishedCount } = await refresh(gladys, config);
        const cpu = format(metrics.cpuPercent, '%');
        const ram = format(metrics.memoryPercent, '%');
        const disk = format(metrics.diskPercent, '%');
        const free = format(metrics.diskFreeGib, '');
        const temp = format(metrics.temperature, '°C');
        return {
          en:
            `CPU ${cpu}, RAM ${ram}, disk ${disk} (${free} GiB free), temperature ${temp}` +
            ` — ${publishedCount} state(s) published.`,
          fr:
            `CPU ${cpu}, RAM ${ram}, disque ${disk} (${free} Gio libres), température ${temp}` +
            ` — ${publishedCount} état(s) publié(s).`,
        };
      },

      async list_temperature_sensors(_gladys, { config }) {
        const sensors = listSensors();
        if (sensors.length === 0) {
          return {
            en: 'No readable temperature sensor found under /sys/class/thermal or /sys/class/hwmon.',
            fr: 'Aucune sonde de température lisible sous /sys/class/thermal ou /sys/class/hwmon.',
          };
        }
        const selected = resolveSensor(config);
        const lines = sensors
          .map((sensor) => {
            const marker = sensor.path === selected ? '> ' : '  ';
            return `${marker}${sensor.name} (${sensor.path}): ${round(sensor.celsius, 1)}°C`;
          })
          .join('\n');
        return {
          en: `${sensors.length} sensor(s) found, "> " marks the one in use:\n${lines}`,
          fr: `${sensors.length} sonde(s) trouvée(s), « > » marque celle utilisée :\n${lines}`,
        };
      },
    },
  };
}

/**
 * Build one of the three percentage features (CPU, memory, disk usage).
 *
 * Gladys has no "computer resource" category; `level-sensor` + a decimal in
 * percent is the closest standard pair, and it renders as a regular percentage
 * sensor with charts.
 * @param {{name: string, externalId: string, keepHistory: boolean}} options - Feature description.
 * @returns {object} The feature payload.
 */
function percentFeature({ name, externalId, keepHistory }) {
  return {
    name,
    external_id: externalId,
    category: DEVICE_FEATURE_CATEGORIES.LEVEL_SENSOR,
    type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
    unit: DEVICE_FEATURE_UNITS.PERCENT,
    min: 0,
    max: 100,
    read_only: true, // a measurement: nothing to command
    has_feedback: false,
    keep_history: keepHistory,
  };
}

/**
 * Format a possibly-missing reading for a log line or an action message.
 * @param {number|null} value - The reading.
 * @param {string} suffix - Unit suffix appended to a present value.
 * @returns {string} Human-readable value.
 */
function format(value, suffix) {
  return Number.isFinite(value) ? `${round(value, 1)}${suffix}` : 'n/a';
}

export const hostMonitor = createHostMonitor();
