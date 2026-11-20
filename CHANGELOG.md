# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Units**: the machines built from a project (e.g. serial RC4-003), each with its own build checklist, test
  results, status (building, tested, shipped, retired), notes and comments.
- **Test results**: a wire's test can be marked as **failed** with a note ("no continuity"); failures show in
  red on the checklist and on the Build tab.
- **Test mode** for phones: one wire at a time in large text, with Pass / Fail buttons and skip, per unit and
  connection. The screen stays on while testing.
- **Checklist without a connection**: ticks made while the server cannot be reached are kept on the device and
  sent when it is back, with the time they were made.
- **Wires view** (Build tab): every wire in one table with filters (folder, connection, missing gauge, length or
  color), to set gauge, length, color or shielding on many wires at once. Each connection gets a history entry.
- **Drawings** (Build tab): harness drawings of one connection, or of a whole folder or project combined in one
  drawing, with colored wires, wire numbers, lengths and a wire list. Print or download as SVG. Every connector
  gets a reference (P1, P2…) with its connector type, number of positions and crimp, and all its cavities are
  listed (unused ones as NC), plus a connector table, so the drawing can be sent to a cable maker. **Download
  order list (CSV)** gives the same as a spreadsheet.
- **Firmware** (Build tab): a draft RepRapFirmware `config.g` (drives, endstops, probes, temperature sensors,
  heaters, fans, other inputs and outputs) or Klipper `printer.cfg` skeleton, from which device is wired to
  which controller port. The CAN address (or Klipper MCU name) of each board is set there.
- **Pin roles** (power, ground, input, output, CAN H, CAN L, shield) on the component's connector panel. New
  checks: CAN_H wired to CAN_L (also from pin names), two outputs joined, power wired to ground, an output on a
  supply.
- **Voltage drop check**: a warning when a wire on a supply net loses more than 3 % of the voltage at the max
  current of its pins, from its length and gauge.
- **Paste pin list** on the connector panel: fill pin names (and color, max current, role) from a datasheet or
  spreadsheet.
- **Restricted projects**: a project can be limited to chosen people (plus admins), e.g. a contractor's own
  project. Others do not see it anywhere. Set with **Access** on the project page (needs "Manage users").
- **Notifications** (Admin panel): a webhook for Slack, Discord, Teams, ntfy and others, on @mentions, new
  comments, failed wire tests and failed backups.
- **Backup restore test**: every automatic backup is unpacked and checked after it is written, and any stored
  backup can be checked with **Verify**. A failure is shown in the Backups tab and sent as a notification.
- **HTTPS** with Caddy: `docker-compose.https.yml` and `Caddyfile` (see README). Turns on offline viewing and
  installing the app on phones.

### Changed

- The Build tab, wiring summary and project comparison load only the projects they need instead of the whole
  database.

- **Build tab** on each project, with five views:
  - **Checks**: design checks of the wiring. Errors: two supplies wired together (from pin names such as
    24V, 5V, 3V3, GND, 0V), wires on a pin the connector does not have, wires too thin for the max current set
    on their pins. Warnings: wires without gauge, length or color, a pin wired in several connections. Notes:
    double crimps, free connectors, nets that join differently named pins. A finding can be marked as
    **intended** (with a note); it comes back if the pins involved change.
  - **Parts & cut list**: loose wire grouped by gauge, color and shielding with the total to cut, cables per
    connection, and connector housings, crimps and splices with where they go. An extra length per wire and
    a spare percentage can be added. Download as CSV or print.
  - **Checklist**: tick each wire as crimped and as tested, per connection or all at once, with progress
    bars. Ticks are shared, allowed in locked projects, and a wire changed after it was ticked shows as
    "changed". The Build tab shows the error count or the tested percentage.
  - **Labels**: wire-end labels (wire number, this end, far end, signal) and harness tags with a QR code that
    opens the connection, printed on A4 or downloaded as CSV for label printer software.
  - **Nets**: every set of pins joined by wires, followed through inline connectors and across connections,
    named after its pin names, with the max current on it.
- **Max current per pin** (optional, in A) in the component's connector panel, used by the gauge check.
- **Compare projects** (History tab): what differs from another project, e.g. the previous revision of the
  machine: components and connections added or removed, and wires added, removed or changed. Matched by
  name, so a duplicated project lines up with its original.
- **Import wires from CSV** (Connections tab): one wire per row; components, connectors and pins are matched
  by name, label or number, an empty component makes an inline connector. A preview lists the rows that
  cannot be placed. New connections are created, existing ones get the wires added, each with a history
  entry that can be reverted.
- **Comments** on connections, components and projects, with **@mentions**: the **@** button in the top bar
  lists open comments that mention you. Comments can be resolved.
- **Files on components**: attach datasheets, pinouts or measurements to a library component.
- **Read-only API tokens** (user menu → API tokens), for scripts: `Authorization: Bearer wn_…`. They can only
  read, and never get admin rights (no backups or accounts).
- **Find on the photo**: a search box on the component page highlights connectors and pins by label, name,
  type or pin name. Search results link to the connector on the photo.
- **Add common connectors**: JST XH/PH/ZH/VH/SM, Molex KK/PicoBlade/Micro-Fit/Mini-Fit, Dupont, Deutsch DT,
  M12 and XT30/60 with housing and crimp part numbers.
- **Wire color suggestions**: a new wire without a cable core or pin color gets the usual color for its pin
  name (GND black, supplies red, PE green/yellow, N blue, L brown).
- **Dark theme** (user menu → Auto / Light / Dark; Auto follows the system).
- **Offline viewing** behind HTTPS: pages opened before can be viewed without a connection; a banner says
  when the browser is offline. Browsers only allow this on HTTPS (or localhost), not on a plain
  `http://<ip>:8080` address.

- **Changes without a reason**: a new permission, "Make changes without giving a reason", lets a group (the Admin
  group included, which does not get it automatically) edit without the reason dialog: editors open straight
  away and changes are recorded in the history without a reason. Each user can override it in the Admin panel
  (As the group / Always asked / Never asked). Deleting, locking and unlocking are still confirmed, with the
  reason optional.
- **Wire gauge and shielding**: each wire has its own editable gauge and a Shielded checkbox, in the wire panel
  and directly in the editor's wire table. Left empty, they follow the wire's cable. Both show in the
  pin-to-pin list of the wiring diagram and in the history.
- **User accounts**: every page needs a sign-in, and there is no registration: accounts are made in the new
  **Admin panel** (user menu, top right). On the first start after the upgrade the server creates the account
  `admin` / `admin`, which has to choose a new password before anything else; existing projects are not touched.
  New accounts get a temporary password and choose their own at the first sign-in. Disabling an account or
  resetting its password signs it out everywhere. The last admin account cannot be disabled, deleted or demoted.
- **Groups and permissions**: each user is in one group; the group's permissions (create, edit, delete, lock and
  unlock projects, delete connections, edit or delete the library, backups, users) are ticked in a table in the
  admin panel. The groups Admin, Editor and Member are made on first start; Admin always has every permission.
- **History ("Recent changes")** of every connection and component, plus a History tab on the project page and
  an Activity tab in the admin panel: who changed what, when, why, and a readable list of what changed (e.g.
  "Added wire Main board: J1 pin 1 (24V) → Fan pin 1"). Opening an editor asks for the reason first; everything
  saved until the editor is left is one entry. Locking, unlocking and deleting also need a reason.
- **Automatic backups**: in the admin panel, set how often a backup is made and how many are kept (the oldest is
  deleted when a new one is made). Stored backups can be downloaded, restored or deleted there. Before any restore,
  the current state is saved as a backup. Set `BACKUP_DIR` (Docker: the `backups` volume) to keep them elsewhere.
  Besides the newest backups, the last backup of each day is kept for 30 days (adjustable; days without a backup,
  e.g. while the server was off, do not count).
- **Revert from the history**: **↶ Revert** on a connection or component change puts the item back to how it was
  before that change: connection edits, deleted connections, and component edits (connectors, name, description,
  picture). Later changes to the same item are listed and undone too. A revert needs a reason and is itself in the
  history, so it can be reverted. New permission "Revert changes from the history" (Admin only by default).
  Changes recorded before this version cannot be reverted. Replaced component pictures are now kept (and included
  in backups), so the history can go back to them.

### Changed

- Backups (format v8) also hold the history and the accounts, including password hashes, so keep them private.
  Restoring keeps the accounts of the server and adds accounts from the backup whose username is free.
- The wiring summary records who downloaded it.
- **Recents drawer**: recently opened components and connections are in a drawer on the left edge of every
  project page (the "◷ Recent" tab), instead of a strip above the project tabs that its scroll bar covered.
  It remembers whether it was left open.

- **Arrange by folders** on the project map (Edit mode): every folder on the Components tab becomes a zone
  with its components laid out inside, most-wired components first. Folders that share wires are placed
  next to each other, and components outside folders go below the zones. A zone already named after a folder
  is reused with its color; other zones are moved to the right of the layout. Inside each zone, blocks are
  swapped around to make the lines short, so a block wired to another zone sits on the side facing it.
- **Touchscreen support** (phones, tablets): tapping a connector in a connection diagram shows the
  component photo with the connector marked (tap the photo to edit the connector). On the project map, tapping
  a component highlights its lines and lists its connections with a link to open it; tapping a line shows its
  connection. In edit mode a finger drag pans the canvas and two fingers zoom.
- **Faster navigation**: a project menu in the top bar, a quick switcher (Ctrl K or /) to jump to any
  component, connection, project or page, a strip of recently opened components and connections on the project
  page, breadcrumbs back to the project and tab, and a keyboard shortcuts help (?).
- **Easier to follow lines on the project map**: pointing at a component highlights its lines and the
  components they lead to and fades the rest; pointing at a line highlights it and its two ends. Line labels
  show for highlighted lines only, or for all lines with **All line labels**.
- **Search tab** on the project page: find connections by component, connector, connector type, pin name, zone,
  folder, wire color or note, e.g. "Motor", "1LC", "io1.in" or "io1.in master duet" (all words must match).
  Results show as connection previews with the matching connectors highlighted and the matching pins listed
  with where they are wired; connections where one connector matches every word come first.
- **Wiring summary** of a project: a readable Markdown file with every component, connector and pin, what each
  pin is wired to (followed through inline connectors and splices), the free connectors, and each connection
  wire by wire. Download it with **Wiring summary** on the project page, e.g. to give to an AI assistant for
  writing firmware config or G-code, or asking where a new part can be plugged in. Backups also contain one
  per project, in the `wiring` folder.
- **Changes since the last wiring summary export**: when the project has changed in a way that shows in the
  wiring summary since it was last downloaded, the project page says so, with when it was last exported. The
  **Wiring summary** button gets an amber dot, and its tooltip shows the last export. Changes that don't show
  in the summary, such as moving blocks on the project map, don't count. Backups keep the export history.
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
- **Deleting a component** from the library (and so from every project) asks you to type
  `permanentlydeletefromallprojects` first. The server refuses the delete without it.
- Removing a component from a project now also removes its connectors and their wires from that project's
  connections. The confirmation lists the affected connections.
- Duplicating a connector on a component continues its numbering ("V.out1" becomes "V.out2", "J3" the next free
  J number) instead of adding "copy". A name that ends in a number is numbered the same way.
- Backup format v6 (folders, connection zones, locked projects). Older v1–v5 backups still restore.
- The connector form asks for **pins per row**. A connector with 5 pins in 2 rows now has 10 pins
  (it had 5 before), and the form shows the total.

### Fixed

- **Print / PDF of a wiring diagram**: the whole diagram is now fitted onto an A4 landscape page (it used to be
  cut to whatever fitted the screen), and wire, pin and swatch colors are printed. The pin-to-pin list starts on
  the next page, repeating its header on every page.

### Upgrading

- Backups now use format v10 (build checklist with units and test results, dismissed checks, comments,
  attached files, restricted project members). Older backups still restore.
- The checklist table gets a new primary key (with the unit); `prisma/upgrade.sql` changes it on start and keeps
  existing ticks.

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
