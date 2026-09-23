// -----------------------------------------------------------------------------
// Device registry.
//
// This integration publishes a single device (the host machine), but the
// registry shape from the official template is kept: adding a second device
// type later — a per-container monitor, a second mount point — is then a new
// file and one line here, with no change to index.js.
//
// Each device module exposes:
//   - key                        : short identifier (used in logs)
//   - deviceExternalId(gladys)   : the device external_id (for dispatch)
//   - buildDevice(gladys, config): the discovery payload sent to Gladys
//   - startPush(gladys, config)   (optional): start a refresh loop / a
//     subscription, and return the function that stops it
//   - refreshNow(gladys, config)  (optional): publish a full snapshot now
//   - resetThrottle()             (optional): forget the published values
//   - actions                     (optional): manifest action handlers, keyed
//     by the action `key` declared in gladys-assistant-integration.json
//   - sceneTriggers               (optional): keys of the manifest
//     `scene_triggers` the blueprint fires through publishSceneEvent
//   - sceneActions                (optional): manifest `scene_actions` handlers,
//     keyed by action key, resolving the declared `outputs`
//   - widgets                     (optional): manifest `widgets` handlers, keyed
//     by widget key: { get(gladys, ctx), action?(gladys, key, params, ctx) }
// -----------------------------------------------------------------------------

import { hostMonitor } from './hostMonitor.js';

export const DEVICE_BLUEPRINTS = [hostMonitor];

/**
 * Build the discovery payload for Gladys (all devices).
 * @param {object} gladys - The SDK instance.
 * @param {object} config - Normalized configuration.
 * @returns {object[]} The discovered devices.
 */
export function buildDiscoveredDevices(gladys, config) {
  return DEVICE_BLUEPRINTS.map((blueprint) => blueprint.buildDevice(gladys, config));
}

/**
 * Find the blueprint that owns a given device, from its external_id.
 * @param {object} gladys - The SDK instance.
 * @param {{external_id: string}} device - The device to route.
 * @returns {object | undefined} The owning blueprint, if any.
 */
export function findBlueprintByDevice(gladys, device) {
  return DEVICE_BLUEPRINTS.find(
    (blueprint) => blueprint.deviceExternalId(gladys) === device.external_id,
  );
}

/**
 * List the devices the user already created whose features no longer match the
 * ones we publish today.
 *
 * Why this check exists: `publishDiscoveredDevices` is NOT an upsert of an
 * already-created device. The Gladys core stores the published list in memory
 * for the Discovery screen and, for a device the user has already created, only
 * upserts its `params` — never its features (see
 * `externalIntegration.setDiscoveredDevices` in the Gladys server). So a device
 * created by an older version of this integration keeps the feature external_ids
 * it was created with, forever.
 *
 * The failure that follows is completely silent from here: Gladys accepts the
 * states, finds no feature for the external_id, and drops them with an `info`
 * line in the SERVER logs. The device then sits in the UI with a "no recent
 * value" badge, which is exactly the symptom this function turns into an
 * actionable message.
 * @param {object} gladys - The SDK instance.
 * @param {object[]} createdDevices - The devices actually created by the user (gladys.getDevices()).
 * @param {object} config - Normalized configuration.
 * @returns {{name: string, deviceExternalId: string, missingFeatures: string[]}[]} One entry per outdated device.
 */
export function findOutdatedDevices(gladys, createdDevices, config) {
  const outdated = [];

  for (const blueprint of DEVICE_BLUEPRINTS) {
    const deviceExternalId = blueprint.deviceExternalId(gladys);
    const created = (createdDevices ?? []).find(
      (device) => device.external_id === deviceExternalId,
    );
    // Not created yet: the user has not added it from the Discovery screen.
    // That is a normal state, not an outdated device.
    if (created === undefined) {
      continue;
    }
    const present = new Set((created.features ?? []).map((feature) => feature.external_id));
    const missingFeatures = blueprint
      .buildDevice(gladys, config)
      .features.map((feature) => feature.external_id)
      .filter((externalId) => !present.has(externalId));

    if (missingFeatures.length > 0) {
      outdated.push({ name: created.name, deviceExternalId, missingFeatures });
    }
  }

  return outdated;
}

/**
 * Publish a full snapshot for the blueprint owning a device, immediately.
 *
 * Called when Gladys tells us the user created (or updated) one of our devices:
 * that is the moment the feature external_ids we have been publishing into the
 * void finally exist, and the moment the device must stop showing "no recent
 * value".
 * @param {object} gladys - The SDK instance.
 * @param {{external_id: string}} device - The device Gladys just created or updated.
 * @param {object} config - Normalized configuration.
 * @returns {Promise<boolean>} True when a blueprint took the device.
 */
export async function refreshDeviceNow(gladys, device, config) {
  const blueprint = findBlueprintByDevice(gladys, device);
  if (blueprint === undefined || typeof blueprint.refreshNow !== 'function') {
    return false;
  }
  await blueprint.refreshNow(gladys, config);
  return true;
}

/**
 * Forget every published value, so the next refresh publishes a full snapshot.
 * @returns {void}
 */
export function resetThrottles() {
  for (const blueprint of DEVICE_BLUEPRINTS) {
    blueprint.resetThrottle?.();
  }
}
