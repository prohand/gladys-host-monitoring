// -----------------------------------------------------------------------------
// Connection and configuration lifecycle: the refresh loops must be armed even
// when Gladys does not answer the calls that follow a (re)connection.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycle } from '../src/lifecycle.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * A blueprint recording how many refresh loops were started and stopped.
 * @returns {object} The blueprint, with its counters.
 */
function fakeBlueprint() {
  const blueprint = {
    key: 'fake',
    started: [],
    stopped: 0,
    deviceExternalId: (gladys) => gladys.externalIds('fake', 'local').device,
    buildDevice: (gladys) => ({
      name: 'Fake',
      external_id: gladys.externalIds('fake', 'local').device,
      features: [],
    }),
    resetThrottle() {},
    startPush(_gladys, config) {
      blueprint.started.push(config);
      return () => {
        blueprint.stopped += 1;
      };
    },
  };
  return blueprint;
}

/**
 * A fake SDK whose config and device reads can be made to fail.
 * @param {{getConfig?: Function, getDevices?: Function, publishDiscoveredDevices?: Function}} overrides - Replaced methods.
 * @returns {object} The fake.
 */
function fakeGladys(overrides = {}) {
  return {
    ...createFakeGladys(),
    getConfig: async () => ({ refresh_interval: 120 }),
    getDevices: async () => [],
    ...overrides,
  };
}

const timeout = () => Promise.reject(new Error('Request timed out'));

test('a connection arms the loops and reports a healthy status', async () => {
  const blueprint = fakeBlueprint();
  const gladys = fakeGladys();
  const lifecycle = createLifecycle(gladys, { blueprints: [blueprint], logger: silentLogger });

  await lifecycle.onConnected();

  assert.equal(blueprint.started.length, 1);
  assert.equal(blueprint.started[0].refresh_interval, 120);
  assert.equal(gladys.discovered.length, 1);
  assert.deepEqual(gladys.connectionStatuses, [{ connected: true, message: undefined }]);
});

test('the loops are armed even when getDevices times out after a connection', async () => {
  const blueprint = fakeBlueprint();
  const gladys = fakeGladys({ getDevices: timeout });
  const lifecycle = createLifecycle(gladys, { blueprints: [blueprint], logger: silentLogger });

  await lifecycle.onConnected();

  assert.equal(blueprint.started.length, 1, 'the refresh loop must run anyway');
  assert.equal(blueprint.started[0].refresh_interval, 120);
  assert.equal(gladys.connectionStatuses.at(-1).connected, false);
});

test('the loops are armed even when the device publication fails', async () => {
  const blueprint = fakeBlueprint();
  const gladys = fakeGladys({ publishDiscoveredDevices: timeout });
  const lifecycle = createLifecycle(gladys, { blueprints: [blueprint], logger: silentLogger });

  await lifecycle.onConnected();

  assert.equal(blueprint.started.length, 1);
});

test('the loops are armed with the last known config when it cannot be read', async () => {
  const blueprint = fakeBlueprint();
  const gladys = fakeGladys({ getConfig: timeout });
  const lifecycle = createLifecycle(gladys, { blueprints: [blueprint], logger: silentLogger });

  await lifecycle.onConnected();

  assert.equal(blueprint.started.length, 1);
  assert.equal(blueprint.started[0].refresh_interval, 300, 'the defaults');
});

test('a configuration change restarts the loops even when the publication fails', async () => {
  const blueprint = fakeBlueprint();
  const gladys = fakeGladys({ publishDiscoveredDevices: timeout });
  const lifecycle = createLifecycle(gladys, { blueprints: [blueprint], logger: silentLogger });

  await lifecycle.onConfigUpdated({ refresh_interval: 600 });

  assert.equal(blueprint.started.length, 1);
  assert.equal(blueprint.started[0].refresh_interval, 600);
  assert.equal(lifecycle.config.refresh_interval, 600);
});

test('a reconnection replaces the running loop instead of stacking a second one', async () => {
  const blueprint = fakeBlueprint();
  const lifecycle = createLifecycle(fakeGladys(), {
    blueprints: [blueprint],
    logger: silentLogger,
  });

  await lifecycle.onConnected();
  await lifecycle.onConnected();
  lifecycle.stopRefreshLoops();

  assert.equal(blueprint.started.length, 2);
  assert.equal(blueprint.stopped, 2);
});
