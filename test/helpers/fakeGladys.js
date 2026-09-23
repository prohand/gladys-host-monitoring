// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface the device module relies on:
//   - externalIds(type, platformId) -> { device, feature(key) }
//   - publishState / publishStates   -> record calls so tests can assert them
//   - publishDiscoveredDevices       -> record calls so tests can assert them
//   - setConnectionStatus            -> record calls so tests can assert them
//   - publishSceneEvent              -> record calls so tests can assert them
//   - requestWidgetRefresh           -> record calls so tests can assert them
//   - devices                        -> the devices "created by the user"
// This lets us test the wiring (discovery payload, throttling, dispatch)
// without a running Gladys server or a real WebSocket.
// -----------------------------------------------------------------------------

/**
 * Build a fake SDK instance.
 * @returns {object} The fake, with the recorded calls exposed as arrays.
 */
export function createFakeGladys() {
  const published = [];
  const discovered = [];
  const connectionStatuses = [];
  const sceneEvents = [];
  const widgetRefreshes = [];

  return {
    published,
    discovered,
    connectionStatuses,
    sceneEvents,
    widgetRefreshes,
    devices: [],

    externalIds(type, platformId) {
      const device = `ext:host-monitoring:${type}:${platformId}`;
      return {
        device,
        feature: (key) => `${device}:${key}`,
      };
    },

    async publishState(featureExternalId, state) {
      published.push({ featureExternalId, state });
    },

    async publishStates(states) {
      for (const state of states) {
        published.push({
          featureExternalId: state.device_feature_external_id,
          state: state.state,
        });
      }
    },

    async publishDiscoveredDevices(devices) {
      discovered.push(devices);
    },

    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
    },

    async publishSceneEvent(key, data) {
      sceneEvents.push({ key, data });
    },

    requestWidgetRefresh(key) {
      widgetRefreshes.push(key);
    },
  };
}
