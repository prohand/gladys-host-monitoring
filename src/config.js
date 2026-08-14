// -----------------------------------------------------------------------------
// Integration configuration.
//
// The values are filled in by the user in Gladys, from the `config_schema`
// declared in `gladys-assistant-integration.json`. The SDK fetches them
// (`gladys.getConfig()`) and notifies every change (`gladys.onConfigUpdated()`).
//
// This module holds the defaults and normalizes the received object, so the
// rest of the code never deals with `undefined`, with a string where a number
// is expected, or with a value outside the range the manifest advertises.
//
// The clamping is not decoration: `refresh_interval` drives how often we write
// to the Gladys database, and a form (or a hand-edited variable) is not a
// trustworthy source for that.
// -----------------------------------------------------------------------------

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest (enforced by test/manifest.test.js).
export const DEFAULT_CONFIG = {
  device_name: 'Machine hôte',
  disk_path: '/data',
  temperature_sensor_path: '', // empty: auto-detect
  refresh_interval: 300, // seconds between two reads
  min_variation: 2, // percentage points
  min_variation_temperature: 1, // degrees Celsius
  max_interval_minutes: 60, // publish at least once per hour, even if flat
  keep_history: true,
};

// Bounds mirrored from the manifest `min`/`max`. Kept here so a value that
// never went through the form (a restored variable, a manual edit) is still
// brought back into the supported range instead of, say, polling every second.
const BOUNDS = {
  refresh_interval: { min: 60, max: 3600 },
  min_variation: { min: 0, max: 50 },
  min_variation_temperature: { min: 0, max: 20 },
  max_interval_minutes: { min: 5, max: 1440 },
};

/**
 * Coerce to a finite number, falling back to the default when the value is
 * missing or unparsable (a form sends strings, an empty input sends '').
 * @param {unknown} value - Raw value.
 * @param {number} fallback - Value used when `value` is not a finite number.
 * @returns {number} A finite number.
 */
function toNumber(value, fallback) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Clamp a number into [min, max].
 * @param {number} value - Value to clamp.
 * @param {{min: number, max: number}} bounds - Inclusive bounds.
 * @returns {number} The clamped value.
 */
function clamp(value, { min, max }) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Read a numeric config key: coerce, then clamp to the manifest bounds.
 * @param {Record<string, unknown>} raw - Raw config.
 * @param {string} key - Config key.
 * @returns {number} The normalized value.
 */
function numericField(raw, key) {
  return clamp(toNumber(raw[key], DEFAULT_CONFIG[key]), BOUNDS[key]);
}

/**
 * Read a string config key: trim, and fall back to the default when empty —
 * except for the keys whose empty value is meaningful (auto-detection).
 * @param {Record<string, unknown>} raw - Raw config.
 * @param {string} key - Config key.
 * @param {{allowEmpty?: boolean}} options - Whether an empty string is a valid value.
 * @returns {string} The normalized value.
 */
function stringField(raw, key, { allowEmpty = false } = {}) {
  const value = typeof raw[key] === 'string' ? raw[key].trim() : '';
  if (value === '' && !allowEmpty) {
    return DEFAULT_CONFIG[key];
  }
  return value;
}

/**
 * Merge the user config with the defaults and normalize the types.
 * @param {Record<string, unknown>} raw - Config returned by the SDK.
 * @returns {typeof DEFAULT_CONFIG} The normalized configuration.
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    device_name: stringField(raw, 'device_name'),
    disk_path: stringField(raw, 'disk_path'),
    // Empty means "auto-detect the CPU sensor", so it must survive normalization.
    temperature_sensor_path: stringField(raw, 'temperature_sensor_path', { allowEmpty: true }),
    refresh_interval: numericField(raw, 'refresh_interval'),
    min_variation: numericField(raw, 'min_variation'),
    min_variation_temperature: numericField(raw, 'min_variation_temperature'),
    max_interval_minutes: numericField(raw, 'max_interval_minutes'),
    // A checkbox: anything but an explicit false keeps the history on.
    keep_history: raw.keep_history !== false,
  };
}
