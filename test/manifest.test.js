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
import {
  ALERT_METRICS,
  DEFAULT_WIDGET_CHART_INTERVAL,
  WIDGET_CHART_INTERVALS,
  buildAlertEventData,
  buildSceneOutputs,
} from '../src/devices/hostMonitor.js';
import { ALERT_STATUS } from '../src/publish/alerts.js';
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

/**
 * The minimum Gladys version the manifest claims compatibility with.
 * @returns {[number, number]} Major and minor of the `>=` bound.
 */
function minimumGladysVersion() {
  const match = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.\d+/);
  assert.ok(match, 'gladys_version must declare a minimum version');
  return [Number(match[1]), Number(match[2])];
}

/**
 * The keys a blueprint field lists, across every blueprint.
 * @param {string} field - Blueprint field (`sceneActions`, `widgets`…).
 * @returns {Set<string>} The keys.
 */
function blueprintKeys(field) {
  return new Set(
    DEVICE_BLUEPRINTS.flatMap((bp) => {
      const value = bp[field] ?? [];
      return Array.isArray(value) ? value : Object.keys(value);
    }),
  );
}

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
  assert.deepEqual(Object.keys(manifest.description), ['en', 'fr', 'de', 'es']);
  for (const [language, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${language} must hold between 10 and 100 characters (got ${text.length})`,
    );
  }
  assert.match(manifest.docker_image, /:[\w.-]+$/, 'the image reference needs an explicit tag');
  assert.match(manifest.cover_image, /^https:\/\//);
});

// The store's controlled vocabulary of catalog shelves (Gladys 5.3 added the
// last four). An unknown key is not rejected, it is DROPPED with a warning: a
// typo silently costs the integration its shelf.
const CATALOG_CATEGORIES = [
  'climate',
  'lighting',
  'energy',
  'security',
  'multimedia',
  'appliances',
  'environment',
  'protocols',
  'network',
  'notifications',
  'assistants',
  'services',
  'transport',
  'vehicles',
  'servers',
  'leisure',
];

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  // What no external check can catch is the coupling: cores older than 4.86
  // validate manifests against a strict field allowlist and reject *any*
  // unknown top-level field, so declaring `categories` while still claiming
  // compatibility with an older Gladys turns a catalog entry into a cryptic
  // install failure.
  assert.ok(
    manifest.categories.length >= 1 && manifest.categories.length <= 3,
    'the store accepts 1 to 3 categories',
  );
  assert.equal(new Set(manifest.categories).size, manifest.categories.length);
  for (const category of manifest.categories) {
    assert.ok(CATALOG_CATEGORIES.includes(category), `unknown catalog category "${category}"`);
  }
  const [major, minor] = minimumGladysVersion();
  assert.ok(
    major > 4 || (major === 4 && minor >= 86),
    `categories requires gladys_version >= 4.86.0, got "${manifest.gladys_version}"`,
  );
});

test('the search keywords follow the store rules', () => {
  // 1 to 10 search-only terms of 2 to 30 characters, unique once trimmed and
  // lowercased: the store rejects the manifest otherwise.
  const { keywords } = manifest;
  assert.ok(Array.isArray(keywords) && keywords.length >= 1 && keywords.length <= 10);
  const normalized = keywords.map((keyword) => keyword.trim().toLowerCase());
  assert.equal(new Set(normalized).size, keywords.length, 'keywords must be unique');
  for (const keyword of normalized) {
    assert.ok(keyword.length >= 2 && keyword.length <= 30, `keyword "${keyword}" length`);
  }
});

test('the integration is worldwide: no countries declared', () => {
  // `countries` hides an integration from the catalog shelves of every other
  // country. A machine runs Gladys anywhere.
  assert.equal(manifest.countries, undefined);
});

test('declaring keywords, countries or music requires Gladys >= 5.3.0', () => {
  // Gladys 5.3 is the first core accepting these fields; an older one rejects
  // the whole manifest over an unknown field.
  const fields = ['keywords', 'countries', 'music'].filter(
    (field) => manifest[field] !== undefined,
  );
  assert.ok(fields.length > 0);
  const [major, minor] = minimumGladysVersion();
  assert.ok(
    major > 5 || (major === 5 && minor >= 3),
    `${fields.join(', ')} requires gladys_version >= 5.3.0, got "${manifest.gladys_version}"`,
  );
});

// --- Gladys 5.1 capabilities: scene triggers, scene actions, widgets ---------

test('declaring widgets or scene capabilities requires Gladys >= 5.1.0', () => {
  // Same coupling as `categories`: an older core rejects the unknown fields.
  const capabilities = ['widgets', 'scene_triggers', 'scene_actions'].filter(
    (field) => manifest[field] !== undefined,
  );
  if (capabilities.length === 0) {
    return;
  }
  const [major, minor] = minimumGladysVersion();
  assert.ok(
    major > 5 || (major === 5 && minor >= 1),
    `${capabilities.join(', ')} requires gladys_version >= 5.1.0, got "${manifest.gladys_version}"`,
  );
});

test('the scene triggers fired by the code are exactly the declared ones', () => {
  // An undeclared key is a 404 on every event; a declared key the code never
  // fires is a card in the scene editor that never starts anything.
  assert.deepEqual(
    new Set((manifest.scene_triggers ?? []).map((trigger) => trigger.key)),
    blueprintKeys('sceneTriggers'),
  );
});

test('the threshold_alert event only carries declared keys, and its filters match the code', () => {
  const trigger = manifest.scene_triggers.find(({ key }) => key === 'threshold_alert');
  const declared = new Set([
    ...trigger.fields.map((field) => field.key),
    ...trigger.variables.map((variable) => variable.key),
  ]);
  const data = buildAlertEventData(
    { metric: 'disk', status: ALERT_STATUS.RAISED, value: 95, threshold: 90 },
    normalizeConfig(),
  );
  // The core drops any key it does not know: it would never reach a scene.
  for (const key of Object.keys(data)) {
    assert.ok(declared.has(key), `event key "${key}" is not declared in the trigger`);
  }
  for (const variable of trigger.variables) {
    assert.equal(typeof data[variable.key], variable.type, `variable "${variable.key}" type`);
  }

  const options = (key) =>
    trigger.fields.find((field) => field.key === key).options.map((option) => option.value);
  assert.deepEqual(
    options('metric'),
    ALERT_METRICS.map((entry) => entry.metric),
  );
  assert.deepEqual(options('status'), Object.values(ALERT_STATUS));
});

test('every alert threshold is a config key', () => {
  for (const entry of ALERT_METRICS) {
    assert.ok(entry.configKey in DEFAULT_CONFIG, `${entry.configKey} is not a config key`);
  }
});

test('the scene actions handled by the code are exactly the declared ones', () => {
  assert.deepEqual(
    new Set((manifest.scene_actions ?? []).map((action) => action.key)),
    blueprintKeys('sceneActions'),
  );
});

test('read_metrics resolves exactly its declared outputs', () => {
  // The core keeps only the declared outputs: an undeclared one is lost, a
  // declared one never resolved is always empty in the scene.
  const action = manifest.scene_actions.find(({ key }) => key === 'read_metrics');
  const outputs = buildSceneOutputs({
    cpuPercent: 1,
    memoryPercent: 2,
    diskPercent: 3,
    diskFreeGib: 4,
    temperature: 5,
  });
  assert.deepEqual(Object.keys(outputs).sort(), action.outputs.map((output) => output.key).sort());
  for (const output of action.outputs) {
    assert.equal(typeof outputs[output.key], output.type, `output "${output.key}" type`);
  }
});

test('the widgets handled by the code are exactly the declared ones', () => {
  assert.deepEqual(
    new Set((manifest.widgets ?? []).map((widget) => widget.key)),
    blueprintKeys('widgets'),
  );
});

test('the host_health chart setting offers the intervals the code understands', () => {
  const widget = manifest.widgets.find(({ key }) => key === 'host_health');
  const setting = widget.settings.find(({ key }) => key === 'chart_interval');
  assert.deepEqual(
    setting.options.map((option) => option.value),
    WIDGET_CHART_INTERVALS,
  );
  assert.equal(setting.default, DEFAULT_WIDGET_CHART_INTERVAL);
});

// --- Languages ---------------------------------------------------------------

// The languages of the Gladys interface: every text a user reads carries all of
// them (the core falls back on `en` for a missing one, which would show English
// to a German or Spanish user without anyone noticing).
const LANGUAGES = ['en', 'fr', 'de', 'es'];

/**
 * Every multi-language object of the manifest, with its JSON path.
 * @param {unknown} node - Part of the manifest.
 * @param {string} path - Path of `node`.
 * @returns {{path: string, text: Record<string, string>}[]} The texts.
 */
function multiLanguageTexts(node, path = '') {
  if (Array.isArray(node)) {
    return node.flatMap((item, index) => multiLanguageTexts(item, `${path}[${index}]`));
  }
  if (node === null || typeof node !== 'object') {
    return [];
  }
  if (typeof node.en === 'string') {
    return [{ path, text: node }];
  }
  return Object.entries(node).flatMap(([key, value]) =>
    multiLanguageTexts(value, path ? `${path}.${key}` : key),
  );
}

test('every manifest text is written in every Gladys language', () => {
  const texts = multiLanguageTexts(manifest);
  assert.ok(texts.length > 50, 'the walk must find the manifest texts');
  for (const { path, text } of texts) {
    assert.deepEqual(Object.keys(text), LANGUAGES, `${path} must be { en, fr, de, es }`);
    for (const language of LANGUAGES) {
      assert.ok(text[language].trim().length > 0, `${path}.${language} is empty`);
    }
  }
});

test('the widget and section texts stay within the store limits in every language', () => {
  for (const widget of manifest.widgets) {
    for (const language of LANGUAGES) {
      const label = widget.label[language];
      assert.ok(label.length >= 3 && label.length <= 30, `widget label.${language}: "${label}"`);
      assert.ok(widget.description[language].length <= 100, `widget description.${language}`);
    }
  }
  for (const section of manifest.config_schema.filter((field) => field.type === 'section')) {
    for (const language of LANGUAGES) {
      assert.ok(
        section.description[language].length <= 1000,
        `section "${section.key}" description.${language} exceeds 1000 characters`,
      );
    }
  }
});
