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
//   - resetThrottle()             (optional): forget the published values
//   - actions                     (optional): manifest action handlers, keyed
//     by the action `key` declared in gladys-assistant-integration.json
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
 * Forget every published value, so the next refresh publishes a full snapshot.
 * @returns {void}
 */
export function resetThrottles() {
  for (const blueprint of DEVICE_BLUEPRINTS) {
    blueprint.resetThrottle?.();
  }
}
