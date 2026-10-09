# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **The same component can be placed in a project more than once**, each time under its own name, such
  as "Main board - Master" and "Main board - Slave". Connections, the connection editor and the project map
  keep the placements apart. "Add existing component" lists the whole library, and each card has
  **Add another**.
- When uploading a component, an optional **name in this project** can be given next to the component name.

### Changed

- Component names in the library must be unique (ignoring case). Uploading a component whose name is
  already in the library is refused and offers to place the existing one instead.
- Removing a component from a project now also removes its connectors and their wires from that project's
  connections. The confirmation lists the affected connections.
- Backup format v2. Older v1 backups still restore.

### Upgrading

- Existing data is upgraded automatically on start. Run `npm run db:push` (not `npx prisma db push`) when
  running from source.

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
