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
import {
  DEVICE_BLUEPRINTS,
  buildDiscoveredDevices,
  findBlueprintByDevice,
  refreshDeviceNow,
} from './src/devices/index.js';
import { createLifecycle } from './src/lifecycle.js';

const gladys = new GladysIntegration();

// Configuration, refresh loops and (re)connection sequence: see src/lifecycle.js.
const lifecycle = createLifecycle(gladys);

// Last-resort net for a promise rejection nobody handled (a fire-and-forget
// SDK call, a timer callback). Node's default is to kill the process, which
// would stop the supervision of the host for a glitch the next refresh does
// not even notice. Log it so it gets fixed, keep running. Deliberately no
// `uncaughtException` counterpart: a synchronous throw leaves the process in
// an unknown state, and the supervisor restarting the container is the right
// answer to that.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', reason);
});

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> publishing the host device');
  await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, lifecycle.config));
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
  await blueprint.onPoll(gladys, lifecycle.config);
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
  await refreshDeviceNow(gladys, device, lifecycle.config);
});

// Same treatment on update: the user may have edited the device features, so
// what we believe Gladys holds is stale again.
gladys.onDeviceUpdated(async (device) => {
  logger.info(`onDeviceUpdated (${device.external_id}) -> publishing a full snapshot`);
  await refreshDeviceNow(gladys, device, lifecycle.config);
});

// --- Manifest actions: buttons in the Configuration screen -------------------
// Each action declared in the `actions` field of the manifest is registered per
// key; the message resolved by the handler is displayed under the button (the
// ack is awaited under the action's `timeout_seconds`, not the usual 5 s).
for (const blueprint of DEVICE_BLUEPRINTS) {
  for (const [actionKey, handler] of Object.entries(blueprint.actions ?? {})) {
    gladys.onAction(actionKey, (fields) => handler(gladys, { fields, config: lifecycle.config }));
  }
}

// --- Scene actions: cards of the Gladys scene editor (Gladys >= 5.1) ---------
// Declared in the manifest `scene_actions`; `fields` arrive resolved (scene
// variables substituted, defaults applied) and the resolved object becomes the
// action `outputs`. Throwing fails this action only, the scene goes on.
for (const blueprint of DEVICE_BLUEPRINTS) {
  for (const [actionKey, handler] of Object.entries(blueprint.sceneActions ?? {})) {
    gladys.onSceneAction(actionKey, (fields) =>
      handler(gladys, { fields, config: lifecycle.config }),
    );
  }
}

// --- Dashboard widgets (Gladys >= 5.1) ---------------------------------------
// Declared in the manifest `widgets`. The core pulls the content (and caches it
// for its `ttl_seconds`); a button carrying an `action` lands in onWidgetAction.
for (const blueprint of DEVICE_BLUEPRINTS) {
  for (const [widgetKey, widget] of Object.entries(blueprint.widgets ?? {})) {
    gladys.onWidgetGet(widgetKey, ({ settings, language, units }) =>
      widget.get(gladys, { settings, language, units, config: lifecycle.config }),
    );
    if (typeof widget.action === 'function') {
      gladys.onWidgetAction(widgetKey, (actionKey, params, { settings }) =>
        widget.action(gladys, actionKey, params, { settings, config: lifecycle.config }),
      );
    }
  }
}

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  await lifecycle.onConfigUpdated(newConfig);
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK itself logs the WebSocket lifecycle (connections, disconnections,
// reconnection attempts) under the `gladys-sdk` name: no need to log it again
// here, these handlers only run the integration's own (re)initialization.
gladys.on('connected', () => lifecycle.onConnected());

gladys.on('disconnected', () => {
  lifecycle.stopRefreshLoops();
});

// --- Graceful shutdown -------------------------------------------------------
// The SDK disconnects cleanly and exits with code 0 when the supervisor stops
// the container (SIGTERM/SIGINT).
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  lifecycle.stopRefreshLoops();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the host supervision integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
