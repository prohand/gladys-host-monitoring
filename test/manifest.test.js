// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers, nor which bounds the code
// enforces — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEVICE_BLUEPRINTS } from '../src/devices/index.js';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

test('every manifest action has a registered handler', () => {
  const handled = new Set(DEVICE_BLUEPRINTS.flatMap((bp) => Object.keys(bp.actions ?? {})));
  for (const action of manifest.actions ?? []) {
    assert.ok(handled.has(action.key), `manifest action "${action.key}" has no handler`);
  }
});

test('every registered handler is declared in the manifest', () => {
  const declared = new Set((manifest.actions ?? []).map((action) => action.key));
  for (const blueprint of DEVICE_BLUEPRINTS) {
    for (const key of Object.keys(blueprint.actions ?? {})) {
      assert.ok(declared.has(key), `handler "${key}" has no button in the manifest`);
    }
  }
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
});

test('every stored config key is declared in the manifest', () => {
  const declared = new Set(
    manifest.config_schema.filter((field) => field.type !== 'section').map((field) => field.key),
  );
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    assert.ok(declared.has(key), `DEFAULT_CONFIG.${key} is not in the config_schema`);
  }
});

test('normalizeConfig clamps to the min/max the manifest advertises', () => {
  // A user cannot ask, through the form, for a value the code would not honour.
  for (const field of manifest.config_schema) {
    if (field.type !== 'number') {
      continue;
    }
    assert.equal(
      normalizeConfig({ [field.key]: field.min - 1 })[field.key],
      field.min,
      `${field.key} must be clamped to its manifest min`,
    );
    assert.equal(
      normalizeConfig({ [field.key]: field.max + 1 })[field.key],
      field.max,
      `${field.key} must be clamped to its manifest max`,
    );
  }
});

test('the refresh interval can never drop below one minute', () => {
  // The whole point of the integration: never flood the Gladys history.
  const refreshInterval = manifest.config_schema.find((f) => f.key === 'refresh_interval');
  assert.ok(refreshInterval.min >= 60, 'the manifest must not offer a sub-minute interval');
  assert.equal(normalizeConfig({ refresh_interval: 0 }).refresh_interval, refreshInterval.min);
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((field) => field.type === 'section');
  assert.ok(sections.length > 0);
  for (const section of sections) {
    // A section stores NO value: declaring `required`, `default` or
    // `placeholder` on it rejects the manifest, and its key must never leak
    // into the config the code manipulates.
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.equal(
      section.placeholder,
      undefined,
      `section "${section.key}" must not have a placeholder`,
    );
    assert.ok(section.label?.en, `section "${section.key}" needs an English label`);
    assert.ok(
      !(section.key in DEFAULT_CONFIG),
      `section "${section.key}" stores no value and must not appear in DEFAULT_CONFIG`,
    );
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('the manifest stays within the store limits', () => {
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  for (const [language, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${language} must hold between 10 and 100 characters (got ${text.length})`,
    );
  }
  assert.match(manifest.docker_image, /:[\w.-]+$/, 'the image reference needs an explicit tag');
  assert.match(manifest.cover_image, /^https:\/\//);
});

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  // The controlled vocabulary is the store validator's job (an unknown key is
  // dropped with a warning there, not rejected). What no external check can
  // catch is the coupling: cores older than 4.86 validate manifests against a
  // strict field allowlist and reject *any* unknown top-level field, so
  // declaring `categories` while still claiming compatibility with an older
  // Gladys turns a catalog entry into a cryptic install failure.
  assert.ok(
    manifest.categories.length >= 1 && manifest.categories.length <= 3,
    'the store accepts 1 to 3 categories',
  );
  const minVersion = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.\d+/);
  assert.ok(minVersion, 'gladys_version must declare a minimum version');
  const [, major, minor] = minVersion.map(Number);
  assert.ok(
    major > 4 || (major === 4 && minor >= 86),
    `categories requires gladys_version >= 4.86.0, got "${manifest.gladys_version}"`,
  );
});
