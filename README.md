# Wire-Node

Self-hosted app for documenting machine wiring: projects, component photos (PCBs, motors, power supplies…) with marked connectors,
cables, connectors, pin-to-pin connections and harnesses, and a project-wide wiring map. Several people can work in it, each
with their own account, and every change is recorded in a history that can be reverted.

Made by Zdeněk Pazourek. MIT license.

## Features

- **Component library** with photos; connectors are drawn as rectangles on the photo.
- **Projects** place library components (the same one several times if needed, each under its own name), sorted into folders.
- **Connections editor** for pin-to-pin wiring, harnesses, splits and inline connectors or splices, grouped into zones.
  Each wire has its own color, gauge and shielding (empty means it follows the cable).
- **Wiring diagram** of one connection, printable to an A4 PDF with a pin-to-pin list.
- **Project map**: one block per component, one line per pair that shares wires. Includes zones and an automatic
  "Arrange by folders" layout.
- **Search** across a project by component, connector, pin, wire color, zone, folder or note.
- **Wiring summary**: a Markdown file of the whole project (e.g. to give to an AI assistant for firmware config).
  The project page shows when the wiring changed since the last export.
- **Lock a project** (e.g. once the machine shipped): it keeps a frozen copy of everything it uses.
- **Build tab**: design checks (shorts between supplies, wires too thin for their current, missing gauges or
  lengths), a bill of materials and cut list (CSV / print), a shared checklist to tick wires as crimped and
  tested, printable wire labels and harness tags with QR codes, and a list of nets.
- **Compare** a project with another one (e.g. the previous revision), and **import wires from CSV**.
- **Comments** with @mentions on connections, components and projects, and **files** (datasheets, pinouts) on
  components.
- **Read-only API tokens** for scripts, a **dark theme**, and offline viewing when served over HTTPS.
- **Units** (machines built from a project) with their own checklist and test results, and a **test mode** for
  phones that also works without a connection.
- **Harness drawings** (SVG / print), a **draft firmware config** (RepRapFirmware or Klipper), pin roles and
  voltage-drop checks, bulk wire editing, **restricted projects**, **webhook notifications** and a restore test
  of every automatic backup.
- **Accounts, groups and permissions**, a **history** of every change with the reason for it, and **revert**.
- **Backups**: download or restore in the browser, plus automatic backups on a schedule.
- Works on phones and tablets (touch, pinch-zoom), with a quick switcher (Ctrl K) and keyboard shortcuts (?).

## Install with Docker

Requirements: Docker with the Compose plugin.

```sh
git clone https://github.com/pazstudio/Wire-Node.git
cd Wire-Node
docker compose up -d --build
```

Open http://localhost:8080 (or `http://<server-ip>:8080` from a phone on the same network).

**First sign-in:** user `admin`, password `admin`. You must choose a new password before doing anything else.
There is no self-registration: other accounts are made in the **Admin panel** (user menu, top right).

To use a database password other than the default `wirenode`, set it before the first start, e.g. in a `.env` file
next to `docker-compose.yml`:

```sh
POSTGRES_PASSWORD=choose-something-long
```

> If `docker compose up --build` fails on your Docker version, build the image separately instead:
> `docker build -t wire-node-app:latest .` and then `docker compose up -d --no-build`.

### HTTPS

Optional, with [Caddy](https://caddyserver.com) in front of the app. HTTPS lets phones keep pages for offline
viewing and install Wire-Node as an app.

```sh
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d
```

Set `SITE_ADDRESS` (e.g. in `.env`) to how people reach the server:

- **A domain name** pointing at the server, reachable from the internet on ports 80 and 443:
  `SITE_ADDRESS=wiring.example.com` and `TLS=` (empty). Caddy gets a Let's Encrypt certificate.
- **A LAN address or name**: `SITE_ADDRESS=192.168.1.50`. Caddy makes its own certificate (`tls internal`).
  Browsers trust it once its root certificate is installed on each device: copy it out with
  `docker compose -f docker-compose.yml -f docker-compose.https.yml cp caddy:/data/caddy/pki/authorities/local/root.crt .`
  and install `root.crt` as a trusted certificate (Windows: double-click → Install → "Trusted Root Certification
  Authorities"; Android: Settings → Security → Install certificate; iOS: open it, then enable it under Settings →
  General → About → Certificate Trust Settings).

### Where the data lives

| Volume    | Contents                                                        |
|-----------|-----------------------------------------------------------------|
| `pgdata`  | PostgreSQL database (projects, library, accounts, history)      |
| `uploads` | Component and connector pictures (WebP), including old versions |
| `backups` | Automatic backups (`BACKUP_DIR`)                                |

The automatic backups are only useful if they survive the server's disk, so consider mounting the `backups`
volume from another disk or a NAS (there is an example in `docker-compose.yml`).

### Upgrading

```sh
git pull
docker compose up -d --build
```

Download a backup first, to be safe. The database is upgraded automatically on start (`prisma/upgrade.sql`, then
`prisma db push`) and existing data is kept. When upgrading from a version without accounts, the `admin` / `admin`
account is created on the first start, as above. See [CHANGELOG.md](CHANGELOG.md) for what changed.

## Accounts and permissions

- Each user is in one **group**, and the group's permissions are ticked in a table in the Admin panel: create, edit,
  delete, lock and unlock projects, delete connections, edit or delete the library, revert changes, backups, and users.
  Everyone signed in can view projects and the history.
- The groups **Admin**, **Editor** and **Member** are made on first start. Admin always has every permission.
- New accounts get a temporary password and choose their own at the first sign-in. Disabling an account or
  resetting its password signs it out everywhere. The last admin cannot be disabled, deleted or demoted.
- Sign-ins last 30 days (an HttpOnly cookie, marked `Secure` behind HTTPS).

## History and revert

- Opening an editor asks **why** you are changing it, and everything saved until you leave the editor becomes one
  history entry. Entries show who, when, why, and a readable list of what changed, e.g.
  "Added wire Main board: J1 pin 1 (24V) → Fan pin 1".
- The permission "Make changes without giving a reason" skips that question (per group, and overridable per user).
  Deleting, locking and unlocking are still confirmed.
- History is shown on each connection and component, in the project's **History** tab, and in the Admin panel's
  **Activity** tab.
- **↶ Revert** puts a connection or component back to how it was before a change, including deleted connections and
  replaced pictures. Later changes to the same item are undone too, and the revert itself goes into the history.

## Backups and moving to another server

A backup is a single `.tar.gz` file with every database row (`wire-node.json`), every picture (`uploads/`), and a
wiring summary of each project (`wiring/`). It does not depend on the PostgreSQL version or on Docker volume names.

**It contains the accounts (with password hashes) and the full history, so keep backups private.**

**Automatic backups:** in Admin panel → Backups, set how often a backup is made and how many are kept. The last
backup of each day is also kept for 30 days (adjustable). Stored backups can be downloaded, restored or deleted there.
Before any restore, the current state is saved as a backup first.

**Moving to a new server in the browser:**

1. On the old server, open *Backup & restore* and click **Download backup**.
2. Install Wire-Node on the new server (see above) and sign in as `admin`.
3. Open *Backup & restore*, pick the file and click **Restore**.

Restoring keeps the new server's accounts and adds the accounts from the backup whose usernames are free.

**From the command line:** the API needs a signed-in account with the Backups permission, so sign in with a cookie
file first.

```sh
# Sign in (stores the session cookie in cookies.txt)
curl -fc cookies.txt -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"YOUR-PASSWORD"}' http://OLD-SERVER:8080/api/auth/login

# Export
curl -fb cookies.txt -o wire-node-backup.tar.gz http://OLD-SERVER:8080/api/backup

# Import into a new, empty server (sign in there the same way first)
curl -fb cookies.txt -F file=@wire-node-backup.tar.gz http://NEW-SERVER:8080/api/restore

# Overwrite a server that already has data (deletes its data first)
curl -fb cookies.txt -F file=@wire-node-backup.tar.gz "http://NEW-SERVER:8080/api/restore?replace=true"
```

A new server's `admin` account must change its password (in the browser) before the API accepts other requests.
Restore is all-or-nothing for the database: if anything fails, the existing data is kept. Without `replace=true`, a
server that already has data refuses the restore with HTTP 409. Backups from older versions (format v1 and later) still restore.

## Develop without Docker

Requirements: Node.js 20+ and a PostgreSQL server.

```sh
# API (http://localhost:8080)
cd server
cp .env.example .env        # adjust DATABASE_URL
npm install
npm run db:push             # not `npx prisma db push`: this also runs the data upgrades
npm run dev

# Web (http://localhost:5173, proxies /api and /uploads to :8080)
cd web
npm install
npm run dev
```

Checks: `npm run typecheck` in both folders, `npm test` in `server`.

## Notifications

In the Admin panel → **Notifications**, paste an incoming-webhook URL from Slack, Microsoft Teams, Discord, ntfy or
anything that accepts a JSON POST with a `text` field, and choose what to send: @mentions, new comments, failed wire
tests, failed backups. **Send a test message** checks it.

## API tokens

For scripts, e.g. pulling the wiring summary in a firmware CI job, create a token in the user menu
(**API tokens**) and send it as a bearer token. Tokens are read-only and never get admin rights.

```sh
curl -H "Authorization: Bearer wn_..." http://SERVER:8080/api/projects
curl -H "Authorization: Bearer wn_..." -o wiring.md http://SERVER:8080/api/projects/PROJECT-ID/wiring.md
curl -H "Authorization: Bearer wn_..." http://SERVER:8080/api/projects/PROJECT-ID/checks
curl -H "Authorization: Bearer wn_..." http://SERVER:8080/api/projects/PROJECT-ID/build-list
curl -H "Authorization: Bearer wn_..." "http://SERVER:8080/api/projects/PROJECT-ID/firmware?format=rrf"
```

## How it works

In the app, "components" are PCBs, motors, power supplies or any other part with connectors.
Internally (database tables, API paths such as `/api/pcbs`) they are still called PCBs.

- **Library vs project.** Components, cables and connector types are a shared library, and component names in it are
  unique. A project places components under a name of its own. The same component can be placed several times
  (e.g. "Peltier Driver - Toolhead1" and "Peltier Driver - Toolhead2") without uploading it again. Connections, folders
  and map zones belong to one project.
- **Component drawings** store rectangle coordinates normalized to the image size (0..1), so they stay on the same spot
  on any screen. Every change is autosaved (debounced, per connector, in order). Uploaded photos are converted to WebP
  and auto-rotated from EXIF, so phone pictures line up.
- **Connections** are graphs: connector nodes plus pin-to-pin wires. More than two connectors makes a harness, and one
  connector's pins can go to different connectors (splits). Inline connectors or splices that are not on a component
  are "inline" nodes.
- **Project map** shows one block per placed component and one line per block pair that shares wires (followed through
  inline connectors). Zones are semi-transparent rectangles for grouping, such as "Frame" or "Toolhead".
- **Locked projects** copy every component, connector type and cable they use into a frozen copy, so library edits no
  longer reach them. Unlocking moves them back to the library items.
- **Auth** is in `server/src/auth.ts`. Every `/api` and `/uploads` request needs a session, except sign-in and health.
  Passwords are hashed with scrypt, and only a SHA-256 of each session token is stored. Requests that change data and
  come from another site (by the `Origin` header) are refused.
- **Build tools** (`projectModel.ts`) resolve every wire's ends, color, gauge and length and group pins into
  nets; the build list (`buildList.ts`), design checks (`designChecks.ts`) and project comparison
  (`compareProjects.ts`) are built on it. Checklist ticks store a fingerprint of the wire, so a moved wire is
  flagged instead of staying ticked.
- **History** entries store the item's database rows from before the change (`history.ts`). The readable list of what
  changed is computed from that snapshot (`historyDiff.ts`), and revert (`revert.ts`) writes it back.

## Stack

React + TypeScript + Vite, react-konva (component photo drawing), React Flow (wizard, diagram, map),
TanStack Query, Fastify, Prisma, PostgreSQL, sharp.
