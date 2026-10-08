# Changelog

All notable changes to this integration are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/), bumped by the Release workflow.

## [Unreleased]

### Fixed

- The refresh loop is started before the device is published: a Gladys that did
  not answer right after a restart no longer stops every metric until the next
  reconnection. A configuration change restarts the loop even when the device
  cannot be published.
- The CPU temperature sensor is detected once (start, scan, configuration
  change) and then kept: a single implausible reading no longer publishes
  another sensor (NVMe, acpitz) as the CPU temperature, and sysfs is no longer
  scanned at every refresh. Three failed readings in a row trigger a new
  detection.
- A metric that does not answer within 5 seconds (a hung network share for the
  disk) is reported as unavailable instead of blocking every refresh, the
  actions and the scene action.
- "Read the metrics now", the widget button and the `read_metrics` scene action
  reuse a reading younger than 10 seconds instead of measuring the CPU over a
  few seconds, and no CPU alert is raised from a window shorter than 10 seconds.
- An unhandled promise rejection is logged instead of stopping the integration.

### Changed

- Node.js 22 or later is required (`engines`); CI tests Node 22 and 24 and
  builds the Docker image on pull requests.
- The Docker image installs strictly from the lock file and cleans the npm
  cache.
- Documentation: which disk is measured (the one holding the `/data` volume),
  when CPU and memory are not the host's (LXC with lxcfs, Docker Desktop), and
  why an alert still active is raised again after a restart.

## [2.2.0] - 2026-10-07

- Maintenance release, no functional change.

## [2.1.1] - 2026-10-07

### Added

- Widget chart: the CPU temperature curve, when the device has a sensor

## [2.1.0] - 2026-10-06

### Added

- `SECURITY.md`: how to report a vulnerability.
- `CHANGELOG.md`, rebuilt from the release history.

### Changed

- Development dependencies updated to their latest versions (ESLint 10.12, Prettier 3.9.9, globals 17.13).

## [2.0.2] - 2026-09-30

### Changed

- Fit the widget gauges and free-space tile on small tiles

## [2.0.1] - 2026-09-29

### Changed

- Show the % unit on the widget gauges (#7)

## [2.0.0] - 2026-09-23

### Added

- Widget, déclencheur et action de scène (Gladys 5.1)

## [1.0.2] - 2026-08-15

### Added

- SDK 0.12.0 et catégories du catalogue (Gladys 4.86)

### Fixed

- Couverture 800x534 et formatage du manifest à la release

## [1.0.1] - 2026-08-14

First public release.

### Added

- Intégration externe "Supervision hôte"
- Nouvelle image de couverture pour l'intégration

### Changed

- Ajouter CLAUDE.md pour guider Claude Code

### Fixed

- Détecter les appareils créés avec d'anciennes fonctionnalités
- Publier un instantané complet quand l'appareil est créé

[Unreleased]: https://github.com/prohand/gladys-host-monitoring/compare/v2.2.0...HEAD
[2.2.0]: https://github.com/prohand/gladys-host-monitoring/compare/v2.1.1...v2.2.0
[2.1.1]: https://github.com/prohand/gladys-host-monitoring/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/prohand/gladys-host-monitoring/compare/v2.0.2...v2.1.0
[2.0.2]: https://github.com/prohand/gladys-host-monitoring/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/prohand/gladys-host-monitoring/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/prohand/gladys-host-monitoring/compare/v1.0.2...v2.0.0
[1.0.2]: https://github.com/prohand/gladys-host-monitoring/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/prohand/gladys-host-monitoring/releases/tag/v1.0.1
