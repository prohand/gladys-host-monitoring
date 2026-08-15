# Supervision hôte — Gladys external integration

Reports the health of the machine Gladys runs on — **CPU usage, memory usage,
disk usage, free disk space and CPU temperature** — as a single Gladys device,
without flooding the Gladys database.

Built from the official
[JavaScript integration template](https://github.com/GladysAssistant/integration-template-js)
and the SDK
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

## The device

| Feature             | Category                    | Unit | Source                           |
| ------------------- | --------------------------- | ---- | -------------------------------- |
| Utilisation CPU     | `level-sensor` / decimal    | %    | `/proc/stat`                     |
| Utilisation mémoire | `level-sensor` / decimal    | %    | `/proc/meminfo` (`MemAvailable`) |
| Utilisation disque  | `level-sensor` / decimal    | %    | `statfs()` on the monitored path |
| Espace disque libre | `data` / size               | GiB  | `statfs()` on the monitored path |
| Température CPU     | `device-temperature-sensor` | °C   | `/sys/class/thermal` or `hwmon`  |

Everything is read locally from `/proc` and `/sys`: no agent, no cloud service,
no extra container privilege. `/proc/stat` and `/proc/meminfo` are not
namespaced by Docker, so a container reads the **host** figures; Docker mounts
`/sys` read-only by default, which is enough for the thermal sensors.

The temperature feature is only published when a readable sensor is found, so a
VM without thermal sensors gets four working features instead of one broken
fifth.

Gladys has no category for computer resources. The three percentages use
`level-sensor` / `decimal`, a supported generic combination that renders as a
plain percentage sensor with charts — the category is only a label and an icon
here (a water drop, since `level-sensor` is primarily the liquid-level
category), never something the core looks at when storing a value.

## Not flooding the Gladys database

This is the design constraint the whole integration is built around.

Gladys writes **one history row per published value** — `device.saveState`
inserts unconditionally when the feature keeps history, there is no server-side
deduplication. Five metrics published every 30 seconds is ~5 million rows a
year, almost all of them repeating the previous value. On a Raspberry Pi that is
paid in SD card wear.

Three mechanisms keep that under control:

1. **The integration owns its schedule.** The device declares no
   `poll_frequency`: the Gladys core scheduler only supports a fixed set of
   frequencies, the slowest being **one minute**
   (`DEVICE_POLL_FREQUENCIES` in the Gladys server constants — 1 s, 2 s, 10 s,
   15 s, 30 s, 60 s, anything else is rejected). So `startPush` starts our own
   timer, default **300 s**, clamped to `[60 s, 3600 s]` in
   [`src/config.js`](./src/config.js) whatever the stored configuration says.
2. **A deadband per feature.** A reading is published only when it moved by at
   least `min_variation` (2 points) — or `min_variation_temperature` (1 °C) —
   since the _last published_ value, not since the last reading, so a slow drift
   still crosses the threshold instead of being lost. Free space uses the same
   relative threshold expressed in GiB. Values are rounded first, otherwise
   floating-point noise defeats the deadband on its own.
3. **A heartbeat.** Each feature is published at least once per
   `max_interval_minutes` (60 min) even when perfectly flat, so charts keep a
   continuous line and Gladys never shows a stale value.

The logic is isolated and unit-tested in
[`src/publish/throttle.js`](./src/publish/throttle.js). A user who wants every
sample can set the variation to 0; a user who wants no history at all can turn
`keep_history` off.

With the defaults, a quiet machine writes a few dozen rows a day.

## Project structure

```
.
├─ index.js                          # SDK bootstrap + event wiring (no measurement logic)
├─ src/
│  ├─ devices/
│  │  ├─ index.js                    #   device registry
│  │  └─ hostMonitor.js              #   the host device: features, refresh loop, actions
│  ├─ metrics/
│  │  ├─ index.js                    #   collector: one call, one snapshot
│  │  ├─ cpu.js                      #   /proc/stat, delta between two snapshots
│  │  ├─ memory.js                   #   /proc/meminfo, MemAvailable based
│  │  ├─ disk.js                     #   statfs(), df-compatible percentage
│  │  └─ temperature.js              #   sysfs sensor detection + read
│  ├─ publish/throttle.js            # deadband + heartbeat: what reaches the database
│  └─ config.js                      # config defaults, normalization and clamping
├─ docs/{en,fr}.md                   # user documentation (re-hosted by Gladys)
├─ gladys-assistant-integration.json # manifest (name, config schema, image…)
├─ Dockerfile                        # Node 24 Alpine, read-only rootfs ready
└─ .github/workflows/                # CI, multi-arch build, UI-driven release
```

Every metric reader is a pure function plus a thin I/O wrapper, and every
dependency (filesystem, clock, timers, SDK) is injectable — the whole behaviour
is tested without a Linux host, a Gladys server or a real clock.

## Configuration

| Key                         | Default        | Purpose                                            |
| --------------------------- | -------------- | -------------------------------------------------- |
| `device_name`               | `Machine hôte` | Name of the device created in Gladys               |
| `disk_path`                 | `/data`        | Path whose filesystem is measured                  |
| `temperature_sensor_path`   | _(empty)_      | Sysfs sensor to read; empty means auto-detect      |
| `refresh_interval`          | `300`          | Seconds between two reads (60–3600)                |
| `min_variation`             | `2`            | Percentage points below which nothing is published |
| `min_variation_temperature` | `1`            | Same, in °C                                        |
| `max_interval_minutes`      | `60`           | Heartbeat: publish anyway after this long          |
| `keep_history`              | `true`         | Applied when the device is created                 |

Two buttons are available in the Configuration screen: **Read the metrics now**
(immediate read, result shown under the button) and **List temperature sensors**
(every visible sysfs sensor with its current reading, the one in use marked
`>`) — so "why is my temperature missing?" is answerable from the UI.

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="supervision-hote" \
LOG_LEVEL=debug \
npm start
```

The three `GLADYS_*` variables are injected by the Gladys supervisor when the
integration runs inside its sandboxed container. The SDK reads them
automatically.

## Quality checks

```bash
npm run format:check   # Prettier
npm run lint           # ESLint
npm test               # unit tests, built-in `node --test` runner
```

The same three checks run on every push and pull request
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

Before tagging a release, the store validator can be run locally:

```bash
npx github:GladysAssistant/integration-store .
```

## Publishing

The manifest declares `categories: ["services"]` — the catalog shelf the
integration sits on, since Gladys 4.86 browses the store by category and an
integration declaring none is only reachable through "All" and search. Host
supervision has no shelf of its own: "Services" is the generic one, where
"Network & presence", "Weather & environment" or "Energy" would each promise
something this integration does not do. Declaring the field forces
`gladys_version` to start at **4.86.0 or later** — older cores validate
manifests against a strict field allowlist and reject any unknown top-level
field — a coupling `test/manifest.test.js` pins.

1. Make the repository public and add the GitHub topic
   `gladys-assistant-integration`.
2. Keep `cover.png` at **exactly 800×534 px and ≤150 KB**: any other size and
   the store silently falls back to its own placeholder cover, with a warning
   in `rejected.json` as the only trace.
3. **Actions → Release → Run workflow**, pick `patch` / `minor` / `major`. The
   workflow bumps the version everywhere (`package.json` + manifest
   `version`/`docker_image`), reformats the manifest with Prettier (`jq` rewrites
   it in its own style, which would fail the `format:check` CI gate on the
   release commit), pushes the `vX.Y.Z` tag and builds the `linux/amd64` +
   `linux/arm64` image to `ghcr.io`.
4. The decentralized indexer picks up the new manifest version and Gladys offers
   a one-click install / update.

## License

Apache-2.0
