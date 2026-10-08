# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-08

First public release.

### Added

- **Projects** that attach components from a shared library and hold their own connections and map zones.
- **Component library** (PCBs, motors, power supplies and other parts) with photo upload. Photos are
  converted to WebP and auto-rotated from EXIF.
- **Connector drawing** on component photos. Rectangles are stored normalized to the image size and
  autosaved per connector.
- **Connector types and cables** as shared library entries.
- **Connections editor** for pin-to-pin wiring between connectors, including harnesses (more than two
  connectors), split pins and inline connectors or splices that are not on a component.
- **Wiring diagram** view of a single connection.
- **Project map** with one block per component, one line per component pair that shares wires (followed
  through inline connectors), and zones for grouping.
- **Backup and restore** of the whole database and all pictures as one `.tar.gz` file, from the browser
  or with `curl`. Restore is all-or-nothing and refuses to overwrite existing data unless `replace=true`.
- **Docker Compose setup** with PostgreSQL. The database password can be set with `POSTGRES_PASSWORD`
  and defaults to `wirenode`.
- MIT license.

[0.1.0]: https://github.com/pazstudio/Wire-Node/releases/tag/v0.1.0
