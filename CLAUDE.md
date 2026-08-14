# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Gladys Assistant **external integration** (a container the Gladys supervisor runs alongside the
server) that publishes one device carrying the health of the host machine: CPU usage, memory usage,
disk usage, free disk space and CPU temperature. Everything is read from `/proc` and `/sys`;
communication with Gladys goes through `@gladysassistant/integration-sdk` over a WebSocket the SDK
manages itself.

ESM only (`"type": "module"`), no build step, no test framework — the built-in `node --test` runner
and no runtime dependency besides the SDK.

## Commands

```bash
npm test                                   # all tests (node --test)
node --test test/throttle.test.js          # one file
node --test --test-name-pattern "heartbeat"  # one test by name
npm run lint                               # ESLint
npm run format:check                       # Prettier (CI gate; npm run format to fix)
npx github:GladysAssistant/integration-store .   # store manifest validator, before a release
```

CI runs `format:check`, `lint`, `test` on Node 24 (the version in the Dockerfile) for every push and
PR. Run all three before pushing — a formatting miss fails the build.

Running locally against a Gladys server:

```bash
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="supervision-hote" \
LOG_LEVEL=debug npm start
```

Those three `GLADYS_*` variables are injected by the supervisor in production; `new GladysIntegration()`
reads them on its own.

## Architecture

Four layers, each ignorant of the one above it:

- **`index.js`** — SDK wiring only, no measurement logic. Registers every handler _before_
  `connect()`, hot-reloads config via `onConfigUpdated`, owns the start/stop of the refresh loops.
- **`src/devices/`** — `index.js` is a registry over an array of _blueprints_; `hostMonitor.js` is the
  only blueprint today. A blueprint exposes `key`, `deviceExternalId(gladys)`,
  `buildDevice(gladys, config)` and optionally `startPush`, `refreshNow`, `resetThrottle`, `actions`.
  Adding a second device type (another mount point, a per-container monitor) is a new file plus one
  entry in `DEVICE_BLUEPRINTS`, with no change to `index.js`.
- **`src/metrics/`** — one file per metric, none of them aware of Gladys. `index.js` assembles them
  into a single snapshot and converts any failure into `null` (`safely()`), so a missing thermal
  sensor or an unmounted disk never blocks the other readings.
- **`src/publish/throttle.js`** — decides what actually reaches the database.

`src/config.js` sits beside all of it: defaults, type coercion and clamping, so no other module ever
sees a string where a number belongs.

### The constraint everything is built around

Gladys inserts **one history row per published state** — `device.saveState` writes unconditionally
when the feature keeps history, there is no server-side deduplication. Three mechanisms bound that,
and a change that weakens any of them defeats the purpose of the integration:

1. **The integration owns its schedule.** The device declares no `poll_frequency` because the core
   scheduler's slowest supported value is 60 s. `startPush` runs its own timer instead (default 300 s,
   clamped to `[60, 3600]` in `config.js` whatever the stored config says), and `onPoll` is
   effectively dead code kept registered so a future polled device does not get nacked.
2. **A per-feature deadband** measured against the _last published_ value, not the last reading — a
   slow drift still eventually crosses the threshold. Values are rounded _before_ the comparison
   (`round()` in `hostMonitor.js`), otherwise float noise makes every sample look like a change.
3. **A heartbeat**: publish anyway after `max_interval_minutes`, so flat metrics keep a continuous
   chart line.

The throttle deliberately splits **`filter()` (select, pure)** from **`commit()` (remember)**:
`commit` runs only after `gladys.publishStates` resolves. Committing earlier would lose a batch on a
failed call and hold the metric back for up to a full heartbeat interval. Keep that ordering.

`filter()` also drops non-finite readings, so an unavailable metric publishes nothing rather than a
fake `0` that would look like a real measurement on the charts.

### Gladys core behaviours the code works around

These are not obvious from the SDK surface and each one has code defending against it:

- **`publishDiscoveredDevices` does not update an already-created device's features.** The core
  re-upserts its `params` and nothing else, so a device created by an older version keeps its original
  feature `external_id`s forever, and states for new features are silently dropped. `findOutdatedDevices()`
  detects this on connect and surfaces it via `setConnectionStatus(false, …)` in the Configuration
  screen; the only fix for the user is deleting and re-adding the device.
- **The refresh loop starts before the user has created the device.** Those states are dropped by the
  core while the throttle records them as published, which would leave a brand-new device on "no
  recent value" for up to an hour. Hence `onDeviceCreated` / `onDeviceUpdated` → `refreshDeviceNow()`,
  which resets the throttle and publishes a full snapshot. Same reason for `resetThrottles()` on
  reconnect.
- **Gladys has no category for computer resources.** The three percentages use
  `LEVEL_SENSOR` + `SENSOR.DECIMAL` + `PERCENT` — a supported generic pair that renders as a
  percentage sensor with charts. The category is only an icon and a label; `saveState` never looks at
  it. Do not "fix" it to `UNKNOWN`, which shows a raw i18n key.
- **A feature that never receives a value looks broken forever**, so the temperature feature is only
  added to the device when `resolveTemperatureSensor()` finds a readable sensor. That is also why
  sensor detection is synchronous: `buildDevice()` needs the answer.

### Manifest ↔ code coupling

`gladys-assistant-integration.json` is the contract with the Gladys store, and `test/manifest.test.js`
enforces the parts no external validator can check: every manifest action has a handler in some
blueprint's `actions` (and vice versa), every `DEFAULT_CONFIG` key is declared in `config_schema` with
the same `default`, and `normalizeConfig` clamps to the manifest's `min`/`max`. Change a config key or
an action in one place and that test tells you about the other.

Never hand-edit `version` or `docker_image` — the **Release** workflow (Actions → Release → patch /
minor / major) bumps `package.json`, `package-lock.json` and both manifest fields together, tags
`vX.Y.Z` and triggers the multi-arch build.

## Conventions

- **Everything injectable.** Every module that touches the filesystem, the clock or timers takes its
  dependencies through an options object with real defaults (`createHostMonitor({ collector, throttle,
setIntervalFn, … })`, `readDisk(path, { statfsFn })`, `createStateThrottle({ now })`). Tests never
  need a Linux host, a Gladys server or a real clock — `test/helpers/fakeGladys.js` stands in for the
  SDK. Preserve that when adding code.
- **Metric readers never throw at the caller**: parse functions return `null` for unusable input, I/O
  wrappers catch and log.
- **Comments explain _why_, not what.** Each file opens with a header block stating the constraint it
  exists for, and inline comments document Gladys-core behaviour that would otherwise look like
  paranoia. Match that density; JSDoc on every exported function (ESLint config allows `_`-prefixed
  unused args).
- **User-facing strings are bilingual objects** `{ en, fr }` — action results, connection-status
  messages, manifest labels/descriptions. Device and feature names shown in Gladys are French.
- Documentation lives in `README.md` (developer-facing, kept current with the design decisions above)
  and `docs/{en,fr}.md` (user-facing, re-hosted by Gladys); update `docs/` in both languages together.
