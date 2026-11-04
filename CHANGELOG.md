# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Wiring summary** of a project: a readable Markdown file with every component, connector and pin, what each
  pin is wired to (followed through inline connectors and splices), the free connectors, and each connection
  wire by wire. Download it with **Wiring summary** on the project page, e.g. to give to an AI assistant for
  writing firmware config or G-code, or asking where a new part can be plugged in. Backups also contain one
  per project, in the `wiring` folder.
- **The same component can be placed in a project more than once**, each time under its own name, such
  as "Main board - Master" and "Main board - Slave". Connections, the connection editor and the project map
  keep the placements apart. "Add existing component" lists the whole library, and each card has
  **Add another**.
- When uploading a component, an optional **name in this project** can be given next to the component name.
- **Zones in the connection editor** group connectors by machine part (e.g. "Frame", "Printbed", "Toolhead").
  With connectors selected, **+ Zone** draws the zone around them. Zones also show on the wiring diagram.
- Dragging a zone by its name (on the project map or in a connection) moves everything inside it along.
- **Box selection**: drag on empty canvas to select several connectors (connection editor) or component blocks
  (project map, Edit mode) and move them together. Pan with the right or middle mouse button, or hold Space.
- Choose a **folder** when uploading a component or adding an existing one. "Add another" suggests the folder
  of the card it was clicked on.
- **Duplicate a project**, e.g. to start a new revision of a machine. The copy has the same components,
  folders, map and connections (with their wires and zones). Library components, connectors and cables stay shared.
- **Lock a project** (e.g. after the device shipped) with the button on the project page. A locked project keeps its
  own frozen copy of every component (with its picture and connectors), connector type and cable it uses, so editing
  or deleting them in the library no longer changes it. Nothing in a locked project can be changed, and it cannot be
  deleted; renaming it is still possible. Duplicate it to start the next revision, which goes back to the library
  items. Unlocking does the same. A component that was deleted from the library (or lost a connector that is wired)
  is put back into the library instead, so no wiring is lost.
- Opening a connector on a component shows the **connections it is used in** (in this project) as small
  diagrams, with the connector highlighted. Clicking a diagram opens that connection.

### Changed

- Component names in the library must be unique (ignoring case). Uploading a component whose name is
  already in the library is refused and offers to place the existing one instead.
- Removing a component from a project now also removes its connectors and their wires from that project's
  connections. The confirmation lists the affected connections.
- Duplicating a connector on a component continues its numbering ("V.out1" becomes "V.out2", "J3" the next free
  J number) instead of adding "copy". A name that ends in a number is numbered the same way.
- Backup format v6 (folders, connection zones, locked projects). Older v1–v5 backups still restore.
- The connector form asks for **pins per row**. A connector with 5 pins in 2 rows now has 10 pins
  (it had 5 before), and the form shows the total.

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
