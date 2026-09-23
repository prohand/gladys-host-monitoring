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
//
// Since Gladys 5.1 the device also carries three capabilities declared in the
// manifest, all fed by the same refresh:
//   - a scene TRIGGER (`threshold_alert`), fired once when a metric reaches its
//     alert threshold and once when it comes back down (src/publish/alerts.js);
//   - a scene ACTION (`read_metrics`), returning the current readings to the
//     scene as outputs;
//   - a dashboard WIDGET (`host_health`), whose tiles and chart are bound to the
//     device features once the device exists, so they follow the published
//     states live without us pushing anything.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
  WIDGET_COLORS,
} from '@gladysassistant/integration-sdk';
import { createMetricsCollector } from '../metrics/index.js';
import { createStateThrottle } from '../publish/throttle.js';
import { createAlertTracker, ALERT_STATUS } from '../publish/alerts.js';
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

// Keys of the manifest capabilities. A published key is never renamed: scenes
// and dashboards store it, a renamed key is a removed one for every user.
export const SCENE_TRIGGER = {
  THRESHOLD_ALERT: 'threshold_alert',
};
export const WIDGET = {
  HOST_HEALTH: 'host_health',
};
// Keys of the widget buttons (the `action.key` of a button component).
export const WIDGET_ACTION = {
  REFRESH: 'refresh',
};

// The metrics a threshold alert can watch. `metric` is the value carried by the
// scene event and matched by the trigger `metric` filter of the manifest; the
// labels are French like the device and feature names shown in Gladys.
export const ALERT_METRICS = [
  {
    metric: 'cpu',
    feature: FEATURE.CPU,
    snapshotKey: 'cpuPercent',
    configKey: 'alert_cpu_percent',
    unit: '%',
    // Points under the threshold before the alert clears (see alerts.js).
    hysteresis: 5,
    label: { en: 'CPU usage', fr: 'Utilisation CPU' },
  },
  {
    metric: 'memory',
    feature: FEATURE.MEMORY,
    snapshotKey: 'memoryPercent',
    configKey: 'alert_memory_percent',
    unit: '%',
    hysteresis: 5,
    label: { en: 'Memory usage', fr: 'Utilisation mémoire' },
  },
  {
    metric: 'disk',
    feature: FEATURE.DISK,
    snapshotKey: 'diskPercent',
    configKey: 'alert_disk_percent',
    unit: '%',
    hysteresis: 5,
    label: { en: 'Disk usage', fr: 'Utilisation disque' },
  },
  {
    metric: 'temperature',
    feature: FEATURE.TEMPERATURE,
    snapshotKey: 'temperature',
    configKey: 'alert_temperature',
    unit: '°C',
    hysteresis: 3,
    label: { en: 'CPU temperature', fr: 'Température CPU' },
  },
];

// Chart spans offered by the widget `chart_interval` setting: `none` hides the
// chart, the others are the core chart box interval enum.
export const WIDGET_CHART_INTERVALS = [
  'none',
  'last-hour',
  'last-twelve-hours',
  'last-day',
  'last-three-days',
  'last-week',
  'last-month',
];
export const DEFAULT_WIDGET_CHART_INTERVAL = 'last-day';

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
 * @param {{collector?: object, throttle?: object, listSensors?: Function, resolveSensor?: Function, alerts?: object, setIntervalFn?: Function, clearIntervalFn?: Function}} options - Injectable dependencies, for tests.
 * @returns {object} The device blueprint, in the shape src/devices/index.js expects.
 */
export function createHostMonitor({
  collector = createMetricsCollector(),
  throttle = createStateThrottle(),
  listSensors = listTemperatureSensors,
  resolveSensor = resolveTemperatureSensor,
  alerts = createAlertTracker(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  // Guard against overlapping runs: a slow read (an unresponsive NFS mount on
  // the measured path) must not stack timers on top of each other. Held as a
  // promise rather than a boolean so a forced refresh can queue behind a slow
  // read instead of being dropped the way a timer tick is.
  /** @type {Promise<void>|null} */
  let refreshInFlight = null;

  // Last snapshot read, for the dashboard widget: it is pulled by the core at
  // any time and must answer from memory, not trigger a read of its own (an
  // extra /proc/stat read would shorten the CPU averaging window of the loop).
  /** @type {object|null} */
  let lastMetrics = null;

  /**
   * Read every metric and publish the ones that passed the throttle.
   * @param {object} gladys - The SDK instance.
   * @param {object} config - Normalized configuration.
   * @returns {Promise<{metrics: object, publishedCount: number}>} What was read and how much of it was published.
   */
  async function refresh(gladys, config) {
    const ids = gladys.externalIds(DEVICE_TYPE, PLATFORM_DEVICE_ID);
    const metrics = await collector.read(config);
    lastMetrics = metrics;

    // Alerts come first and never throw: they are evaluated on every raw
    // reading, whatever the throttle holds back, and a failed states batch
    // must not delay a "disk full" scene.
    await fireAlerts(gladys, metrics, config);

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
      // Only now are these values really published. Committing before the call
      // would lose the batch whenever it fails (Gladys restarting, a network
      // blip): the throttle would hold the metrics back until they cross the
      // deadband again — up to a full heartbeat interval on a flat metric.
      throttle.commit(toPublish);
    }

    logger.info(
      `Read: CPU ${format(metrics.cpuPercent, '%')} / RAM ${format(metrics.memoryPercent, '%')} / ` +
        `disk ${format(metrics.diskPercent, '%')} (${format(metrics.diskFreeGib, ' GiB free')}) / ` +
        `temp ${format(metrics.temperature, '°C')} -> ${toPublish.length}/${readings.length} state(s) published`,
    );

    requestWidgetRefresh(gladys);

    return { metrics, publishedCount: toPublish.length };
  }

  /**
   * Compare the readings with the alert thresholds and fire the
   * `threshold_alert` scene trigger for each transition.
   *
   * Never throws: a transition Gladys did not accept stays uncommitted and is
   * fired again at the next refresh.
   * @param {object} gladys - The SDK instance.
   * @param {object} metrics - The snapshot just read.
   * @param {object} config - Normalized configuration.
   * @returns {Promise<void>}
   */
  async function fireAlerts(gladys, metrics, config) {
    const readings = ALERT_METRICS.map((entry) => ({
      metric: entry.metric,
      // Rounded like the published state, so the event and the chart agree.
      value: round(metrics[entry.snapshotKey], 1),
      threshold: config[entry.configKey],
      hysteresis: entry.hysteresis,
    }));
    alerts.prune(readings);

    for (const transition of alerts.evaluate(readings)) {
      try {
        await gladys.publishSceneEvent(
          SCENE_TRIGGER.THRESHOLD_ALERT,
          buildAlertEventData(transition, config),
        );
        alerts.commit(transition);
        logger.info(
          `Alert ${transition.status}: ${transition.metric} at ${transition.value} ` +
            `(threshold ${transition.threshold})`,
        );
      } catch (err) {
        logger.warn(
          `Cannot fire the ${transition.status} alert for ${transition.metric}, ` +
            `retried at the next refresh: ${err.message}`,
        );
      }
    }
  }

  /**
   * Ask the core to re-pull the widget content. The device-bound tiles follow
   * the states live on their own, but the alert statuses and the inline values
   * (device not created yet) only change through a new pull.
   *
   * Fire-and-forget: rate-limited core-side, dropped while disconnected.
   * @param {object} gladys - The SDK instance.
   * @returns {void}
   */
  function requestWidgetRefresh(gladys) {
    try {
      gladys.requestWidgetRefresh(WIDGET.HOST_HEALTH);
    } catch (err) {
      logger.debug(`Widget refresh request failed: ${err.message}`);
    }
  }

  /**
   * Read now on behalf of a user or a scene, through the throttle.
   *
   * Unlike a timer tick, such a read answers someone: it waits for a read
   * already in progress rather than being dropped.
   * @param {object} gladys - The SDK instance.
   * @param {object} config - Normalized configuration.
   * @param {{full?: boolean}} options - `full` forgets the published values first, so every metric is republished.
   * @returns {Promise<{metrics: object, publishedCount: number}>} What was read and published.
   */
  async function readNow(gladys, config, { full = false } = {}) {
    while (refreshInFlight !== null) {
      await refreshInFlight;
    }
    if (full) {
      throttle.reset();
    }
    return startRefresh(gladys, config);
  }

  /**
   * Run a refresh and expose it as the in-flight one until it settles.
   * @param {object} gladys - The SDK instance.
   * @param {object} config - Normalized configuration.
   * @returns {Promise<{metrics: object, publishedCount: number}>} The refresh result.
   */
  function startRefresh(gladys, config) {
    const running = refresh(gladys, config);
    // The tracked promise swallows the failure: callers waiting for the slot to
    // free up care that the read is over, not how it went. The real promise is
    // returned untouched, so the caller still sees the error.
    refreshInFlight = running
      .catch(() => {})
      .finally(() => {
        refreshInFlight = null;
      });
    return running;
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
        if (refreshInFlight !== null) {
          logger.warn('Previous refresh still running, skipping this tick');
          return;
        }
        try {
          await startRefresh(gladys, config);
        } catch (err) {
          logger.error('Refresh failed', err);
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

    /**
     * Publish a full snapshot right now, whatever the throttle believes.
     *
     * This is what makes a freshly created device show values immediately. The
     * refresh loop starts as soon as we are connected, so it publishes states
     * for a device the user has not added yet; Gladys finds no feature for
     * those external_ids and drops them, but the throttle has no way of knowing
     * and records them as published. Without this reset, the device the user
     * just added stays on "no recent value" until a metric crosses its deadband
     * or the heartbeat fires — up to `max_interval_minutes` (one hour by
     * default), and that is the best case: a flat metric like disk usage really
     * does wait the full hour.
     * @param {object} gladys - The SDK instance.
     * @param {object} config - Normalized configuration.
     * @returns {Promise<{metrics: object, publishedCount: number}>} What was read and published.
     */
    async refreshNow(gladys, config) {
      return readNow(gladys, config, { full: true });
    },

    // Manifest actions: buttons rendered in the Configuration screen. Both are
    // diagnosis tools — "why is my temperature missing?" must be answerable
    // from the UI, without reading container logs.
    actions: {
      async test_metrics(gladys, { config }) {
        logger.info('Action test_metrics -> immediate read');
        const { metrics, publishedCount } = await readNow(gladys, config);
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

    // Scene triggers this blueprint fires (declared in the manifest
    // `scene_triggers`; the manifest test keeps both lists in sync).
    sceneTriggers: [SCENE_TRIGGER.THRESHOLD_ALERT],

    // Scene actions: cards of the scene editor, declared in the manifest
    // `scene_actions`. The resolved object is the action `outputs`.
    sceneActions: {
      async read_metrics(gladys, { config }) {
        logger.info('Scene action read_metrics -> immediate read');
        // Through the throttle, like the button: a scene running every minute
        // must not turn into one history row per metric per minute.
        const { metrics } = await readNow(gladys, config);
        return buildSceneOutputs(metrics);
      },
    },

    // Dashboard widgets, declared in the manifest `widgets`.
    widgets: {
      [WIDGET.HOST_HEALTH]: {
        async get(gladys, { settings, units, config }) {
          return buildWidgetContent({
            gladys,
            config,
            settings,
            units,
            metrics: lastMetrics,
            isAlertActive: (metric) => alerts.isActive(metric),
            deviceExternalId: gladys.externalIds(DEVICE_TYPE, PLATFORM_DEVICE_ID).device,
          });
        },

        async action(gladys, actionKey, _params, { config }) {
          if (actionKey !== WIDGET_ACTION.REFRESH) {
            throw new Error(`Unknown widget action "${actionKey}"`);
          }
          const { publishedCount } = await readNow(gladys, config);
          // The core drops the cached content after the ack: every open
          // dashboard re-pulls it with the new snapshot.
          return {
            en: `Metrics read, ${publishedCount} state(s) published.`,
            fr: `Métriques lues, ${publishedCount} état(s) publié(s).`,
          };
        },
      },
    },
  };
}

/**
 * Build the flat data of a `threshold_alert` scene event. Every key must be
 * declared in the manifest trigger `fields` or `variables` — the core drops the
 * others (enforced by test/manifest.test.js).
 *
 * `message` is a ready-made French sentence, so the most common scene — "send
 * me a message when the disk is full" — needs no template at all.
 * @param {{metric: string, status: string, value: number, threshold: number}} transition - An alert transition.
 * @param {object} config - Normalized configuration.
 * @returns {Record<string, string|number>} The event data.
 */
export function buildAlertEventData(transition, config) {
  const entry = ALERT_METRICS.find((candidate) => candidate.metric === transition.metric);
  const value = `${transition.value} ${entry.unit}`;
  const threshold = `${transition.threshold} ${entry.unit}`;
  const message =
    transition.status === ALERT_STATUS.RAISED
      ? `${config.device_name} : ${entry.label.fr} à ${value} (seuil ${threshold})`
      : `${config.device_name} : ${entry.label.fr} revenue à ${value} (seuil ${threshold})`;
  return {
    metric: transition.metric,
    status: transition.status,
    value: transition.value,
    threshold: transition.threshold,
    unit: entry.unit,
    metric_label: entry.label.fr,
    device_name: config.device_name,
    message,
  };
}

/**
 * Build the outputs of the `read_metrics` scene action. An unavailable metric
 * is `null`, never a fake 0 a scene condition would take for a real reading.
 * @param {object} metrics - A metrics snapshot.
 * @returns {Record<string, number|string|null>} The declared outputs.
 */
export function buildSceneOutputs(metrics) {
  return {
    cpu_percent: round(metrics.cpuPercent, 1),
    memory_percent: round(metrics.memoryPercent, 1),
    disk_percent: round(metrics.diskPercent, 1),
    disk_free_gib: round(metrics.diskFreeGib, 2),
    temperature: round(metrics.temperature, 1),
    summary:
      `CPU ${format(metrics.cpuPercent, ' %')}, mémoire ${format(metrics.memoryPercent, ' %')}, ` +
      `disque ${format(metrics.diskPercent, ' %')} (${format(metrics.diskFreeGib, ' Gio')} libres), ` +
      `température ${format(metrics.temperature, ' °C')}`,
  };
}

/**
 * Build the content of the `host_health` dashboard widget.
 *
 * Once the user has created the device, every tile and the chart are bound to
 * its features (`device_feature`): the core renders them live from the
 * published states, in the user's units, with no nudge from us. Before that —
 * or for a feature the device was created without — the tile shows the last
 * reading inline, so the widget is useful from the first minute.
 *
 * The layout stays inside the core content budget: five tiles, one chart, one
 * status list, one button.
 * @param {{gladys: object, config: object, settings?: object, units?: string, metrics: object|null, isAlertActive: Function, deviceExternalId: string}} options - What the content is built from.
 * @returns {{ttl_seconds: number, components: object[]}} The widget content.
 */
export function buildWidgetContent({
  gladys,
  config,
  settings,
  units,
  metrics,
  isAlertActive,
  deviceExternalId,
}) {
  const refreshButton = {
    type: 'button',
    label: { en: 'Read now', fr: 'Lire maintenant' },
    icon: 'refresh-cw',
    style: 'secondary',
    action: { key: WIDGET_ACTION.REFRESH },
  };

  // The content outlives the refresh loop tick at most by one interval; the
  // loop nudges the core after each read anyway.
  const ttl = config.refresh_interval;

  if (metrics === null) {
    return {
      ttl_seconds: 10,
      components: [
        {
          type: 'text',
          text: { en: 'First reading in progress…', fr: 'Première mesure en cours…' },
        },
        refreshButton,
      ],
    };
  }

  const created = (gladys.devices ?? []).find((device) => device.external_id === deviceExternalId);
  const createdFeatures = new Map(
    (created?.features ?? []).map((feature) => [feature.external_id, feature]),
  );
  const featureId = (key) => `${deviceExternalId}:${key}`;
  const isBound = (key) => createdFeatures.has(featureId(key));
  // Spread into a component: no `color` key at all outside an alert, so the
  // tile keeps the core's neutral styling.
  const alertColor = (metric) => (isAlertActive(metric) ? { color: WIDGET_COLORS.DANGER } : {});
  const isUs = units === 'us';

  const components = [];

  const gauges = [
    { key: FEATURE.CPU, metric: 'cpu', value: metrics.cpuPercent, label: 'CPU' },
    {
      key: FEATURE.MEMORY,
      metric: 'memory',
      value: metrics.memoryPercent,
      label: { en: 'Memory', fr: 'Mémoire' },
    },
    {
      key: FEATURE.DISK,
      metric: 'disk',
      value: metrics.diskPercent,
      label: { en: 'Disk', fr: 'Disque' },
    },
  ];
  for (const gauge of gauges) {
    const base = { type: 'gauge', label: gauge.label, ...alertColor(gauge.metric) };
    if (isBound(gauge.key)) {
      components.push({ ...base, device_feature: featureId(gauge.key) });
    } else if (Number.isFinite(gauge.value)) {
      components.push({ ...base, value: round(gauge.value, 1), min: 0, max: 100, unit: '%' });
    }
  }

  const temperatureLabel = { en: 'CPU temp.', fr: 'Temp. CPU' };
  if (isBound(FEATURE.TEMPERATURE)) {
    components.push({
      type: 'value',
      label: temperatureLabel,
      icon: 'thermometer',
      ...alertColor('temperature'),
      device_feature: featureId(FEATURE.TEMPERATURE),
    });
  } else if (Number.isFinite(metrics.temperature)) {
    components.push({
      type: 'value',
      label: temperatureLabel,
      icon: 'thermometer',
      ...alertColor('temperature'),
      value: round(isUs ? celsiusToFahrenheit(metrics.temperature) : metrics.temperature, 1),
      unit: isUs ? '°F' : '°C',
    });
  }

  const freeLabel = { en: 'Free disk', fr: 'Disque libre' };
  if (isBound(FEATURE.DISK_FREE)) {
    components.push({
      type: 'value',
      label: freeLabel,
      icon: 'hard-drive',
      device_feature: featureId(FEATURE.DISK_FREE),
    });
  } else if (Number.isFinite(metrics.diskFreeGib)) {
    components.push({
      type: 'value',
      label: freeLabel,
      icon: 'hard-drive',
      value: round(metrics.diskFreeGib, 1),
      unit: { en: 'GiB', fr: 'Gio' },
    });
  }

  // The chart plots the core's own history of the features: only possible on
  // a created device whose features keep their history.
  const interval = WIDGET_CHART_INTERVALS.includes(settings?.chart_interval)
    ? settings.chart_interval
    : DEFAULT_WIDGET_CHART_INTERVAL;
  const charted = [FEATURE.CPU, FEATURE.MEMORY, FEATURE.DISK]
    .map(featureId)
    .filter((id) => createdFeatures.has(id) && createdFeatures.get(id).keep_history !== false);
  if (interval !== 'none' && charted.length > 0) {
    components.push({
      type: 'chart',
      chart_type: 'line',
      title: { en: 'Usage history', fr: "Historique d'utilisation" },
      unit: '%',
      device_features: charted,
      interval,
    });
  }

  // One row per enabled alert, so the user sees what is watched and what fired.
  const alertRows = ALERT_METRICS.filter(
    (entry) => config[entry.configKey] > 0 && Number.isFinite(metrics[entry.snapshotKey]),
  ).map((entry) => {
    const active = isAlertActive(entry.metric);
    const threshold =
      entry.metric === 'temperature' && isUs
        ? `${round(celsiusToFahrenheit(config[entry.configKey]), 0)} °F`
        : `${config[entry.configKey]} ${entry.unit}`;
    return {
      label: entry.label,
      value: active
        ? { en: `Alert (≥ ${threshold})`, fr: `Alerte (≥ ${threshold})` }
        : { en: `OK (< ${threshold})`, fr: `OK (< ${threshold})` },
      icon: active ? 'alert-triangle' : 'check-circle',
      color: active ? WIDGET_COLORS.DANGER : WIDGET_COLORS.SUCCESS,
    };
  });
  if (alertRows.length > 0) {
    components.push({ type: 'status', items: alertRows });
  }

  components.push(refreshButton);

  return { ttl_seconds: ttl, components };
}

/**
 * Convert Celsius to Fahrenheit, for the inline tiles of a `us` user (the
 * device-bound ones are converted by the core).
 * @param {number} celsius - Temperature in Celsius.
 * @returns {number} Temperature in Fahrenheit.
 */
function celsiusToFahrenheit(celsius) {
  return (celsius * 9) / 5 + 32;
}

/**
 * Build one of the three percentage features (CPU, memory, disk usage).
 *
 * On the category: Gladys has no "computer resource" category, and none of the
 * existing ones really fits a CPU or a memory usage. `level-sensor` is the
 * liquid-level category (its own types are liquid-state, liquid-level-percent
 * and liquid-depth, and the UI draws it with a water-drop icon), but the
 * `level-sensor` + `decimal` pair is a supported generic combination: it is
 * translated ("Level sensor"), it accepts the percent unit, and it renders as a
 * plain percentage sensor with charts. The alternatives are worse — `unknown` +
 * `decimal` has no translation at all and shows a raw i18n key.
 *
 * The category never affects the values: `device.saveState` stores whatever an
 * integration publishes without looking at it. What we pick here only changes
 * the icon and the label in the UI.
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
