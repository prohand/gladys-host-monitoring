// -----------------------------------------------------------------------------
// Connection and configuration lifecycle: what runs on `connected` and on
// `onConfigUpdated`, and the refresh loops both of them (re)start.
//
// Kept out of index.js so it can be tested against a fake SDK — index.js
// instantiates the real one and connects at import time.
//
// The one rule this module exists for: the refresh loops are armed FIRST, and
// nothing that talks to Gladys afterwards can prevent it. Right after Gladys
// restarts, the WebSocket is up before the core answers every request, and
// `publishDiscoveredDevices` or `getDevices` time out. When the loops were
// started after those calls, such a timeout left the integration connected
// and silent — no metric at all until the next reconnection, which may never
// come. The loops only need the configuration; the discovery payload and the
// outdated-device check are best-effort and reported in the Configuration
// screen when they fail.
// -----------------------------------------------------------------------------

import { logger as sdkLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import {
  DEVICE_BLUEPRINTS,
  buildDiscoveredDevices,
  findOutdatedDevices,
  resetThrottles,
} from './devices/index.js';

const INIT_FAILED_MESSAGE = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
};

/**
 * Build the lifecycle of the integration around an SDK instance.
 * @param {object} gladys - The SDK instance (or a fake one).
 * @param {{blueprints?: object[], logger?: object}} options - Injectable dependencies, for tests.
 * @returns {{config: object, onConnected: Function, onConfigUpdated: Function, restartRefreshLoops: Function, stopRefreshLoops: Function}} The lifecycle.
 */
export function createLifecycle(
  gladys,
  { blueprints = DEVICE_BLUEPRINTS, logger = sdkLogger } = {},
) {
  // Current configuration (hot-reloaded via onConfigUpdated).
  let config = normalizeConfig();
  // Cleanup functions of the running refresh loops.
  let pushCleanups = [];

  /**
   * Stop every running refresh loop.
   * @returns {void}
   */
  function stopRefreshLoops() {
    for (const cleanup of pushCleanups) {
      try {
        cleanup?.();
      } catch (err) {
        logger.error('Refresh loop cleanup failed', err);
      }
    }
    pushCleanups = [];
  }

  /**
   * Stop the running refresh loops, then start them again with the current
   * configuration. The throttle is cleared first so the restart publishes a
   * full snapshot rather than silently skipping unchanged metrics.
   * @returns {void}
   */
  function restartRefreshLoops() {
    stopRefreshLoops();
    resetThrottles(blueprints);
    for (const blueprint of blueprints) {
      if (typeof blueprint.startPush !== 'function') {
        continue;
      }
      try {
        pushCleanups.push(blueprint.startPush(gladys, config));
      } catch (err) {
        logger.error(`Cannot start the refresh loop of ${blueprint.key}`, err);
      }
    }
  }

  /**
   * (Re)initialize after a (re)connection: read the configuration, arm the
   * loops, then publish the device and check the created one.
   * @returns {Promise<void>}
   */
  async function onConnected() {
    try {
      // 1) Fetch the config filled in by the user. On failure the last known
      // one (the defaults on a first start) still drives the loops: a reading
      // with a default disk path beats no reading at all, and the next
      // connection or configuration change brings the real one.
      try {
        config = normalizeConfig(await gladys.getConfig());
      } catch (err) {
        logger.error('Cannot read the configuration, keeping the last known one', err);
      }

      // 2) Arm the refresh loop BEFORE anything else talks to Gladys (see the
      // file header). It publishes a first snapshot immediately: whatever we
      // held back while disconnected is republished.
      restartRefreshLoops();

      // 3) (Re)publish the device.
      await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, config, blueprints));

      // 4) Compare what we publish with what the user actually has: a device
      // created by an older version keeps its original features, and every
      // state we send for a feature it does not carry is dropped by the core
      // without a word. Detected here, it becomes a message in the
      // Configuration screen instead of a device stuck on "no recent value".
      const outdatedDevices = findOutdatedDevices(
        gladys,
        await gladys.getDevices(),
        config,
        blueprints,
      );
      for (const device of outdatedDevices) {
        logger.warn(
          `Device "${device.name}" (${device.deviceExternalId}) does not carry the feature(s) ` +
            `${device.missingFeatures.join(', ')}: their values will be ignored by Gladys. ` +
            'Remove the device in Gladys and add it again from the Discovery screen.',
        );
      }

      // 5) Report the application-level status, shown in the Configuration
      // screen. Distinct from the container state machine: an integration can
      // be RUNNING and still unable to read what it supervises.
      if (outdatedDevices.length > 0) {
        await gladys.setConnectionStatus(false, outdatedDevicesMessage(outdatedDevices));
      } else {
        await gladys.setConnectionStatus(true);
      }
    } catch (err) {
      logger.error('Post-connection initialization failed', err);
      await Promise.resolve()
        .then(() => gladys.setConnectionStatus(false, INIT_FAILED_MESSAGE))
        .catch(() => {});
    }
  }

  /**
   * Apply a configuration saved by the user.
   * @param {Record<string, unknown>} newConfig - The raw configuration.
   * @returns {Promise<void>}
   */
  async function onConfigUpdated(newConfig) {
    config = normalizeConfig(newConfig);
    // Restart the refresh loops first, so a new interval takes effect
    // immediately (instead of at the end of the current, possibly one hour
    // long, tick) even when the publication below fails.
    restartRefreshLoops();
    // Re-publish the device: the name, the history flag and the presence of
    // the temperature feature all depend on the configuration.
    //
    // Careful, this only refreshes the DISCOVERY entry: for a device the user
    // has already created, the Gladys core re-upserts its params and nothing
    // else, so the features (and their keep_history flag) keep the shape they
    // had at creation time. Changing those settings on an existing device
    // means removing it and adding it again — see findOutdatedDevices().
    try {
      await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, config, blueprints));
    } catch (err) {
      logger.error('Cannot publish the device after a configuration change', err);
    }
  }

  return {
    get config() {
      return config;
    },
    onConnected,
    onConfigUpdated,
    restartRefreshLoops,
    stopRefreshLoops,
  };
}

/**
 * Turn the outdated devices into the message shown in the Configuration
 * screen. It names the culprit and gives the only fix: the core never updates
 * the features of a device already created, so it has to be created again.
 * @param {{name: string, missingFeatures: string[]}[]} devices - Outdated devices.
 * @returns {{en: string, fr: string}} The message.
 */
export function outdatedDevicesMessage(devices) {
  const names = devices.map((device) => `"${device.name}"`).join(', ');
  return {
    en:
      `${names}: this device was created with an older version of the integration and no longer ` +
      'carries the features published today, so its values are ignored. Remove it in Gladys, ' +
      'then add it again from the Discovery screen.',
    fr:
      `${names} : cet appareil a été créé avec une version plus ancienne de l'intégration et ne ` +
      "porte plus les fonctionnalités publiées aujourd'hui, ses valeurs sont donc ignorées. " +
      "Supprimez-le dans Gladys, puis rajoutez-le depuis l'écran Découverte.",
  };
}
