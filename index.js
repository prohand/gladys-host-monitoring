// -----------------------------------------------------------------------------
// Entry point of the "Supervision hôte" external integration.
//
// Role of this file: wire the SDK to the device catalog (src/devices/). It
// holds NO measurement logic — reading the host lives in src/metrics/, deciding
// what is worth writing to the database lives in src/publish/throttle.js. This
// file only:
//   1. instantiates the SDK (connection, auth, reconnection: handled for you);
//   2. registers the event handlers BEFORE connect();
//   3. connects, publishes the device and starts the refresh loop.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './src/config.js';
import {
  DEVICE_BLUEPRINTS,
  buildDiscoveredDevices,
  findBlueprintByDevice,
  findOutdatedDevices,
  refreshDeviceNow,
  resetThrottles,
} from './src/devices/index.js';

const gladys = new GladysIntegration();

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();

// Cleanup functions of the running refresh loops.
let pushCleanups = [];

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> publishing the host device');
  await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, config));
});

// --- Polling: Gladys asks to refresh a device --------------------------------
// The host device declares no poll_frequency (the core scheduler cannot go
// slower than one minute, see src/devices/hostMonitor.js), so this handler is
// never called in practice. It stays registered because a device published by
// a future version might use it, and an unregistered handler would nack the
// command instead of ignoring it.
gladys.onPoll(async (device) => {
  const blueprint = findBlueprintByDevice(gladys, device);
  if (!blueprint || typeof blueprint.onPoll !== 'function') {
    logger.debug(`onPoll ignored (self-scheduled device) for ${device.external_id}`);
    return;
  }
  await blueprint.onPoll(gladys, config);
});

// --- The user added (or edited) one of our devices ---------------------------
// This is what makes a brand new device show its values straight away.
//
// The refresh loop runs from the moment we are connected, so it has been
// publishing states for feature external_ids that did not exist yet: Gladys
// dropped them (it matches states to features by external_id, and there was no
// feature to match), while our throttle recorded them as published. From its
// point of view every metric is now "already sent and unchanged", so it holds
// them all back — and the device the user just created sits on "no recent
// value" until something crosses its deadband or the heartbeat fires, up to
// `max_interval_minutes` later. Forcing a full snapshot here closes that gap.
gladys.onDeviceCreated(async (device) => {
  logger.info(`onDeviceCreated (${device.external_id}) -> publishing a full snapshot`);
  await refreshDeviceNow(gladys, device, config);
});

// Same treatment on update: the user may have edited the device features, so
// what we believe Gladys holds is stale again.
gladys.onDeviceUpdated(async (device) => {
  logger.info(`onDeviceUpdated (${device.external_id}) -> publishing a full snapshot`);
  await refreshDeviceNow(gladys, device, config);
});

// --- Manifest actions: buttons in the Configuration screen -------------------
// Each action declared in the `actions` field of the manifest is registered per
// key; the message resolved by the handler is displayed under the button (the
// ack is awaited under the action's `timeout_seconds`, not the usual 5 s).
for (const blueprint of DEVICE_BLUEPRINTS) {
  for (const [actionKey, handler] of Object.entries(blueprint.actions ?? {})) {
    gladys.onAction(actionKey, (fields) => handler(gladys, { fields, config }));
  }
}

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  config = normalizeConfig(newConfig);
  // Re-publish the device: the name, the history flag and the presence of the
  // temperature feature all depend on the configuration.
  //
  // Careful, this only refreshes the DISCOVERY entry: for a device the user has
  // already created, the Gladys core re-upserts its params and nothing else, so
  // the features (and their keep_history flag) keep the shape they had at
  // creation time. Changing those settings on an existing device means removing
  // it and adding it again — see findOutdatedDevices().
  await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, config));
  // Restart the refresh loops so a new interval takes effect immediately,
  // instead of at the end of the current (possibly one hour long) tick.
  restartRefreshLoops();
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK itself logs the WebSocket lifecycle (connections, disconnections,
// reconnection attempts) under the `gladys-sdk` name: no need to log it again
// here, these handlers only run the integration's own (re)initialization.
gladys.on('connected', async () => {
  try {
    // 1) Fetch the config filled in by the user.
    config = normalizeConfig(await gladys.getConfig());

    // 2) (Re)publish the device as soon as we are connected.
    await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, config));

    // 3) Compare what we are about to publish with what the user actually has:
    // a device created by an older version keeps its original features, and
    // every state we send for a feature it does not carry is dropped by the
    // core without a word. Detected here, it becomes a message in the
    // Configuration screen instead of a device stuck on "no recent value".
    const outdatedDevices = findOutdatedDevices(gladys, await gladys.getDevices(), config);
    for (const device of outdatedDevices) {
      logger.warn(
        `Device "${device.name}" (${device.deviceExternalId}) does not carry the feature(s) ` +
          `${device.missingFeatures.join(', ')}: their values will be ignored by Gladys. ` +
          'Remove the device in Gladys and add it again from the Discovery screen.',
      );
    }

    // 4) Start the refresh loop. It publishes a first snapshot immediately:
    // whatever we held back while disconnected is republished.
    restartRefreshLoops();

    // 5) Report the application-level status, shown in the Configuration
    // screen. Distinct from the container state machine: an integration can be
    // RUNNING and still unable to read what it supervises.
    if (outdatedDevices.length > 0) {
      await gladys.setConnectionStatus(false, outdatedDevicesMessage(outdatedDevices));
    } else {
      await gladys.setConnectionStatus(true);
    }
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
      })
      .catch(() => {});
  }
});

gladys.on('disconnected', () => {
  stopRefreshLoops();
});

/**
 * Turn the outdated devices into the message shown in the Configuration
 * screen. It names the culprit and gives the only fix: the core never updates
 * the features of a device already created, so it has to be created again.
 * @param {{name: string, missingFeatures: string[]}[]} devices - Outdated devices.
 * @returns {{en: string, fr: string}} The message.
 */
function outdatedDevicesMessage(devices) {
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

/**
 * Stop the running refresh loops, then start them again with the current
 * configuration. The throttle is cleared first so the restart publishes a full
 * snapshot rather than silently skipping unchanged metrics.
 * @returns {void}
 */
function restartRefreshLoops() {
  stopRefreshLoops();
  resetThrottles();
  pushCleanups = DEVICE_BLUEPRINTS.filter(
    (blueprint) => typeof blueprint.startPush === 'function',
  ).map((blueprint) => blueprint.startPush(gladys, config));
}

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

// --- Graceful shutdown -------------------------------------------------------
// The SDK disconnects cleanly and exits with code 0 when the supervisor stops
// the container (SIGTERM/SIGINT).
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  stopRefreshLoops();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the host supervision integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
